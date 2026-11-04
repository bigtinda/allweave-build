import { CodemodeSandbox, type CodemodeTool, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { NativeTool } from "@pi-console/kernel";

export interface CodemodeToolOptions {
	name?: string;
	description?: string;
	timeoutMs?: number;
	memoryLimitBytes?: number;
	/** Optional release-build worker specifier; source checkouts use the package default. */
	workerUrl?: string | URL;
	/** Optional wasm path when the package asset is not resolvable from this module. */
	wasmPath?: string;
}

/** Creates a code-execution tool whose scripts may only call the supplied read-only tools. */
export function createCodemodeNativeTool(tools: NativeTool[], options: CodemodeToolOptions = {}): NativeTool {
	const readOnly = tools.filter((tool) => tool.readOnly);
	return {
		name: options.name ?? "codemode",
		description:
			options.description ??
			"Run a JavaScript function body in a sandbox. Call allowed read-only tools as tools.<name>(args); return a JSON value.",
		parameters: {
			type: "object",
			properties: {
				code: { type: "string", description: "Async function body; top-level await and return are allowed." },
			},
			required: ["code"],
			additionalProperties: false,
		},
		readOnly: true,
		execute: async (input, context) => {
			const code = typeof input.code === "string" ? input.code : "";
			const sandboxTools: CodemodeTool[] = readOnly.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.parameters,
				execute: async (args, nested) => {
					const result = await tool.execute(
						(args ?? {}) as Record<string, unknown>,
						{
							signal: nested.signal,
							workspace: context.workspace,
						} as never,
					);
					if (result.isError) throw new Error(result.content);
					return result.content;
				},
			}));
			const sandbox = new CodemodeSandbox({
				tools: sandboxTools,
				timeoutMs: options.timeoutMs ?? 60_000,
				memoryLimitBytes: options.memoryLimitBytes ?? 64 * 1024 * 1024,
				wasm: loadQuickJSWasm(options.wasmPath),
				...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
			});
			try {
				const result = await sandbox.execute(code, { signal: context.signal });
				const text = result.output
					.map((item) => (item.type === "text" ? item.text : `[image ${item.mimeType}]`))
					.join("\n");
				if (!result.ok) return { content: `${result.error.kind}: ${result.error.message}`, isError: true };
				return { content: `${text}${result.value === undefined ? "" : `\n${JSON.stringify(result.value)}`}` };
			} finally {
				await sandbox.close();
			}
		},
	};
}
