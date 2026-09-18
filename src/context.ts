/**
 * How large a prompt the server will actually accept, asked of the server.
 *
 * The chat model entry needs `maxInputTokens`, and it used to be a constant:
 * 28000, for every engine and model. A 0.5B on llama.cpp started with -c 8192
 * then received prompts three times its window, and the failure was silent —
 * truncation or an error inside the engine, with nothing in the editor to say
 * the number was wrong. This is the same class of "guessable wrongly" the setup
 * command exists to remove, and every engine here can be asked.
 */

async function getJson(url: string, init?: RequestInit): Promise<any> {
	try {
		const res = await fetch(url, {
			...init,
			headers: { accept: 'application/json', connection: 'close', ...init?.headers },
			signal: AbortSignal.timeout(3000)
		});
		return res.ok ? await res.json() : undefined;
	} catch {
		return undefined;
	}
}

const num = (v: unknown): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/**
 * The generic OpenAI listing. The field is not standardised: vLLM says
 * `max_model_len`, MTPLX sends that and `context_length` and
 * `max_context_length` all three, LM Studio uses the last on its own endpoint.
 */
async function fromModels(base: string, modelId: string): Promise<number | undefined> {
	const m = await getJson(`${base}/v1/models`);
	const hit = m?.data?.find((x: any) => x?.id === modelId) ?? m?.data?.[0];
	return num(hit?.max_model_len) ?? num(hit?.context_length) ?? num(hit?.max_context_length);
}

/** The context window `modelId` runs with at `base`, or undefined if unsaid. */
export async function contextLength(
	engineId: string,
	base: string,
	modelId: string
): Promise<number | undefined> {
	switch (engineId) {
		case 'llamacpp': {
			// Per slot, which is the figure a single request sees.
			const props = await getJson(`${base}/props`);
			return num(props?.default_generation_settings?.n_ctx);
		}
		case 'ollama': {
			// /api/ps reports the window a *loaded* model is running with.
			// /api/show reports the model's trained maximum, which is what
			// Ollama uses only if nothing lowered num_ctx — so it is the
			// fallback, for a model not loaded yet, not the first answer.
			const ps = await getJson(`${base}/api/ps`);
			const loaded = ps?.models?.find((m: any) => m?.name === modelId || m?.model === modelId);
			const running = num(loaded?.context_length);
			if (running) {
				return running;
			}
			const show = await getJson(`${base}/api/show`, {
				method: 'POST',
				body: JSON.stringify({ model: modelId }),
				headers: { 'content-type': 'application/json' }
			});
			const info = show?.model_info ?? {};
			const key = Object.keys(info).find(k => k.endsWith('.context_length'));
			return key ? num(info[key]) : undefined;
		}
		case 'lmstudio': {
			const m = await getJson(`${base}/api/v0/models`);
			const hit = m?.data?.find((x: any) => x?.id === modelId);
			return num(hit?.max_context_length) ?? fromModels(base, modelId);
		}
		default:
			return fromModels(base, modelId);
	}
}

/** What was reached for when the server would not say. Conservative on purpose. */
export const FALLBACK_CONTEXT = 8192;

/**
 * Split a context window into the two limits the chat entry wants. Output is
 * capped at 4096 or a quarter of the window, whichever is smaller; the rest is
 * input. Too high an input limit fails inside the engine where nothing reports
 * it; too low merely trims history where the user can see it - so an unknown
 * window is treated as small.
 */
export function budget(ctx: number | undefined): {
	maxInputTokens: number;
	maxOutputTokens: number;
	known: boolean;
} {
	const known = ctx !== undefined;
	const window = ctx ?? FALLBACK_CONTEXT;
	const maxOutputTokens = Math.min(4096, Math.floor(window / 4));
	return { maxInputTokens: window - maxOutputTokens, maxOutputTokens, known };
}
