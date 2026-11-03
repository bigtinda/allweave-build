import type { SessionEvent } from "../../../shared/src/protocol.ts";

export type SessionEventListener = (event: SessionEvent) => void;

/**
 * Publishes session events to the transport layer. The hub knows nothing about
 * WebSockets: the transport registers a callback per session and receives the
 * persisted events.
 */
export class EventHub {
	private listeners = new Map<string, Set<SessionEventListener>>();

	subscribe(sessionId: string, listener: SessionEventListener): () => void {
		const listeners = this.listeners.get(sessionId) ?? new Set();
		listeners.add(listener);
		this.listeners.set(sessionId, listeners);
		return () => {
			listeners.delete(listener);
			if (!listeners.size) this.listeners.delete(sessionId);
		};
	}

	publish(sessionId: string, event: SessionEvent): void {
		for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener(event);
	}
}
