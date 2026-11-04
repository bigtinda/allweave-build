import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeLoop } from "../packages/kernel/src/engine/loop.ts";
import { buildContext } from "../packages/kernel/src/context/builder.ts";
import { SqliteEventStore } from "../packages/kernel/src/store/sqlite.ts";
import { KernelSessionStore } from "../apps/server/src/persistence/kernel-session-store.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-kernel-bench-"));
const dbPath = join(directory, "console.sqlite");
const store = new SqliteEventStore(dbPath);
const now = new Date().toISOString();
for (let index = 0; index < 100; index++) {
	store.createSession({ id: `session-${index}`, data: "{}", seq: 0, updatedAt: now });
}
const listStart = performance.now();
const sessions = store.listSessions();
const listMs = performance.now() - listStart;
store.close();

const prepare = new SqliteEventStore(dbPath);
prepare.createSession({ id: "stream", data: "{}", seq: 0, updatedAt: now });
prepare.close();
const batch = new KernelSessionStore(directory);
const deltaStart = performance.now();
for (let index = 0; index < 100; index++) {
	batch.append({
		sessionId: "stream",
		type: "message.delta",
		messageId: "assistant:bench",
		timestamp: now,
		message: { id: "assistant:bench", role: "assistant", text: "x".repeat(200), thinking: "", complete: false, timestamp: now },
	});
}
batch.flushPending();
const deltaMs = performance.now() - deltaStart;
const wal = statSync(`${dbPath}-wal`).size;
batch.close();
rmSync(directory, { recursive: true, force: true });

const messages = Array.from({ length: 100 }, (_, index) => ({
	role: index % 2 === 0 ? "user" : "assistant",
	text: index % 2 === 0 ? `第 ${index} 轮：请检查构建输出并说明失败原因。` : `第 ${index} 轮回复：构建失败原因是类型错误。`,
	timestamp: Date.now(),
}));
const contextStart = performance.now();
const context = await buildContext({ cwd: process.cwd(), messages, tools: [] });
const contextMs = performance.now() - contextStart;

const ttft = [];
for (let index = 0; index < 30; index++) {
	const started = performance.now();
	let first = 0;
	await runNativeLoop(
		{
			sessionId: "ttft",
			cwd: process.cwd(),
			system: "bench",
			signal: new AbortController().signal,
			tools: [{ name: "noop", description: "noop", parameters: {}, readOnly: true, execute: async () => ({ content: "" }) }],
			onEvent: (event) => {
				if (event.type === "message.delta" && !first) first = performance.now() - started;
			},
			gateway: {
				async *stream() {
					yield { type: "text", delta: "ok" };
					yield { type: "done", result: { text: "ok", thinking: "", toolCalls: [], stopReason: "stop" } };
				},
			},
		},
		[],
		"ping",
	);
	ttft.push(first);
}
const ttftMs = ttft.sort((a, b) => a - b)[Math.floor(ttft.length / 2)];

let calls = 0;
const toolStart = performance.now();
await runNativeLoop(
	{
		sessionId: "tools",
		cwd: process.cwd(),
		system: "bench",
		signal: new AbortController().signal,
		tools: Array.from({ length: 4 }, (_, index) => ({
			name: `slow-${index}`,
			description: "slow read",
			parameters: {},
			readOnly: true,
			execute: async () => {
				await new Promise((done) => setTimeout(done, 20));
				return { content: "ok" };
			},
		})),
		onEvent: () => undefined,
		gateway: {
			async *stream() {
				if (calls++ === 0) {
					yield {
						type: "done",
						result: {
							text: "",
							thinking: "",
							toolCalls: Array.from({ length: 4 }, (_, index) => ({ id: `c${index}`, name: `slow-${index}`, input: {} })),
							stopReason: "toolUse",
						},
					};
					return;
				}
				yield { type: "done", result: { text: "done", thinking: "", toolCalls: [], stopReason: "stop" } };
			},
		},
	},
	[],
	"run tools",
);
const toolMs = performance.now() - toolStart;

const result = {
	lists: { sessions: sessions.length, ms: Number(listMs.toFixed(2)), budgetMs: 20 },
	deltas: { events: 100, ms: Number(deltaMs.toFixed(2)), walBytes: wal, budgetMs: 50, budgetWal: 2_000_000 },
	context: { messages: context.messages.length, estimatedTokens: context.estimatedTokens, ms: Number(contextMs.toFixed(2)), budgetMs: 10 },
	ttft: { samples: ttft.length, ms: Number(ttftMs.toFixed(2)), budgetMs: 20 },
	tools: { calls: 4, ms: Number(toolMs.toFixed(2)), budgetMs: 60 },
};
console.log(JSON.stringify(result, null, 2));
const failed = listMs > 20 || deltaMs > 50 || wal > 2_000_000 || contextMs > 10 || ttftMs > 20 || toolMs > 60;
if (failed) process.exitCode = 1;
