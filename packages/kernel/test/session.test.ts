import assert from "node:assert/strict";
import { test } from "node:test";
import { KernelSession, KernelSessionConflict } from "../src/index.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("serializes runs and exposes the run id", async () => {
	const session = new KernelSession({ id: "s" });
	const gate = deferred();
	const states: string[] = [];
	session.subscribe((state) => states.push(state.status));
	const run = session.start(async (context) => {
		assert.equal(context.sessionId, "s");
		assert.ok(context.runId);
		await gate.promise;
	});
	assert.throws(() => session.start(async () => {}), KernelSessionConflict);
	assert.equal(session.state().status, "running");
	gate.resolve();
	await run;
	assert.equal(session.state().status, "idle");
	assert.deepEqual(states, ["running", "idle"]);
});

test("abort runs the engine abort hook and settles the run", async () => {
	const session = new KernelSession({ id: "s", onAbort: async () => gate.resolve() });
	const gate = deferred();
	let aborted = false;
	const run = session.start(async (context) => {
		context.signal.addEventListener("abort", () => {
			aborted = true;
		});
		await gate.promise;
	});
	await session.abort();
	assert.equal(aborted, true);
	await run;
	assert.equal(session.state().status, "idle");
});

test("approval keeps the session in approval until the last gate settles", async () => {
	const session = new KernelSession({ id: "s" });
	const gate = deferred();
	const run = session.start(async () => {
		session.enterApproval();
		session.enterApproval();
		await gate.promise;
	});
	assert.equal(session.state().status, "approval");
	session.settleApproval();
	assert.equal(session.state().status, "approval");
	session.settleApproval();
	assert.equal(session.state().status, "running");
	gate.resolve();
	await run;
	assert.equal(session.state().status, "idle");
});

test("marks an idle session interrupted without overriding an active run", async () => {
	const session = new KernelSession({ id: "s" });
	session.markInterrupted();
	assert.equal(session.state().status, "interrupted");
	const gate = deferred();
	const run = session.start(async () => {
		await gate.promise;
	});
	session.markInterrupted();
	assert.equal(session.state().status, "running");
	gate.resolve();
	await run;
});

test("queues steering messages for the next turn", async () => {
	const session = new KernelSession({ id: "s" });
	const gate = deferred();
	let take: (() => string[]) | undefined;
	const run = session.start(async (context) => {
		take = context.takeSteering;
		await gate.promise;
	});
	session.steer("focus on tests");
	assert.deepEqual(take?.(), ["focus on tests"]);
	assert.deepEqual(take?.(), []);
	gate.resolve();
	await run;
});
