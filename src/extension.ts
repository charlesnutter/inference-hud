import * as vscode from 'vscode';
import { CompletedStats, TelemetryAdapter, TelemetryEvent } from './adapter';
import { mtplxAdapter } from './adapters/mtplx';

/**
 * Adapters available to the status bar. Only MTPLX is implemented; detection
 * across several engines lives in `engines.ts` and is not wired up yet.
 */
const ADAPTER: TelemetryAdapter = mtplxAdapter;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

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
	item.show();

	const view = new StatusView(item, ADAPTER.displayName);
	view.setDisconnected();

	let abort: AbortController | undefined;
	let generation = 0;

	function serverUrl(): string {
		return vscode.workspace
			.getConfiguration('inferenceHud')
			.get<string>('serverUrl', 'http://127.0.0.1:8000')
			.replace(/\/+$/, '');
	}

	async function connect(): Promise<void> {
		const myGen = ++generation;
		abort?.abort();
		let delay = RECONNECT_MIN_MS;

		while (myGen === generation) {
			const url = serverUrl();
			const ac = new AbortController();
			abort = ac;

			try {
				log.info(`[${ADAPTER.id}] connecting to ${url}`);
				await ADAPTER.run(url, ac.signal, event => {
					if (myGen !== generation) {
						return;
					}
					delay = RECONNECT_MIN_MS; // real traffic — reset backoff
					render(event, view, log);
				});
			} catch (err) {
				if (myGen !== generation || ac.signal.aborted) {
					return;
				}
				view.setDisconnected(`unreachable at ${url}\n${err}`);
				log.warn(`[${ADAPTER.id}] ${err}`);
			}

			if (myGen !== generation) {
				return;
			}
			await new Promise(r => setTimeout(r, delay));
			delay = Math.min(delay * 2, RECONNECT_MAX_MS);
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

function render(event: TelemetryEvent, view: StatusView, log: vscode.LogOutputChannel): void {
	switch (event.kind) {
		case 'connected':
			view.setConnected();
			break;
		case 'prefill':
			view.setPrefill(event.done, event.total);
			break;
		case 'progress':
			view.setProgress(event.completionTokens, event.decodeTokS);
			break;
		case 'completed':
			view.setCompleted(event.stats);
			log.info(summarize(event.stats));
			break;
	}
}

const fmt = (n: number | undefined | null, digits = 1) =>
	typeof n === 'number' && isFinite(n) ? n.toFixed(digits) : '—';

function summarize(s: CompletedStats): string {
	return (
		`done · ${fmt(s.decodeTokS, 2)} tok/s · ${s.completionTokens ?? 0} out / ` +
		`${s.promptTokens ?? 0} in · ttft ${fmt(s.ttftS, 3)}s · total ${fmt(s.requestElapsedS, 2)}s`
	);
}

/** Owns every pixel the extension puts on screen. */
class StatusView {
	private last: CompletedStats | undefined;

	constructor(
		private readonly item: vscode.StatusBarItem,
		private readonly engine: string
	) {}

	setDisconnected(detail?: string): void {
		this.item.text = `$(debug-disconnect) ${this.engine}`;
		this.item.tooltip = detail ?? `${this.engine}: connecting…`;
	}

	setConnected(): void {
		this.item.text = this.idleText();
		this.item.tooltip = this.tooltip();
	}

	setPrefill(done: number | null, total: number): void {
		this.item.text = `$(loading~spin) prefill ${done ?? 0}/${total}`;
	}

	setProgress(tokens: number, rate: number | null): void {
		this.item.text =
			rate === null
				? `$(loading~spin) ${tokens} tok`
				: `$(zap) ${fmt(rate)} tok/s · ${tokens}`;
	}

	setCompleted(stats: CompletedStats): void {
		this.last = stats;
		this.item.text = this.idleText();
		this.item.tooltip = this.tooltip();
	}

	private idleText(): string {
		if (!this.last) {
			return `$(zap) ${this.engine} idle`;
		}
		return `$(zap) ${fmt(this.last.decodeTokS)} tok/s · ${this.last.completionTokens ?? 0} tok`;
	}

	private tooltip(): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.supportThemeIcons = true;
		const s = this.last;
		if (!s) {
			md.appendMarkdown(`**${this.engine}** — connected, no requests yet.`);
			return md;
		}

		md.appendMarkdown(`**${s.model ?? this.engine}** — last request\n\n`);
		md.appendMarkdown('| | |\n|---|---|\n');
		md.appendMarkdown(`| Decode | **${fmt(s.decodeTokS, 2)} tok/s** |\n`);
		md.appendMarkdown(`| End-to-end | ${fmt(s.requestTokS, 2)} tok/s |\n`);
		md.appendMarkdown(
			`| Generated | ${s.completionTokens ?? 0} tokens in ${fmt(s.decodeElapsedS, 2)}s |\n`
		);
		md.appendMarkdown(`| TTFT | ${fmt(s.ttftS, 3)}s |\n`);
		md.appendMarkdown(
			`| Prefill | ${s.promptTokens ?? 0} tokens @ ${fmt(s.prefillTokS, 0)} tok/s |\n`
		);
		md.appendMarkdown(`| Cache | ${s.cachedTokens ?? 0} cached (${s.cacheSource ?? 'none'}) |\n`);
		md.appendMarkdown(`| Context | ${s.contextLen ?? 0} tokens |\n`);
		for (const [label, value] of Object.entries(s.extra ?? {})) {
			md.appendMarkdown(`| ${label} | ${value} |\n`);
		}
		md.appendMarkdown(`| Total | ${fmt(s.requestElapsedS, 2)}s |\n`);
		return md;
	}
}
