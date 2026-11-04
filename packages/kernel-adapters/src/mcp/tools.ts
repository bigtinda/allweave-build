import type { NativeTool, NativeToolResult } from "@allweave/kernel";

export interface McpToolInfo {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
	annotations?: { readOnlyHint?: boolean };
}

export interface McpContentBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface McpCallResult {
	content?: McpContentBlock[];
	structuredContent?: unknown;
	isError?: boolean;
}

/** Structural subset of @allweave/mcp's client. */
export interface McpToolClient {
	listTools(): Promise<McpToolInfo[]>;
	callTool(name: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<McpCallResult>;
}

function toolName(name: string, prefix: string): string {
	return `${prefix}${name}`.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
}

function resultText(result: McpCallResult): string {
	const parts: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text" && block.text) parts.push(block.text);
		else if (block.type === "image") parts.push(`[image ${block.mimeType ?? "unknown"}]`);
		else if (block.type) parts.push(`[${block.type}]`);
	}
	if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
	return parts.join("\n");
}

/** Converts an already-connected MCP client into native tools. */
export async function createMcpNativeTools(
	client: McpToolClient,
	options: { prefix?: string } = {},
): Promise<NativeTool[]> {
	const tools = await client.listTools();
	return tools.map((tool) => ({
		name: toolName(tool.name, options.prefix ?? "mcp_"),
		description: tool.description ?? tool.title ?? tool.name,
		parameters: {
			type: "object",
			properties: tool.inputSchema?.properties ?? {},
			required: tool.inputSchema?.required ?? [],
			additionalProperties: true,
		},
		readOnly: tool.annotations?.readOnlyHint === true,
		execute: async (input, context): Promise<NativeToolResult> => {
			const result = await client.callTool(tool.name, input, { signal: context.signal });
			return { content: resultText(result), isError: result.isError === true };
		},
	}));
}
