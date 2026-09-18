import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { __test } from '../adapters/prometheus';
import { fixture } from './helpers';

const { parsePrometheus, VLLM, SGLANG } = __test;

test('vllm: exposed names, not source names, and _created is not a value', () => {
	const m = parsePrometheus(fixture('vllm-busy.prom'));
	assert.equal(m.sum(VLLM.generationTokens), 617);
	assert.equal(m.sum(VLLM.promptTokens), 78);
	assert.equal(m.sum(VLLM.running), 1);
	// Every counter has a sibling `_created` line holding a unix timestamp.
	// An exact-name lookup keeps it out; a prefix match would have added
	// 1.78e9 to the token count.
	assert.ok(m.sum('vllm:generation_tokens_created') > 1e9);
	assert.equal(m.sum('vllm:generation_tokens'), 0, 'the source name is not the exposed name');
});

test('vllm: the model comes from the label, before any request', () => {
	const m = parsePrometheus(fixture('vllm-idle.prom'));
	assert.equal(m.label(VLLM.generationTokens, VLLM.modelLabel), 'Qwen/Qwen2.5-0.5B-Instruct');
	assert.equal(m.sum(VLLM.running), 0);
	assert.equal(m.sum(VLLM.generationTokens), 700);
});

test('vllm: ttft is a histogram; only sum and count are read', () => {
	const m = parsePrometheus(fixture('vllm-busy.prom'));
	assert.equal(m.sum(VLLM.ttftCount), 2);
	assert.ok(Math.abs(m.sum(VLLM.ttftSum) - 4.6046302318573) < 1e-9);
});

test('sglang: series split by label are summed, and the gauge is read', () => {
	// Synthesized from source, not captured — see fixtures/README.md.
	const m = parsePrometheus(fixture('sglang-busy.prom'));
	assert.equal(m.sum(SGLANG.generationTokens), 187);
	assert.equal(m.sum(SGLANG.running), 1);
	assert.equal(m.sum(SGLANG.throughputGauge!), 327.4);
	assert.ok(m.sum(SGLANG.cachedTokens) >= 2198, 'cached_tokens_total is split by cache_source');
});

test('labels with commas and escapes survive', () => {
	const m = parsePrometheus(
		'x_total{model_name="a/b,c \\"q\\"",engine="0"} 5\n' + 'x_total{model_name="a/b,c \\"q\\"",engine="1"} 7\n'
	);
	assert.equal(m.sum('x_total'), 12);
	assert.equal(m.label('x_total', 'model_name'), 'a/b,c "q"');
});
