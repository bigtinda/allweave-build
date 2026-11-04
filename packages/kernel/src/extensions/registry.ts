import type { NativeTool } from "../engine/types.ts";
import type {
	ExtensionContextEvent,
	ExtensionContextPatch,
	ExtensionDiagnostic,
	ExtensionHookName,
	ExtensionHooks,
	ExtensionResourceProvider,
	ExtensionToolCallDecision,
	ExtensionToolCallEvent,
	ExtensionToolResultEvent,
	ExtensionToolResultPatch,
	KernelExtension,
} from "./types.ts";

interface ExtensionRecord {
	extension: KernelExtension;
	tools: Map<string, NativeTool>;
	resources: Map<string, ExtensionResourceProvider>;
}

type VoidHook = Exclude<ExtensionHookName, "context" | "tool_call" | "tool_result">;

/** In-process extension host. Hooks are sequential and fail closed. */
export class ExtensionRegistry {
	private readonly records = new Map<string, ExtensionRecord>();
	private readonly diagnostics: ExtensionDiagnostic[] = [];

	register(extension: KernelExtension): boolean {
		if (this.records.has(extension.name)) {
			this.diagnostics.push({
				extension: extension.name,
				level: "warn",
				message: `extension ${extension.name} is already registered`,
			});
			return false;
		}
		const record: ExtensionRecord = { extension, tools: new Map(), resources: new Map() };
		for (const tool of extension.tools ?? []) this.addTool(record, tool);
		for (const resource of extension.resources ?? []) {
			if (record.resources.has(resource.name)) {
				this.diagnostics.push({
					extension: extension.name,
					level: "warn",
					message: `resource provider ${resource.name} is duplicated`,
				});
				continue;
			}
			record.resources.set(resource.name, resource);
		}
		this.records.set(extension.name, record);
		return true;
	}

	unregister(name: string): boolean {
		return this.records.delete(name);
	}

	registerTool(extensionName: string, tool: NativeTool): boolean {
		if (this.toolExists(tool.name)) {
			this.diagnostics.push({
				extension: extensionName,
				level: "warn",
				message: `tool ${tool.name} is already registered`,
			});
			return false;
		}
		const record = this.records.get(extensionName) ?? {
			extension: { name: extensionName },
			tools: new Map<string, NativeTool>(),
			resources: new Map<string, ExtensionResourceProvider>(),
		};
		if (!this.addTool(record, tool)) return false;
		this.records.set(extensionName, record);
		return true;
	}

	registerResourceProvider(extensionName: string, provider: ExtensionResourceProvider): boolean {
		const record = this.records.get(extensionName) ?? {
			extension: { name: extensionName },
			tools: new Map<string, NativeTool>(),
			resources: new Map<string, ExtensionResourceProvider>(),
		};
		if (record.resources.has(provider.name)) return false;
		record.resources.set(provider.name, provider);
		this.records.set(extensionName, record);
		return true;
	}

	tools(): NativeTool[] {
		const tools: NativeTool[] = [];
		const seen = new Set<string>();
		for (const record of this.records.values()) {
			for (const tool of record.tools.values()) {
				if (seen.has(tool.name)) {
					this.diagnostics.push({
						extension: record.extension.name,
						level: "warn",
						message: `tool ${tool.name} is duplicated; keeping the first registration`,
					});
					continue;
				}
				seen.add(tool.name);
				tools.push(tool);
			}
		}
		return tools;
	}

	resourceProviders(): ExtensionResourceProvider[] {
		return [...this.records.values()].flatMap((record) => [...record.resources.values()]);
	}

	diagnostics_(): ExtensionDiagnostic[] {
		return [...this.diagnostics];
	}

	async run(name: VoidHook, event: unknown): Promise<void> {
		for (const record of this.records.values()) {
			const hook = record.extension.hooks?.[name] as ((value: unknown) => unknown) | undefined;
			if (!hook) continue;
			try {
				await hook(event);
			} catch (error) {
				this.reportFailure(record.extension.name, name, error);
			}
		}
	}

	async context(event: ExtensionContextEvent): Promise<ExtensionContextPatch> {
		let patch: ExtensionContextPatch = {};
		for (const record of this.records.values()) {
			const hook = record.extension.hooks?.context;
			if (!hook) continue;
			try {
				const result = await hook({ ...event, ...patch });
				if (result) patch = { ...patch, ...result };
			} catch (error) {
				this.reportFailure(record.extension.name, "context", error);
			}
		}
		return patch;
	}

	async toolCall(event: ExtensionToolCallEvent): Promise<ExtensionToolCallDecision | undefined> {
		let decision: ExtensionToolCallDecision | undefined;
		for (const record of this.records.values()) {
			const hook = record.extension.hooks?.tool_call;
			if (!hook) continue;
			try {
				const input = decision && "input" in decision ? decision.input : event.toolCall.input;
				const result = await hook({ ...event, toolCall: { ...event.toolCall, input } });
				if (!result) continue;
				if ("block" in result) return result;
				decision = result;
			} catch (error) {
				this.reportFailure(record.extension.name, "tool_call", error);
				return { block: true, reason: `extension ${record.extension.name} failed during tool_call` };
			}
		}
		return decision;
	}

	async toolResult(event: ExtensionToolResultEvent): Promise<ExtensionToolResultPatch> {
		let patch: ExtensionToolResultPatch = {};
		for (const record of this.records.values()) {
			const hook = record.extension.hooks?.tool_result;
			if (!hook) continue;
			try {
				const result = await hook({ ...event, result: { ...event.result, ...patch } });
				if (result) patch = { ...patch, ...result };
			} catch (error) {
				this.reportFailure(record.extension.name, "tool_result", error);
			}
		}
		return patch;
	}

	private toolExists(name: string): boolean {
		for (const record of this.records.values()) {
			if (record.tools.has(name)) return true;
		}
		return false;
	}

	private addTool(record: ExtensionRecord, tool: NativeTool): boolean {
		if (record.tools.has(tool.name)) {
			this.diagnostics.push({
				extension: record.extension.name,
				level: "warn",
				message: `tool ${tool.name} is already registered`,
			});
			return false;
		}
		record.tools.set(tool.name, tool);
		return true;
	}

	private reportFailure(extension: string, hook: string, error: unknown): void {
		this.diagnostics.push({
			extension,
			level: "warn",
			message: `${hook} failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

export function createExtensionRegistry(extensions: KernelExtension[] = []): ExtensionRegistry {
	const registry = new ExtensionRegistry();
	for (const extension of extensions) registry.register(extension);
	return registry;
}

export type { ExtensionHooks };
