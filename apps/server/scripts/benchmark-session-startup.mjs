// Run from the repository root with the source resolver used by Server tests.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { projectSessionMeta } from "../src/persistence/session-projection.ts";
import { EventProjector } from "../src/sessions/event-projector.ts";
import { ConsoleStore } from "../src/store.ts";

const [mode, directory] = process.argv.slice(2);
if (mode) {
	const start = performance.now();
	const store = new ConsoleStore(directory);
	const records = mode === "legacy" ? store.sessions() : new EventProjector(store).list();
	console.log(JSON.stringify({ mode, count: records.length, loadMs: performance.now() - start,
		heapBytes: process.memoryUsage().heapUsed, peakRssKiB: process.resourceUsage().maxRSS }));
	store.close();
} else {
	const root = mkdtempSync(join(tmpdir(), "pi-stage7-benchmark-"));
	try {
		let seed = 42;
		const text = () => Array.from({ length: 2000 }, () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return String.fromCharCode(32 + (seed % 95));
		}).join("");
		const fixtures = [];
		let jsonlBytes = 0;
		for (let i = 0; i < 100; i++) {
			const file = join(root, `session-${i}.jsonl`);
			const messages = Array.from({ length: 100 }, (_, j) => ({ id: `${i}-${j}`, role: "user",
				text: text(), thinking: "", complete: true, timestamp: new Date(1700000000000 + j).toISOString() }));
			const entries = [{ type: "session", version: CURRENT_SESSION_VERSION, id: `s${i}`,
				timestamp: messages[0].timestamp, cwd: root }, ...messages.map((message, j) => ({ type: "message",
				id: message.id, parentId: j ? messages[j - 1].id : null, timestamp: message.timestamp,
				message: { role: message.role, content: message.text, timestamp: Date.parse(message.timestamp) } }))];
			writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			jsonlBytes += statSync(file).size;
			fixtures.push({ file, detail: { id: `s${i}`, workspaceId: "w", title: `Session ${i}`, status: "idle",
				updatedAt: messages.at(-1).timestamp, thinkingLevel: "medium", accessMode: "ask", sequence: 0,
				messages, tools: [], approvals: [], activity: [] } });
		}
		for (const variant of ["legacy", "migrated", "migration"]) {
			const dir = join(root, variant);
			mkdirSync(dir);
			const store = new ConsoleStore(dir);
			for (const fixture of fixtures) {
				store.saveSession(fixture.detail, fixture.file);
				if (variant === "migrated") store.saveSessionMeta(projectSessionMeta(fixture.detail, fixture.file));
			}
			store.close();
			console.log(JSON.stringify({ variant, sqliteBytes: statSync(join(dir, "console.sqlite")).size, jsonlBytes }));
			for (let repeat = 0; repeat < 5; repeat++) {
				const start = performance.now();
				const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), variant, dir], { encoding: "utf8" });
				if (child.status !== 0) throw new Error(child.stderr);
				console.log(JSON.stringify({ ...JSON.parse(child.stdout), repeat, processMs: performance.now() - start }));
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
