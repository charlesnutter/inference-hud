/**
 * Minimal SSE reader over global fetch. Yields {event, data} frames.
 * `skipEvents` are recognised but their payload is never parsed — MTPLX's
 * `snapshot` frames are ~250KB each and we have no use for them.
 */
export interface SseFrame {
	event: string;
	data: string;
}

export async function* readSse(
	url: string,
	signal: AbortSignal,
	skipEvents: ReadonlySet<string>
): AsyncGenerator<SseFrame> {
	const res = await fetch(url, {
		signal,
		headers: { accept: 'text/event-stream' }
	});
	if (!res.ok || !res.body) {
		throw new Error(`${res.status} ${res.statusText}`);
	}

	const decoder = new TextDecoder();
	let buf = '';

	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		buf += decoder.decode(chunk, { stream: true });

		let sep: number;
		while ((sep = buf.indexOf('\n\n')) !== -1) {
			const block = buf.slice(0, sep);
			buf = buf.slice(sep + 2);

			let event = 'message';
			const dataLines: string[] = [];
			for (const line of block.split('\n')) {
				if (line.startsWith('event:')) {
					event = line.slice(6).trim();
				} else if (line.startsWith('data:')) {
					dataLines.push(line.slice(5).trimStart());
				}
			}
			if (dataLines.length === 0) {
				continue;
			}
			// Drop the payload before it costs us anything.
			yield { event, data: skipEvents.has(event) ? '' : dataLines.join('\n') };
		}
	}
}
