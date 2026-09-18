import { setTimeout as delay } from 'timers/promises';

/**
 * Wait, or return early when `signal` aborts.
 *
 * The obvious version — a setTimeout plus `signal.addEventListener('abort',
 * …)` — adds a listener on every call and only removes it when the signal
 * fires. A poll loop sleeping every 300 ms therefore accumulated a listener per
 * poll for the life of the connection, some twelve thousand an hour, until the
 * watcher was restarted. Node's promisified timer takes the signal itself and
 * detaches on completion.
 */
export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
	try {
		await delay(ms, undefined, { signal });
	} catch {
		/* aborted: the caller checks signal.aborted and leaves */
	}
}
