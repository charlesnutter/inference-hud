import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { count, shortModel, unit } from '../format';

test('shortModel drops affixes that carry no identity', () => {
	assert.equal(shortModel('Qwen/Qwen2.5-0.5B-Instruct'), 'Qwen2.5-0.5B');
	assert.equal(shortModel('qwen2.5-0.5b-instruct-q4_k_m.gguf'), 'qwen2.5-0.5b');
	assert.equal(shortModel('/Users/me/models/gguf/qwen2.5-0.5b-instruct-q4_k_m.gguf'), 'qwen2.5-0.5b');
	assert.equal(shortModel('Qwen3.8:27b-mlx'), 'Qwen3.8:27b-mlx');
	assert.equal(shortModel('gemma-3-27b-it'), 'gemma-3-27b');
});

test('shortModel elides rather than trims once over budget', () => {
	const s = shortModel('a-very-long-model-identifier-that-goes-on');
	assert.ok(s.length <= 20);
	assert.ok(s.endsWith('…'));
});

test('unit renders a missing value as a dash, never as a dash with a unit', () => {
	assert.equal(unit(1.234, ' tok/s'), '1.2 tok/s');
	assert.equal(unit(0.0301, 's', 3), '0.030s');
	assert.equal(unit(undefined, 's'), '—');
	assert.equal(unit(null, ' tok/s'), '—');
	assert.equal(unit(NaN, 's'), '—');
	assert.equal(unit(Infinity, 's'), '—');
});

test('count renders a missing count as a dash, not as zero', () => {
	assert.equal(count(120, ' tokens'), '120 tokens');
	assert.equal(count(0, ' tokens'), '0 tokens');
	assert.equal(count(undefined, ' tokens'), '—');
	assert.equal(count(null, ''), '—');
});
