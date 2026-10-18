import assert from "node:assert/strict";
import { test } from "node:test";
import { toolPermission } from "../src/tool-policy.ts";

test("permission modes preserve read access and apply distinct write policies", () => {
	for (const mode of ["plan", "ask", "auto", "full"] as const) {
		assert.equal(toolPermission(mode, "read"), "allow");
		assert.equal(toolPermission(mode, "grep"), "allow");
		assert.equal(toolPermission(mode, "plugin_project_tasks_list", new Set(["plugin_project_tasks_list"])), "allow");
	}
	assert.equal(toolPermission("plan", "write"), "deny");
	assert.equal(toolPermission("plan", "bash"), "deny");
	assert.equal(toolPermission("ask", "write"), "ask");
	assert.equal(toolPermission("ask", "custom_tool"), "ask");
	assert.equal(toolPermission("ask", "plugin_project_tasks_create"), "ask");
	assert.equal(toolPermission("ask", "plugin_project_tasks_list"), "ask");
	assert.equal(toolPermission("ask", "plugin_validate"), "ask");
	assert.equal(toolPermission("auto", "write"), "allow");
	assert.equal(toolPermission("auto", "edit"), "allow");
	assert.equal(toolPermission("auto", "bash"), "ask");
	assert.equal(toolPermission("auto", "custom_tool"), "ask");
	assert.equal(toolPermission("full", "bash"), "allow");
	assert.equal(toolPermission("full", "custom_tool"), "allow");
});
