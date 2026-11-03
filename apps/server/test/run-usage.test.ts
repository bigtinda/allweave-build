import assert from "node:assert/strict";
import { test } from "node:test";
import { usageDelta } from "../src/sessions/run-usage.ts";

test("usage deltas include cache and cost and reject reset or missing counters", () => {
	const before = { input: 10, output: 2, total: 17, cacheRead: 5, cost: 1 };
	assert.deepEqual(usageDelta(before, { input: 13, output: 4, total: 26, cacheRead: 9, cost: 2 }), {
		input: 3,
		output: 2,
		total: 9,
		cacheRead: 4,
		cost: 1,
	});
	assert.equal(usageDelta(before, { input: 0, output: 0, total: 0 }), undefined);
	assert.equal(usageDelta(before, { ...before, cost: Number.NaN }), undefined);
});
