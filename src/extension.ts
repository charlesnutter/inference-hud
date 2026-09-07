import * as vscode from 'vscode';
import { CompletedStats, TelemetryEvent } from './adapter';
import { EndpointConfig, ResolvedEndpoint, resolveEndpoints } from './endpoints';

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

	const view = new StatusView(item);
	let abort: AbortController | undefined;
	let generation = 0;

	async function restart(): Promise<void> {
		const myGen = ++generation;
		abort?.abort();
		const ac = new AbortController();
		abort = ac;

		const cfg = vscode.workspace.getConfiguration('inferenceHud');
		const { endpoints, unsupported } = await resolveEndpoints(
			cfg.get<EndpointConfig[]>('endpoints', []),
			cfg.get<boolean>('autoDetect', true)
		);
		if (myGen !== generation) {
			return;
		}

		for (const u of unsupported) {
			log.info(`skipping ${u.url} (${u.engineName}): ${u.reason}`);
		}
		view.setEndpoints(endpoints);

		if (endpoints.length === 0) {
			log.warn('no inference servers found; set inferenceHud.endpoints');
			return;
		}
		log.info(
			`watching ${endpoints.length} endpoint(s): ` +
				endpoints.map(e => `${e.url} [${e.adapter.id}]`).join(', ')
		);

		// Every endpoint runs its own loop; one being down never stops another.
		for (const endpoint of endpoints) {
			void watch(endpoint, ac.signal, myGen);
		}
	}

	async function watch(
		endpoint: ResolvedEndpoint,
		signal: AbortSignal,
		myGen: number
	): Promise<void> {
		let delay = RECONNECT_MIN_MS;
		while (!signal.aborted && myGen === generation) {
			try {
				await endpoint.adapter.run(endpoint.url, signal, event => {
					if (myGen !== generation) {
						return;
					}
					delay = RECONNECT_MIN_MS;
					render(endpoint, event, view, log);
				});
			} catch (err) {
				if (signal.aborted || myGen !== generation) {
					return;
				}
				view.setDisconnected(endpoint, String(err));
				log.warn(`[${endpoint.adapter.id}] ${endpoint.url}: ${err}`);
			}
			if (signal.aborted || myGen !== generation) {
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
		vscode.commands.registerCommand('inferenceHud.reconnect', () => void restart()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('inferenceHud.endpoints') ||
				e.affectsConfiguration('inferenceHud.autoDetect')
			) {
				void restart();
			}
		})
	);

	void restart();
}

export function deactivate() {}

function render(
	endpoint: ResolvedEndpoint,
	event: TelemetryEvent,
	view: StatusView,
	log: vscode.LogOutputChannel
): void {
	switch (event.kind) {
		case 'connected':
			view.setConnected(endpoint);
			break;
		case 'notice':
			view.notice(endpoint, event.level, event.message, log);
			break;
		case 'prefill':
			view.setPrefill(endpoint, event.done, event.total);
			break;
		case 'progress':
			view.setProgress(endpoint, event.completionTokens, event.decodeTokS);
			break;
		case 'completed':
			view.setCompleted(endpoint, event.stats);
			log.info(`[${endpoint.adapter.id}] ${summarize(event.stats)}`);
			break;
	}
}

/**
 * A measurement with its unit, where a missing value renders as a bare dash.
 * Appending the unit unconditionally produces `—s` and `— tok/s`, which read
 * as a malformed number rather than as "this engine does not report it" —
 * a distinction that matters here, since several fields are genuinely absent
 * on some engines: llama.cpp publishes no time-to-first-token at all.
 */
const unit = (n: number | undefined | null, suffix: string, digits = 1) =>
	typeof n === 'number' && isFinite(n) ? `${n.toFixed(digits)}${suffix}` : '—';

/** Longest model name the status bar will carry before it is elided. */
const MODEL_BUDGET = 20;

/**
 * Model ids are far longer than a status bar can spare once it also carries a
 * rate and a token count, so trim them to the part that actually identifies
 * the model: `Qwen/Qwen2.5-0.5B-Instruct` and
 * `qwen2.5-0.5b-instruct-q4_k_m.gguf` both reduce to a recognisable stem.
 *
 * Only affixes that carry no identity are dropped — namespace, file extension,
 * quantisation tag, and the role suffix nearly every instruct model shares.
 * Anything still over budget is elided rather than trimmed further, since
 * beyond this point the remaining characters are what tell two models apart.
 * The untouched id is always in the tooltip.
 */
function shortModel(name: string): string {
	let s = name.split('/').pop() ?? name;
	s = s.replace(/\.(gguf|safetensors|bin|pt)$/i, '');
	s = s.replace(/-(q\d+[a-z0-9_]*|f16|bf16|fp16|fp8|int[48])$/i, '');
	s = s.replace(/-(instruct|chat|it)$/i, '');
	return s.length > MODEL_BUDGET ? `${s.slice(0, MODEL_BUDGET - 1)}…` : s;
}

function summarize(s: CompletedStats): string {
	return (
		`done · ${unit(s.decodeTokS, ' tok/s', 2)} · ${s.completionTokens ?? 0} out / ` +
		`${s.promptTokens ?? 0} in · ttft ${unit(s.ttftS, 's', 3)} · total ${unit(s.requestElapsedS, 's', 2)}`
	);
}

interface SourceState {
	endpoint: ResolvedEndpoint;
	connected: boolean;
	/** Most recent completion from this endpoint. */
	last?: CompletedStats;
	/** Model id the server reported, once we've seen one. */
	model?: string;
}

/**
 * Renders several endpoints into one status bar item.
 *
 * Whichever endpoint most recently showed activity owns the display, which is
 * what makes the HUD follow the model you're actually using without needing to
 * know what the chat view has selected.
 */
class StatusView {
	private readonly sources = new Map<string, SourceState>();
	private readonly seenNotices = new Set<string>();
	/** URL of the endpoint currently owning the display. */
	private active?: string;

	constructor(private readonly item: vscode.StatusBarItem) {
		this.repaintIdle();
	}

	setEndpoints(endpoints: readonly ResolvedEndpoint[]): void {
		this.sources.clear();
		this.active = undefined;
		for (const endpoint of endpoints) {
			this.sources.set(endpoint.url, { endpoint, connected: false });
		}
		this.repaintIdle();
	}

	setConnected(endpoint: ResolvedEndpoint): void {
		const s = this.source(endpoint);
		s.connected = true;
		this.repaintIdle();
	}

	setDisconnected(endpoint: ResolvedEndpoint, detail: string): void {
		const s = this.source(endpoint);
		s.connected = false;
		if (this.active === endpoint.url) {
			this.active = undefined;
		}
		this.seenNotices.delete(`${endpoint.url}:${detail}`);
		this.repaintIdle();
	}

	setPrefill(endpoint: ResolvedEndpoint, done: number | null, total: number | null): void {
		this.active = endpoint.url;
		this.item.text =
			total === null
				? `$(loading~spin) prefill ${done ?? 0} tok`
				: `$(loading~spin) prefill ${done ?? 0}/${total}`;
		this.item.tooltip = this.tooltip();
	}

	setProgress(endpoint: ResolvedEndpoint, tokens: number, rate: number | null): void {
		this.active = endpoint.url;
		this.item.text =
			rate === null
				? `$(loading~spin) ${tokens} tok`
				: `$(zap) ${unit(rate, ' tok/s')} · ${tokens}`;
		this.item.tooltip = this.tooltip();
	}

	setCompleted(endpoint: ResolvedEndpoint, stats: CompletedStats): void {
		const s = this.source(endpoint);
		s.last = stats;
		s.model = stats.model ?? s.model;
		this.active = endpoint.url;
		this.repaintIdle();
	}

	/** Deduped per endpoint so reconnects don't nag. */
	notice(
		endpoint: ResolvedEndpoint,
		level: 'info' | 'warn',
		message: string,
		log: vscode.LogOutputChannel
	): void {
		const key = `${endpoint.url}:${message}`;
		if (this.seenNotices.has(key)) {
			return;
		}
		this.seenNotices.add(key);
		if (level === 'warn') {
			log.warn(`${endpoint.url}: ${message}`);
			void vscode.window.showWarningMessage(`Inference HUD: ${message}`);
		} else {
			log.info(`${endpoint.url}: ${message}`);
		}
	}

	private source(endpoint: ResolvedEndpoint): SourceState {
		let s = this.sources.get(endpoint.url);
		if (!s) {
			s = { endpoint, connected: false };
			this.sources.set(endpoint.url, s);
		}
		return s;
	}

	private repaintIdle(): void {
		const all = [...this.sources.values()];
		if (all.length === 0) {
			this.item.text = '$(debug-disconnect) no engine';
			this.item.tooltip = 'Inference HUD: no inference server found.';
			return;
		}
		// Only claim disconnected when nothing at all is reachable.
		if (!all.some(s => s.connected)) {
			this.item.text = '$(debug-disconnect) Inference HUD';
			this.item.tooltip = this.tooltip();
			return;
		}

		const shown = this.activeSource() ?? all.find(s => s.last);
		const last = shown?.last;
		this.item.text =
			shown && last
				? `$(zap) ${this.shortName(shown)} · ${unit(last.decodeTokS, ' tok/s')} · ` +
					`${last.completionTokens ?? 0} tok`
				: `$(zap) ${this.shortName(shown ?? all[0])} idle`;
		this.item.tooltip = this.tooltip();
	}

	private activeSource(): SourceState | undefined {
		return this.active ? this.sources.get(this.active) : undefined;
	}

	private shortName(s: SourceState): string {
		return shortModel(s.model ?? s.endpoint.label ?? s.endpoint.adapter.displayName);
	}

	private tooltip(): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.supportThemeIcons = true;
		const all = [...this.sources.values()];
		const shown = this.activeSource() ?? all.find(s => s.last);

		if (shown?.last) {
			const s = shown.last;
			md.appendMarkdown(`**${this.shortName(shown)}** — last request\n\n`);
			md.appendMarkdown('| | |\n|---|---|\n');
			md.appendMarkdown(`| Decode | **${unit(s.decodeTokS, ' tok/s', 2)}** |\n`);
			md.appendMarkdown(`| End-to-end | ${unit(s.requestTokS, ' tok/s', 2)} |\n`);
			md.appendMarkdown(
				`| Generated | ${s.completionTokens ?? 0} tokens in ${unit(s.decodeElapsedS, 's', 2)} |\n`
			);
			md.appendMarkdown(`| TTFT | ${unit(s.ttftS, 's', 3)} |\n`);
			md.appendMarkdown(
				`| Prefill | ${s.promptTokens ?? 0} tokens @ ${unit(s.prefillTokS, ' tok/s', 0)} |\n`
			);
			md.appendMarkdown(
				`| Cache | ${s.cachedTokens ?? 0} cached (${s.cacheSource ?? 'none'}) |\n`
			);
			md.appendMarkdown(`| Context | ${s.contextLen ?? 0} tokens |\n`);
			for (const [label, value] of Object.entries(s.extra ?? {})) {
				md.appendMarkdown(`| ${label} | ${value} |\n`);
			}
			md.appendMarkdown(`| Total | ${unit(s.requestElapsedS, 's', 2)} |\n`);
		} else {
			md.appendMarkdown('**Inference HUD** — no requests seen yet.\n');
		}

		if (all.length > 1 || !shown?.last) {
			md.appendMarkdown('\n**Endpoints**\n\n');
			for (const s of all) {
				const dot = s.connected ? '$(pass-filled)' : '$(circle-slash)';
				const mark = s.endpoint.url === this.active ? ' ←' : '';
				const how = s.endpoint.detected ? 'detected' : 'configured';
				md.appendMarkdown(
					`- ${dot} \`${s.endpoint.url}\` — ${s.endpoint.adapter.displayName} (${how})${mark}\n`
				);
			}
		}
		return md;
	}
}
