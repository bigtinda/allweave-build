import assert from "node:assert/strict";
import test from "node:test";
import { decideToolAccess } from "../src/engine/policy.ts";
import type { NativeTool } from "../src/engine/types.ts";

const read: NativeTool = {
	name: "read",
	description: "",
	parameters: {},
	readOnly: true,
	async execute() {
		return { content: "" };
	},
};
const write: NativeTool = { ...read, name: "write", readOnly: false };

test("read-only tools are allowed in every mode", () => {
	for (const mode of ["plan", "ask", "auto", "full"] as const) {
		assert.equal(decideToolAccess(read, mode).action, "allow");
	}
});

test("write tools follow the access mode", () => {
	assert.equal(decideToolAccess(write, "plan").action, "deny");
	assert.equal(decideToolAccess(write, "ask").action, "ask");
	assert.equal(decideToolAccess(write, "auto").action, "allow");
	assert.equal(decideToolAccess(write, "full").action, "allow");
});
