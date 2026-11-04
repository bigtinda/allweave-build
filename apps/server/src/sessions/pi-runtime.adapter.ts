import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isModelType } from "@earendil-works/pi-ai/utils/model-operations";
import {
	type AgentSession,
	type createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	defaultModelPerProvider,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionRegistry } from "@pi-console/kernel";
import type { NativeModelRuntime } from "@pi-console/kernel-adapters";
import type {
	AccessMode,
	ChatMessage,
	ModelOption,
	Resources,
	SessionDetail,
	ThinkingLevel,
	Workspace,
} from "../../../shared/src/protocol.ts";
import type { AppPluginManager } from "../app-plugins.ts";
import type { BrowserService } from "../browser.ts";
import { prepareDoomCordisHostExtension } from "../legacy/doompi-host.ts";
import type { RemoteWorkspaceService } from "../remote-workspaces.ts";
import { HttpError } from "../security.ts";
import type { WorkspaceTools } from "../workspaces/workspace-access.ts";
import { NativeAgentRuntime } from "./native-runtime.ts";
import { adaptRuntimeEvent, type RuntimeEvent } from "./pi-events.ts";
import { createWorkbenchTools } from "./tool-factory.ts";

/** Token usage of a runtime, shaped like the persisted session projection. */
export type RuntimeUsage = NonNullable<SessionDetail["tokens"]>;

/** The Pi session factory seam. */
export type SessionFactory = typeof createAgentSession;

/** Outcome of a branch or rewind inside the Pi session. */
export interface BranchOutcome {
	editorText?: string;
	/** Tool call ids that remain part of the selected branch. */
	toolIds: string[];
	usage: RuntimeUsage;
}

/** Model selection details owned by the Pi session. */
export interface RuntimeModel {
	id: string;
	provider: string;
	name: string;
	reasoning: boolean;
}

/** Project defaults used to preselect a model. */
export interface ProjectModelDefaults {
	provider?: string;
	modelId?: string;
	thinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined;
	defaultThinkingLevel(): ThinkingLevel | undefined;
}

/**
 * The workbench view of a live Pi session. Everything the agent service needs
 * from the SDK is expressed here in workbench types.
 */
export interface AgentRuntime {
	/** Transcript file of the Pi session. */
	readonly sessionFile: string | undefined;
	/** The runtime applies access-mode instructions to its own system prompt. */
	readonly handlesPlanMode?: boolean;
	prompt(text: string, signal?: AbortSignal): Promise<void>;
	abort(): Promise<void>;
	usage(): RuntimeUsage;
	compactions?(): number;
	subscribe(listener: (event: RuntimeEvent) => void): () => void;
	selectedModel(): RuntimeModel | undefined;
	thinkingLevel(): ThinkingLevel;
	setModel(provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<void>;
	listModels(): Promise<ModelOption[]>;
	resources(): Resources;
	navigate(message: ChatMessage, role: "user" | "assistant"): Promise<BranchOutcome>;
	dispose(reason: "quit" | "reload"): Promise<void>;
	/** Model fallback message reported when the session was created. */
	modelFallbackMessage(): string | undefined;
}

export interface AgentRuntimeInput {
	sessionId: string;
	workspace: Workspace;
	pluginDevelopment: boolean;
	/** Working directory of the session: the project path, or the remote mirror. */
	cwd: string;
	/** File access boundary shared with the HTTP API. */
	tools: WorkspaceTools;
	/** Current session projection, used to resolve pending message and tool ids. */
	state: () => SessionDetail;
	/** Existing transcript of a restored session. */
	transcriptFile?: string;
	remote?: RemoteWorkspaceService;
	browser: BrowserService;
	appPlugins?: AppPluginManager;
	pluginWorkspaceId: string;
	accessMode: () => AccessMode;
	requestApproval: (toolCallId: string, name: string, input: unknown) => Promise<boolean>;
	refreshAfterPluginChange: () => Promise<void>;
	extensions?: ExtensionRegistry;
}

export interface AgentRuntimeFactoryOptions {
	/** Seam for tests: the Pi session factory. */
	createSession?: typeof createAgentSession;
	/** Console data directory: transcripts and remote project mirrors. */
	directory: string;
	/** Workbench agent directory: settings, credentials and extensions. */
	agentDirectory?: string;
	/** Server-owned model runtime, used by the native short-session engine. */
	providers?: { runtime(): Promise<NativeModelRuntime> };
}

/** The runtime factory contract used by the session coordinator. */
export interface RuntimeFactory {
	open(input: AgentRuntimeInput): Promise<AgentRuntime>;
	listModels(): Promise<ModelOption[]>;
	modelDefaults(cwd: string): ProjectModelDefaults;
	defaultModelOrder(): Array<[provider: string, modelId: string]>;
}

class PiAgentRuntime implements AgentRuntime {
	private session: AgentSession;
	private listeners = new Set<(event: RuntimeEvent) => void>();
	private modelFallback: string | undefined;

	constructor(session: AgentSession, modelFallback: string | undefined, state: () => SessionDetail) {
		this.session = session;
		this.modelFallback = modelFallback;
		session.subscribe((event) => {
			const runtimeEvent = adaptRuntimeEvent(event, state());
			if (!runtimeEvent) return;
			for (const listener of this.listeners) listener(runtimeEvent);
		});
	}

	get sessionFile(): string | undefined {
		return this.session.sessionManager.getSessionFile();
	}
	prompt(text: string, _signal?: AbortSignal): Promise<void> {
		return this.session.prompt(text);
	}
	async abort(): Promise<void> {
		await this.session.abort();
	}
	usage(): RuntimeUsage {
		const stats = this.session.getSessionStats();
		return { ...stats.tokens, cost: stats.cost };
	}
	compactions(): number {
		return this.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
	}
	subscribe(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	selectedModel(): RuntimeModel | undefined {
		const model = this.session.model;
		const selected = this.session.modelRuntime
			.getAvailableSnapshot()
			.find((candidate) => candidate.provider === model?.provider && candidate.id === model?.id);
		return selected
			? { id: selected.id, provider: selected.provider, name: selected.name, reasoning: selected.reasoning }
			: undefined;
	}
	thinkingLevel(): ThinkingLevel {
		return this.session.thinkingLevel;
	}
	async setModel(provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<void> {
		const model = (await this.session.modelRuntime.getAvailable()).find(
			(candidate) => candidate.provider === provider && candidate.id === modelId,
		);
		if (!model) throw new HttpError(400, "Model has no configured server credential or is unavailable");
		await this.session.setModel(model);
		if (thinkingLevel) this.session.setThinkingLevel(thinkingLevel);
	}
	async listModels(): Promise<ModelOption[]> {
		return listModels(this.session.modelRuntime);
	}
	resources(): Resources {
		const skills = this.session.resourceLoader.getSkills();
		const extensions = this.session.resourceLoader.getExtensions();
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
	private findBranchMessageEntry(target: ChatMessage) {
		return this.session.sessionManager.getBranch().findLast((entry) => {
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
	async navigate(message: ChatMessage, role: "user" | "assistant"): Promise<BranchOutcome> {
		const entry = this.findBranchMessageEntry(message);
		if (!entry) throw new HttpError(409, "消息不在当前 Pi 会话分支中");
		const result = await this.session.navigateTree(entry.id, { summarize: false });
		if (result.cancelled) throw new HttpError(409, "扩展取消了会话分支操作");
		// Persist the selected branch point so a restart restores the same active path.
		this.session.sessionManager.appendCustomEntry("pi-console.navigation", {
			messageId: message.id,
			role,
		});
		const toolIds = new Set(
			this.session.sessionManager
				.getBranch()
				.flatMap((item) =>
					item.type === "message" && item.message.role === "toolResult" ? [item.message.toolCallId] : [],
				),
		);
		return { editorText: result.editorText, toolIds: [...toolIds], usage: this.usage() };
	}
	async dispose(reason: "quit" | "reload"): Promise<void> {
		try {
			await this.session.extensionRunner.emit({ type: "session_shutdown", reason });
		} finally {
			this.session.dispose();
		}
	}
	modelFallbackMessage(): string | undefined {
		return this.modelFallback;
	}
	/** Report an extension failure as a workbench event. */
	reportError(error: string): void {
		const runtimeEvent: RuntimeEvent = { phase: "update", adapted: { type: "agent.error", error } };
		for (const listener of this.listeners) listener(runtimeEvent);
	}
}

/**
 * Creates Pi runtimes for workbench sessions. All SDK setup lives here: the
 * resource loader, the session manager, the extension set and the session factory.
 */
export class AgentRuntimeFactory implements RuntimeFactory {
	private createSession?: typeof createAgentSession;
	private directory: string;
	private agentDirectory: string;
	private providers?: { runtime(): Promise<NativeModelRuntime> };

	constructor(options: AgentRuntimeFactoryOptions) {
		this.createSession = options.createSession;
		this.directory = options.directory;
		this.agentDirectory = options.agentDirectory ?? getAgentDir();
		this.providers = options.providers;
	}

	/** Default model preference per provider, used to preselect a model. */
	defaultModelOrder(): Array<[provider: string, modelId: string]> {
		return Object.entries(defaultModelPerProvider);
	}

	/** Models available to the workbench, without opening a session. */
	async listModels(): Promise<ModelOption[]> {
		const runtime = await ModelRuntime.create({
			authPath: join(this.agentDirectory, "auth.json"),
			modelsPath: join(this.agentDirectory, "models.json"),
			modelsStorePath: join(this.agentDirectory, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		return listModels(runtime);
	}

	/** Persisted project defaults used to preselect a model. */
	modelDefaults(cwd: string): ProjectModelDefaults {
		const settings = SettingsManager.create(cwd, this.agentDirectory);
		return {
			provider: settings.getDefaultProvider() ?? undefined,
			modelId: settings.getDefaultModel() ?? undefined,
			thinkingLevel: (provider, modelId) => settings.getModelThinkingLevel(provider, modelId) ?? undefined,
			defaultThinkingLevel: () => settings.getDefaultThinkingLevel() ?? undefined,
		};
	}

	async open(input: AgentRuntimeInput): Promise<AgentRuntime> {
		if (
			process.env.KERNEL_ENGINE === "native" &&
			this.providers &&
			input.state().messages.length === 0 &&
			!input.transcriptFile &&
			!input.workspace.remote
		) {
			return new NativeAgentRuntime(input, await this.providers.runtime());
		}
		const createSession = this.createSession;
		if (!createSession) throw new Error("会话工厂不可用");
		const { cwd, pluginDevelopment, workspace } = input;
		const remoteWorkspace = workspace.remote !== undefined;
		const remoteService = input.remote;
		if (remoteWorkspace && !remoteService) throw new HttpError(501, "远程主机服务不可用");
		if (remoteWorkspace) {
			// Resolve the remote environment eagerly: an unreachable host fails the session start.
			await remoteService!.workspaceEnvironment(workspace);
			await mkdir(cwd, { recursive: true });
			await remoteService!.prepareMcpConfigs(workspace, cwd);
		}
		if (pluginDevelopment) await mkdir(workspace.path, { recursive: true });
		const agentDir = this.agentDirectory;
		const settingsManager = SettingsManager.create(pluginDevelopment ? this.directory : cwd, agentDir);
		// Workspace authorization also trusts its configuration/extensions. They execute native server code.
		if (!pluginDevelopment) settingsManager.setProjectTrusted(true);
		const cordisHostPath = pluginDevelopment ? undefined : await prepareDoomCordisHostExtension(agentDir);
		const remoteExtensions = remoteWorkspace
			? [
					{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
					{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
					{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
				]
			: [];
		const toolFactory = await createWorkbenchTools({
			sessionId: input.sessionId,
			workspace,
			cwd,
			tools: input.tools,
			pluginDevelopment,
			remote: remoteService,
			browser: input.browser,
			appPlugins: input.appPlugins,
			pluginWorkspaceId: input.pluginWorkspaceId,
			accessMode: input.accessMode,
			requestApproval: input.requestApproval,
			refreshAfterPluginChange: input.refreshAfterPluginChange,
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: cordisHostPath ? [cordisHostPath] : [],
			noExtensions: pluginDevelopment,
			noSkills: pluginDevelopment,
			noPromptTemplates: pluginDevelopment,
			noThemes: pluginDevelopment,
			noContextFiles: pluginDevelopment,
			systemPrompt: pluginDevelopment
				? "你是 AllWeave Build 的插件开发助手。用户直接在主聊天框描述插件新增或升级需求，你在此默认插件开发工作区中协作。你可以读取、编辑和写入此工作区中的插件 JSON 清单；不能运行 shell、脚本或其他程序。清单路径使用 plugins/<plugin-id>.json。先调用 plugin_list 了解已安装插件，再按需要创建或升级清单；调用 plugin_validate 检查协议、版本和数据字段兼容性。只有用户明确要求安装或启用时才调用 plugin_install，该操作会请求用户确认。插件目前使用声明式 manifestVersion 1：字段驱动表单，页面使用 table 或 board 视图，navigation 生成软件侧栏入口；不得编造脚本执行能力。升级时必须提高版本号并保留现有字段 ID、类型、必填状态和选项。"
				: workspace.remote
					? `你正在 SSH 远程主机 ${workspace.remote.host} 的项目 ${workspace.path} 中工作。read、edit、write 和 bash 工具会在该远程项目中执行。文件工具请使用相对于项目根目录的路径。`
					: undefined,
			appendSystemPrompt: pluginDevelopment ? [] : undefined,
			extensionFactories: [...remoteExtensions, ...toolFactory.extensionFactories],
		});
		await resourceLoader.reload();
		const sessionManager = input.transcriptFile
			? SessionManager.open(input.transcriptFile, join(this.directory, "sessions"), cwd)
			: SessionManager.create(cwd, join(this.directory, "sessions"));
		const { session, modelFallbackMessage } = await createSession({
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
							...toolFactory.pluginDevelopmentToolNames,
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
			customTools: toolFactory.customTools,
		});
		const runtime = new PiAgentRuntime(session, modelFallbackMessage, input.state);
		try {
			await session.bindExtensions({
				mode: "rpc",
				onError: (error) => runtime.reportError(error.error),
			});
		} catch (error) {
			await runtime.dispose("quit");
			throw error;
		}
		return runtime;
	}
}

async function listModels(runtime: ModelRuntime): Promise<ModelOption[]> {
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
