import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "./config.ts";
import type { McpCallResult, McpToolClient, McpToolInfo } from "./tools.ts";

class OfficialMcpClient implements McpToolClient {
	private readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	async listTools(): Promise<McpToolInfo[]> {
		const result = await this.client.listTools();
		return result.tools.map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: {
				type: tool.inputSchema.type,
				properties: tool.inputSchema.properties,
				required: tool.inputSchema.required,
			},
			annotations: tool.annotations ? { readOnlyHint: tool.annotations.readOnlyHint } : undefined,
		}));
	}

	async callTool(
		name: string,
		input: Record<string, unknown>,
		options: { signal?: AbortSignal } = {},
	): Promise<McpCallResult> {
		const result = await this.client.callTool({ name, arguments: input }, { signal: options.signal });
		return {
			content: result.content,
			structuredContent: result.structuredContent,
			isError: result.isError,
		};
	}
}

function transportFor(config: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
	if (config.url) {
		return new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: config.headers ? { headers: config.headers } : undefined,
		});
	}
	if (!config.command) throw new Error("MCP server command or url is required");
	return new StdioClientTransport({
		command: config.command,
		args: config.args,
		cwd: config.cwd,
		env: config.env,
		stderr: "ignore",
	});
}

/** Connects a configured server through the official MCP client. */
export async function connectOfficialServer(
	name: string,
	config: McpServerConfig,
): Promise<{ name: string; client: McpToolClient; close(): Promise<void> }> {
	const client = new Client({ name: "allweave", version: "1.2.1" });
	await client.connect(transportFor(config));
	return {
		name,
		client: new OfficialMcpClient(client),
		close: () => client.close(),
	};
}
