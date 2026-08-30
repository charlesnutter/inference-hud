import { readSse } from '../sse';
import { CompletedStats, Emit, TelemetryAdapter } from '../adapter';

/** `snapshot` frames are ~250KB of server config we never read. */
const SKIP = new Set(['snapshot']);

interface PrefillFrame {
	/** `started` | `chunk` | `completed`; the last carries no count. */
	phase: string;
	tokens_done: number | null;
	tokens_total: number;
}

interface ProgressFrame {
	progress: {
		completion_tokens: number;
		decode_tok_s: number | null;
	};
}

interface CompletedFrame {
	envelope: {
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
	};
}

/**
 * MTPLX publishes per-request telemetry server-wide over SSE, so this observes
 * every client's traffic without sitting in the request path.
 */
export const mtplxAdapter: TelemetryAdapter = {
	id: 'mtplx',
	displayName: 'MTPLX',

	async run(baseUrl, signal, emit) {
		const url = `${baseUrl.replace(/\/+$/, '')}/v1/mtplx/metrics/stream`;
		let announced = false;

		for await (const frame of readSse(url, signal, SKIP)) {
			if (!announced) {
				emit({ kind: 'connected' });
				announced = true;
			}
			// A skipped frame still proves the connection is alive.
			if (frame.data === '') {
				continue;
			}
			handle(frame.event, frame.data, emit);
		}
	}
};

function handle(event: string, data: string, emit: Emit): void {
	switch (event) {
		case 'prefill': {
			const f = JSON.parse(data) as PrefillFrame;
			// `completed` has no count and is immediately followed by decode.
			if (f.phase !== 'completed') {
				emit({ kind: 'prefill', done: f.tokens_done ?? 0, total: f.tokens_total });
			}
			break;
		}
		case 'progress': {
			const p = (JSON.parse(data) as ProgressFrame).progress;
			emit({
				kind: 'progress',
				completionTokens: p.completion_tokens,
				decodeTokS: p.decode_tok_s
			});
			break;
		}
		case 'completed': {
			emit({ kind: 'completed', stats: toStats((JSON.parse(data) as CompletedFrame).envelope) });
			break;
		}
	}
}

function toStats(e: CompletedFrame['envelope']): CompletedStats {
	const accepted = (e.accepted_by_depth ?? []).reduce((a, b) => a + b, 0);
	const drafted = (e.drafted_by_depth ?? []).reduce((a, b) => a + b, 0);
	const extra: Record<string, string> = {};
	if (drafted > 0) {
		extra['MTP accept'] = `${((accepted / drafted) * 100).toFixed(1)}% (${accepted}/${drafted})`;
	}

	return {
		model: e.request_model,
		promptTokens: e.prompt_tokens,
		cachedTokens: e.cached_tokens,
		completionTokens: e.completion_tokens,
		decodeTokS: e.decode_tok_s,
		requestTokS: e.request_tok_s,
		prefillTokS: e.prefill_tok_s,
		ttftS: e.ttft_s,
		decodeElapsedS: e.decode_elapsed_s,
		requestElapsedS: e.request_elapsed_s,
		cacheSource: e.cache_source,
		contextLen: e.context_len,
		extra: Object.keys(extra).length > 0 ? extra : undefined
	};
}
