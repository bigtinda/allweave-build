import assert from "node:assert/strict";
import test from "node:test";
import { bridgeLegacyExtension } from "../src/extensions/legacy-bridge.ts";

test("bridges legacy hooks and tools", async () => {
	const result = await bridgeLegacyExtension("legacy", async (pi) => {
		pi.on("tool_call", () => ({ block: true, reason: "no" }));
		pi.registerTool({
			name: "legacy_tool",
			description: "legacy",
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		(pi as unknown as { registerCommand: (name: string) => void }).registerCommand("x");
	});
	assert.equal(result.extension.tools?.[0]?.name, "legacy_tool");
	const decision = await result.extension.hooks?.tool_call?.({
		sessionId: "s",
		tool: result.extension.tools![0]!,
		toolCall: { id: "1", name: "legacy_tool", input: {} },
	});
	assert.deepEqual(decision, { block: true, reason: "no" });
	assert.ok(result.diagnostics.some((entry) => entry.includes("registerCommand")));
});
