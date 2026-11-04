import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CURRENT_SESSION_VERSION = 3;

import type { ModelOption, Resources, SessionDetail, SessionEvent, Workspace } from "../../shared/src/protocol.ts";
import type { AdaptedEvent } from "../src/adapter.ts";
import type { BrowserService } from "../src/browser.ts";
import { projectSessionMeta, type SessionMeta } from "../src/persistence/session-projection.ts";
import { HttpError } from "../src/security.ts";
import { SessionCoordinator } from "../src/sessions/coordinator.ts";
import { EventHub } from "../src/sessions/event-hub.ts";
import { EventProjector, type SavedSession, type SessionStore } from "../src/sessions/event-projector.ts";
import type {
	AgentRuntime,
	AgentRuntimeInput,
	ProjectModelDefaults,
	RuntimeFactory,
} from "../src/sessions/runtime.adapter.ts";
import type { RuntimeEvent } from "../src/sessions/runtime-events.ts";
import { ToolAuthorization } from "../src/sessions/tool-authorization.ts";
import { WorkspaceAccess } from "../src/workspaces/workspace-access.ts";

class FakeStore implements SessionStore {
	saved = new Map<string, SavedSession>();
	events: SessionEvent[] = [];
	private eventId = 0;

	sessionMetas(): SessionMeta[] {
		return [...this.saved.values()].map(({ detail, file }) => projectSessionMeta(detail, file));
	}
	loadSessionSnapshot(id: string): SavedSession | undefined {
		return this.saved.get(id);
	}
	saveSessionMeta(): void {}
	saveSession(detail: SessionDetail, file?: string): void {
		this.saved.set(detail.id, { detail, file });
	}
	deleteSession(id: string): void {
		this.saved.delete(id);
	}
	append(event: Omit<SessionEvent, "eventId">): SessionEvent {
		this.eventId += 1;
		const stored = { ...event, eventId: this.eventId };
		this.events.push(stored);
		return stored;
	}
	withTransaction<T>(operation: () => T): T {
		return operation();
	}
}

class FakeRuntime implements AgentRuntime {
	sessionFile: string;
	readonly listeners = new Set<(event: RuntimeEvent) => void>();
	readonly prompts: string[] = [];
	release?: () => void;
	released = false;
	aborted = false;
	disposed = false;
	totals = { input: 1, output: 2, total: 3 };

	constructor(sessionFile = "transcript.jsonl") {
		this.sessionFile = sessionFile;
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.emit({ phase: "started", adapted: { type: "session.started" } });
		await new Promise<void>((resolve) => {
			this.release = resolve;
		});
	}
	async abort(): Promise<void> {
		this.aborted = true;
		this.release?.();
	}
	async compact() {
		return { compacted: false, dropped: 0, estimatedTokens: 0 };
	}
	usage() {
		return { ...this.totals };
	}
	subscribe(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	selectedModel() {
		return { id: "faux", provider: "faux", name: "Faux", reasoning: false };
	}
	thinkingLevel() {
		return "medium" as const;
	}
	async setModel(): Promise<void> {}
	async listModels(): Promise<ModelOption[]> {
		return [];
	}
	resources(): Resources {
		return { skills: [], extensions: [], diagnostics: [] };
	}
	async navigate() {
		return { toolIds: [], usage: { input: 0, output: 0, total: 0 } };
	}
	async dispose(): Promise<void> {
		this.disposed = true;
	}
	modelFallbackMessage(): string | undefined {
		return undefined;
	}
	emit(event: RuntimeEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

class FakeRuntimeFactory implements RuntimeFactory {
	readonly runtimes = new Map<string, FakeRuntime>();
	sessionFile?: string;

	constructor(sessionFile?: string) {
		this.sessionFile = sessionFile;
	}
	async open(input: AgentRuntimeInput): Promise<AgentRuntime> {
		const runtime = new FakeRuntime(this.sessionFile);
		this.runtimes.set(input.sessionId, runtime);
		return runtime;
	}
	async listModels(): Promise<ModelOption[]> {
		return [];
	}
	modelDefaults(): ProjectModelDefaults {
		return { thinkingLevel: () => undefined, defaultThinkingLevel: () => undefined };
	}
	defaultModelOrder(): Array<[provider: string, modelId: string]> {
		return [];
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the session state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function coordinatorFixture(sessionFile?: string): {
	coordinator: SessionCoordinator;
	store: FakeStore;
	hub: EventHub;
	factory: FakeRuntimeFactory;
	workspace: Workspace;
} {
	const store = new FakeStore();
	const hub = new EventHub();
	const factory = new FakeRuntimeFactory(sessionFile);
	const workspace: Workspace = { id: randomUUID(), name: "project", path: "/project" };
	const workspaceAccess = new WorkspaceAccess({
		store: { workspaces: () => [workspace] },
		roots: () => [workspace.path],
	});
	const browser = {
		release: async () => {},
		close: async () => {},
	} as unknown as BrowserService;
	const coordinator = new SessionCoordinator({
		directory: "/data",
		projector: new EventProjector(store),
		hub,
		runtimeFactory: factory,
		workspaceAccess,
		browser,
	});
	return { coordinator, store, hub, factory, workspace };
}

test("the coordinator owns the run state, the conflict rule and the event publication", async () => {
	const { coordinator, store, factory, workspace } = coordinatorFixture();
	const session = await coordinator.create(workspace.id, "run");
	const events: SessionEvent[] = [];
	const unsubscribe = coordinator.subscribe(session.id, (event) => events.push(event));

	await coordinator.prompt(session.id, "hello", []);
	assert.equal(coordinator.get(session.id).status, "running", "the session runs in the background");
	assert.ok(factory.runtimes.get(session.id), "the runtime was created");
	assert.deepEqual(factory.runtimes.get(session.id)?.prompts, ["hello"]);

	assert.equal(events[0]?.type, "session.updated", "the created runtime is projected first");
	assert.equal(events[1]?.type, "agent.status");
	assert.equal(events[1]?.summary.status, "running");
	assert.ok(
		events.some((event) => event.type === "session.started"),
		"the runtime events reach the hub",
	);
	for (let index = 1; index < events.length; index += 1) {
		assert.ok(events[index].eventId > events[index - 1].eventId, "event ids increase");
	}

	await assert.rejects(
		() => coordinator.prompt(session.id, "second", []),
		(error) => error instanceof HttpError && error.statusCode === 409,
		"a second run of the same session conflicts",
	);

	const other = await coordinator.create(workspace.id, "other");
	await coordinator.prompt(other.id, "independent", []);
	assert.equal(coordinator.get(other.id).status, "running", "other sessions keep running");

	// A reconnect reads the authoritative snapshot instead of the event stream.
	unsubscribe();
	const snapshot = coordinator.get(session.id);
	assert.equal(snapshot.status, "running");
	assert.equal(snapshot.messages.length, 0);
	const reconnect: SessionEvent[] = [];
	coordinator.subscribe(session.id, (event) => reconnect.push(event));
	factory.runtimes.get(session.id)?.emit({ phase: "ended", adapted: { type: "agent.status" } });
	assert.equal(reconnect.length, 1, "only new events are delivered after a reconnect");
	assert.equal(reconnect[0].type, "agent.status");

	const stored = store.saved.get(session.id);
	assert.ok(stored, "the session is persisted");
	assert.equal(stored.detail.status, "running");
});

test("run usage survives publication and counts an aborted run once", async () => {
	const { coordinator, store, factory, workspace } = coordinatorFixture();
	const session = await coordinator.create(workspace.id, "usage");
	await coordinator.prompt(session.id, "hello", []);
	const runtime = factory.runtimes.get(session.id)!;
	runtime.totals = { input: 11, output: 7, total: 18 };
	await coordinator.abort(session.id);
	await waitFor(() => coordinator.get(session.id).status === "idle");
	const usage = coordinator.get(session.id).lastRunUsage;
	assert.equal(usage?.outcome, "aborted");
	assert.deepEqual(usage?.tokens, { input: 10, output: 5, total: 15 });
	assert.deepEqual(store.events.at(-1)?.lastRunUsage, usage);
	assert.deepEqual(store.saved.get(session.id)?.detail.lastRunUsage, usage);
	await coordinator.close();
});

test("the coordinator stops a session whose projection cannot be persisted", async () => {
	const { coordinator, store, factory, workspace } = coordinatorFixture();
	const session = await coordinator.create(workspace.id, "broken");
	await coordinator.prompt(session.id, "hello", []);
	const runtime = factory.runtimes.get(session.id);
	assert.ok(runtime);
	runtime.release?.();
	await waitFor(() => coordinator.get(session.id).status === "idle");

	store.append = () => {
		throw new Error("database is gone");
	};
	await coordinator.prompt(session.id, "again", []);
	await assert.rejects(
		() => coordinator.prompt(session.id, "third", []),
		(error) => error instanceof HttpError && error.statusCode === 409 && /transcript/u.test(error.message),
		"the session is stopped until it is recovered from the transcript",
	);
	runtime.release?.();
});

test("a failed session is recovered from the transcript and resumes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-coordinator-"));
	const transcript = join(directory, "session.jsonl");
	const entries = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "transcript",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: directory,
		},
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "hello", timestamp: Date.parse("2026-01-01T00:00:00.000Z") },
		},
	];
	await writeFile(transcript, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	try {
		const { coordinator, store, factory, workspace } = coordinatorFixture(transcript);
		const session = await coordinator.create(workspace.id, "broken");
		await coordinator.prompt(session.id, "hello", []);
		await coordinator.abort(session.id);

		const originalAppend = store.append;
		store.append = () => {
			throw new Error("database is gone");
		};
		await coordinator.prompt(session.id, "again", []);
		await coordinator.abort(session.id);
		assert.equal(coordinator.get(session.id).recoveryRequired, true, "the failure is visible on the session");
		await assert.rejects(
			() => coordinator.prompt(session.id, "third", []),
			(error) => error instanceof HttpError && error.statusCode === 409,
			"the session stays blocked until it is recovered",
		);

		store.append = originalAppend;
		const restored = await coordinator.recover(session.id);
		assert.equal(restored.recoveryRequired, false);
		assert.ok(
			restored.messages.some((message) => message.role === "user" && message.text === "hello"),
			"the conversation comes from the transcript",
		);
		await coordinator.prompt(session.id, "after recovery", []);
		await waitFor(() => factory.runtimes.get(session.id)?.prompts.includes("after recovery") === true);
		assert.deepEqual(factory.runtimes.get(session.id)?.prompts, ["after recovery"], "a fresh runtime is used");
		await coordinator.abort(session.id);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("approvals are granted, denied, cancelled and expire", async () => {
	const draft: SessionDetail = {
		id: "session",
		workspaceId: "workspace",
		title: "session",
		status: "running",
		updatedAt: "2026-01-01",
		thinkingLevel: "medium",
		accessMode: "ask",
		messages: [],
		tools: [],
		approvals: [],
		activity: [],
		sequence: 0,
	};
	const changes: AdaptedEvent[] = [];
	const authorizer = new ToolAuthorization({
		emit: (_sessionId, change, mutate) => {
			mutate?.(draft);
			changes.push(change);
		},
		accessMode: () => "ask",
		canRequest: () => true,
		timeoutMs: 20,
	});

	const granted = authorizer.request("session", { toolCallId: "tool-1", name: "write", input: { path: "a" } });
	assert.equal(draft.approvals.length, 1, "the approval is pending");
	assert.equal(draft.status, "approval");
	assert.equal(changes[0].type, "approval.requested");
	const approvalId = draft.approvals[0].id;
	authorizer.approve("session", approvalId, true);
	assert.equal(await granted, true);
	assert.equal(draft.approvals.length, 0);
	assert.equal(draft.status, "running");

	const denied = authorizer.request("session", { toolCallId: "tool-2", name: "write", input: {} });
	authorizer.approve("session", draft.approvals[0].id, false);
	assert.equal(await denied, false);

	const cancelled = authorizer.request("session", { toolCallId: "tool-3", name: "write", input: {} });
	authorizer.cancel("session");
	assert.equal(await cancelled, false);

	const expired = authorizer.request("session", { toolCallId: "tool-4", name: "write", input: {} });
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(await expired, false, "an approval expires after the deadline");
	assert.ok(
		changes.some((change) => change.type === "approval.expired"),
		"the expiry is published as its own event",
	);
	assert.equal(draft.approvals.length, 0);
	assert.throws(
		() => authorizer.approve("session", "unknown", true),
		(error) => error instanceof HttpError && error.statusCode === 404,
	);
});
