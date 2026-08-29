import * as vscode from 'vscode';
import { readSse } from './sse';

/**
 * The engine currently wired to the status bar. Only MTPLX has a stream
 * adapter so far; see src/engines.ts for the registry this will resolve
 * against once the poll and proxy adapters land.
 */
const ENGINE_LABEL = 'MTPLX';

/** Events whose payloads we never parse — `snapshot` frames are huge. */
const SKIP = new Set(['snapshot']);

interface ProgressEvent {
	completion_tokens: number;
	decode_elapsed_s: number;
	decode_tok_s: number | null;
	request_id: string;
}

interface PrefillEvent {
	phase: string;
	tokens_done: number | null;
	tokens_total: number;
	cached_tokens: number;
	new_prefill_tokens: number;
}

/** Trimmed subset of the `completed` envelope we actually render. */
interface CompletedEnvelope {
	prompt_tokens?: number;
	cached_tokens?: number;
	completion_tokens?: number;
	decode_tok_s?: number;
	request_tok_s?: number;
	prefill_tok_s?: number;
	ttft_s?: number;
	decode_elapsed_s?: number;
	request_elapsed_s?: number;
	cache_source?: string;
	request_model?: string;
	context_len?: number;
	accepted_by_depth?: number[];
	drafted_by_depth?: number[];
}

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Inference HUD', { log: true });
	const priority = vscode.workspace
		.getConfiguration('inferenceHud')
		.get<number>('statusBarPriority', 100);

	const item = vscode.window.createStatusBarItem(
		'inferenceHud.status',
		vscode.StatusBarAlignment.Right,
		priority
	);
	item.name = 'Inference HUD';
	item.command = 'inferenceHud.showLog';
	item.text = `$(debug-disconnect) ${ENGINE_LABEL}`;
	item.tooltip = `${ENGINE_LABEL}: connecting…`;
	item.show();

	let abort: AbortController | undefined;
	let generation = 0;
	let lastCompleted: CompletedEnvelope | undefined;

	const fmt = (n: number | undefined, digits = 1) =>
		typeof n === 'number' && isFinite(n) ? n.toFixed(digits) : '—';

	function idleText() {
		if (!lastCompleted) {
			return `$(zap) ${ENGINE_LABEL} idle`;
		}
		return `$(zap) ${fmt(lastCompleted.decode_tok_s)} tok/s · ${lastCompleted.completion_tokens ?? 0} tok`;
	}

	function tooltipFor(e: CompletedEnvelope | undefined): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.supportThemeIcons = true;
		if (!e) {
			md.appendMarkdown(`**${ENGINE_LABEL}** — connected, no requests yet.`);
			return md;
		}
		const accepted = (e.accepted_by_depth ?? []).reduce((a, b) => a + b, 0);
		const drafted = (e.drafted_by_depth ?? []).reduce((a, b) => a + b, 0);
		md.appendMarkdown(`**${e.request_model ?? 'model'}** — last request\n\n`);
		md.appendMarkdown(`| | |\n|---|---|\n`);
		md.appendMarkdown(`| Decode | **${fmt(e.decode_tok_s, 2)} tok/s** |\n`);
		md.appendMarkdown(`| End-to-end | ${fmt(e.request_tok_s, 2)} tok/s |\n`);
		md.appendMarkdown(`| Generated | ${e.completion_tokens ?? 0} tokens in ${fmt(e.decode_elapsed_s, 2)}s |\n`);
		md.appendMarkdown(`| TTFT | ${fmt(e.ttft_s, 3)}s |\n`);
		md.appendMarkdown(`| Prefill | ${e.prompt_tokens ?? 0} tokens @ ${fmt(e.prefill_tok_s, 0)} tok/s |\n`);
		md.appendMarkdown(`| Cache | ${e.cached_tokens ?? 0} cached (${e.cache_source ?? 'none'}) |\n`);
		md.appendMarkdown(`| Context | ${e.context_len ?? 0} tokens |\n`);
		if (drafted > 0) {
			md.appendMarkdown(`| MTP accept | ${((accepted / drafted) * 100).toFixed(1)}% (${accepted}/${drafted}) |\n`);
		}
		md.appendMarkdown(`| Total | ${fmt(e.request_elapsed_s, 2)}s |\n`);
		return md;
	}

	function handle(event: string, data: string) {
		switch (event) {
			case 'prefill': {
				const pf = JSON.parse(data) as PrefillEvent;
				// Phases are `started` | `chunk` | `completed`; the last one
				// carries no token count and is immediately followed by decode.
				if (pf.phase !== 'completed') {
					item.text = `$(loading~spin) prefill ${pf.tokens_done ?? 0}/${pf.tokens_total}`;
				}
				break;
			}
			case 'progress': {
				const pr = JSON.parse(data).progress as ProgressEvent;
				const rate = pr.decode_tok_s;
				item.text =
					rate === null
						? `$(loading~spin) ${pr.completion_tokens} tok`
						: `$(zap) ${fmt(rate)} tok/s · ${pr.completion_tokens}`;
				break;
			}
			case 'completed': {
				const env = JSON.parse(data).envelope as CompletedEnvelope;
				lastCompleted = env;
				item.text = idleText();
				item.tooltip = tooltipFor(env);
				log.info(
					`done · ${fmt(env.decode_tok_s, 2)} tok/s · ${env.completion_tokens ?? 0} out / ` +
						`${env.prompt_tokens ?? 0} in · ttft ${fmt(env.ttft_s, 3)}s · ` +
						`total ${fmt(env.request_elapsed_s, 2)}s`
				);
				break;
			}
			case 'new_max_tps': {
				const { tok_s } = JSON.parse(data) as { tok_s: number };
				log.info(`new max decode rate: ${fmt(tok_s, 2)} tok/s`);
				break;
			}
		}
	}

	async function connect() {
		const myGen = ++generation;
		abort?.abort();
		let delay = 1000;

		while (myGen === generation) {
			const base = vscode.workspace
				.getConfiguration('inferenceHud')
				.get<string>('serverUrl', 'http://127.0.0.1:8000')
				.replace(/\/+$/, '');
			const url = `${base}/v1/mtplx/metrics/stream`;
			const ac = new AbortController();
			abort = ac;

			try {
				log.info(`connecting to ${url}`);
				for await (const frame of readSse(url, ac.signal, SKIP)) {
					if (myGen !== generation) {
						break;
					}
					if (frame.data === '') {
						// A skipped event (snapshot); connection is alive.
						if (item.text.startsWith('$(debug-disconnect)')) {
							item.text = idleText();
							item.tooltip = tooltipFor(lastCompleted);
						}
						continue;
					}
					delay = 1000; // real traffic — reset backoff
					try {
						handle(frame.event, frame.data);
					} catch (err) {
						log.warn(`failed to handle "${frame.event}": ${err}`);
					}
				}
			} catch (err) {
				if (myGen !== generation || ac.signal.aborted) {
					return;
				}
				item.text = `$(debug-disconnect) ${ENGINE_LABEL}`;
				item.tooltip = `${ENGINE_LABEL} unreachable at ${url}\n${err}`;
				log.warn(`stream error: ${err}`);
			}

			if (myGen !== generation) {
				return;
			}
			await new Promise(r => setTimeout(r, delay));
			delay = Math.min(delay * 2, 15000);
		}
	}

	context.subscriptions.push(
		item,
		log,
		new vscode.Disposable(() => {
			generation++;
			abort?.abort();
		}),
		vscode.commands.registerCommand('inferenceHud.showLog', () => log.show()),
		vscode.commands.registerCommand('inferenceHud.reconnect', () => void connect()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('inferenceHud.serverUrl')) {
				void connect();
			}
		})
	);

	void connect();
}

export function deactivate() {}
