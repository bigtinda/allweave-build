import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { NativeTool } from "@pi-console/kernel";
import type { McpServerConfig } from "./config.ts";
import { createMcpNativeTools, type McpToolClient } from "./tools.ts";

interface Connection {
	name: string;
	client: McpToolClient;
	close(): Promise<void>;
}

export interface McpManagerOptions {
	servers: Map<string, McpServerConfig>;
	/** Test seam; production connects real stdio/HTTP transports. */
	connect?: (name: string, config: McpServerConfig) => Promise<Connection>;
}

export interface McpManager {
	tools: NativeTool[];
	diagnostics: string[];
	close(): Promise<void>;
}

async function connectServer(name: string, config: McpServerConfig): Promise<Connection> {
	const client = new McpClient({ name: "pi-console", version: "0.1.0" });
	const transport = config.url
		? new StreamableHttpTransport({ url: config.url, headers: config.headers })
		: new StdioTransport({ command: config.command!, args: config.args, cwd: config.cwd, env: config.env });
	await client.connect(transport);
	return { name, client, close: () => client.close() };
}

/** Connects configured MCP servers concurrently; one failure does not hide the others. */
export async function createMcpManager(options: McpManagerOptions): Promise<McpManager> {
	const diagnostics: string[] = [];
	const connections: Connection[] = [];
	await Promise.all(
		[...options.servers].map(async ([name, config]) => {
			try {
				const connection = await (options.connect ?? connectServer)(name, config);
				connections.push(connection);
			} catch (error) {
				diagnostics.push(`mcp server "${name}": ${error instanceof Error ? error.message : String(error)}`);
			}
		}),
	);
	const tools = (
		await Promise.all(
			connections.map(async (connection) =>
				(
					await createMcpNativeTools(connection.client, { prefix: `mcp__${connection.name}__` })
				).map((tool) => ({
					...tool,
					description: `[${connection.name}] ${tool.description}`,
				})),
			),
		)
	).flat();
	return {
		tools,
		diagnostics,
		close: async () => {
			await Promise.all(connections.map((connection) => connection.close().catch(() => {})));
		},
	};
}
