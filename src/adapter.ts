/**
 * The engine-neutral contract the status bar renders against.
 *
 * Adapters translate whatever their engine publishes — an SSE push stream, a
 * polled counter, a proxied response body — into this one event shape. Nothing
 * downstream of here knows which engine produced the numbers.
 */

/** Per-request totals, emitted once when a generation finishes. */
export interface CompletedStats {
	model?: string;
	promptTokens?: number;
	cachedTokens?: number;
	completionTokens?: number;
	/** Decode throughput, excluding prefill. */
	decodeTokS?: number;
	/** Throughput across the whole request, prefill included. */
	requestTokS?: number;
	prefillTokS?: number;
	ttftS?: number;
	decodeElapsedS?: number;
	requestElapsedS?: number;
	cacheSource?: string;
	contextLen?: number;
	/**
	 * Engine-specific rows for the tooltip, already formatted. Keeps things like
	 * MTPLX's speculative-decode acceptance out of the shared shape.
	 */
	extra?: Record<string, string>;
}

export type TelemetryEvent =
	/** The adapter has a working connection. */
	| { kind: 'connected' }
	/**
	 * Prompt processing. `done` is null when the engine reports no progress;
	 * `total` is null when it does not know the prompt length up front, as
	 * llama.cpp does not — it discovers the size as it chunks through.
	 */
	| { kind: 'prefill'; done: number | null; total: number | null }
	/** Token generation in flight. `decodeTokS` is null before a rate exists. */
	| { kind: 'progress'; completionTokens: number; decodeTokS: number | null }
	/** A generation finished. */
	| { kind: 'completed'; stats: CompletedStats }
	/**
	 * Something the user should know — a missing server flag, a degraded mode.
	 * Adapters surface these rather than importing vscode, which keeps them
	 * runnable (and testable) outside the extension host.
	 */
	| { kind: 'notice'; level: 'info' | 'warn'; message: string };

export type Emit = (event: TelemetryEvent) => void;

export interface TelemetryAdapter {
	readonly id: string;
	readonly displayName: string;

	/**
	 * Observe `baseUrl` until `signal` aborts, emitting normalized events.
	 *
	 * Returning or throwing both mean "this attempt is over" — the caller owns
	 * reconnection and backoff, so adapters never retry internally. Streaming
	 * adapters iterate their connection; polling adapters loop until aborted.
	 */
	run(baseUrl: string, signal: AbortSignal, emit: Emit): Promise<void>;
}
