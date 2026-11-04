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
test("official MCP client uses OAuth client credentials over HTTP", async () => {
	let origin = "";
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
		if (url.pathname === "/.well-known/oauth-protected-resource") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					response_types_supported: ["code"],
					token_endpoint: `${origin}/token`,
					grant_types_supported: ["client_credentials"],
					token_endpoint_auth_methods_supported: ["client_secret_basic"],
				}),
			);
			return;
		}
		if (url.pathname === "/token" && request.method === "POST") {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
			const expected = `Basic ${Buffer.from("client:secret").toString("base64")}`;
			if (request.headers.authorization !== expected || body.get("grant_type") !== "client_credentials") {
				response.writeHead(401).end();
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ access_token: "oauth-token", token_type: "Bearer", expires_in: 3600 }));
			return;
		}
		if (url.pathname === "/mcp") {
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			if (request.headers.authorization !== "Bearer oauth-token") {
				response.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
				});
				response.end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!("id" in message)) {
				response.writeHead(202).end();
				return;
			}
			const result =
				message.method === "initialize"
					? {
							protocolVersion: "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "oauth-fixture", version: "1.0.0" },
						}
					: message.method === "tools/list"
						? { tools: [] }
						: {};
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	origin = `http://127.0.0.1:${address.port}`;
	const connection = await connectOfficialServer("oauth", {
		url: `${origin}/mcp`,
		auth: {
			type: "oauth",
			grant: "client_credentials",
			clientId: "client",
			clientSecret: "secret",
			issuer: origin,
		},
	});
	try {
		assert.deepEqual(await connection.client.listTools(), []);
	} finally {
		await connection.close();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
