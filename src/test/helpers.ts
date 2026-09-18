import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { TelemetryEvent } from '../adapter';
import { StreamWatcher } from '../adapters/proxy';

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');

/** A fixture as captured: raw bytes, no trailing newline added or removed. */
export function fixture(...parts: string[]): string {
	return fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8');
}

/**
 * Run a captured body through a watcher in chunks of `size` bytes, the way the
 * proxy sees it — frames arrive split at arbitrary points, and a fixture fed
 * whole would never exercise the buffering.
 */
export function replay(body: string, size = Infinity, stopped = false): TelemetryEvent[] {
	const events: TelemetryEvent[] = [];
	const w = new StreamWatcher(e => events.push(e));
	const bytes = Buffer.from(body, 'utf8');
	for (let i = 0; i < bytes.length; i += size) {
		w.consume(bytes.subarray(i, Math.min(i + size, bytes.length)));
	}
	w.finish(stopped);
	return events;
}

export function completed(events: TelemetryEvent[]) {
	const done = events.filter(e => e.kind === 'completed');
	if (done.length !== 1) {
		throw new Error(`expected exactly one completed event, got ${done.length}`);
	}
	return (done[0] as Extract<TelemetryEvent, { kind: 'completed' }>).stats;
}

export type Routes = Record<string, string>;

export async function serve(phases: Routes[], pollsPerPhase: number) {
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

