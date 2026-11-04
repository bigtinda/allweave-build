import type { NativeTool, NativeToolResult } from "@pi-console/kernel";
import type { AppPluginManager } from "../app-plugins.ts";
import { parseAppPluginManifest } from "../app-plugins.ts";
import { createBrowserTool } from "../browser.ts";
import type { WorkspaceTools } from "../workspaces/workspace-access.ts";

export interface NativeWorkbenchToolInput {
	sessionId: string;
	pluginDevelopment: boolean;
	pluginWorkspaceId: string;
	appPlugins?: AppPluginManager;
	browser?: Parameters<typeof createBrowserTool>[0];
	tools: WorkspaceTools;
	refreshAfterPluginChange: () => Promise<void>;
}

function truncate(value: string, limit = 32_000): string {
	return value.length > limit ? `${value.slice(0, limit)}\n[结果已截断]` : value;
}

function text(value: unknown): NativeToolResult {
	return { content: truncate(JSON.stringify(value, null, 2)) };
}

async function readManifest(input: NativeWorkbenchToolInput, path: string): Promise<string> {
	return new TextDecoder("utf-8").decode(await input.tools.readBuffer(path));
}

/** Server-owned workbench tools exposed to the native loop. */
export async function createNativeWorkbenchTools(input: NativeWorkbenchToolInput): Promise<NativeTool[]> {
	const appPlugins = input.appPlugins;
	const tools: NativeTool[] = [];
	if (input.browser) {
		const browser = createBrowserTool(input.browser, input.sessionId);
		tools.push({
			name: browser.name,
			description: browser.description,
			parameters: browser.parameters as unknown as Record<string, unknown>,
			readOnly: false,
			execute: async (params, context) => {
				const value = await browser.execute(params, context.signal);
				const content = value.content
					.map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type}]`))
					.join("\n");
				return { content, isError: false };
			},
		});
	}
	if (!appPlugins) return tools;
	if (input.pluginDevelopment) {
		tools.push(
			{
				name: "plugin_list",
				description: "List installed app plugins and their manifests.",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				readOnly: true,
				execute: async () => text(await appPlugins.list()),
			},
			{
				name: "plugin_validate",
				description: "Validate a plugin manifest JSON file in the development workspace.",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
					additionalProperties: false,
				},
				readOnly: true,
				execute: async (values) => {
					const manifest = parseAppPluginManifest(await readManifest(input, String(values.path ?? "")));
					return text(await appPlugins.validate(manifest));
				},
			},
			{
				name: "plugin_install",
				description: "Install and enable a validated plugin manifest from the development workspace.",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
					additionalProperties: false,
				},
				readOnly: false,
				execute: async (values) => {
					const manifest = parseAppPluginManifest(await readManifest(input, String(values.path ?? "")));
					await appPlugins.validate(manifest);
					const plugin = await appPlugins.install(manifest);
					await input.refreshAfterPluginChange();
					return text({
						pluginId: manifest.id,
						version: manifest.version,
						status: plugin.enabled ? "enabled" : "disabled",
						pages: manifest.navigation.map((entry) => ({
							title: entry.title,
							path: `/plugins/${manifest.id}/${entry.viewId}?workspace={workspaceId}`,
						})),
					});
				},
			},
		);
	}
	for (const manifest of await appPlugins.enabledManifests()) {
		const prefix = `plugin_${manifest.id.replaceAll("-", "_")}`;
		tools.push(
			{
				name: `${prefix}_list`,
				description: `List ${manifest.name} records in the current workspace.`,
				parameters: { type: "object", properties: {}, additionalProperties: false },
				readOnly: true,
				execute: async () => text(await appPlugins.listRecords(manifest.id, input.pluginWorkspaceId)),
			},
			{
				name: `${prefix}_create`,
				description: `Create a ${manifest.name} record. Use only fields from the plugin schema.`,
				parameters: {
					type: "object",
					properties: { values: { type: "object", additionalProperties: true } },
					required: ["values"],
					additionalProperties: false,
				},
				readOnly: false,
				execute: async (values) =>
					text(
						await appPlugins.createRecord(
							manifest.id,
							input.pluginWorkspaceId,
							(values.values as Record<string, unknown>) ?? {},
						),
					),
			},
			{
				name: `${prefix}_update`,
				description: `Update a ${manifest.name} record by id.`,
				parameters: {
					type: "object",
					properties: {
						id: { type: "string" },
						values: { type: "object", additionalProperties: true },
					},
					required: ["id", "values"],
					additionalProperties: false,
				},
				readOnly: false,
				execute: async (values) =>
					text(
						await appPlugins.updateRecord(
							manifest.id,
							input.pluginWorkspaceId,
							String(values.id ?? ""),
							(values.values as Record<string, unknown>) ?? {},
						),
					),
			},
			{
				name: `${prefix}_delete`,
				description: `Delete a ${manifest.name} record by id.`,
				parameters: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
					additionalProperties: false,
				},
				readOnly: false,
				execute: async (values) => {
					await appPlugins.deleteRecord(manifest.id, input.pluginWorkspaceId, String(values.id ?? ""));
					return text({ deleted: true });
				},
			},
		);
	}
	return tools;
}
