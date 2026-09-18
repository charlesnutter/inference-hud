/**
 * Formatting the status bar and tooltip share. Pure functions with no VS Code
 * dependency, so they can be tested outside the extension host.
 */

/**
 * A measurement with its unit, where a missing value renders as a bare dash.
 * Appending the unit unconditionally produces `—s` and `— tok/s`, which read
 * as a malformed number rather than as "this engine does not report it" —
 * a distinction that matters here, since several fields are genuinely absent
 * on some engines: llama.cpp publishes no time-to-first-token at all.
 */
export const unit = (n: number | undefined | null, suffix: string, digits = 1) =>
	typeof n === 'number' && isFinite(n) ? `${n.toFixed(digits)}${suffix}` : '—';

/**
 * A count with its noun, where a missing count is a dash — not `0 tokens`,
 * which claims a measurement that was never made. The proxy cannot know the
 * prompt length of a streamed chat completion; that is different from knowing
 * it was zero.
 */
export const count = (n: number | undefined | null, suffix: string) =>
	typeof n === 'number' && isFinite(n) ? `${n}${suffix}` : '—';

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
export function shortModel(name: string): string {
	let s = name.split('/').pop() ?? name;
	s = s.replace(/\.(gguf|safetensors|bin|pt)$/i, '');
	s = s.replace(/-(q\d+[a-z0-9_]*|f16|bf16|fp16|fp8|int[48])$/i, '');
	s = s.replace(/-(instruct|chat|it)$/i, '');
	return s.length > MODEL_BUDGET ? `${s.slice(0, MODEL_BUDGET - 1)}…` : s;
}
