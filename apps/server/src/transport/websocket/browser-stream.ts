import type { WebSocket } from "ws";
import type { BrowserService } from "../../browser.ts";
/**
 * Live browser stream of a session. The browser service owns the page; this
 * module only forwards its events and keeps the connection alive.
 */
export function registerBrowserStream(socket: WebSocket, browser: BrowserService, sessionId: string): void {
	const unsubscribe = browser.subscribe(sessionId, (event) => {
		if (socket.readyState !== 1) return;
		if (socket.bufferedAmount > 2 * 1024 * 1024) {
			if (event.type === "state") socket.close(1013, "Reconnect for current browser state");
			return;
		}
		socket.send(JSON.stringify(event));
	});
	const heartbeat = setInterval(() => {
		if (socket.readyState === 1) socket.ping();
	}, 30_000);
	const cleanup = () => {
		unsubscribe();
		clearInterval(heartbeat);
	};
	socket.on("close", cleanup);
	socket.on("error", cleanup);
}
