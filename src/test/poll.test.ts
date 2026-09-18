import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as http from 'http';
import { TelemetryEvent } from '../adapter';
import { llamaCppAdapter } from '../adapters/llamacpp';
import { vllmAdapter } from '../adapters/prometheus';
import { fixture } from './helpers';

/**
 * The poll adapters against a server that answers from captured fixtures, one
 * set per phase. Each phase is held for a few polls, then the next begins, so
 * the adapter sees the same sequence of states it would against the engine.
 * These take a couple of seconds each: the poll intervals are real.
 */

type Routes = Record<string, string>;

async function serve(phases: Routes[], pollsPerPhase: number) {
	let hits = 0;
	const server = http.createServer((req, res) => {
		// Advance on the slot/metrics reads, not on /props, which is read once.
		const phase = Math.min(Math.floor(hits / pollsPerPhase), phases.length - 1);
		const body = phases[phase][req.url ?? ''];
		if (req.url !== '/props') {
			hits++;
		}
		if (body === undefined) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { 'content-type': 'text/plain' }).end(body);
	});
	await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as { port: number };
	return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Run until `done` says so or `ms` elapse, then abort. */
async function collect(
	run: (url: string, signal: AbortSignal, emit: (e: TelemetryEvent) => void) => Promise<void>,
	url: string,
	done: (events: TelemetryEvent[]) => boolean,
	ms: number
): Promise<TelemetryEvent[]> {
	const events: TelemetryEvent[] = [];
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), ms);
	const finished = run(url, ac.signal, e => {
		events.push(e);
		if (done(events)) {
			ac.abort();
		}
	}).catch(() => undefined);
	await finished;
	clearTimeout(timer);
	return events;
}

const completed = (events: TelemetryEvent[]) =>
	events.filter((e): e is Extract<TelemetryEvent, { kind: 'completed' }> => e.kind === 'completed');

const L = {
	props: fixture('llamacpp', 'props.json'),
	slotsIdle: fixture('llamacpp', 'slots-idle.json'),
	slotsBusy: fixture('llamacpp', 'slots-busy.json'),
	metricsIdle: fixture('llamacpp', 'metrics-idle.prom'),
	metricsBusy: fixture('llamacpp', 'metrics-busy.prom'),
	metricsAfter: fixture('llamacpp', 'metrics-after.prom')
};

test('llama.cpp: a request seen in flight gets progress, then exact totals', async () => {
	// Each /slots poll also reads /metrics, so two hits per poll.
	const s = await serve(
		[
			{ '/props': L.props, '/slots': L.slotsIdle, '/metrics': L.metricsIdle },
			{ '/props': L.props, '/slots': L.slotsBusy, '/metrics': L.metricsBusy },
			{ '/props': L.props, '/slots': L.slotsIdle, '/metrics': L.metricsAfter }
		],
		4
	);
	try {
		const events = await collect(llamaCppAdapter.run, s.url, e => completed(e).length > 0, 6000);
		assert.ok(events.some(e => e.kind === 'prefill' || e.kind === 'progress'), 'seen in flight');
		const [c] = completed(events);
		// tokens_predicted_total 6805 -> 9805 over 21.363s -> 30.524s.
		assert.equal(c.stats.completionTokens, 3000);
		assert.ok(Math.abs(c.stats.decodeTokS! - 3000 / 9.161) < 0.01, `${c.stats.decodeTokS}`);
		// The slot's own accounting: 11 processed + 24 from cache.
		assert.equal(c.stats.promptTokens, 35);
		assert.equal(c.stats.cachedTokens, 24);
		assert.equal(c.stats.cacheSource, 'prompt cache');
		assert.equal(c.stats.model, 'qwen2.5-0.5b-instruct-q4_k_m.gguf');
	} finally {
		s.close();
	}
});

test('llama.cpp: a request that finished between polls is still reported, with rates', async () => {
	const s = await serve(
		[
			{ '/props': L.props, '/slots': L.slotsIdle, '/metrics': L.metricsIdle },
			{ '/props': L.props, '/slots': L.slotsIdle, '/metrics': L.metricsAfter }
		],
		4
	);
	try {
		const events = await collect(llamaCppAdapter.run, s.url, e => completed(e).length > 0, 6000);
		assert.ok(!events.some(e => e.kind === 'progress'), 'never seen in flight');
		const [c] = completed(events);
		assert.equal(c.stats.completionTokens, 3000);
		// No slot was ever seen, so the prompt is the counter delta: 78 -> 89.
		assert.equal(c.stats.promptTokens, 11);
		assert.ok(Math.abs(c.stats.decodeTokS! - 3000 / 9.161) < 0.01);
		assert.ok(c.stats.prefillTokS! > 0, 'prompt_seconds_total moved too');
	} finally {
		s.close();
	}
});

test('llama.cpp: the server going away ends the run', async () => {
	const s = await serve([{ '/props': L.props, '/slots': L.slotsIdle, '/metrics': L.metricsIdle }], 99);
	const ac = new AbortController();
	const run = llamaCppAdapter.run(s.url, ac.signal, () => undefined);
	await new Promise(r => setTimeout(r, 400));
	s.close();
	await assert.rejects(run, /stopped answering/);
});

test('vllm: busy then idle is one request with wall-clock timing', async () => {
	const s = await serve(
		[{ '/metrics': fixture('vllm-busy.prom') }, { '/metrics': fixture('vllm-idle.prom') }],
		2
	);
	try {
		const events = await collect(vllmAdapter.run, s.url, e => completed(e).length > 0, 6000);
		const [c] = completed(events);
		// generation_tokens_total 617 -> 700 while running went 1 -> 0.
		assert.equal(c.stats.completionTokens, 83);
		assert.equal(typeof c.stats.requestElapsedS, 'number');
		assert.equal(c.stats.model, 'Qwen/Qwen2.5-0.5B-Instruct');
		// TTFT is a histogram: an average, labelled as one, never ttftS.
		assert.equal(c.stats.ttftS, undefined);
		assert.ok(Object.keys(c.stats.extra!).some(k => k.startsWith('TTFT (avg')));
	} finally {
		s.close();
	}
});

test('vllm: counters that moved while idle are a request, reported without a rate', async () => {
	// The idle capture with fifty more generated tokens and running still 0 —
	// the one synthesized state here, since a fast request cannot be caught
	// on purpose. Everything else about the text is the capture.
	const idle = fixture('vllm-idle.prom');
	const later = idle.replace(/(vllm:generation_tokens_total\{[^}]*\}) 700\.0/, '$1 750.0');
	assert.notEqual(later, idle, 'the fixture line the test relies on is present');
	const s = await serve([{ '/metrics': idle }, { '/metrics': later }], 2);
	try {
		const events = await collect(vllmAdapter.run, s.url, e => completed(e).length > 0, 6000);
		const [c] = completed(events);
		assert.equal(c.stats.completionTokens, 50);
		assert.equal(c.stats.decodeTokS, undefined);
		assert.equal(c.stats.requestTokS, undefined);
		assert.match(c.stats.extra!['Timing'], /between polls/);
	} finally {
		s.close();
	}
});
