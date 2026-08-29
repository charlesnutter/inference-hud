/**
 * Engine registry: how each local inference server exposes telemetry, and how
 * to recognise it on a port.
 *
 * `mode` is the important axis:
 *   'stream' — server pushes per-request telemetry; observe any client, live.
 *   'poll'   — server exposes counters/state; observe any client by differencing.
 *   'proxy'  — telemetry exists only in the response body of the caller's own
 *              request, so we must sit in the request path to see it.
 */
export type TelemetryMode = 'stream' | 'poll' | 'proxy';

export interface EngineAdapter {
	readonly id: string;
	readonly displayName: string;
	readonly defaultPorts: readonly number[];
	readonly mode: TelemetryMode;
	/** Endpoint used for stream/poll modes, relative to the base URL. */
	readonly telemetryPath?: string;
	/** Why this engine can't be observed passively, if mode is 'proxy'. */
	readonly proxyReason?: string;
	/** Resolves to a version/model label if this engine is at `base`, else null. */
	probe(base: string, signal: AbortSignal): Promise<string | null>;
}

async function getJson(url: string, signal: AbortSignal): Promise<any | null> {
	try {
		const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
		if (!res.ok) {
			return null;
		}
		return await res.json();
	} catch {
		return null;
	}
}

async function getText(url: string, signal: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(url, { signal });
		if (!res.ok) {
			return null;
		}
		return await res.text();
	} catch {
		return null;
	}
}

export const ENGINES: readonly EngineAdapter[] = [
	{
		id: 'mtplx',
		displayName: 'MTPLX',
		defaultPorts: [8000],
		mode: 'stream',
		telemetryPath: '/v1/mtplx/metrics/stream',
		async probe(base, signal) {
			const m = await getJson(`${base}/v1/models`, signal);
			const first = m?.data?.[0];
			return first?.owned_by === 'mtplx' ? first.id : null;
		}
	},
	{
		id: 'omlx',
		displayName: 'oMLX',
		defaultPorts: [8000, 8080],
		mode: 'poll',
		// Server-wide, but gated: needs an admin session or API key.
		telemetryPath: '/admin/api/stats',
		async probe(base, signal) {
			const spec = await getJson(`${base}/openapi.json`, signal);
			const paths = spec?.paths ? Object.keys(spec.paths) : [];
			if (!paths.includes('/admin/api/stats') || !paths.includes('/v1/rerank')) {
				return null;
			}
			// Distinguish from MTPLX, which shares the OpenAI surface.
			return paths.some(p => p.startsWith('/v1/mtplx')) ? null : (spec.info?.version ?? 'oMLX');
		}
	},
	{
		id: 'llamacpp',
		displayName: 'llama.cpp',
		defaultPorts: [8080, 8081],
		mode: 'poll',
		// /slots is on by default (--no-slots disables); /metrics needs --metrics.
		telemetryPath: '/slots',
		async probe(base, signal) {
			const props = await getJson(`${base}/props`, signal);
			if (props && ('default_generation_settings' in props || 'model_path' in props)) {
				return props.model_path ?? props.default_generation_settings?.model ?? 'llama.cpp';
			}
			return null;
		}
	},
	{
		id: 'vllm',
		displayName: 'vLLM',
		defaultPorts: [8000],
		mode: 'poll',
		telemetryPath: '/metrics',
		async probe(base, signal) {
			const t = await getText(`${base}/metrics`, signal);
			return t?.includes('vllm:') ? 'vLLM' : null;
		}
	},
	{
		id: 'sglang',
		displayName: 'SGLang',
		defaultPorts: [30000],
		mode: 'poll',
		telemetryPath: '/metrics',
		async probe(base, signal) {
			const t = await getText(`${base}/metrics`, signal);
			return t?.includes('sglang:') ? 'SGLang' : null;
		}
	},
	{
		id: 'ollama',
		displayName: 'Ollama',
		defaultPorts: [11434],
		mode: 'proxy',
		proxyReason:
			'Ollama has no /metrics endpoint; eval_count/eval_duration are returned only ' +
			'to the caller, and the OpenAI-compatible path omits them entirely.',
		async probe(base, signal) {
			const v = await getJson(`${base}/api/version`, signal);
			return v?.version ? `Ollama ${v.version}` : null;
		}
	},
	{
		id: 'lmstudio',
		displayName: 'LM Studio',
		defaultPorts: [1234],
		mode: 'proxy',
		proxyReason: 'LM Studio reports stats.tokens_per_second per response only.',
		async probe(base, signal) {
			const m = await getJson(`${base}/api/v0/models`, signal);
			return Array.isArray(m?.data) ? 'LM Studio' : null;
		}
	},
	{
		id: 'openai-generic',
		displayName: 'OpenAI-compatible server',
		defaultPorts: [8000, 8080, 1234, 5000, 4891, 8090],
		mode: 'proxy',
		proxyReason: 'Unrecognised engine; only the OpenAI `usage` block is guaranteed.',
		async probe(base, signal) {
			const m = await getJson(`${base}/v1/models`, signal);
			return Array.isArray(m?.data) && m.data.length > 0 ? (m.data[0].id ?? 'unknown') : null;
		}
	}
];

export interface Detected {
	engine: EngineAdapter;
	baseUrl: string;
	label: string;
}

/**
 * Scan candidate ports. Specific engines are probed before the generic
 * OpenAI fallback, and the first match per port wins.
 */
export async function detect(
	extraPorts: readonly number[] = [],
	timeoutMs = 800
): Promise<Detected[]> {
	const ports = [...new Set([...ENGINES.flatMap(e => e.defaultPorts), ...extraPorts])];
	const found: Detected[] = [];

	await Promise.all(
		ports.map(async port => {
			const baseUrl = `http://127.0.0.1:${port}`;
			for (const engine of ENGINES) {
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), timeoutMs);
				try {
					const label = await engine.probe(baseUrl, ac.signal);
					if (label !== null) {
						found.push({ engine, baseUrl, label });
						return; // first (most specific) match wins for this port
					}
				} catch {
					/* unreachable or not this engine */
				} finally {
					clearTimeout(timer);
				}
			}
		})
	);

	return found.sort((a, b) => a.baseUrl.localeCompare(b.baseUrl));
}
