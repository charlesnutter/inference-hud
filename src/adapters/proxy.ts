import * as http from 'http';
import { CompletedStats, Emit, TelemetryAdapter } from '../adapter';

/**
 * Telemetry for engines that publish none.
 *
 * Ollama, LM Studio and every unrecognised OpenAI-compatible server return
 * their numbers only to whoever made the request. Watching the server is
 * therefore impossible; the only way to see the traffic is to carry it. This
 * adapter listens on a local port, forwards to the real engine, and reads the
 * stream on its way past.
 *
 * It sits in the critical path, which no other adapter does, so the rules here
 * are stricter than elsewhere:
 *
 *   - **Bytes are forwarded untouched and immediately.** Request and response
 *     bodies are piped; telemetry is parsed from a copy of the chunks. Nothing
 *     is buffered, rewritten, or delayed, so a failure to parse can never
 *     change what the client receives.
 *   - **Requests are never modified.** The obvious way to get exact token
 *     counts is to inject `stream_options: {include_usage: true}`, since the
 *     OpenAI spec omits `usage` from streams unless asked. That would mean
 *     editing a request the editor composed, and a malformed edit breaks the
 *     agent loop. Counting `delta.content` chunks instead is approximate, and
 *     the approximation is disclosed rather than hidden.
 *   - **Parse errors are swallowed.** A telemetry bug must not surface as a
 *     failed completion.
 *
 * What it buys, beyond covering engines nothing else can reach: the numbers are
 * live and per-request, because the tokens are physically passing through.
 * A polling adapter can only sample.
 */

/** Chunks arriving this far apart end one request and begin another. */
const IDLE_GAP_MS = 250;

/**
 * A rate needs a span to be a rate. The first token divided by the millisecond
 * since it arrived reads as a thousand tokens a second, which flashes in the
 * status bar before correcting itself — so nothing is reported until there is
 * enough of an interval for the number to mean something.
 */
const MIN_RATE_TOKENS = 2;
const MIN_RATE_MS = 250;

function rateOf(tokens: number, sinceMs: number): number | null {
	if (tokens < MIN_RATE_TOKENS || sinceMs < MIN_RATE_MS) {
		return null;
	}
	return tokens / (sinceMs / 1000);
}

export function proxyAdapter(listenPort: number): TelemetryAdapter {
	return {
		id: 'proxy',
		displayName: 'proxy',

		run(upstreamUrl, signal, emit) {
			return new Promise<void>((resolve, reject) => {
				const upstream = new URL(upstreamUrl);
				let settled = false;
				const finish = (err?: Error) => {
					if (settled) {
						return;
					}
					settled = true;
					server.close();
					err ? reject(err) : resolve();
				};

				const server = http.createServer((req, res) => {
					handle(req, res, upstream, emit);
				});

				server.on('error', err => {
					// Port already taken is the common case and needs to be
					// legible, not a stack trace about EADDRINUSE.
					const e = err as NodeJS.ErrnoException;
					finish(
						new Error(
							e.code === 'EADDRINUSE'
								? `proxy port ${listenPort} is already in use`
								: `proxy on ${listenPort}: ${e.message}`
						)
					);
				});

				server.listen(listenPort, '127.0.0.1', () => {
					emit({ kind: 'connected' });
					// This has to be seen, not logged. Traffic sent to the engine
					// directly still works and is simply invisible, so a user who
					// misses this concludes the extension is broken.
					emit({
						kind: 'notice',
						level: 'info',
						message:
							`Measuring ${upstreamUrl} through a proxy. Point your client's base ` +
							`URL at http://127.0.0.1:${listenPort}/v1 — traffic sent straight to ` +
							'the engine still works, but cannot be measured.',
						copyable: `http://127.0.0.1:${listenPort}/v1`
					});
				});

				signal.addEventListener('abort', () => finish(), { once: true });
			});
		}
	};
}

function handle(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	upstream: URL,
	emit: Emit
): void {
	// `/v1/messages` is the Anthropic Messages API, which VS Code's chat can be
	// pointed at directly — its custom endpoints take an apiType of
	// `chatCompletions`, `responses` or `messages`. Omitting it here meant that
	// traffic was forwarded perfectly and measured not at all.
	const isCompletion = /\/(chat\/)?completions$|\/api\/(chat|generate)$|\/v1\/messages$/.test(
		req.url ?? ''
	);
	// Started here, when the request arrives, rather than when the response
	// begins — otherwise the clock starts at the first byte and time to first
	// token measures as zero. The interval between these two points is the
	// whole quantity a proxy exists to observe.
	const watch = isCompletion ? new StreamWatcher(emit) : undefined;

	const proxied = http.request(
		{
			protocol: upstream.protocol,
			hostname: upstream.hostname,
			port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
			path: req.url,
			method: req.method,
			headers: { ...req.headers, host: upstream.host }
		},
		upstreamRes => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);

			if (!watch) {
				upstreamRes.pipe(res);
				return;
			}

			upstreamRes.on('data', (chunk: Buffer) => {
				// Forward first, always. Measurement must never gate delivery.
				res.write(chunk);
				try {
					watch.consume(chunk);
				} catch {
					/* a telemetry bug must not break the response */
				}
			});
			upstreamRes.on('end', () => {
				res.end();
				try {
					watch.finish();
				} catch {
					/* as above */
				}
			});
			upstreamRes.on('error', () => res.end());
		}
	);

	proxied.on('error', err => {
		// The upstream is down or refused. Answer rather than hang, so the
		// client sees a normal failure instead of a stalled request.
		if (!res.headersSent) {
			res.writeHead(502, { 'content-type': 'application/json' });
		}
		res.end(JSON.stringify({ error: { message: `upstream unreachable: ${err.message}` } }));
	});

	req.pipe(proxied);
}

/**
 * Reads an OpenAI-compatible response as it streams past.
 *
 * Handles both shapes without being told which is coming: SSE `data:` frames
 * for a streamed completion, and a single JSON body for a non-streamed one.
 * Ollama's native endpoints emit newline-delimited JSON, which falls out of the
 * same line-by-line handling.
 */
class StreamWatcher {
	private buffer = '';
	private started = 0;
	private firstToken = 0;
	private tokens = 0;
	/**
	 * Of those tokens, how many were the model thinking rather than answering.
	 * Only meaningful while streaming: a whole-body response carries reasoning
	 * as a single string, which counts as one chunk and would misreport the
	 * split as "1 of n".
	 */
	private reasoningTokens = 0;
	/** True when the response arrived in one piece rather than as a stream. */
	private wholeBody = false;
	/** Prompt tokens the upstream said came from cache rather than compute. */
	private cachedTokens?: number;
	private lastEmit = 0;
	/** Exact counts, when the upstream volunteers them. */
	private usage?: { prompt?: number; completion?: number };
	private model?: string;
	private done = false;

	constructor(private readonly emit: Emit) {
		this.started = Date.now();
	}

	consume(chunk: Buffer): void {
		this.buffer += chunk.toString('utf8');
		const lines = this.buffer.split('\n');
		// Keep the trailing fragment; it may be half a frame.
		this.buffer = lines.pop() ?? '';

		for (const raw of lines) {
			const line = raw.trim();
			if (!line || line === 'data: [DONE]') {
				continue;
			}
			const json = line.startsWith('data:') ? line.slice(5).trim() : line;
			if (!json.startsWith('{')) {
				continue;
			}

			let obj: any;
			try {
				obj = JSON.parse(json);
			} catch {
				continue;
			}
			this.absorb(obj);
		}
	}

	private absorb(obj: any): void {
		// The Anthropic Messages stream is a different shape: typed events
		// rather than choice deltas, with the model and prompt size arriving in
		// `message_start` and the output count only at `message_delta`.
		// Note `content_block_*` as well as `message_*`: the text deltas live
		// under the former, so matching only the latter silently collects the
		// token counts while measuring no throughput at all.
		if (
			typeof obj.type === 'string' &&
			(obj.type.startsWith('message_') || obj.type.startsWith('content_block'))
		) {
			this.absorbAnthropic(obj);
			return;
		}
		// A whole, non-streamed Anthropic reply.
		if (obj.type === 'message' && Array.isArray(obj.content)) {
			this.absorbAnthropic({ type: 'message_start', message: obj });
			this.wholeBody = true;
			return;
		}

		this.model = obj.model ?? this.model;

		if (obj.usage) {
			this.usage = {
				prompt: obj.usage.prompt_tokens ?? obj.usage.input_tokens,
				completion: obj.usage.completion_tokens ?? obj.usage.output_tokens
			};
		}
		// Ollama's native shape reports its own counts and nanosecond timings.
		if (typeof obj.eval_count === 'number') {
			this.usage = { prompt: obj.prompt_eval_count, completion: obj.eval_count };
		}

		const choice = obj.choices?.[0];
		const d = choice?.delta ?? choice?.message ?? obj.message ?? {};

		// Reasoning tokens are generated tokens. They cost the same time and
		// the same throughput, and a thinking model can spend an entire
		// response in them — a 27B via Ollama emitted sixty consecutive frames
		// with `content: ""` and every token in `reasoning`. Counting only
		// `content` would report 0 tok/s for the whole request.
		//
		// The field name is not standardised: `reasoning` (Ollama),
		// `reasoning_content` (DeepSeek, and vLLM's parser), `thinking`.
		const think: string | undefined =
			d.reasoning ?? d.reasoning_content ?? d.thinking ?? obj.thinking;
		const said: string | undefined =
			d.content ??
			// Ollama's native /api/generate puts it here.
			obj.response;

		const delta = typeof think === 'string' && think !== '' ? think : said;

		if (typeof delta !== 'string' || delta === '') {
			return;
		}

		if (this.firstToken === 0) {
			this.firstToken = Date.now();
			this.emit({ kind: 'prefill', done: null, total: null });
		}

		// A whole-body response is one chunk carrying everything, so counting
		// chunks would report 1. Fall back to the usage block for those.
		const streaming =
			choice?.delta !== undefined || obj.message !== undefined || obj.response !== undefined;
		if (!streaming) {
			// A whole-body response carries everything in one piece, so there
			// are no chunks to count and no interval to measure a rate over.
			// Its exact counts come from the usage block instead.
			this.wholeBody = true;
			return;
		}
		this.tokens += 1;
		if (typeof think === 'string' && think !== '') {
			this.reasoningTokens++;
		}

		const now = Date.now();
		if (now - this.lastEmit > 100 && this.tokens > 0) {
			this.lastEmit = now;
			this.emit({
				kind: 'progress',
				completionTokens: this.tokens,
				decodeTokS: rateOf(this.tokens, now - this.firstToken)
			});
		}
	}

	/**
	 * Anthropic's streaming events, which carry the same facts in other places:
	 * `message_start` has the model and input tokens, `content_block_delta`
	 * carries the text (or the thinking, under extended thinking), and the
	 * output count lands once at `message_delta`.
	 */
	private absorbAnthropic(obj: any): void {
		if (obj.type === 'message_start') {
			const m = obj.message ?? {};
			this.model = m.model ?? this.model;
			if (m.usage) {
				// Anthropic's `input_tokens` counts only what was *not* served
				// from cache, so on a warm prefix it reads as a handful of
				// tokens for a prompt of thousands. The prompt is the sum, the
				// same accounting llama.cpp's slots needed.
				const cached =
					(m.usage.cache_read_input_tokens ?? 0) +
					(m.usage.cache_creation_input_tokens ?? 0);
				this.cachedTokens = cached || undefined;
				this.usage = {
					prompt: (m.usage.input_tokens ?? 0) + cached || undefined,
					completion: m.usage.output_tokens || undefined
				};
			}
			return;
		}
		if (obj.type === 'message_delta') {
			// The authoritative output count, and the only one Anthropic sends.
			if (obj.usage?.output_tokens) {
				this.usage = { prompt: this.usage?.prompt, completion: obj.usage.output_tokens };
			}
			return;
		}
		if (obj.type !== 'content_block_delta') {
			return;
		}

		const d = obj.delta ?? {};
		const think: string | undefined = d.thinking;
		const said: string | undefined = d.text ?? d.partial_json;
		const delta = typeof think === 'string' && think !== '' ? think : said;
		if (typeof delta !== 'string' || delta === '') {
			return;
		}

		if (this.firstToken === 0) {
			this.firstToken = Date.now();
			this.emit({ kind: 'prefill', done: null, total: null });
		}
		this.tokens += 1;
		if (typeof think === 'string' && think !== '') {
			this.reasoningTokens++;
		}

		const now = Date.now();
		if (now - this.lastEmit > 100) {
			this.lastEmit = now;
			this.emit({
				kind: 'progress',
				completionTokens: this.tokens,
				decodeTokS: rateOf(this.tokens, now - this.firstToken)
			});
		}
	}

	finish(): void {
		if (this.done) {
			return;
		}
		this.done = true;

		// A whole-body response is one JSON object with no trailing newline, so
		// `consume` holds all of it back as an incomplete line. Without this
		// flush nothing is ever parsed and the request reports nothing at all —
		// which only shows up on engines whose bodies happen not to end in a
		// newline, making it the kind of bug that looks like it works.
		const tail = this.buffer.trim();
		this.buffer = '';
		if (tail.startsWith('{')) {
			try {
				this.absorb(JSON.parse(tail));
			} catch {
				/* not a complete object; nothing to salvage */
			}
		}
		const end = Date.now();
		if (this.firstToken === 0 && !this.usage) {
			return; // Not a generation, or it failed. Nothing to report.
		}

		const completion = this.usage?.completion ?? this.tokens;
		// Decode duration needs a first token and a last one to sit between.
		// A whole-body response has no such interval, so the rate is genuinely
		// unmeasurable rather than zero.
		const decodeElapsedS =
			this.firstToken && !this.wholeBody ? (end - this.firstToken) / 1000 : undefined;
		const requestElapsedS = (end - this.started) / 1000;

		const stats: CompletedStats = {
			model: this.model,
			promptTokens: this.usage?.prompt,
			cachedTokens: this.cachedTokens,
			cacheSource: this.cachedTokens ? 'prompt cache' : undefined,
			completionTokens: completion,
			decodeTokS: decodeElapsedS && decodeElapsedS > 0 ? completion / decodeElapsedS : undefined,
			requestTokS: requestElapsedS > 0 ? completion / requestElapsedS : undefined,
			// Time to first byte of content is time to first token, measured
			// at the socket. This is the one figure a proxy gets for free and
			// gets exactly, on any engine, including those reporting nothing.
			ttftS: this.firstToken ? (this.firstToken - this.started) / 1000 : undefined,
			decodeElapsedS,
			requestElapsedS,
			extra: {}
		};

		if (!this.usage?.completion) {
			// Say so rather than implying a precision that isn't there: one
			// streamed chunk is usually one token, but nothing guarantees it.
			stats.extra!['Tokens'] = 'counted from stream chunks (approximate)';
		}
		if (this.reasoningTokens > 0 && !this.wholeBody) {
			// Worth surfacing on its own: a thinking model can spend most of a
			// request here, and the split explains an answer that took far
			// longer than its visible length suggests.
			stats.extra!['Reasoning'] = `${this.reasoningTokens} of ${completion} tokens`;
		}
		this.emit({ kind: 'completed', stats });
	}
}

export { IDLE_GAP_MS };
