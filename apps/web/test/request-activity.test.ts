import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, api } from "../src/services/api.ts";
import {
	beginRequestActivity,
	getRequestActivity,
	subscribeRequestActivity,
} from "../src/services/request-activity.ts";

test("request activity handles overlap, duplicate completion and unsubscribe", () => {
	const counts: number[] = [];
	const unsubscribe = subscribeRequestActivity(() => counts.push(getRequestActivity()));
	const first = beginRequestActivity();
	const second = beginRequestActivity();
	first();
	first();
	second();
	assert.deepEqual(counts, [1, 2, 1, 0]);
	unsubscribe();
	beginRequestActivity()();
	assert.deepEqual(counts, [1, 2, 1, 0]);
});

test("API progress remains active until all concurrent actions settle, including errors", async () => {
	const original = globalThis.fetch;
	const responses: Array<(response: Response) => void> = [];
	globalThis.fetch = () => new Promise<Response>((resolve) => responses.push(resolve));
	try {
		const first = api<{ ok: boolean }>("/first", {});
		const second = api("/second", {}, "PUT");
		assert.equal(getRequestActivity(), 2);
		responses[0](new Response(JSON.stringify({ ok: true })));
		assert.deepEqual(await first, { ok: true });
		assert.equal(getRequestActivity(), 1);
		responses[1](new Response(JSON.stringify({ error: "failed" }), { status: 500 }));
		await assert.rejects(second, ApiError);
		assert.equal(getRequestActivity(), 0);
	} finally {
		globalThis.fetch = original;
	}
});

test("reads and browser input do not increment action counters; parse errors clear pending actions", async () => {
	const original = globalThis.fetch;
	const counts: number[] = [];
	const unsubscribe = subscribeRequestActivity(() => counts.push(getRequestActivity()));
	globalThis.fetch = async () => new Response("{}");
	try {
		await api("/health");
		await api("/sessions/example/browser/input", { action: "resize" });
		assert.deepEqual(counts, []);
		globalThis.fetch = async () => new Response("invalid-json");
		await assert.rejects(api("/action", {}), SyntaxError);
		assert.deepEqual(counts, [1, 0]);
		assert.equal(getRequestActivity(), 0);
	} finally {
		unsubscribe();
		globalThis.fetch = original;
	}
});
