const queues = new Map<string, Promise<unknown>>();

/**
 * Serializes mutations for one path. Keys must be normalized absolute paths
 * or remote mutation keys. Failed operations do not poison the queue.
 */
export async function withPathMutation<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const run = (async () => {
		await previous.catch(() => {});
		return operation();
	})();
	const tail = run.catch(() => {});
	queues.set(key, tail);
	try {
		return await run;
	} finally {
		if (queues.get(key) === tail) queues.delete(key);
	}
}
