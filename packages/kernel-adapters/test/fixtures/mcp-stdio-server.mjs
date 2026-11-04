import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
	const message = JSON.parse(line);
	if (!("id" in message)) continue;
	let result;
	if (message.method === "initialize") {
		result = {
			protocolVersion: "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "mcp-fixture", version: "1.0.0" },
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
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })}\n`,
		);
		continue;
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
