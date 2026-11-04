import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionDetail } from "../../shared/src/protocol.ts";
import { KernelSessionStore } from "../src/persistence/kernel-session-store.ts";
import { EventProjector } from "../src/sessions/event-projector.ts";

test("streaming keeps its checkpoint, replays after restart and rolls back failed writes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-checkpoint-"));
	let store = new KernelSessionStore(directory);
	try {
		let projector = new EventProjector(store);
		const detail: SessionDetail = {
			id: "s",
			workspaceId: "w",
			title: "stream",
			status: "running",
			updatedAt: "2026-01-01",
			thinkingLevel: "off",
			accessMode: "ask",
			messages: [],
			tools: [],
			approvals: [],
			activity: [],
			sequence: 0,
		};
		projector.create(detail);
		const message = {
			id: "m",
			role: "assistant" as const,
			text: "",
			thinking: "",
			timestamp: "2026-01-01",
			complete: false,
		};
		for (let index = 0; index < 1002; index++) {
			message.text += "x";
			projector.project("s", { type: "message.delta", message: { ...message } });
		}
		const checkpoint = store.loadSessionSnapshot("s")!.detail.sequence;
		assert.ok(checkpoint > 0 && checkpoint < 1002, "long streams checkpoint periodically instead of on every delta");
		assert.equal(store.loadSessionEvents("s", 0).length, 1002);
		assert.equal(store.loadSessionEvents("s", checkpoint).length, 1002 - checkpoint);
		store.close();
		store = new KernelSessionStore(directory);
		projector = new EventProjector(store);
		assert.equal(projector.get("s").messages[0].text, message.text);
		assert.equal(projector.get("s").messages[0].complete, true);
		projector.project("s", { type: "message.completed", message: { ...message, complete: true } });
		assert.equal(store.sessionMetas()[0].checkpointSequence, undefined);
		assert.equal(store.loadSessionSnapshot("s")?.detail.messages[0].text, message.text);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
