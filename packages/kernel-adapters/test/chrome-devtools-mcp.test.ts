import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { LocalWorkspace } from "@pi-console/kernel";
import { createMcpManager } from "../src/mcp/manager.ts";

// Requires a local Chrome and the globally installed `chrome-devtools-mcp`:
//   npm install -g chrome-devtools-mcp@1.12.0
//   CHROME_DEVTOOLS_MCP=1 node --import ./scripts/source-resolver.ts --test packages/kernel-adapters/test/chrome-devtools-mcp.test.ts
const enabled = process.env.CHROME_DEVTOOLS_MCP === "1";

test("connects to chrome-devtools-mcp and evaluates a page", { skip: !enabled, timeout: 120_000 }, async () => {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<title>MCP Fixture</title><h1>hello from mcp</h1>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const manager = await createMcpManager({
		servers: new Map([
			[
				"chrome-devtools",
				{ command: "chrome-devtools-mcp", args: ["--headless", "--isolated", "--viewport", "1280x720"] },
			],
		]),
	});
	try {
		assert.deepEqual(manager.diagnostics, []);
		const tool = (suffix: string) => {
			const found = manager.tools.find((candidate) => candidate.name.endsWith(suffix));
			assert.ok(found, `missing ${suffix}`);
			return found;
		};
		const context = {
			sessionId: "test",
			cwd: process.cwd(),
			workspace: new LocalWorkspace(process.cwd()),
			signal: AbortSignal.timeout(60_000),
		};
		const created = await tool("new_page").execute({ url: `http://127.0.0.1:${address.port}/` }, context);
		assert.equal(created.isError, false);
		const selected = created.content.split("\n").find((line) => line.includes("[selected]"));
		const pageId = Number(/^(\d+):/.exec(selected ?? "")?.[1]);
		assert.ok(Number.isInteger(pageId) && pageId > 0);
		const evaluated = await tool("evaluate_script").execute(
			{ pageId, function: "() => ({ title: document.title, h1: document.querySelector('h1')?.textContent })" },
			context,
		);
		assert.equal(evaluated.isError, false);
		assert.match(evaluated.content, /MCP Fixture/);
		assert.match(evaluated.content, /hello from mcp/);
	} finally {
		await manager.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
