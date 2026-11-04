import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMcpConfig } from "../src/mcp/config.ts";

test("merges global and trusted project MCP config", () => {
	const root = mkdtempSync(join(tmpdir(), "mcp-config-"));
	try {
		mkdirSync(join(root, "agent"), { recursive: true });
		mkdirSync(join(root, "project", ".pi"), { recursive: true });
		writeFileSync(
			join(root, "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b", enabled: false } } }),
		);
		writeFileSync(join(root, "project", ".pi", "mcp.json"), JSON.stringify({ mcpServers: { a: { args: ["x"] } } }));
		const loaded = loadMcpConfig({ agentDir: join(root, "agent"), cwd: join(root, "project"), projectTrusted: true });
		assert.deepEqual([...loaded.servers.keys()], ["a"]);
		assert.deepEqual(loaded.servers.get("a")?.args, ["x"]);
		assert.equal(loaded.diagnostics.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
