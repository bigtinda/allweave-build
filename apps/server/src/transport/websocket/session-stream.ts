import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { AgentService } from "../../agent.ts";

/**
 * Live session stream: the subscriber receives the persisted session events and
 * the authoritative snapshot, so a reconnect never depends on replayed events.
 */
export function registerSessionStream(
	socket: WebSocket,
	agents: AgentService,
	sessionId: string,
	after: number,
	logger: FastifyBaseLogger,
): void {
	const connectedAt = performance.now();
	let closeCause = "peer";
	// Subscribe and snapshot synchronously: no event can fall between these operations.
	const unsubscribe = agents.subscribe(sessionId, (event) => {
		if (socket.readyState !== 1) return;
		if (socket.bufferedAmount > 4 * 1024 * 1024) {
			closeCause = "backpressure";
			socket.close(1013, "Reconnect for latest snapshot");
			return;
		}
		socket.send(JSON.stringify(event));
	});
	const snapshot = agents.get(sessionId);
	socket.send(JSON.stringify({ type: "session.snapshot", session: snapshot }));
	for (const event of agents.replay(sessionId, after)) {
		if (event.eventId > snapshot.sequence) socket.send(JSON.stringify(event));
	}
	let alive = true;
	socket.on("pong", () => {
		alive = true;
	});
	const heartbeat = setInterval(() => {
		if (!alive) {
			closeCause = "heartbeat-timeout";
			socket.terminate();
			return;
		}
		alive = false;
		socket.ping();
	}, 30_000);
	const cleanup = () => {
		clearInterval(heartbeat);
		unsubscribe();
	};
	socket.on("close", (code, reason) => {
		cleanup();
		if (code === 1000 || code === 1001) return;
		logger.warn(
			{
				sessionId,
				closeCode: code,
				closeReason: reason.toString(),
				cause: closeCause,
				lifetimeMs: Math.round(performance.now() - connectedAt),
			},
			"Session WebSocket closed unexpectedly",
		);
	});
	socket.on("error", cleanup);
}
