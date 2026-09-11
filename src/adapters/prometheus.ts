import { CompletedStats, Emit, TelemetryAdapter } from '../adapter';

/**
 * vLLM and SGLang both publish server-wide Prometheus counters and differ only
 * in metric names and in how much they hand you, so one implementation covers
 * both. Unlike llama.cpp, whose counters stay frozen until a request finishes,
 * these update *during* generation — verified against vLLM 0.1.dev1 by polling
 * a 300-token run and watching `generation_tokens_total` climb 25 -> 300 at a
 * steady 40 tok/s. That is why `/metrics` alone is enough here and llama.cpp
 * needs a second endpoint.
 *
 * What differencing cannot recover, on either engine:
 *
 *   - **Per-request TTFT.** It is a Histogram, so sum/count gives a running
 *     average across every request since start and nothing about the last one.
 *     Reported as an `extra` row, never as `ttftS`, so the tooltip does not
 *     imply it describes the request just finished.
 *   - **Concurrency.** Counters are server-wide. Two requests in flight blend
 *     into one rate; the user is told rather than shown a wrong number.
 *   - **Resolution.** Capped by the poll interval, so each rate is an average
 *     over the window rather than an instantaneous reading.
 */

const POLL_MS = 500;

interface PromSpec {
	id: string;
	displayName: string;
	/** Cumulative prompt tokens processed. */
	promptTokens: string;
	/** Cumulative generated tokens. */
	generationTokens: string;
	/** Cumulative prompt tokens served from cache. */
	cachedTokens: string;
	/** Gauge: requests currently generating. Drives busy/idle. */
	running: string;
	ttftSum: string;
	ttftCount: string;
	/**
	 * Gauge publishing live throughput directly, where the engine has one.
	 * SGLang does; vLLM does not, and must have its rate differenced.
	 */
	throughputGauge?: string;
	/** Label carrying the served model name. Both engines use `model_name`. */
	modelLabel: string;
	/** Metric-name prefix, used to confirm the engine is the one we expect. */
	prefix: string;
	/**
	 * A path that answers whenever the server is up, whether or not metrics are
	 * enabled. Used to tell "the server is gone" apart from "the server is here
	 * but not reporting", which are the same failed scrape and completely
	 * different problems.
	 */
	identityPath: string;
	/** Flag that turns metrics on, where they are not on by default. */
	metricsFlag?: string;
}

const VLLM: PromSpec = {
	id: 'vllm',
	displayName: 'vLLM',
	promptTokens: 'vllm:prompt_tokens_total',
	generationTokens: 'vllm:generation_tokens_total',
	cachedTokens: 'vllm:prompt_tokens_cached_total',
	running: 'vllm:num_requests_running',
	ttftSum: 'vllm:time_to_first_token_seconds_sum',
	ttftCount: 'vllm:time_to_first_token_seconds_count',
	modelLabel: 'model_name',
	prefix: 'vllm:',
	identityPath: '/v1/models'
};

const SGLANG: PromSpec = {
	id: 'sglang',
	displayName: 'SGLang',
	promptTokens: 'sglang:prompt_tokens_total',
	generationTokens: 'sglang:generation_tokens_total',
	cachedTokens: 'sglang:cached_tokens_total',
	running: 'sglang:num_running_reqs',
	ttftSum: 'sglang:time_to_first_token_seconds_sum',
	ttftCount: 'sglang:time_to_first_token_seconds_count',
	throughputGauge: 'sglang:gen_throughput',
	modelLabel: 'model_name',
	prefix: 'sglang:',
	// SGLang mounts /metrics only under --enable-metrics, which defaults off.
	identityPath: '/model_info',
	metricsFlag: '--enable-metrics'
};

/** One scrape, reduced to the handful of numbers this adapter reasons about. */
interface Sample {
	at: number;
	promptTokens: number;
	generationTokens: number;
	cachedTokens: number;
	running: number;
	ttftSum: number;
	ttftCount: number;
	throughput?: number;
	model?: string;
}

function makeAdapter(spec: PromSpec): TelemetryAdapter {
	return {
		id: spec.id,
		displayName: spec.displayName,

		async run(baseUrl, signal, emit) {
			const base = baseUrl.replace(/\/+$/, '');

			const first = await scrape(base, spec, signal);
			if (!first) {
				// A failed scrape means one of two very different things. If the
				// server itself answers, it is running and simply not reporting,
				// which is a flag away from working — and saying so is the whole
				// reason detection fingerprints an identity path rather than
				// /metrics. Retrying silently would leave the user watching an
				// endpoint that can never connect, with the fix unmentioned.
				if (await reachable(`${base}${spec.identityPath}`, signal)) {
					emit({
						kind: 'notice',
						level: 'warn',
						message: spec.metricsFlag
							? `${spec.displayName} is running but serves no /metrics. Restart it ` +
								`with ${spec.metricsFlag} for any telemetry at all.`
							: `${spec.displayName} is running but serves no /metrics, so it ` +
								'cannot be measured.'
					});
				}
				throw new Error(`no ${spec.displayName} metrics at ${base}`);
			}
			emit({ kind: 'connected' });

			let model = first.model;
			/** The scrape taken the last time the server was idle. */
			let baseline = first;
			/** The previous scrape, for rate differencing. */
			let prev = first;
			let busySince: number | undefined;
			/** When the first generated token of this request was observed. */
			let decodeSince: number | undefined;
			let warnedConcurrent = false;

			while (!signal.aborted) {
				await sleep(POLL_MS, signal);
				if (signal.aborted) {
					return;
				}

				const now = await scrape(base, spec, signal);
				if (!now) {
					// A failed scrape ends the attempt; the extension reconnects.
					throw new Error(`${spec.displayName} stopped answering at ${base}`);
				}
				model = now.model ?? model;

				// A restarted server resets every counter. Treat a backwards
				// delta as a new baseline rather than emitting a negative rate.
				if (now.generationTokens < prev.generationTokens || now.promptTokens < prev.promptTokens) {
					baseline = now;
					prev = now;
					busySince = undefined;
					decodeSince = undefined;
					continue;
				}

				if (now.running > 0) {
					if (busySince === undefined) {
						busySince = now.at;
						decodeSince = undefined;
						warnedConcurrent = false;
					}
					if (now.running > 1 && !warnedConcurrent) {
						warnedConcurrent = true;
						emit({
							kind: 'notice',
							level: 'info',
							message:
								`${now.running} requests are running at once; ${spec.displayName} ` +
								'counters are server-wide, so the rate shown covers all of them.'
						});
					}

					const generated = now.generationTokens - baseline.generationTokens;
					if (generated <= 0) {
						// Prompt is being processed and nothing is generated yet.
						// Prefill is a single scheduled step on both engines, so
						// the total is not known progressively — hence `null`.
						emit({
							kind: 'prefill',
							done: now.promptTokens - baseline.promptTokens || null,
							total: null
						});
					} else {
						if (decodeSince === undefined) {
							decodeSince = now.at;
						}
						emit({
							kind: 'progress',
							completionTokens: generated,
							decodeTokS: rateBetween(spec, prev, now)
						});
					}
				} else if (busySince !== undefined) {
					emit({
						kind: 'completed',
						stats: toStats(spec, model, baseline, now, busySince, decodeSince)
					});
					baseline = now;
					busySince = undefined;
					decodeSince = undefined;
				} else {
					// Idle and staying idle: keep the baseline current so the
					// next request is measured from the right starting point.
					baseline = now;
				}

				prev = now;
			}
		}
	};
}

/**
 * Live decode rate. SGLang publishes one outright; vLLM must have it
 * differenced across the poll window.
 */
function rateBetween(spec: PromSpec, prev: Sample, now: Sample): number | null {
	if (spec.throughputGauge && now.throughput !== undefined && now.throughput > 0) {
		return now.throughput;
	}
	const dt = (now.at - prev.at) / 1000;
	const dTokens = now.generationTokens - prev.generationTokens;
	if (dt <= 0 || dTokens < 0) {
		return null;
	}
	return dTokens / dt;
}

function toStats(
	spec: PromSpec,
	model: string | undefined,
	before: Sample,
	after: Sample,
	busySince: number,
	decodeSince: number | undefined
): CompletedStats {
	const completionTokens = after.generationTokens - before.generationTokens;
	const promptTokens = after.promptTokens - before.promptTokens;
	const cachedTokens = after.cachedTokens - before.cachedTokens;
	// Wall-clock, quantized to the poll interval — the engines expose no
	// per-request timing, so this is the only elapsed figure available.
	const requestElapsedS = (after.at - busySince) / 1000;
	const decodeElapsedS = decodeSince !== undefined ? (after.at - decodeSince) / 1000 : undefined;

	const extra: Record<string, string> = {};
	// TTFT is a Histogram: sum/count is an average over every request since
	// the server started, not this request's value. Labelled so, and kept out
	// of `ttftS` which the tooltip renders as a per-request figure.
	const dCount = after.ttftCount - before.ttftCount;
	if (dCount > 0) {
		extra['TTFT (avg)'] = `${((after.ttftSum - before.ttftSum) / dCount).toFixed(3)}s`;
	} else if (after.ttftCount > 0) {
		extra['TTFT (avg, all time)'] = `${(after.ttftSum / after.ttftCount).toFixed(3)}s`;
	}

	return {
		model,
		promptTokens: promptTokens > 0 ? promptTokens : undefined,
		cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
		completionTokens,
		decodeTokS:
			decodeElapsedS && decodeElapsedS > 0 ? completionTokens / decodeElapsedS : undefined,
		requestTokS: requestElapsedS > 0 ? completionTokens / requestElapsedS : undefined,
		// Prefill is one scheduled step and the engines publish no prefill
		// duration, so any rate here would be an artefact of the poll interval.
		prefillTokS: undefined,
		// Per-request TTFT is not recoverable from a Histogram. See `extra`.
		ttftS: undefined,
		decodeElapsedS,
		requestElapsedS,
		cacheSource: cachedTokens > 0 ? 'prefix cache' : 'none',
		contextLen: promptTokens + completionTokens,
		extra
	};
}

/** Does anything answer here? Used only to explain a failed scrape. */
async function reachable(url: string, signal: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(url, { signal, headers: { connection: 'close' } });
		return res.ok;
	} catch {
		return false;
	}
}

async function scrape(
	base: string,
	spec: PromSpec,
	signal: AbortSignal
): Promise<Sample | null> {
	let text: string;
	try {
		// `connection: close` is not politeness — it is required for the poll
		// to keep time. Node's fetch pools keep-alive sockets, and once polls
		// are spaced apart the pool races the server closing its idle
		// connection: measured against vLLM, a scrape that takes 2ms
		// back-to-back degrades to 200ms-3.5s at a 300-1000ms interval, which
		// is exactly the range a HUD polls at. A fresh connection each time
		// costs a localhost handshake and holds steady at 7-10ms.
		const res = await fetch(`${base}/metrics`, { signal, headers: { connection: 'close' } });
		if (!res.ok) {
			return null;
		}
		text = await res.text();
	} catch {
		return null;
	}
	if (!text.includes(spec.prefix)) {
		return null;
	}

	const m = parsePrometheus(text);
	return {
		at: Date.now(),
		promptTokens: m.sum(spec.promptTokens),
		generationTokens: m.sum(spec.generationTokens),
		cachedTokens: m.sum(spec.cachedTokens),
		running: m.sum(spec.running),
		ttftSum: m.sum(spec.ttftSum),
		ttftCount: m.sum(spec.ttftCount),
		throughput: spec.throughputGauge ? m.sum(spec.throughputGauge) : undefined,
		model: m.label(spec.generationTokens, spec.modelLabel)
	};
}

interface Parsed {
	/**
	 * Total across every label set carrying this name. Data-parallel engines
	 * report one series per engine rank, and SGLang splits cached tokens by
	 * `cache_source`, so the useful figure is always the sum.
	 */
	sum(name: string): number;
	label(name: string, label: string): string | undefined;
}

/**
 * Both engines emit labelled series:
 *
 *   vllm:prompt_tokens_total{engine="0",model_name="Qwen/Qwen2.5-0.5B"} 39.0
 *
 * Note the exposed name is not the name in either engine's source — the
 * Prometheus client appends `_total` to counters. Each counter also gets a
 * `_created` line holding a unix timestamp, which must not be read as a value;
 * looking up exact names rather than prefixes keeps those out.
 */
function parsePrometheus(text: string): Parsed {
	const values = new Map<string, number>();
	const labels = new Map<string, Record<string, string>>();

	for (const line of text.split('\n')) {
		if (!line || line.startsWith('#')) {
			continue;
		}
		const sp = line.lastIndexOf(' ');
		if (sp === -1) {
			continue;
		}
		const value = Number(line.slice(sp + 1));
		if (Number.isNaN(value)) {
			continue;
		}
		const head = line.slice(0, sp);
		const brace = head.indexOf('{');
		const name = brace === -1 ? head : head.slice(0, brace);

		values.set(name, (values.get(name) ?? 0) + value);
		if (brace !== -1 && !labels.has(name)) {
			labels.set(name, parseLabels(head.slice(brace + 1, head.lastIndexOf('}'))));
		}
	}

	return {
		sum: name => values.get(name) ?? 0,
		label: (name, label) => labels.get(name)?.[label]
	};
}

function parseLabels(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	// Values may contain commas (model paths, cache sources), so split on the
	// quote-delimited form rather than on commas.
	const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(body)) !== null) {
		out[match[1]] = match[2].replace(/\\(.)/g, '$1');
	}
	return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
	});
}

export const vllmAdapter = makeAdapter(VLLM);
export const sglangAdapter = makeAdapter(SGLANG);

/** Exported for tests, which replay captured `/metrics` text from `fixtures/`. */
export const __test = { parsePrometheus, VLLM, SGLANG };
