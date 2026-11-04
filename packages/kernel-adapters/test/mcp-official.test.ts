import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connectOfficialServer } from "../src/mcp/official.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));

test("official MCP client lists and calls tools over stdio", async () => {
	const connection = await connectOfficialServer("fixture", {
		command: process.execPath,
		args: [fixture],
	});
	try {
		const tools = await connection.client.listTools();
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["echo"],
		);
		assert.equal(tools[0]?.annotations?.readOnlyHint, true);
		const result = await connection.client.callTool("echo", { text: "hello" });
		assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
	} finally {
		await connection.close();
	}
});

test("official MCP client lists and calls tools over streamable HTTP", async () => {
	const server = createServer(async (request, response) => {
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk);
		const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!("id" in message)) {
			response.writeHead(202).end();
			return;
		}
		let result: unknown;
		if (message.method === "initialize") {
			result = {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "http-fixture", version: "1.0.0" },
			};
		} else if (message.method === "tools/list") {
			result = {
				tools: [
					{
						name: "echo",
						description: "Echo text",
						inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
						annotations: { readOnlyHint: true },
					},
				],
			};
		} else if (message.method === "tools/call") {
			result = { content: [{ type: "text", text: String(message.params.arguments.text) }] };
		} else if (message.method === "ping") {
			result = {};
		} else {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } }),
			);
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const connection = await connectOfficialServer("fixture", { url: `http://127.0.0.1:${address.port}/mcp` });
	try {
		const tools = await connection.client.listTools();
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["echo"],
		);
		const result = await connection.client.callTool("echo", { text: "over http" });
		assert.deepEqual(result.content, [{ type: "text", text: "over http" }]);
	} finally {
		await connection.close();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
