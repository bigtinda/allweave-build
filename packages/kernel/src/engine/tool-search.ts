import type { NativeTool } from "./types.ts";

/** A read-only meta tool for discovering and invoking read-only tools by name. */
export function createToolSearchTool(tools: NativeTool[]): NativeTool {
	return {
		name: "tool_search",
		description:
			"Search available read-only tools by keyword. Pass name and args to invoke a matching tool; mutating tools are not callable here.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Case-insensitive name or description fragment." },
				name: { type: "string", description: "Exact tool name to invoke." },
				args: { type: "object", additionalProperties: true },
			},
			additionalProperties: false,
		},
		readOnly: true,
		execute: async (input, context) => {
			if (typeof input.name === "string") {
				const tool = tools.find((candidate) => candidate.name === input.name && candidate.readOnly);
				if (!tool) return { content: `Unknown or mutating tool: ${input.name}`, isError: true };
				return tool.execute((input.args as Record<string, unknown>) ?? {}, context);
			}
			const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
			const matches = tools
				.filter((tool) => tool.readOnly)
				.filter(
					(tool) =>
						!query || tool.name.toLowerCase().includes(query) || tool.description.toLowerCase().includes(query),
				)
				.slice(0, 20);
			return { content: matches.map((tool) => `${tool.name}: ${tool.description}`).join("\n") };
		},
	};
}
