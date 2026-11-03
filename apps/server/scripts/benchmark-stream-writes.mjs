import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventProjector } from "../src/sessions/event-projector.ts";
import { ConsoleStore } from "../src/store.ts";

const root = mkdtempSync(join(tmpdir(), "pi-stream-benchmark-"));
try {
	for (const mode of ["full-snapshot", "checkpoint"]) {
		const directory = join(root, mode);
		const store = new ConsoleStore(directory);
		let writes = 0;
		const measured = new Proxy(store, { get(target, key) {
			if (key === "loadSessionEvents" && mode === "full-snapshot") return undefined;
			if (key === "saveSession") return (...args) => { writes++; return target.saveSession(...args); };
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		} });
		const projector = new EventProjector(measured);
		let seed = 42;
		const chunk = () => Array.from({ length: 200 }, () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return String.fromCharCode(32 + seed % 95);
		}).join("");
		const timestamp = "2026-01-01T00:00:00.000Z";
		projector.create({ id: "s", workspaceId: "w", title: "fixture", status: "running", updatedAt: timestamp,
			thinkingLevel: "off", accessMode: "ask", sequence: 0, approvals: [], activity: [], tools: [],
			messages: Array.from({ length: 100 }, (_, index) => ({ id: `history-${index}`, role: "assistant", text: chunk(), thinking: "", complete: true, timestamp })) });
		store.db.exec("PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
		writes = 0;
		const start = performance.now();
		let text = "";
		for (let index = 0; index < 100; index++) {
			text += chunk();
			projector.project("s", { type: "message.delta", message: { id: "stream", role: "assistant", text, thinking: "", complete: false, timestamp } });
		}
		projector.project("s", { type: "message.completed", message: { id: "stream", role: "assistant", text, thinking: "", complete: true, timestamp } });
		const ms = performance.now() - start;
		assert.equal(store.loadSessionSnapshot("s").detail.messages.at(-1).text, text);
		console.log(JSON.stringify({ mode, deltas: 100, ms, fullSnapshotWrites: writes, walBytes: statSync(join(directory, "console.sqlite-wal")).size }));
		store.close();
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
