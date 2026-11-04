import type { ExtensionHooks, KernelExtension, NativeTool, NativeToolResult } from "@pi-console/kernel";

interface LegacyTool {
	name: string;
	label?: string;
	description: string;
	parameters?: unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		context: unknown,
	): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

export interface LegacyPiApi {
	on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
	registerTool(tool: LegacyTool): void;
}

export interface LegacyBridgeResult {
	extension: KernelExtension;
	diagnostics: string[];
}

function resultText(content: Array<{ type: string; text?: string }>): string {
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`)).join("\n");
}

/**
 * Adapts the subset of the Pi extension API used by tool/hook extensions.
 * UI, commands, shortcuts and session mutation remain unsupported and are diagnosed.
 */
export async function bridgeLegacyExtension(
	name: string,
	factory: (pi: LegacyPiApi) => void | Promise<void>,
): Promise<LegacyBridgeResult> {
	const diagnostics: string[] = [];
	const hooks: ExtensionHooks = {};
	const tools: NativeTool[] = [];
	const unsupported = new Set<string>();
	const api = new Proxy(
		{
			on(event: string, handler: (event: Record<string, unknown>) => unknown) {
				if (event === "session_start") hooks.session_start = async () => void (await handler({}));
				else if (event === "session_shutdown") hooks.session_shutdown = async () => void (await handler({}));
				else if (event === "tool_call") {
					hooks.tool_call = async (event) => {
						const decision = (await handler({
							toolName: event.toolCall.name,
							toolCallId: event.toolCall.id,
							input: event.toolCall.input,
						})) as { block?: boolean; reason?: string; input?: Record<string, unknown> } | undefined;
						if (!decision) return undefined;
						if (decision.block) return { block: true, reason: decision.reason ?? "blocked by extension" };
						if (decision.input) return { input: decision.input };
						return undefined;
					};
				} else if (event === "tool_result") {
					hooks.tool_result = async (event) => {
						const result = (await handler({
							toolName: event.toolCall.name,
							toolCallId: event.toolCall.id,
							input: event.toolCall.input,
							content: [{ type: "text", text: event.result.content }],
							isError: event.result.isError === true,
						})) as { content?: string; isError?: boolean } | undefined;
						return result;
					};
				} else if (event === "context") {
					hooks.context = async (event) => {
						const result = (await handler({
							messages: event.messages.map((message) => ({
								role: message.role,
								content: [{ type: "text", text: message.text }],
							})),
						})) as { messages?: Array<{ role: string; content: Array<{ text?: string }> }> } | undefined;
						if (!result?.messages) return undefined;
						return {
							messages: result.messages.map((message) => ({
								role: message.role as "user" | "assistant" | "tool",
								text: message.content.map((block) => block.text ?? "").join(""),
								timestamp: Date.now(),
							})),
						};
					};
				} else {
					diagnostic(`hook ${event}`);
				}
			},
			registerTool(tool: LegacyTool) {
				tools.push({
					name: tool.name,
					description: tool.description || tool.label || tool.name,
					parameters: (tool.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
					readOnly: false,
					execute: async (input, context): Promise<NativeToolResult> => {
						const result = await tool.execute(crypto.randomUUID(), input, context.signal, () => {}, {
							cwd: context.cwd,
						});
						return { content: resultText(result.content), isError: result.isError === true };
					},
				});
			},
		},
		{
			get(target, property: string) {
				if (property in target) return target[property as keyof typeof target];
				diagnostic(`api ${property}`);
				return () => {};
			},
		},
	);
	function diagnostic(feature: string): void {
		if (unsupported.has(feature)) return;
		unsupported.add(feature);
		diagnostics.push(`${name}: unsupported ${feature}`);
	}
	await factory(api);
	return { extension: { name, hooks, tools }, diagnostics };
}
