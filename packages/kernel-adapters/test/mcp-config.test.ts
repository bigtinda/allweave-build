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
		mkdirSync(join(root, "project", ".allweave"), { recursive: true });
		writeFileSync(
			join(root, "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b", enabled: false } } }),
		);
		writeFileSync(
			join(root, "project", ".allweave", "mcp.json"),
			JSON.stringify({ mcpServers: { a: { args: ["x"] } } }),
		);
		const loaded = loadMcpConfig({ agentDir: join(root, "agent"), cwd: join(root, "project"), projectTrusted: true });
		assert.deepEqual([...loaded.servers.keys()], ["a"]);
		assert.deepEqual(loaded.servers.get("a")?.args, ["x"]);
		assert.equal(loaded.diagnostics.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("validates MCP auth configuration", () => {
	const root = mkdtempSync(join(tmpdir(), "mcp-auth-"));
	try {
		mkdirSync(join(root, "agent"), { recursive: true });
		writeFileSync(
			join(root, "agent", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					bearer: { url: "https://example.test/mcp", auth: { type: "bearer", token: "token" } },
					oauth: {
						url: "https://example.test/mcp",
						auth: {
							type: "oauth",
							grant: "client_credentials",
							clientId: "id",
							clientSecret: "secret",
							issuer: "https://auth.example.test",
						},
					},
					missing: { url: "https://example.test/mcp", auth: { type: "oauth", clientId: "id" } },
				},
			}),
		);
		const loaded = loadMcpConfig({ agentDir: join(root, "agent"), cwd: root, projectTrusted: false });
		assert.deepEqual([...loaded.servers.keys()], ["bearer", "oauth"]);
		assert.match(loaded.diagnostics.join("\n"), /mcp server "missing".*clientId, clientSecret and issuer/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
