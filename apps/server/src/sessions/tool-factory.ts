import { join } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	defineTool,
	type InlineExtension,
	type ToolDefinition,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AccessMode, Workspace } from "../../../shared/src/protocol.ts";
import { type AppPluginManager, parseAppPluginManifest } from "../app-plugins.ts";
import { type BrowserService, createBrowserTool } from "../browser.ts";
import type { RemoteWorkspaceService } from "../remote-workspaces.ts";
import { HttpError } from "../security.ts";
import { toolPermission } from "../tool-policy.ts";
import { workspaceCommandOperations } from "../workspaces/command-operations.ts";
import type { WorkspaceTools } from "../workspaces/workspace-access.ts";

function createPiBrowserTool(service: BrowserService, sessionId: string) {
	const browser = createBrowserTool(service, sessionId);
	return defineTool({
		name: browser.name,
		label: "内置浏览器",
		description: browser.description,
		parameters: Type.Unsafe<Record<string, unknown>>(browser.parameters),
		async execute(_toolCallId, params, signal) {
			const value = await browser.execute(params as Record<string, unknown>, signal);
			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
			for (const item of value.content) {
				if (item.type === "text") content.push({ type: "text", text: item.text ?? "" });
				else if (item.data && item.mimeType)
					content.push({ type: "image", data: item.data, mimeType: item.mimeType });
			}
			return { content, details: value.details };
		},
	});
}

export interface ToolFactoryInput {
	sessionId: string;
	workspace: Workspace;
	cwd: string;
	/** File access boundary shared with the HTTP API. */
	tools: WorkspaceTools;
	pluginDevelopment: boolean;
	remote?: RemoteWorkspaceService;
	browser: BrowserService;
	appPlugins?: AppPluginManager;
	pluginWorkspaceId: string;
	accessMode: () => AccessMode;
	requestApproval: (toolCallId: string, name: string, input: unknown) => Promise<boolean>;
	refreshAfterPluginChange: () => Promise<void>;
}

export interface ToolFactoryResult {
	/** File and command tools handed to the Pi session. */
	customTools: ToolDefinition[];
	/** Extensions that register the workbench tools and the safety hook. */
	extensionFactories: InlineExtension[];
	/** Tool names available to plugin development sessions. */
	pluginDevelopmentToolNames: string[];
}

/**
 * Assemble the Pi tool set for one session: file tools bound to the workspace
 * access boundary, the remote command tool and the workbench plugin tools.
 */
export async function createWorkbenchTools(input: ToolFactoryInput): Promise<ToolFactoryResult> {
	const { cwd, tools, workspace, pluginDevelopment } = input;
	const checkedRead = async (path: string) => tools.readBuffer(path);
	const checkedAccess = async (path: string) => {
		await tools.access(path);
	};
	const checkedWrite = async (path: string, content: string) => {
		await tools.write(path, content);
	};
	const customTools: ToolDefinition[] = [
		// SDK customTools erases schema types, but renderers are contravariant under strict TS.
		// These casts bridge that SDK boundary; each factory retains its runtime schema validation.
		createReadToolDefinition(cwd, {
			operations: {
				readFile: checkedRead,
				access: checkedAccess,
				detectImageMimeType: (path) => tools.imageMimeType(path),
			},
		}) as unknown as ToolDefinition,
		createEditToolDefinition(cwd, {
			operations: { readFile: checkedRead, access: checkedAccess, writeFile: checkedWrite },
		}) as unknown as ToolDefinition,
		createWriteToolDefinition(cwd, {
			operations: {
				writeFile: checkedWrite,
				mkdir: (path) => tools.mkdir(path),
			},
		}) as unknown as ToolDefinition,
	];
	const commandOperations = workspaceCommandOperations(workspace, cwd, input.remote);
	if (commandOperations) {
		customTools.push(
			createBashToolDefinition(cwd, {
				operations: commandOperations,
			}) as unknown as ToolDefinition,
		);
		// Remote tools receive host paths; translate them to project-relative paths
		// and serialize mutations per remote file.
		for (const tool of customTools) {
			if (!["read", "write", "edit"].includes(tool.name)) continue;
			const execute = tool.execute;
			tool.execute = async (toolCallId, params, signal, onUpdate, context) => {
				const toolInput = params as Record<string, unknown>;
				if (typeof toolInput.path !== "string") throw new HttpError(400, "文件路径无效");
				const checked = await tools.check(toolInput.path, tool.name === "write", signal);
				const args = { ...toolInput, path: join(...checked.relative.split(checked.paths.sep)) };
				if (tool.name === "read") return execute(toolCallId, args, signal, onUpdate, context);
				return withFileMutationQueue(checked.mutationKey, () =>
					execute(toolCallId, args, signal, onUpdate, context),
				);
			};
		}
	}
	const extensionFactories: InlineExtension[] = [
		async (pi) => {
			const pluginReadOnlyTools = new Set<string>();
			if (pluginDevelopment) {
				pluginReadOnlyTools.add("plugin_list");
				pluginReadOnlyTools.add("plugin_validate");
			}
			pi.on("tool_call", async (event) => {
				const toolInput = event.input as Record<string, unknown>;
				if (["read", "write", "edit", "ls", "find", "grep"].includes(event.toolName)) {
					try {
						const path = typeof toolInput.path === "string" ? toolInput.path : ".";
						await tools.check(path, event.toolName === "write");
					} catch (error) {
						return { block: true, reason: error instanceof Error ? error.message : "Path denied" };
					}
				}
				// Even innocuous shell commands can invoke scripts. Confirm every command, mutation,
				// and custom tool instead of trying to identify danger with command-string heuristics.
				const permission = toolPermission(input.accessMode(), event.toolName, pluginReadOnlyTools);
				if (permission === "deny") {
					return { block: true, reason: "计划模式仅允许只读工具。切换权限模式后再执行此操作。" };
				}
				if (permission === "ask") {
					const approved = await input.requestApproval(event.toolCallId, event.toolName, toolInput);
					if (!approved)
						return {
							block: true,
							reason: "User denied or cancelled this tool call",
							terminate: true,
						};
				}
				return undefined;
			});
			if (pluginDevelopment) {
				const appPlugins = input.appPlugins;
				if (!appPlugins) return;
				const readManifest = async (path: string) => new TextDecoder("utf-8").decode(await tools.readBuffer(path));
				pi.registerTool({
					name: "plugin_list",
					label: "查看已安装插件",
					description: "列出已安装应用插件及其清单，用于规划插件新增或升级。",
					parameters: Type.Object({}, { additionalProperties: false }),
					async execute() {
						const registry = await appPlugins.list();
						return {
							content: [{ type: "text", text: JSON.stringify(registry, null, 2) }],
							details: { revision: registry.revision, plugins: registry.plugins.length },
						};
					},
				});
				pi.registerTool({
					name: "plugin_validate",
					label: "校验插件清单",
					description: "读取开发工作区中的插件 JSON 清单并检查协议、版本和数据兼容性。",
					parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
					async execute(_toolCallId, params) {
						const manifest = parseAppPluginManifest(await readManifest(params.path));
						const result = await appPlugins.validate(manifest);
						return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
					},
				});
				pi.registerTool({
					name: "plugin_install",
					label: "安装应用插件",
					description: "在用户确认后安装并启用开发工作区中的有效插件清单。",
					parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
					async execute(_toolCallId, params) {
						const manifest = parseAppPluginManifest(await readManifest(params.path));
						await appPlugins.validate(manifest);
						const plugin = await appPlugins.install(manifest);
						await input.refreshAfterPluginChange();
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											pluginId: manifest.id,
											version: manifest.version,
											status: plugin.enabled ? "enabled" : "disabled",
											pages: manifest.navigation.map((entry) => ({
												title: entry.title,
												path: `/plugins/${manifest.id}/${entry.viewId}?workspace={workspaceId}`,
											})),
										},
										null,
										2,
									),
								},
							],
							details: { pluginId: manifest.id, version: manifest.version },
						};
					},
				});
			}
			if (!pluginDevelopment) pi.registerTool(createPiBrowserTool(input.browser, input.sessionId));
			const appPlugins = input.appPlugins;
			if (!appPlugins) return;
			for (const manifest of await appPlugins.enabledManifests()) {
				const prefix = `plugin_${manifest.id.replaceAll("-", "_")}`;
				const valuesSchema = Type.Record(Type.String(), Type.Unknown());
				for (const operation of ["list", "create", "update", "delete"] as const) {
					const parameters =
						operation === "list"
							? Type.Object({}, { additionalProperties: false })
							: operation === "create"
								? Type.Object({ values: valuesSchema }, { additionalProperties: false })
								: operation === "update"
									? Type.Object({ id: Type.String(), values: valuesSchema }, { additionalProperties: false })
									: Type.Object({ id: Type.String() }, { additionalProperties: false });
					if (operation === "list") pluginReadOnlyTools.add(`${prefix}_list`);
					pi.registerTool({
						name: `${prefix}_${operation}`,
						label: `${manifest.name} · ${operation}`,
						description: `${manifest.description || manifest.name}. ${operation} records in the current workspace; use only fields from the plugin schema.`,
						promptSnippet: `Manage ${manifest.name} records in the current workspace.`,
						promptGuidelines: [`Use ${prefix}_list to inspect records before changing them.`],
						parameters,
						async execute(_toolCallId, params) {
							const toolParams = params as { id?: string; values?: Record<string, unknown> };
							let result: unknown;
							if (operation === "list")
								result = await appPlugins.listRecords(manifest.id, input.pluginWorkspaceId);
							else if (operation === "create")
								result = await appPlugins.createRecord(
									manifest.id,
									input.pluginWorkspaceId,
									toolParams.values ?? {},
								);
							else if (operation === "update")
								result = await appPlugins.updateRecord(
									manifest.id,
									input.pluginWorkspaceId,
									toolParams.id ?? "",
									toolParams.values ?? {},
								);
							else {
								await appPlugins.deleteRecord(manifest.id, input.pluginWorkspaceId, toolParams.id ?? "");
								result = { deleted: true };
							}
							const serialized = JSON.stringify(result);
							return {
								content: [
									{
										type: "text",
										text:
											serialized.length > 32_000
												? `${serialized.slice(0, 32_000)}\n[结果已截断]`
												: serialized,
									},
								],
								details: { pluginId: manifest.id, operation },
							};
						},
					});
				}
			}
		},
	];
	const pluginDevelopmentToolNames = pluginDevelopment
		? ((await input.appPlugins?.enabledManifests())?.flatMap((manifest) => {
				const prefix = `plugin_${manifest.id.replaceAll("-", "_")}`;
				return [`${prefix}_list`, `${prefix}_create`, `${prefix}_update`, `${prefix}_delete`];
			}) ?? [])
		: [];
	return { customTools, extensionFactories, pluginDevelopmentToolNames };
}
