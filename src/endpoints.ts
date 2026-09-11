import { TelemetryAdapter } from './adapter';
import { mtplxAdapter } from './adapters/mtplx';
import { llamaCppAdapter } from './adapters/llamacpp';
import { vllmAdapter, sglangAdapter } from './adapters/prometheus';
import { proxyAdapter } from './adapters/proxy';
import { detect, probeOne } from './engines';

/** Engines with a working telemetry adapter, keyed by their `engines.ts` id. */
export const ADAPTERS: Record<string, TelemetryAdapter> = {
	mtplx: mtplxAdapter,
	llamacpp: llamaCppAdapter,
	vllm: vllmAdapter,
	sglang: sglangAdapter
};

/**
 * One entry of `inferenceHud.endpoints` (a bare URL) or of
 * `inferenceHud.endpointOverrides` (the object form).
 *
 * They are separate settings because the settings editor can only render a list
 * widget for arrays of strings; an array of objects degrades to an "Edit in
 * settings.json" link. Keeping the common case a plain URL list means it gets a
 * real UI, and the object form stays where it belongs, out of the way.
 *
 * `proxy` names a local port to listen on and turns the entry into a forwarder:
 * traffic sent through that port is measured on its way to `url`. It is the
 * only way to see engines that publish no server-wide telemetry, and it is
 * opt-in precisely because it sits in the request path.
 */
export type EndpointConfig =
	| string
	| { url: string; engine?: string; label?: string; proxy?: number };

export interface ResolvedEndpoint {
	url: string;
	adapter: TelemetryAdapter;
	/** Shown in the tooltip; the model id replaces it once one is known. */
	label: string;
	/** True when auto-detection found this rather than the user configuring it. */
	detected: boolean;
	/**
	 * Local port this endpoint's proxy listens on, when it has one. Clients must
	 * be pointed here rather than at `url`, so setup needs it as a real field
	 * rather than something parsed back out of a display label.
	 */
	proxyPort?: number;
}

/** An endpoint we identified but cannot read, so the user can be told why. */
export interface UnsupportedEndpoint {
	url: string;
	engineName: string;
	reason: string;
}

export interface Resolution {
	endpoints: ResolvedEndpoint[];
	unsupported: UnsupportedEndpoint[];
}

const normalize = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * The two settings that name endpoints, read as one list.
 *
 * `endpoints` holds plain URLs so the settings editor can give it a real list
 * widget; `endpointOverrides` holds the object form for pinning an engine or a
 * proxy port. Objects left in `endpoints` are still honoured rather than
 * dropped, since nothing is gained by breaking a configuration that was valid
 * before the split.
 */
export function configuredEndpoints(cfg: {
	get<T>(section: string, fallback: T): T;
}): EndpointConfig[] {
	return [
		...cfg.get<EndpointConfig[]>('endpoints', []),
		...cfg.get<EndpointConfig[]>('endpointOverrides', [])
	];
}

/**
 * Turn configuration into a concrete list to watch.
 *
 * Explicit entries always win: they are kept even if unreachable, since a
 * server the user named may simply not be running yet. Auto-detection then
 * fills in anything on localhost that isn't already covered.
 */
export async function resolveEndpoints(
	configured: readonly EndpointConfig[],
	autoDetect: boolean,
	/** Start proxies for detected engines that publish nothing. */
	autoProxy = false,
	/** First port an auto-started proxy may claim; later ones increment. */
	autoProxyPort = 8788
): Promise<Resolution> {
	const endpoints: ResolvedEndpoint[] = [];
	const unsupported: UnsupportedEndpoint[] = [];
	const seen = new Set<string>();

	for (const entry of configured) {
		const url = normalize(typeof entry === 'string' ? entry : entry.url);
		if (!url || seen.has(url)) {
			continue;
		}
		seen.add(url);

		const pinned = typeof entry === 'string' ? undefined : entry.engine;
		const label = typeof entry === 'string' ? undefined : entry.label;
		const proxyPort = typeof entry === 'string' ? undefined : entry.proxy;

		// A proxy entry wins over detection: the user is asking to carry the
		// traffic, which works whether or not the engine is recognised.
		if (proxyPort) {
			endpoints.push({
				url,
				adapter: proxyAdapter(proxyPort),
				label: label ?? `${url} (via :${proxyPort})`,
				detected: false,
				proxyPort
			});
			continue;
		}

		if (pinned) {
			const adapter = ADAPTERS[pinned];
			if (!adapter) {
				unsupported.push({
					url,
					engineName: pinned,
					reason: `no adapter for engine "${pinned}"`
				});
				continue;
			}
			endpoints.push({ url, adapter, label: label ?? adapter.displayName, detected: false });
			continue;
		}

		// Unpinned: ask the URL what it is.
		const hit = await probeOne(url);
		if (!hit) {
			// Unreachable or unrecognised. Keep it anyway so the HUD shows it
			// reconnecting rather than silently dropping what the user asked for.
			endpoints.push({
				url,
				adapter: mtplxAdapter,
				label: label ?? url,
				detected: false
			});
			continue;
		}
		const adapter = ADAPTERS[hit.engine.id];
		if (!adapter) {
			unsupported.push({ url, engineName: hit.engine.displayName, reason: describe(hit.engine.id) });
			continue;
		}
		endpoints.push({ url, adapter, label: label ?? hit.label, detected: false });
	}

	if (autoDetect) {
		// Ports already claimed by an explicit proxy entry, so an auto-started
		// one never lands on top of a proxy the user configured by hand.
		const claimed = new Set(
			configured
				.map(e => (typeof e === 'string' ? undefined : e.proxy))
				.filter((n): n is number => typeof n === 'number')
		);
		let nextPort = autoProxyPort;

		for (const hit of await detect()) {
			const url = normalize(hit.baseUrl);
			if (seen.has(url)) {
				continue;
			}
			seen.add(url);
			const adapter = ADAPTERS[hit.engine.id];
			if (adapter) {
				endpoints.push({ url, adapter, label: hit.label, detected: true });
				continue;
			}

			// No adapter. If the engine publishes nothing server-wide, the only
			// way to measure it is to carry its traffic — so offer to, rather
			// than reporting a dead end the user has to configure their way out
			// of. Engines blocked for other reasons (oMLX needs credentials)
			// are not helped by a proxy and are still listed as unsupported.
			if (autoProxy && hit.engine.mode === 'proxy') {
				while (claimed.has(nextPort)) {
					nextPort++;
				}
				claimed.add(nextPort);
				endpoints.push({
					url,
					adapter: proxyAdapter(nextPort),
					label: `${hit.label} (via :${nextPort})`,
					detected: true,
					proxyPort: nextPort
				});
				continue;
			}

			unsupported.push({
				url,
				engineName: hit.engine.displayName,
				reason: describe(hit.engine.id)
			});
		}
	}

	return { endpoints, unsupported };
}

function describe(engineId: string): string {
	switch (engineId) {
		case 'ollama':
		case 'lmstudio':
		case 'openai-generic':
			// The proxy exists now, so say how to turn it on rather than
			// reporting the engine as a dead end.
			return (
				'publishes no server-wide telemetry, so it can only be measured by ' +
				'carrying its traffic. Add a proxy port to this endpoint, e.g. ' +
				'{"url": "<this url>", "proxy": 8788}, then point your client at ' +
				'http://127.0.0.1:8788/v1'
			);
		case 'omlx':
			return 'telemetry is behind admin authentication, which is not supported yet';
		default:
			return 'no adapter yet';
	}
}
