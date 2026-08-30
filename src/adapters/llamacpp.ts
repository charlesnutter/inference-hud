import { CompletedStats, Emit, TelemetryAdapter } from '../adapter';

const POLL_MS = 300;

interface Slot {
	is_processing: boolean;
	/** Identifies the request occupying the slot; changes on every new one. */
	id_task?: number;
	n_prompt_tokens?: number;
	n_prompt_tokens_processed?: number;
	n_prompt_tokens_cache?: number;
}

/** The counters we difference. All are cumulative since server start. */
interface Counters {
	promptTokens: number;
	promptSeconds: number;
	predictedTokens: number;
	predictedSeconds: number;
}

/**
 * llama.cpp needs both of its endpoints, because neither is sufficient alone:
 *
 *   /slots   — the only source of live progress, but carries no timings and
 *              goes blank the instant a request finishes.
 *   /metrics — the only source of accurate totals, but its counters do not
 *              move until a request completes, so it cannot drive a live
 *              readout. Requires `--metrics`, which is off by default.
 */
export const llamaCppAdapter: TelemetryAdapter = {
	id: 'llamacpp',
	displayName: 'llama.cpp',

	async run(baseUrl, signal, emit) {
		const base = baseUrl.replace(/\/+$/, '');

		const props = await getJson(`${base}/props`, signal);
		if (!props) {
			throw new Error(`no llama.cpp server at ${base}`);
		}
		const model = basename(props.model_path ?? props.model_alias ?? '') || 'llama.cpp';
		const hasMetrics = props.endpoint_metrics === true;
		const hasSlots = props.endpoint_slots === true;

		emit({ kind: 'connected' });
		if (!hasSlots) {
			emit({
				kind: 'notice',
				level: 'warn',
				message: 'llama-server was started with --no-slots; live progress is unavailable.'
			});
		}
		if (!hasMetrics) {
			emit({
				kind: 'notice',
				level: 'warn',
				message:
					'llama-server was started without --metrics; per-request totals are ' +
					'unavailable. Restart it with --metrics for full telemetry.'
			});
		}

		/** Counters as of the last moment the server was idle. */
		let baseline = hasMetrics ? await readCounters(base, signal) : undefined;
		let wasBusy = false;
		/** Set on busy->idle; cleared once the counters actually move. */
		let awaitingTotals = false;
		let lastSlot: Slot | undefined;
		let prevNpt: { tokens: number; at: number } | undefined;
		// Slots are reused, and `is_processing` flips true a tick before the
		// counters are reset — so a fresh task briefly reports the previous
		// request's totals. Track the task id and distrust its first sample.
		let taskId: number | undefined;
		let samplesThisTask = 0;

		while (!signal.aborted) {
			const slots = (await getJson(`${base}/slots`, signal)) as Slot[] | null;
			const active = Array.isArray(slots) ? slots.find(s => s.is_processing) : undefined;

			if (active) {
				if (active.id_task !== taskId) {
					taskId = active.id_task;
					samplesThisTask = 0;
					prevNpt = undefined;
				}
				samplesThisTask++;
				lastSlot = active;
				const npt = active.n_prompt_tokens ?? 0;
				// `n_prompt_tokens_processed` counts only what this request had
				// to compute; anything served from the prompt cache is reported
				// separately, so the full prompt is the sum of the two.
				const promptLen =
					(active.n_prompt_tokens_processed ?? 0) + (active.n_prompt_tokens_cache ?? 0);
				// Once decoding starts, `promptLen` is fixed and everything
				// beyond it in the slot's context is generated output.
				const generated = npt - promptLen;

				if (generated <= 0 || samplesThisTask === 1) {
					// The first sample of a task may still carry stale totals,
					// so report it as prefill rather than trusting the count.
					emit({ kind: 'prefill', done: promptLen, total: null });
					prevNpt = { tokens: npt, at: Date.now() };
				} else {
					const now = Date.now();
					let rate: number | null = null;
					if (prevNpt && now > prevNpt.at && npt >= prevNpt.tokens) {
						rate = ((npt - prevNpt.tokens) * 1000) / (now - prevNpt.at);
					}
					prevNpt = { tokens: npt, at: now };
					emit({ kind: 'progress', completionTokens: generated, decodeTokS: rate });
				}
				wasBusy = true;
			} else {
				if (wasBusy) {
					wasBusy = false;
					prevNpt = undefined;
					taskId = undefined;
					samplesThisTask = 0;
					awaitingTotals = hasMetrics;
					if (!hasMetrics) {
						emit({ kind: 'completed', stats: { model } });
					}
				}

				// The counters flush at completion, which can land a tick after
				// the slot reports idle — so wait for them to actually move.
				if (awaitingTotals && baseline) {
					const now = await readCounters(base, signal);
					if (now && now.predictedTokens > baseline.predictedTokens) {
						emit({ kind: 'completed', stats: toStats(model, baseline, now, lastSlot) });
						baseline = now;
						awaitingTotals = false;
					}
				} else if (hasMetrics && !awaitingTotals) {
					baseline = (await readCounters(base, signal)) ?? baseline;
				}
			}

			await sleep(POLL_MS, signal);
		}
	}
};

function toStats(
	model: string,
	before: Counters,
	after: Counters,
	slot: Slot | undefined
): CompletedStats {
	const completionTokens = after.predictedTokens - before.predictedTokens;
	const decodeElapsedS = after.predictedSeconds - before.predictedSeconds;
	// The counter only tracks tokens actually computed, so on a cache hit it
	// under-reports the prompt badly. Prefer the slot's own accounting.
	const computed = after.promptTokens - before.promptTokens;
	const cached = slot?.n_prompt_tokens_cache ?? 0;
	const promptTokens = slot ? (slot.n_prompt_tokens_processed ?? 0) + cached : computed;
	const prefillS = after.promptSeconds - before.promptSeconds;
	const requestElapsedS = decodeElapsedS + prefillS;

	return {
		model,
		promptTokens,
		cachedTokens: slot?.n_prompt_tokens_cache,
		completionTokens,
		decodeTokS: decodeElapsedS > 0 ? completionTokens / decodeElapsedS : undefined,
		requestTokS: requestElapsedS > 0 ? completionTokens / requestElapsedS : undefined,
		// Rate over the tokens actually computed, not the cached ones.
		prefillTokS: prefillS > 0 ? computed / prefillS : undefined,
		// llama.cpp exposes no time-to-first-token anywhere.
		ttftS: undefined,
		decodeElapsedS,
		requestElapsedS,
		cacheSource: cached > 0 ? 'prompt cache' : 'none',
		// The slot's own figure is whatever the last poll caught mid-flight.
		contextLen: promptTokens + completionTokens
	};
}

async function readCounters(base: string, signal: AbortSignal): Promise<Counters | null> {
	const text = await getText(`${base}/metrics`, signal);
	if (text === null) {
		return null;
	}
	const v = parsePrometheus(text);
	return {
		promptTokens: v['llamacpp:prompt_tokens_total'] ?? 0,
		promptSeconds: v['llamacpp:prompt_seconds_total'] ?? 0,
		predictedTokens: v['llamacpp:tokens_predicted_total'] ?? 0,
		predictedSeconds: v['llamacpp:tokens_predicted_seconds_total'] ?? 0
	};
}

/** llama.cpp emits bare `name value` lines with no labels. */
function parsePrometheus(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of text.split('\n')) {
		if (line.startsWith('#') || !line.trim()) {
			continue;
		}
		const sp = line.lastIndexOf(' ');
		if (sp === -1) {
			continue;
		}
		const name = line.slice(0, sp).replace(/\{.*\}$/, '');
		const value = Number(line.slice(sp + 1));
		if (!Number.isNaN(value)) {
			out[name] = value;
		}
	}
	return out;
}

async function getJson(url: string, signal: AbortSignal): Promise<any | null> {
	try {
		const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

async function getText(url: string, signal: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(url, { signal });
		return res.ok ? await res.text() : null;
	} catch {
		return null;
	}
}

function basename(p: string): string {
	return p.split('/').pop() ?? p;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
	});
}
