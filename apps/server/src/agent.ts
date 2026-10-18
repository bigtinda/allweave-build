import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { isModelType } from "@earendil-works/pi-ai/utils/model-operations";
import {
	type AgentSession,
	type createAgentSession,
	createBashToolDefinition,
	createCodemodeExtension,
	createEditToolDefinition,
	createMcpExtension,
	createReadToolDefinition,
	createToolSearchExtension,
	createWriteToolDefinition,
	DefaultResourceLoader,
	defaultModelPerProvider,
	detectSupportedImageMimeTypeFromFile,
	getAgentDir,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AccessMode,
	type Approval,
	applyEvent,
	type ChatMessage,
	type ModelOption,
	type Resources,
	type SessionDetail,
	type SessionEvent,
	type SessionPurpose,
	type SessionSummary,
	type ThinkingLevel,
	type Workspace,
} from "../../shared/src/protocol.ts";
import { type AdaptedEvent, adaptSdkEvent } from "./adapter.ts";
import { type AppPluginManager, parseAppPluginManifest } from "./app-plugins.ts";
import { BrowserService, createBrowserTool } from "./browser.ts";
import { captureGitSnapshot, changedGitFiles, type GitSnapshot } from "./git.ts";
import { prepareDoomCordisHostExtension } from "./kernel.ts";
import type { ProviderManager } from "./providers.ts";
import type { RemoteWorkspaceService } from "./remote-workspaces.ts";
import { HttpError, workspacePath } from "./security.ts";
import type { ConsoleStore, SavedSession } from "./store.ts";
import { toolPermission } from "./tool-policy.ts";

function remoteImageMimeType(path: string): string | undefined {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".bmp":
			return "image/bmp";
		default:
			return undefined;
	}
}

interface PendingApproval {
	sessionId: string;
	resolve: (approved: boolean) => void;
}

export class AgentService {
	private store: ConsoleStore;
	private directory: string;
	private records = new Map<string, SavedSession>();
	private agents = new Map<string, Promise<AgentSession>>();
	private busy = new Set<string>();
	private cancelled = new Set<string>();
	private runs = new Map<string, Promise<void>>();
	private updating = new Set<string>();
	private refreshing = new Set<string>();
	private pendingPluginRefresh = new Set<string>();
	private inputs = new Map<string, { prompt: string; text: string; references: string[] }>();
	private listeners = new Map<string, Set<(event: SessionEvent) => void>>();
	private approvals = new Map<string, PendingApproval>();
	private closing = false;
	private createSession?: typeof createAgentSession;
	private providers?: ProviderManager;
	private agentDirectory: string;
	private browser: BrowserService;
	private appPlugins?: AppPluginManager;
	private remoteWorkspaces?: RemoteWorkspaceService;

	constructor(
		store: ConsoleStore,
		directory: string,
		options: {
			createSession?: typeof createAgentSession;
			providers?: ProviderManager;
			agentDirectory?: string;
			browser?: BrowserService;
			appPlugins?: AppPluginManager;
			remoteWorkspaces?: RemoteWorkspaceService;
		} = {},
	) {
		this.store = store;
		this.directory = directory;
		this.createSession = options.createSession;
		this.providers = options.providers;
		this.agentDirectory = options.agentDirectory ?? getAgentDir();
		this.browser = options.browser ?? new BrowserService();
		this.appPlugins = options.appPlugins;
		this.remoteWorkspaces = options.remoteWorkspaces;
		for (const record of store.sessions()) {
			record.detail.accessMode ??= "ask";
			record.detail.status = "idle";
			record.detail.approvals = [];
			for (const tool of record.detail.tools) {
				if (tool.status === "running" || tool.status === "approval") {
					tool.status = "failed";
					tool.output = "Server restarted before execution completed";
				}
			}
			for (const message of record.detail.messages) message.complete = true;
			this.records.set(record.detail.id, record);
			store.saveSession(record.detail, record.file);
		}
	}

	list(): SessionSummary[] {
		return [...this.records.values()]
			.map((record) => this.summary(record.detail))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	private summary(detail: SessionDetail): SessionSummary {
		const { id, workspaceId, title, purpose, status, updatedAt, model, thinkingLevel } = detail;
		return {
			id,
			workspaceId,
			title,
			purpose,
			status,
			updatedAt,
			model,
			thinkingLevel,
			accessMode: detail.accessMode,
		};
	}
	get(id: string): SessionDetail {
		const record = this.records.get(id);
		if (!record) throw new HttpError(404, "Session not found");
		return record.detail;
	}
	private workspace(id: string): Workspace {
		const workspace = this.store.workspaces().find((item) => item.id === id);
		if (!workspace) throw new HttpError(404, "Workspace not found");
		return workspace;
	}
	async create(workspaceId: string, title: string, purpose?: SessionPurpose): Promise<SessionDetail> {
		this.workspace(workspaceId);
		const detail: SessionDetail = {
			id: randomUUID(),
			workspaceId,
			title,
			...(purpose ? { purpose } : {}),
			status: "idle",
			updatedAt: new Date().toISOString(),
			thinkingLevel: "medium",
			accessMode: "ask",
			messages: [],
			tools: [],
			approvals: [],
			activity: [],
			sequence: 0,
		};
		this.records.set(detail.id, { detail });
		this.store.saveSession(detail);
		return this.get(detail.id);
	}
	async createPluginDevelopmentSession(workspaceId: string, title: string): Promise<SessionDetail> {
		return this.create(workspaceId, title, "plugin-development");
	}
	private selectInitialModel(id: string, models: ModelOption[]): void {
		const detail = this.get(id);
		if (detail.model) return;
		const available = models.filter((model) => model.available);
		if (!available.length) return;
		const workspace = this.workspace(detail.workspaceId);
		const settingsCwd =
			detail.purpose === "plugin-development"
				? this.directory
				: workspace.remote
					? join(this.directory, "remote-projects", workspace.id)
					: workspace.path;
		const settings = SettingsManager.create(settingsCwd, this.agentDirectory);
		const defaultProvider = settings.getDefaultProvider();
		const defaultModelId = settings.getDefaultModel();
		const preferred =
			defaultProvider && defaultModelId
				? available.find((model) => model.provider === defaultProvider && model.id === defaultModelId)
				: undefined;
		const model =
			preferred ??
			Object.entries(defaultModelPerProvider)
				.map(([provider, modelId]) =>
					available.find((candidate) => candidate.provider === provider && candidate.id === modelId),
				)
				.find((candidate) => candidate !== undefined) ??
			available[0];
		detail.model = model;
		detail.thinkingLevel =
			settings.getModelThinkingLevel(model.provider, model.id) ?? settings.getDefaultThinkingLevel() ?? "medium";
		this.emit(id, { type: "session.updated" });
	}
	private agent(id: string): Promise<AgentSession> {
		this.get(id);
		const existing = this.agents.get(id);
		if (existing) return existing;
		const creating = this.initialize(id).catch((error) => {
			this.agents.delete(id);
			throw error;
		});
		this.agents.set(id, creating);
		return creating;
	}
	async prepareForProviderChange(): Promise<void> {
		if (this.busy.size > 0 || this.updating.size > 0)
			throw new HttpError(409, "请先停止运行中的会话，再修改供应商凭据");
		for (const pending of this.agents.values()) await this.disposeAgent(await pending, "reload");
		this.agents.clear();
	}
	private async disposeAgent(session: AgentSession, reason: "quit" | "reload"): Promise<void> {
		try {
			await session.extensionRunner.emit({ type: "session_shutdown", reason });
		} finally {
			session.dispose();
		}
	}
	async refreshIdleAgentsForPluginChange(): Promise<void> {
		for (const id of this.agents.keys()) {
			this.pendingPluginRefresh.add(id);
			await this.refreshAgentAfterPluginChange(id);
		}
	}
	private async refreshAgentAfterPluginChange(id: string): Promise<void> {
		if (!this.pendingPluginRefresh.has(id)) return;
		if (this.busy.has(id) || this.updating.has(id)) {
			this.pendingPluginRefresh.add(id);
			return;
		}
		const pending = this.agents.get(id);
		if (!pending) {
			this.pendingPluginRefresh.delete(id);
			return;
		}
		this.refreshing.add(id);
		try {
			let session: AgentSession;
			try {
				session = await pending;
			} catch {
				if (this.agents.get(id) === pending) this.agents.delete(id);
				this.pendingPluginRefresh.delete(id);
				return;
			}
			if (this.busy.has(id) || this.updating.has(id)) {
				this.pendingPluginRefresh.add(id);
				return;
			}
			if (this.agents.get(id) !== pending) return;
			this.agents.delete(id);
			this.pendingPluginRefresh.delete(id);
			await this.disposeAgent(session, "reload");
		} finally {
			this.refreshing.delete(id);
		}
	}
	private async initialize(id: string): Promise<AgentSession> {
		if (!this.createSession) throw new Error("会话工厂不可用");
		const record = this.records.get(id);
		if (!record) throw new HttpError(404, "Session not found");
		const workspace = this.workspace(record.detail.workspaceId);
		const pluginDevelopment = record.detail.purpose === "plugin-development";
		const remoteWorkspace = workspace.remote !== undefined;
		const remoteService = this.remoteWorkspaces;
		if (remoteWorkspace && !remoteService) throw new HttpError(501, "远程主机服务不可用");
		const remoteEnvironment = remoteWorkspace ? await remoteService!.workspaceEnvironment(workspace) : undefined;
		const resourceCwd = remoteWorkspace ? join(this.directory, "remote-projects", workspace.id) : workspace.path;
		if (remoteWorkspace) await mkdir(resourceCwd, { recursive: true });
		if (remoteWorkspace) await remoteService!.prepareMcpConfigs(workspace, resourceCwd);
		const cwd = remoteWorkspace ? resourceCwd : workspace.path;
		if (pluginDevelopment) await mkdir(workspace.path, { recursive: true });
		const agentDir = this.agentDirectory;
		const settingsManager = SettingsManager.create(pluginDevelopment ? this.directory : cwd, agentDir);
		// Workspace authorization also trusts its configuration/extensions. They execute native server code.
		if (!pluginDevelopment) settingsManager.setProjectTrusted(true);
		const cordisHostPath = pluginDevelopment ? undefined : await prepareDoomCordisHostExtension(agentDir);
		const appPlugins = this.appPlugins;
		const agentService = this;
		const pluginWorkspaceId = record.detail.workspaceId;
		const remoteExtensions: InlineExtension[] = remoteWorkspace
			? [
					{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
					{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
					{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
				]
			: [];
		const resourceLoader = new DefaultResourceLoader({
			cwd: resourceCwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: cordisHostPath ? [cordisHostPath] : [],
			noExtensions: pluginDevelopment,
			noSkills: pluginDevelopment,
			noPromptTemplates: pluginDevelopment,
			noThemes: pluginDevelopment,
			noContextFiles: pluginDevelopment,
			systemPrompt: pluginDevelopment
				? "你是 AllWeave Build 的插件开发助手。用户直接在主聊天框描述需求，你在此默认插件开发工作区中协作。你可以读取、编辑和写入此工作区中的插件 JSON 清单；不能运行 shell、脚本或其他程序。清单路径使用 plugins/<plugin-id>.json。先调用 plugin_list 了解已安装插件，再按需要创建或升级清单；调用 plugin_validate 检查协议、版本和数据字段兼容性。只有用户明确要求安装或启用时才调用 plugin_install，该操作会请求用户确认。插件目前使用声明式 manifestVersion 1：字段驱动表单，页面使用 table 或 board 视图，navigation 生成软件侧栏入口；不得编造脚本执行能力。升级时必须提高版本号并保留现有字段 ID、类型、必填状态和选项。"
				: workspace.remote
					? `你正在 SSH 远程主机 ${workspace.remote.host} 的项目 ${workspace.path} 中工作。read、edit、write 和 bash 工具会在该远程项目中执行。文件工具请使用相对于项目根目录的路径。`
					: undefined,
			appendSystemPrompt: pluginDevelopment ? [] : undefined,
			extensionFactories: [
				...remoteExtensions,
				async (pi) => {
					const pluginReadOnlyTools = new Set<string>();
					if (pluginDevelopment) {
						pluginReadOnlyTools.add("plugin_list");
						pluginReadOnlyTools.add("plugin_validate");
					}
					pi.on("tool_call", async (event) => {
						const input = event.input as Record<string, unknown>;
						if (["read", "write", "edit", "ls", "find", "grep"].includes(event.toolName)) {
							try {
								const path = typeof input.path === "string" ? input.path : ".";
								if (remoteWorkspace) {
									await remoteService!.checkedPath(workspace, path, event.toolName === "write");
								} else {
									await workspacePath(cwd, path, event.toolName === "write");
								}
							} catch (error) {
								return { block: true, reason: error instanceof Error ? error.message : "Path denied" };
							}
						}
						// Even innocuous shell commands can invoke scripts. Confirm every command, mutation,
						// and custom tool instead of trying to identify danger with command-string heuristics.
						const permission = toolPermission(this.get(id).accessMode, event.toolName, pluginReadOnlyTools);
						if (permission === "deny") {
							return { block: true, reason: "计划模式仅允许只读工具。切换权限模式后再执行此操作。" };
						}
						if (permission === "ask") {
							const approved = await this.requestApproval(id, event.toolCallId, event.toolName, input);
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
						if (!appPlugins) return;
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
								const path = await workspacePath(cwd, params.path);
								const manifest = parseAppPluginManifest(await readFile(path, "utf8"));
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
								const path = await workspacePath(cwd, params.path);
								const manifest = parseAppPluginManifest(await readFile(path, "utf8"));
								await appPlugins.validate(manifest);
								const plugin = await appPlugins.install(manifest);
								await agentService.refreshIdleAgentsForPluginChange();
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
					if (!pluginDevelopment) pi.registerTool(createBrowserTool(this.browser, id));
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
											? Type.Object(
													{ id: Type.String(), values: valuesSchema },
													{ additionalProperties: false },
												)
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
									const input = params as { id?: string; values?: Record<string, unknown> };
									let result: unknown;
									if (operation === "list")
										result = await appPlugins.listRecords(manifest.id, pluginWorkspaceId);
									else if (operation === "create")
										result = await appPlugins.createRecord(
											manifest.id,
											pluginWorkspaceId,
											input.values ?? {},
										);
									else if (operation === "update")
										result = await appPlugins.updateRecord(
											manifest.id,
											pluginWorkspaceId,
											input.id ?? "",
											input.values ?? {},
										);
									else {
										await appPlugins.deleteRecord(manifest.id, pluginWorkspaceId, input.id ?? "");
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
			],
		});
		await resourceLoader.reload();
		const pluginDevelopmentToolNames =
			pluginDevelopment && appPlugins
				? (await appPlugins.enabledManifests()).flatMap((manifest) => {
						const prefix = `plugin_${manifest.id.replaceAll("-", "_")}`;
						return [`${prefix}_list`, `${prefix}_create`, `${prefix}_update`, `${prefix}_delete`];
					})
				: [];
		const checkedRead = async (path: string) =>
			remoteWorkspace
				? remoteService!.readBuffer(workspace, await remoteService!.toolPath(workspace, cwd, path))
				: readFile(await workspacePath(cwd, path));
		const checkedAccess = async (path: string) => {
			if (remoteWorkspace) {
				await remoteService!.checkedPath(workspace, await remoteService!.toolPath(workspace, cwd, path));
				return;
			}
			await access(await workspacePath(cwd, path));
		};
		const checkedWrite = async (path: string, content: string) => {
			if (remoteWorkspace) {
				await remoteService!.writeFile(workspace, await remoteService!.toolPath(workspace, cwd, path), content);
				return;
			}
			await writeFile(await workspacePath(cwd, path, true), content, "utf8");
		};
		const sessionManager = record.file
			? SessionManager.open(record.file, join(this.directory, "sessions"), cwd)
			: SessionManager.create(cwd, join(this.directory, "sessions"));
		const customTools: ToolDefinition[] = [
			// SDK customTools erases schema types, but renderers are contravariant under strict TS.
			// These casts bridge that SDK boundary; each factory retains its runtime schema validation.
			createReadToolDefinition(cwd, {
				operations: {
					readFile: checkedRead,
					access: checkedAccess,
					detectImageMimeType: async (path) => {
						if (remoteWorkspace) {
							const remotePath = await remoteService!.toolPath(workspace, cwd, path);
							return remoteImageMimeType(remotePath);
						}
						return detectSupportedImageMimeTypeFromFile(await workspacePath(cwd, path));
					},
				},
			}) as unknown as ToolDefinition,
			createEditToolDefinition(cwd, {
				operations: { readFile: checkedRead, access: checkedAccess, writeFile: checkedWrite },
			}) as unknown as ToolDefinition,
			createWriteToolDefinition(cwd, {
				operations: {
					writeFile: checkedWrite,
					mkdir: async (path) => {
						if (remoteWorkspace) {
							await remoteService!.createDirectory(
								workspace,
								await remoteService!.toolPath(workspace, cwd, path),
							);
						} else await mkdir(await workspacePath(cwd, path, true), { recursive: true });
					},
				},
			}) as unknown as ToolDefinition,
		];
		if (remoteEnvironment) {
			for (const tool of customTools) {
				const execute = tool.execute;
				tool.execute = async (toolCallId, params, signal, onUpdate, context) => {
					const input = params as Record<string, unknown>;
					if (typeof input.path !== "string") throw new HttpError(400, "文件路径无效");
					const checked = await remoteService!.checkedPath(workspace, input.path, tool.name === "write", signal);
					const relativePath = checked.paths.relative(workspace.path, checked.path);
					const args = { ...input, path: join(...relativePath.split(checked.paths.sep)) };
					if (tool.name === "read") return execute(toolCallId, args, signal, onUpdate, context);
					return withFileMutationQueue(remoteService!.mutationKey(workspace, checked.path, checked.paths), () =>
						execute(toolCallId, args, signal, onUpdate, context),
					);
				};
			}
			customTools.push(
				createBashToolDefinition(cwd, {
					operations: {
						exec: async (command, workingDirectory, { onData, signal, timeout }) => {
							const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
							const remoteCwd = await remoteService!.toolPath(workspace, cwd, workingDirectory);
							const checked = await remoteService!.checkedPath(workspace, remoteCwd);
							const result = await checked.env.exec(
								command,
								{
									cwd: remoteCwd,
									timeout,
									onOutput: (text) => onData(Buffer.from(text)),
								},
								context,
							);
							if (!result.ok) throw result.error;
							return { exitCode: result.value.exitCode };
						},
					},
				}) as unknown as ToolDefinition,
			);
		}
		const { session, modelFallbackMessage } = await this.createSession({
			cwd,
			agentDir,
			resourceLoader,
			settingsManager,
			sessionManager,
			...(pluginDevelopment
				? {
						tools: [
							"read",
							"edit",
							"write",
							"plugin_list",
							"plugin_validate",
							"plugin_install",
							...pluginDevelopmentToolNames,
						],
						noTools: "all" as const,
					}
				: remoteWorkspace
					? {
							noTools: "builtin" as const,
							tools: ["+read", "+bash", "+edit", "+write"],
							excludeTools: ["ls", "find", "grep"],
						}
					: {}),
			customTools,
		});
		try {
			await session.bindExtensions({
				mode: "rpc",
				onError: (error) => this.emit(id, { type: "agent.error", error: error.error }),
			});
			record.file = sessionManager.getSessionFile();
			const selectedModel = session.modelRuntime
				.getAvailableSnapshot()
				.find((model) => model.provider === session.model?.provider && model.id === session.model?.id);
			record.detail.model = selectedModel ? this.modelOption(selectedModel) : undefined;
			record.detail.thinkingLevel = session.thinkingLevel;
			record.detail.error = modelFallbackMessage;
			this.store.saveSession(record.detail, record.file);
			session.subscribe((event) => {
				const adapted = adaptSdkEvent(event, this.get(id));
				if (!adapted) return;
				if (adapted.message?.role === "user") {
					const input = this.inputs.get(id);
					adapted.message.input =
						input?.prompt === adapted.message.text
							? { text: input.text, references: input.references }
							: this.get(id).messages.find((message) => message.id === adapted.message?.id)?.input;
				}
				if (event.type === "agent_start") this.get(id).status = "running";
				// prompt's finally owns idle status: agent_end can precede extension settlement.
				if (event.type === "agent_end") {
					const stats = session.getSessionStats();
					this.get(id).tokens = { ...stats.tokens, cost: stats.cost };
				}
				if (adapted.error) this.get(id).status = "error";
				this.emit(id, adapted);
			});
			this.emit(id, { type: "session.updated" });
			return session;
		} catch (error) {
			await this.disposeAgent(session, "quit");
			throw error;
		}
	}

	private promptForAccessMode(id: string, text: string): string {
		if (this.get(id).accessMode !== "plan") return text;
		return `计划模式已启用。请先分析任务并给出清晰的实施计划；可以使用只读工具检查工作区，但不要修改文件、运行命令或调用会改变外部状态的工具。等用户明确确认计划后，再切换权限模式执行。\n\n${text}`;
	}
	private modelOption(model: { id: string; provider: string; name: string; reasoning: boolean }): ModelOption {
		return { id: model.id, provider: model.provider, name: model.name, reasoning: model.reasoning, available: true };
	}
	private emit(id: string, change: AdaptedEvent): void {
		const detail = this.get(id);
		detail.updatedAt = new Date().toISOString();
		if (change.error) detail.error = change.error;
		const event = this.store.append({
			...change,
			sessionId: id,
			messageId:
				change.message?.id ??
				(change.tool ? (detail.messages.findLast((message) => message.role === "assistant")?.id ?? null) : null),
			timestamp: detail.updatedAt,
			summary: this.summary(detail),
			approvals: [...detail.approvals],
			tokens: detail.tokens,
			error: detail.error,
		});
		const updated = applyEvent(detail, event);
		const record = this.records.get(id)!;
		record.detail = updated;
		this.store.saveSession(updated, record.file, change.type === "message.delta" || change.type === "tool.updated");
		for (const listener of this.listeners.get(id) ?? []) listener(event);
	}
	subscribe(id: string, listener: (event: SessionEvent) => void): () => void {
		this.get(id);
		const listeners = this.listeners.get(id) ?? new Set();
		listeners.add(listener);
		this.listeners.set(id, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(id);
		};
	}
	async prompt(id: string, text: string, references: string[]): Promise<void> {
		if (this.closing) throw new HttpError(503, "Server is shutting down");
		this.get(id);
		if (this.busy.has(id) || this.updating.has(id) || this.refreshing.has(id))
			throw new HttpError(409, "Agent is already running");
		this.busy.add(id);
		this.cancelled.delete(id);
		let finishRun!: () => void;
		this.runs.set(
			id,
			new Promise<void>((resolve) => {
				finishRun = resolve;
			}),
		);
		let session: AgentSession;
		let fileSnapshot: GitSnapshot | undefined;
		let previousAssistantMessages = new Set<string>();
		try {
			session = await this.agent(id);
			if (!session.model || !this.get(id).model)
				throw new HttpError(400, "未配置模型。请先配置供应商凭据并选择模型。");
			const workspace = this.workspace(this.get(id).workspaceId);
			const pluginDevelopment = this.get(id).purpose === "plugin-development";
			if (pluginDevelopment && references.length) {
				throw new HttpError(400, "插件开发会话不能引用工作区文件");
			}
			if (!pluginDevelopment) {
				for (const reference of references) {
					if (workspace.remote) {
						if (!this.remoteWorkspaces) throw new HttpError(501, "远程主机服务不可用");
						await this.remoteWorkspaces.checkedPath(workspace, reference);
					} else {
						await workspacePath(workspace.path, reference);
					}
				}
			}
			if (this.cancelled.has(id)) throw new HttpError(409, "Task was cancelled before execution");
			if (!pluginDevelopment && !workspace.remote)
				fileSnapshot = await captureGitSnapshot(workspace.path).catch(() => undefined);
			previousAssistantMessages = new Set(
				this.get(id)
					.messages.filter((message) => message.role === "assistant")
					.map((message) => message.id),
			);
			// A reference asks the agent to inspect an authorized file, without uploading host paths.
			const prompt =
				this.promptForAccessMode(id, text) +
				(references.length
					? `\n\nWorkspace file references:\n${references.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`
					: "");
			this.get(id).error = undefined;
			this.get(id).status = "running";
			this.inputs.set(id, { prompt, text, references: [...references] });
			this.emit(id, { type: "agent.status" });
			void session
				.prompt(prompt)
				.catch((error) => {
					this.get(id).status = "error";
					this.emit(id, { type: "agent.error", error: error instanceof Error ? error.message : String(error) });
				})
				.finally(async () => {
					try {
						if (fileSnapshot) {
							const currentSnapshot = await captureGitSnapshot(workspace.path).catch(() => undefined);
							if (currentSnapshot) {
								const changedFiles = await changedGitFiles(fileSnapshot, currentSnapshot).catch(() => []);
								const message = this.get(id).messages.findLast(
									(candidate) =>
										candidate.role === "assistant" && !previousAssistantMessages.has(candidate.id),
								);
								if (message && changedFiles.length)
									this.emit(id, {
										type: "message.completed",
										message: { ...message, changedFiles },
									});
							}
						}
					} finally {
						this.resolveApprovals(id);
						this.busy.delete(id);
						this.cancelled.delete(id);
						this.inputs.delete(id);
						this.runs.delete(id);
						finishRun();
						const detail = this.get(id);
						const stats = session.getSessionStats();
						detail.tokens = { ...stats.tokens, cost: stats.cost };
						await this.refreshAgentAfterPluginChange(id);
						if (detail.status !== "error") detail.status = "idle";
						this.emit(id, { type: "agent.status" });
					}
				});
		} catch (error) {
			this.busy.delete(id);
			this.cancelled.delete(id);
			this.runs.delete(id);
			finishRun();
			await this.refreshAgentAfterPluginChange(id);
			throw error;
		}
	}
	async abort(id: string): Promise<void> {
		this.get(id);
		const run = this.runs.get(id);
		if (this.busy.has(id)) this.cancelled.add(id);
		this.resolveApprovals(id);
		const pending = this.agents.get(id);
		if (pending) await (await pending).abort();
		await run;
	}
	async interrupt(id: string, text: string, references: string[]): Promise<void> {
		this.get(id);
		if (this.updating.has(id)) throw new HttpError(409, "会话正在更新，请稍后重试");
		this.updating.add(id);
		try {
			const workspace = this.workspace(this.get(id).workspaceId);
			for (const reference of references) await workspacePath(workspace.path, reference);
			await this.abort(id);
		} finally {
			this.updating.delete(id);
			await this.refreshAgentAfterPluginChange(id);
		}
		await this.prompt(id, text, references);
	}
	private findBranchMessageEntry(session: AgentSession, target: ChatMessage) {
		return session.sessionManager.getBranch().findLast((entry) => {
			if (entry.type !== "message" || entry.message.role !== target.role) return false;
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("");
			return entry.message.timestamp === Date.parse(target.timestamp) && text === target.text;
		});
	}
	private async navigateToMessage(
		id: string,
		messageId: string,
		role: ChatMessage["role"],
	): Promise<{ target: ChatMessage; session: SessionDetail; editorText: string | undefined }> {
		const target = this.get(id).messages.find((message) => message.id === messageId && message.role === role);
		if (!target) throw new HttpError(404, role === "user" ? "用户消息不存在" : "AI 回复不存在");
		await this.abort(id);
		const session = await this.agent(id);
		const entry = this.findBranchMessageEntry(session, target);
		if (!entry) throw new HttpError(409, "消息不在当前 Pi 会话分支中");
		const result = await session.navigateTree(entry.id, { summarize: false });
		if (result.cancelled) throw new HttpError(409, "扩展取消了会话分支操作");
		// Persist the selected branch point so a restart restores the same active path.
		session.sessionManager.appendCustomEntry("pi-console.navigation", { messageId, role });
		const detail = this.get(id);
		const index = detail.messages.findIndex((message) => message.id === messageId);
		detail.messages = detail.messages.slice(0, index + (role === "assistant" ? 1 : 0));
		const toolIds = new Set(
			session.sessionManager
				.getBranch()
				.flatMap((item) =>
					item.type === "message" && item.message.role === "toolResult" ? [item.message.toolCallId] : [],
				),
		);
		detail.tools = detail.tools.filter((tool) => toolIds.has(tool.id));
		detail.status = "idle";
		detail.error = undefined;
		const stats = session.getSessionStats();
		detail.tokens = { ...stats.tokens, cost: stats.cost };
		this.emit(id, {
			type: role === "user" ? "conversation.rewound" : "conversation.branched",
			conversation: { messages: detail.messages, tools: detail.tools },
		});
		return { target, session: this.get(id), editorText: result.editorText };
	}
	async recall(
		id: string,
		messageId: string,
	): Promise<{ session: SessionDetail; text: string; references: string[] }> {
		if (this.updating.has(id)) throw new HttpError(409, "会话正在更新，请稍后重试");
		this.updating.add(id);
		try {
			const { target, session, editorText } = await this.navigateToMessage(id, messageId, "user");
			return {
				session,
				text: target.input?.text ?? editorText ?? target.text,
				references: target.input?.references ?? [],
			};
		} finally {
			this.updating.delete(id);
			await this.refreshAgentAfterPluginChange(id);
		}
	}
	async branch(id: string, messageId: string): Promise<SessionDetail> {
		if (this.updating.has(id)) throw new HttpError(409, "会话正在更新，请稍后重试");
		this.updating.add(id);
		try {
			return (await this.navigateToMessage(id, messageId, "assistant")).session;
		} finally {
			this.updating.delete(id);
			await this.refreshAgentAfterPluginChange(id);
		}
	}
	rename(id: string, title: string): void {
		this.get(id).title = title;
		this.emit(id, { type: "session.updated" });
	}
	async setModel(id: string, provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<void> {
		if (this.busy.has(id) || this.updating.has(id) || this.refreshing.has(id))
			throw new HttpError(409, "Stop the agent before changing models");
		this.busy.add(id);
		try {
			const session = await this.agent(id);
			const model = (await session.modelRuntime.getAvailable()).find(
				(model) => model.provider === provider && model.id === modelId,
			);
			if (!model) throw new HttpError(400, "Model has no configured server credential or is unavailable");
			await session.setModel(model);
			if (thinkingLevel) session.setThinkingLevel(thinkingLevel);
			this.get(id).model = this.modelOption(model);
			this.get(id).thinkingLevel = session.thinkingLevel;
			this.get(id).error = undefined;
			this.emit(id, { type: "session.updated" });
		} finally {
			this.busy.delete(id);
			await this.refreshAgentAfterPluginChange(id);
		}
	}
	async setAccessMode(id: string, accessMode: AccessMode): Promise<SessionDetail> {
		const detail = this.get(id);
		if (detail.purpose === "plugin-development" && accessMode !== "ask") {
			throw new HttpError(409, "插件开发会话始终禁用工具调用");
		}
		detail.accessMode = accessMode;
		this.emit(id, { type: "session.updated" });
		return detail;
	}
	async models(id?: string): Promise<ModelOption[]> {
		if (this.providers) {
			const models = await this.providers.models();
			if (id) this.selectInitialModel(id, models);
			return models;
		}
		const runtime = id
			? (await this.agent(id)).modelRuntime
			: await ModelRuntime.create({
					authPath: join(this.agentDirectory, "auth.json"),
					modelsPath: join(this.agentDirectory, "models.json"),
					modelsStorePath: join(this.agentDirectory, "models-store.json"),
					allowModelNetwork: false,
					refreshOnCreate: false,
				});
		const available = await runtime.getAvailable();
		const keys = new Set(available.map((model) => `${model.provider}/${model.id}`));
		return runtime
			.getAllModels()
			.filter((model) => isModelType(model, "chat"))
			.map((model) => ({
				id: model.id,
				provider: model.provider,
				name: model.name,
				reasoning: model.reasoning,
				available: keys.has(`${model.provider}/${model.id}`),
			}));
	}
	async resources(id: string): Promise<Resources> {
		const session = await this.agent(id);
		const skills = session.resourceLoader.getSkills();
		const extensions = session.resourceLoader.getExtensions();
		return {
			skills: skills.skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
				status: "loaded",
			})),
			extensions: extensions.extensions.map((extension) => extension.path),
			diagnostics: [
				...skills.diagnostics.map((item) => item.message),
				...extensions.errors.map((item) => `${item.path}: ${item.error}`),
			],
		};
	}
	private requestApproval(sessionId: string, toolCallId: string, name: string, input: unknown): Promise<boolean> {
		if (this.closing || this.cancelled.has(sessionId) || !this.busy.has(sessionId)) return Promise.resolve(false);
		const approval: Approval = {
			id: randomUUID(),
			toolCallId,
			name,
			input,
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
		};
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.approvals.get(approval.id)?.resolve(false), 300_000);
			this.approvals.set(approval.id, {
				sessionId,
				resolve: (approved) => {
					clearTimeout(timer);
					this.approvals.delete(approval.id);
					const detail = this.get(sessionId);
					detail.approvals = detail.approvals.filter((item) => item.id !== approval.id);
					detail.status = detail.approvals.length ? "approval" : "running";
					this.emit(sessionId, { type: "agent.status" });
					resolve(approved);
				},
			});
			const detail = this.get(sessionId);
			detail.approvals.push(approval);
			detail.status = "approval";
			this.emit(sessionId, {
				type: "approval.requested",
				tool: { id: toolCallId, name, input, status: "approval", startedAt: new Date().toISOString() },
			});
		});
	}
	approve(sessionId: string, approvalId: string, allowed: boolean): void {
		const approval = this.approvals.get(approvalId);
		if (!approval || approval.sessionId !== sessionId) throw new HttpError(404, "Approval expired or not found");
		approval.resolve(allowed);
	}
	private resolveApprovals(id: string): void {
		for (const approval of this.approvals.values()) if (approval.sessionId === id) approval.resolve(false);
	}
	async delete(id: string): Promise<void> {
		this.get(id);
		if (this.busy.has(id) || this.updating.has(id))
			throw new HttpError(409, "Stop the agent before deleting a session");
		await this.removeSession(id, true);
	}
	async deleteWorkspaceSessions(workspaceId: string): Promise<number> {
		const ids = [...this.records.values()]
			.filter((record) => record.detail.workspaceId === workspaceId)
			.map((record) => record.detail.id);
		if (ids.some((id) => this.busy.has(id) || this.updating.has(id))) {
			throw new HttpError(409, "Stop all running workspace sessions before removing this workspace");
		}
		for (const id of ids) await this.removeSession(id, false);
		return ids.length;
	}
	private async removeSession(id: string, removeTranscript: boolean): Promise<void> {
		const pending = this.agents.get(id);
		if (pending) await this.disposeAgent(await pending, "quit");
		this.agents.delete(id);
		await this.browser.release(id);
		const file = this.records.get(id)?.file;
		if (removeTranscript && file) await rm(file, { force: true });
		this.records.delete(id);
		this.store.deleteSession(id);
	}
	async close(): Promise<void> {
		this.closing = true;
		for (const id of this.records.keys()) this.resolveApprovals(id);
		for (const pending of this.agents.values()) {
			const agent = await pending;
			await agent.abort();
			await this.disposeAgent(agent, "quit");
		}
		await this.browser.close();
	}
}
