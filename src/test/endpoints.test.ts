import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveEndpoints } from '../endpoints';
import { Detected, ENGINES, detectionKey } from '../engines';

/**
 * Detection is handed in, never run: these test how a scan becomes a list of
 * endpoints, and that must not depend on what happens to be listening.
 */
const found = (id: string, port: number): Detected => ({
	engine: ENGINES.find(e => e.id === id)!,
	baseUrl: `http://127.0.0.1:${port}`,
	label: id
});

test('observable engines get their adapter; proxy-only ones get a proxy, in order', async () => {
	const scan = [found('ollama', 11434), found('llamacpp', 8080), found('lmstudio', 1234)];
	const r = await resolveEndpoints([], true, true, 8788, scan);
	assert.deepEqual(
		r.endpoints.map(e => [e.adapter.id, e.url, e.proxyPort]),
		[
			['proxy', 'http://127.0.0.1:11434', 8788],
			['llamacpp', 'http://127.0.0.1:8080', undefined],
			['proxy', 'http://127.0.0.1:1234', 8789]
		]
	);
	assert.ok(r.endpoints.every(e => e.detected));
	assert.deepEqual(r.unsupported, []);
	assert.deepEqual(r.detected, scan, 'the scan used is the scan returned');
});

test('a port claimed by an explicit proxy entry is skipped', async () => {
	const r = await resolveEndpoints(
		[{ url: 'http://10.0.0.5:11434', proxy: 8788 }],
		true,
		true,
		8788,
		[found('ollama', 11434)]
	);
	assert.deepEqual(
		r.endpoints.map(e => [e.url, e.proxyPort]),
		[
			['http://10.0.0.5:11434', 8788],
			['http://127.0.0.1:11434', 8789]
		]
	);
});

test('without autoProxy, a proxy-only engine is reported, not watched', async () => {
	const r = await resolveEndpoints([], true, false, 8788, [found('ollama', 11434), found('vllm', 8000)]);
	assert.deepEqual(r.endpoints.map(e => e.adapter.id), ['vllm']);
	assert.equal(r.unsupported.length, 1);
	assert.equal(r.unsupported[0].engineName, 'Ollama');
	assert.match(r.unsupported[0].reason, /proxy/);
});

test('an engine blocked for a reason a proxy cannot fix stays unsupported', async () => {
	const r = await resolveEndpoints([], true, true, 8788, [found('omlx', 8000)]);
	assert.deepEqual(r.endpoints, []);
	assert.match(r.unsupported[0].reason, /authentication/);
});

test('pinning names the adapter without a probe; an unknown pin is reported', async () => {
	const r = await resolveEndpoints(
		[
			{ url: 'http://127.0.0.1:9090', engine: 'vllm', label: 'box' },
			{ url: 'http://127.0.0.1:9091', engine: 'nope' }
		],
		false
	);
	assert.deepEqual(
		r.endpoints.map(e => [e.adapter.id, e.label, e.detected]),
		[['vllm', 'box', false]]
	);
	assert.deepEqual(r.unsupported.map(u => u.engineName), ['nope']);
});

test('urls are normalised and deduplicated before anything else', async () => {
	const r = await resolveEndpoints(
		[{ url: ' http://127.0.0.1:8080/ ', engine: 'llamacpp' }, 'http://127.0.0.1:8080'],
		true,
		false,
		8788,
		[found('llamacpp', 8080)]
	);
	assert.deepEqual(r.endpoints.map(e => [e.url, e.detected]), [['http://127.0.0.1:8080', false]]);
});

test('with autoDetect off, nothing is scanned and nothing is reported as detected', async () => {
	const r = await resolveEndpoints([], false, true, 8788, [found('ollama', 11434)]);
	assert.deepEqual(r.endpoints, []);
	assert.deepEqual(r.detected, []);
});

test('the detection key is order-independent and carries the engine', () => {
	const a = detectionKey([found('ollama', 11434), found('llamacpp', 8080)]);
	const b = detectionKey([found('llamacpp', 8080), found('ollama', 11434)]);
	assert.equal(a, b);
	assert.notEqual(a, detectionKey([found('ollama', 11434), found('openai-generic', 8080)]));
	assert.equal(detectionKey([]), '');
});
