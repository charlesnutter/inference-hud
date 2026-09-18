import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { budget, contextLength, FALLBACK_CONTEXT } from '../context';
import { fixture, serve } from './helpers';

test('llama.cpp: the per-slot n_ctx from /props', async () => {
	const s = await serve([{ '/props': fixture('llamacpp', 'props.json') }], 99);
	try {
		assert.equal(await contextLength('llamacpp', s.url, 'anything'), 8192);
	} finally {
		s.close();
	}
});

test('ollama: the running window from /api/ps, the trained one from /api/show if not loaded', async () => {
	const loaded = await serve([{ '/api/ps': fixture('setup', 'ollama-ps.json') }], 99);
	const notLoaded = await serve(
		[{ '/api/ps': '{"models":[]}', '/api/show': fixture('setup', 'ollama-show.json') }],
		99
	);
	try {
		assert.equal(await contextLength('ollama', loaded.url, 'Qwen3.8:27b-mlx'), 262144);
		assert.equal(await contextLength('ollama', notLoaded.url, 'Qwen3.8:27b-mlx'), 262144);
		assert.equal(await contextLength('ollama', loaded.url, 'some-other-model'), undefined);
	} finally {
		loaded.close();
		notLoaded.close();
	}
});

test('an OpenAI listing: whichever of the three field names the engine uses', async () => {
	const s = await serve([{ '/v1/models': fixture('setup', 'mtplx-models.json') }], 99);
	const vllm = await serve([{ '/v1/models': '{"data":[{"id":"m","max_model_len":32768}]}' }], 99);
	const bare = await serve([{ '/v1/models': '{"data":[{"id":"m"}]}' }], 99);
	try {
		assert.equal(await contextLength('mtplx', s.url, 'mtplx-qwen38-27b-optimized-speed'), 262144);
		assert.equal(await contextLength('vllm', vllm.url, 'm'), 32768);
		assert.equal(await contextLength('openai-generic', bare.url, 'm'), undefined);
	} finally {
		s.close();
		vllm.close();
		bare.close();
	}
});

test('a server that is gone or slow answers undefined, not an exception', async () => {
	assert.equal(await contextLength('llamacpp', 'http://127.0.0.1:1', 'x'), undefined);
});

test('budget: output capped, the rest is input, unknown treated as small', () => {
	assert.deepEqual(budget(8192), { maxInputTokens: 6144, maxOutputTokens: 2048, known: true });
	assert.deepEqual(budget(262144), { maxInputTokens: 258048, maxOutputTokens: 4096, known: true });
	assert.deepEqual(budget(4096), { maxInputTokens: 3072, maxOutputTokens: 1024, known: true });
	assert.deepEqual(budget(undefined), {
		maxInputTokens: FALLBACK_CONTEXT - 2048,
		maxOutputTokens: 2048,
		known: false
	});
});
