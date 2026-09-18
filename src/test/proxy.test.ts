import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fixture, replay, completed } from './helpers';

/**
 * Every body here was captured from a live server; see fixtures/proxy/README.md
 * for which one and when. Rates are not asserted: a replay takes microseconds,
 * so any rate it produced would describe the test machine, not the engine.
 */

// The same prompt on the same warm server, so the prompt is 36 tokens of which
// 35 came from cache on every llama.cpp capture — the number each format has
// to arrive at by its own accounting.
const PROMPT = 36;
const CACHED = 35;
const MODEL = '/Users/charlesnutter/models/gguf/qwen2.5-0.5b-instruct-q4_k_m.gguf';

for (const size of [Infinity, 1000, 7]) {
	const label = size === Infinity ? 'whole' : `${size}-byte chunks`;

	test(`chat completions, streamed (${label})`, () => {
		const s = completed(replay(fixture('proxy', 'llamacpp-chat-stream.txt'), size));
		assert.equal(s.model, MODEL);
		assert.equal(s.completionTokens, 40);
		// A chat stream carries no usage unless asked, and the proxy never asks.
		assert.equal(s.promptTokens, undefined);
		assert.equal(s.extra?.Tokens, 'counted from stream chunks (approximate)');
		assert.equal(typeof s.ttftS, 'number');
		assert.equal(s.extra?.Reasoning, undefined);
	});

	test(`chat completions, whole body (${label})`, () => {
		const s = completed(replay(fixture('proxy', 'llamacpp-chat-body.txt'), size));
		assert.equal(s.completionTokens, 16);
		assert.equal(s.promptTokens, PROMPT);
		assert.equal(s.cachedTokens, CACHED);
		assert.equal(s.cacheSource, 'prompt cache');
		// Exact counts from usage, so no approximation disclaimer.
		assert.equal(s.extra?.Tokens, undefined);
		// One piece, no interval: the rate is unmeasurable, not zero.
		assert.equal(s.decodeTokS, undefined);
	});

	test(`anthropic messages, streamed (${label})`, () => {
		const s = completed(replay(fixture('proxy', 'llamacpp-messages-stream.txt'), size));
		assert.equal(s.completionTokens, 40);
		// input_tokens was 1 and cache_read_input_tokens 35: Anthropic excludes
		// cache reads from the input count, so the prompt is the sum.
		assert.equal(s.promptTokens, PROMPT);
		assert.equal(s.cachedTokens, CACHED);
		assert.equal(s.extra?.Tokens, undefined);
	});

	test(`anthropic messages, whole body (${label})`, () => {
		const s = completed(replay(fixture('proxy', 'llamacpp-messages-body.txt'), size));
		assert.equal(s.completionTokens, 40);
		assert.equal(s.promptTokens, PROMPT);
		assert.equal(s.cachedTokens, CACHED);
		assert.equal(s.decodeTokS, undefined);
	});

	test(`responses, streamed (${label})`, () => {
		const s = completed(replay(fixture('proxy', 'llamacpp-responses-stream.txt'), size));
		assert.equal(s.model, MODEL);
		assert.equal(s.completionTokens, 40);
		// input_tokens was 36 and cached_tokens 35: a subset, as under chat
		// completions and unlike Anthropic. Adding them would report 71.
		assert.equal(s.promptTokens, PROMPT);
		assert.equal(s.cachedTokens, CACHED);
		// The one format whose stream sends usage unbidden.
		assert.equal(s.extra?.Tokens, undefined);
		assert.equal(typeof s.ttftS, 'number');
	});

	test(`responses, whole body (${label})`, () => {
		const s = completed(replay(fixture('proxy', 'llamacpp-responses-body.txt'), size));
		assert.equal(s.completionTokens, 40);
		assert.equal(s.promptTokens, PROMPT);
		assert.equal(s.cachedTokens, CACHED);
		assert.equal(s.decodeTokS, undefined);
	});

	test(`ollama chat stream: reasoning tokens are generated tokens (${label})`, () => {
		const s = completed(replay(fixture('proxy', 'ollama-chat-stream.txt'), size));
		assert.equal(s.model, 'Qwen3.8:27b-mlx');
		// Every frame had content "" and the token under `reasoning`.
		// Counting only content would have reported zero.
		assert.equal(s.completionTokens, 24);
		assert.equal(s.extra?.Reasoning, '24 of 24 tokens');
		assert.equal(s.extra?.Tokens, 'counted from stream chunks (approximate)');
	});

	test(`ollama responses stream: deltas matched by shape, not name (${label})`, () => {
		const s = completed(replay(fixture('proxy', 'ollama-responses-stream.txt'), size));
		assert.equal(s.model, 'Qwen3.8:27b-mlx');
		// `response.reasoning_summary_text.delta` — an event name that appears
		// nowhere in the adapter, counted because it carries a string delta.
		assert.equal(s.completionTokens, 24);
		assert.equal(s.extra?.Reasoning, '24 of 24 tokens');
		assert.equal(s.promptTokens, 17);
		// cached_tokens was 0, which is "none", not "0 cached".
		assert.equal(s.cachedTokens, undefined);
		assert.equal(s.extra?.Tokens, undefined);
	});
}

test('an error body reports nothing', () => {
	// Ollama's MLX runner panicked; the body is {"error": ...}. Not a
	// generation, so no prefill, no progress and no completion.
	const events = replay(fixture('proxy', 'ollama-error-body.txt'));
	assert.deepEqual(events, []);
});

test('a body that is not a completion reports nothing', () => {
	const events = replay('{"object":"list","data":[{"id":"m","object":"model"}]}');
	assert.deepEqual(events, []);
});

test('a request the client stopped says so, with the count so far', () => {
	const body = fixture('proxy', 'llamacpp-chat-stream.txt');
	const half = body.slice(0, Math.floor(body.length / 2));
	const s = completed(replay(half, 7, true));
	assert.ok(s.completionTokens! > 0 && s.completionTokens! < 40, `${s.completionTokens}`);
	assert.equal(s.extra?.Stopped, `by the client after ${s.completionTokens} tokens`);
});

test('a stop before any token reports nothing', () => {
	assert.deepEqual(replay('', Infinity, true), []);
});

test('prefill is announced once, at the first token', () => {
	const events = replay(fixture('proxy', 'llamacpp-chat-stream.txt'), 7);
	assert.equal(events.filter(e => e.kind === 'prefill').length, 1);
	assert.equal(events[0].kind, 'prefill');
});
