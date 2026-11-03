let pending = 0;
const listeners = new Set<() => void>();

export function subscribeRequestActivity(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function getRequestActivity(): number {
	return pending;
}

export function beginRequestActivity(): () => void {
	pending++;
	for (const listener of listeners) listener();
	let completed = false;
	return () => {
		if (completed) return;
		completed = true;
		pending--;
		for (const listener of listeners) listener();
	};
}
