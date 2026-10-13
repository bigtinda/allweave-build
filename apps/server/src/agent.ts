import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isModelType } from "@earendil-works/pi-ai/utils/model-operations";
import type { JsonAgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import {
	type AgentSession,
	type createAgentSession,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DefaultResourceLoader,
	defaultModelPerProvider,
	detectSupportedImageMimeTypeFromFile,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type AccessMode,
	type Approval,
	applyEvent,
	type ModelOption,
	type Resources,
	type SessionDetail,
	type SessionEvent,
	type SessionSummary,
	type ThinkingLevel,
	type Workspace,
} from "../../shared/src/protocol.ts";
import { type AdaptedEvent, adaptRpcEvent, adaptSdkEvent } from "./adapter.ts";
import { type PiKernelArchive, PiRpcClient, type RpcRecord, rpcValue } from "./kernel.ts";
import { APPROVAL_MARKER } from "./kernel-guard.ts";
import type { ProviderManager } from "./providers.ts";
import { HttpError, workspacePath } from "./security.ts";
import type { ConsoleStore, SavedSession } from "./store.ts";
import { toolPermission } from "./tool-policy.ts";

interface PendingApproval {
	sessionId: string;
	resolve: (approved: boolean) => void;
}

interface KernelSession {
	client: PiRpcClient;
}

interface KernelState {
	model?: { id: string; provider: string; name?: string; reasoning?: boolean };
	thinkingLevel: ThinkingLevel;
	sessionFile?: string;
	sessionId: string;
}

function parseRpcApproval(message: string): { toolCallId: string; name: string; input: unknown } | undefined {
	if (!message.startsWith(APPROVAL_MARKER)) return undefined;
	try {
		const parsed: unknown = JSON.parse(message.slice(APPROVAL_MARKER.length));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const value = parsed as Record<string, unknown>;
		if (typeof value.toolCallId !== "string" || typeof value.name !== "string") return undefined;
		return { toolCallId: value.toolCallId, name: value.name, input: value.input };
	} catch {
		return undefined;
	}
}

export class AgentService {
	private store: ConsoleStore;
	private directory: string;
	private records = new Map<string, SavedSession>();
	private agents = new Map<string, Promise<AgentSession>>();
	private kernelAgents = new Map<string, Promise<KernelSession>>();
	private busy = new Set<string>();
	private cancelled = new Set<string>();
	private listeners = new Map<string, Set<(event: SessionEvent) => void>>();
	private approvals = new Map<string, PendingApproval>();
	private closing = false;
	private createSession?: typeof createAgentSession;
	private kernel?: PiKernelArchive;
	private providers?: ProviderManager;
	private agentDirectory: string;
	private guardExtensionPath: string;

	constructor(
		store: ConsoleStore,
		directory: string,
		options: {
			createSession?: typeof createAgentSession;
			kernel?: PiKernelArchive;
			providers?: ProviderManager;
			agentDirectory?: string;
			guardExtensionPath?: string;
		} = {},
	) {
		this.store = store;
		this.directory = directory;
		this.createSession = options.createSession;
		this.kernel = options.kernel;
		this.providers = options.providers;
		this.agentDirectory = options.agentDirectory ?? getAgentDir();
		this.guardExtensionPath = options.guardExtensionPath ?? "";
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
		const { id, workspaceId, title, status, updatedAt, model, thinkingLevel } = detail;
		return { id, workspaceId, title, status, updatedAt, model, thinkingLevel, accessMode: detail.accessMode };
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
	async create(workspaceId: string, title: string): Promise<SessionDetail> {
		this.workspace(workspaceId);
		const detail: SessionDetail = {
			id: randomUUID(),
			workspaceId,
			title,
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
	private selectInitialModel(id: string, models: ModelOption[]): void {
		const detail = this.get(id);
		if (detail.model) return;
		const available = models.filter((model) => model.available);
		if (!available.length) return;
		const workspace = this.workspace(detail.workspaceId);
		const settings = SettingsManager.create(workspace.path, this.agentDirectory);
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
	private kernelAgent(id: string): Promise<KernelSession> {
		this.get(id);
		if (!this.kernel) throw new Error("内核发行包不可用");
		const existing = this.kernelAgents.get(id);
		if (existing) return existing;
		const creating = this.initializeKernel(id).catch((error: unknown) => {
			this.kernelAgents.delete(id);
			throw error;
		});
		this.kernelAgents.set(id, creating);
		return creating;
	}
	private async initializeKernel(id: string): Promise<KernelSession> {
		if (!this.kernel) throw new Error("内核发行包不可用");
		const record = this.records.get(id);
		if (!record) throw new HttpError(404, "Session not found");
		const workspace = this.workspace(record.detail.workspaceId);
		if (!this.guardExtensionPath) throw new Error("工作区保护扩展未配置");
		let client: PiRpcClient;
		client = new PiRpcClient((event) => this.handleKernelRecord(id, client, event));
		const sessionDir = join(this.directory, "sessions", id);
		try {
			await this.writeAccessMode(id, record.detail.accessMode);
			await client.start({
				executable: this.kernel.getInfo().executable,
				cwd: workspace.path,
				sessionDir,
				existingSessionFile: record.file,
				agentDir: this.agentDirectory,
				extensionPath: this.guardExtensionPath,
				accessModeFile: this.accessModePath(id),
			});
			const state = await client.request<KernelState>({ type: "get_state" });
			record.file = state.sessionFile ?? record.file;
			record.detail.model = state.model
				? {
						id: state.model.id,
						provider: state.model.provider,
						name: state.model.name ?? state.model.id,
						reasoning: state.model.reasoning === true,
						available: true,
					}
				: undefined;
			record.detail.thinkingLevel = state.thinkingLevel;
			record.detail.status = "idle";
			this.store.saveSession(record.detail, record.file);
			this.emit(id, { type: "session.updated" });
			return { client };
		} catch (error) {
			await client.stop();
			throw error;
		}
	}
	private handleKernelRecord(id: string, client: PiRpcClient, event: RpcRecord): void {
		if (!this.records.has(id)) return;
		if (event.type === "extension_ui_request") {
			this.handleKernelUiRequest(id, client, event);
			return;
		}
		if (event.type === "kernel_exit") {
			this.resolveApprovals(id);
			this.busy.delete(id);
			this.kernelAgents.delete(id);
			const detail = this.get(id);
			if (!this.closing) {
				detail.status = "error";
				const message = rpcValue<string>(event, "error");
				this.emit(id, { type: "agent.error", error: message ?? "内核意外停止" });
			}
			return;
		}
		if (event.type === "agent_settled") {
			this.resolveApprovals(id);
			this.busy.delete(id);
			const detail = this.get(id);
			if (detail.status !== "error") detail.status = "idle";
			void client
				.request<SessionStats>({ type: "get_session_stats" })
				.then((stats) => {
					detail.tokens = stats.tokens;
					this.emit(id, { type: "agent.status" });
				})
				.catch(() => this.emit(id, { type: "agent.status" }));
		}
		if (event.type === "agent_start") this.get(id).status = "running";
		if (event.type === "session_info_changed") {
			const name = rpcValue<string | undefined>(event, "name");
			if (name) this.get(id).title = name;
		}
		const adapted = adaptRpcEvent(event as unknown as JsonAgentSessionEvent, this.get(id));
		if (adapted) {
			if (adapted.error) this.get(id).status = "error";
			this.emit(id, adapted);
		}
	}
	private handleKernelUiRequest(id: string, client: PiRpcClient, event: RpcRecord): void {
		const requestId = rpcValue<string>(event, "id");
		const method = rpcValue<string>(event, "method");
		if (!requestId || !method) return;
		if (method === "setTitle") {
			const title = rpcValue<string>(event, "title");
			if (title) {
				this.get(id).title = title;
				this.emit(id, { type: "session.updated" });
			}
			return;
		}
		if (method === "notify" || method === "setStatus" || method === "set_editor_text") return;
		if (method === "confirm") {
			const title = rpcValue<string>(event, "title") ?? "扩展确认";
			const message = rpcValue<string>(event, "message") ?? "";
			const parsed = parseRpcApproval(message);
			const approval = parsed ?? { toolCallId: requestId, name: title, input: message };
			void this.requestApproval(id, approval.toolCallId, approval.name, approval.input)
				.then((approved) => client.sendUiResponse(requestId, approved))
				.catch(() => client.sendUiResponse(requestId, false));
			return;
		}
		client.sendUiCancelled(requestId);
	}
	async prepareForProviderChange(): Promise<void> {
		if (this.busy.size > 0) throw new HttpError(409, "请先停止运行中的会话，再修改供应商凭据");
		for (const pending of this.kernelAgents.values()) await (await pending).client.stop();
		this.kernelAgents.clear();
		for (const pending of this.agents.values()) (await pending).dispose();
		this.agents.clear();
	}
	private async initialize(id: string): Promise<AgentSession> {
		if (!this.createSession) throw new Error("会话工厂不可用");
		const record = this.records.get(id);
		if (!record) throw new HttpError(404, "Session not found");
		const workspace = this.workspace(record.detail.workspaceId);
		const cwd = workspace.path;
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		// Workspace authorization also trusts its configuration/extensions. They execute native server code.
		settingsManager.setProjectTrusted(true);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						const input = event.input as Record<string, unknown>;
						if (["read", "write", "edit", "ls", "find", "grep"].includes(event.toolName)) {
							try {
								await workspacePath(
									cwd,
									typeof input.path === "string" ? input.path : ".",
									event.toolName === "write",
								);
							} catch (error) {
								return { block: true, reason: error instanceof Error ? error.message : "Path denied" };
							}
						}
						// Even innocuous shell commands can invoke scripts. Confirm every command, mutation,
						// and custom tool instead of trying to identify danger with command-string heuristics.
						const permission = toolPermission(this.get(id).accessMode, event.toolName);
						if (permission === "deny") {
							return { block: true, reason: "计划模式仅允许只读工具。切换权限模式后再执行此操作。" };
						}
						if (permission === "ask") {
							const approved = await this.requestApproval(id, event.toolCallId, event.toolName, input);
							if (!approved)
								return { block: true, reason: "User denied or cancelled this tool call", terminate: true };
						}
						return undefined;
					});
				},
			],
		});
		await resourceLoader.reload();
		const checkedRead = async (path: string) => readFile(await workspacePath(cwd, path));
		const checkedAccess = async (path: string) => access(await workspacePath(cwd, path));
		const checkedWrite = async (path: string, content: string) =>
			writeFile(await workspacePath(cwd, path, true), content, "utf8");
		const sessionManager = record.file
			? SessionManager.open(record.file, join(this.directory, "sessions"), cwd)
			: SessionManager.create(cwd, join(this.directory, "sessions"));
		const { session, modelFallbackMessage } = await this.createSession({
			cwd,
			resourceLoader,
			settingsManager,
			sessionManager,
			customTools: [
				// SDK customTools erases schema types, but renderers are contravariant under strict TS.
				// These casts bridge that SDK boundary; each factory retains its runtime schema validation.
				createReadToolDefinition(cwd, {
					operations: {
						readFile: checkedRead,
						access: checkedAccess,
						detectImageMimeType: async (path) =>
							detectSupportedImageMimeTypeFromFile(await workspacePath(cwd, path)),
					},
				}) as unknown as ToolDefinition,
				createEditToolDefinition(cwd, {
					operations: { readFile: checkedRead, access: checkedAccess, writeFile: checkedWrite },
				}) as unknown as ToolDefinition,
				createWriteToolDefinition(cwd, {
					operations: {
						writeFile: checkedWrite,
						mkdir: async (path) => {
							await mkdir(await workspacePath(cwd, path, true), { recursive: true });
						},
					},
				}) as unknown as ToolDefinition,
			],
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
				if (event.type === "agent_start") this.get(id).status = "running";
				// prompt's finally owns idle status: agent_end can precede extension settlement.
				if (event.type === "agent_end") this.get(id).tokens = session.getSessionStats().tokens;
				if (adapted.error) this.get(id).status = "error";
				this.emit(id, adapted);
			});
			this.emit(id, { type: "session.updated" });
			return session;
		} catch (error) {
			session.dispose();
			throw error;
		}
	}

	private accessModePath(id: string): string {
		return join(this.directory, "policies", `${id}.json`);
	}
	private async writeAccessMode(id: string, mode: AccessMode): Promise<void> {
		const path = this.accessModePath(id);
		await mkdir(join(this.directory, "policies"), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify({ mode })}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, path);
		} catch (error) {
			await rm(temporary, { force: true });
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
		this.store.saveSession(updated, record.file);
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
		if (this.busy.has(id)) throw new HttpError(409, "Agent is already running");
		if (this.kernel) return this.promptKernel(id, text, references);
		this.busy.add(id);
		this.cancelled.delete(id);
		let session: AgentSession;
		try {
			session = await this.agent(id);
			if (!session.model || !this.get(id).model)
				throw new HttpError(400, "未配置模型。请先配置供应商凭据并选择模型。");
			const workspace = this.workspace(this.get(id).workspaceId);
			for (const reference of references) await workspacePath(workspace.path, reference);
			if (this.cancelled.has(id)) throw new HttpError(409, "Task was cancelled before execution");
			// A reference asks the agent to inspect an authorized file, without uploading host paths.
			const prompt =
				this.promptForAccessMode(id, text) +
				(references.length
					? `\n\nWorkspace file references:\n${references.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`
					: "");
			this.get(id).error = undefined;
			this.get(id).status = "running";
			this.emit(id, { type: "agent.status" });
			void session
				.prompt(prompt)
				.catch((error) => {
					this.get(id).status = "error";
					this.emit(id, { type: "agent.error", error: error instanceof Error ? error.message : String(error) });
				})
				.finally(() => {
					this.resolveApprovals(id);
					this.busy.delete(id);
					this.cancelled.delete(id);
					const detail = this.get(id);
					if (detail.status !== "error") detail.status = "idle";
					detail.tokens = session.getSessionStats().tokens;
					this.emit(id, { type: "agent.status" });
				});
		} catch (error) {
			this.busy.delete(id);
			this.cancelled.delete(id);
			throw error;
		}
	}
	private async promptKernel(id: string, text: string, references: string[]): Promise<void> {
		this.busy.add(id);
		this.cancelled.delete(id);
		try {
			const session = await this.kernelAgent(id);
			if (!this.get(id).model) {
				throw new HttpError(400, "No model configured. Add a provider credential and select an available model.");
			}
			const workspace = this.workspace(this.get(id).workspaceId);
			for (const reference of references) await workspacePath(workspace.path, reference);
			if (this.cancelled.has(id)) throw new HttpError(409, "Task was cancelled before execution");
			const prompt =
				this.promptForAccessMode(id, text) +
				(references.length
					? `\n\nWorkspace file references:\n${references.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`
					: "");
			this.get(id).error = undefined;
			this.get(id).status = "running";
			this.emit(id, { type: "agent.status" });
			const result = await session.client.request<{ disposition: string }>({ type: "prompt", message: prompt });
			if (result.disposition === "handled") {
				this.resolveApprovals(id);
				this.busy.delete(id);
				this.get(id).status = "idle";
				this.emit(id, { type: "agent.status" });
			}
		} catch (error) {
			this.resolveApprovals(id);
			this.busy.delete(id);
			this.cancelled.delete(id);
			this.get(id).status = "error";
			this.emit(id, { type: "agent.error", error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}
	async abort(id: string): Promise<void> {
		this.get(id);
		if (this.busy.has(id)) this.cancelled.add(id);
		this.resolveApprovals(id);
		if (this.kernel) {
			const session = await this.kernelAgent(id);
			await session.client.request({ type: "abort" });
			return;
		}
		await (await this.agent(id)).abort();
	}
	rename(id: string, title: string): void {
		this.get(id).title = title;
		this.emit(id, { type: "session.updated" });
	}
	async setModel(id: string, provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<void> {
		if (this.busy.has(id)) throw new HttpError(409, "Stop the agent before changing models");
		this.busy.add(id);
		try {
			if (this.kernel) {
				const runtime = await this.providers?.runtime();
				if (!runtime) throw new Error("供应商目录不可用");
				const model = (await runtime.getAvailable(provider)).find((item) => item.id === modelId);
				if (!model) throw new HttpError(400, "模型没有可用凭据或当前不可用");
				const session = await this.kernelAgent(id);
				await session.client.request({ type: "set_model", provider, modelId });
				const level = thinkingLevel ?? this.get(id).thinkingLevel;
				await session.client.request({ type: "set_thinking_level", level });
				this.get(id).model = {
					id: model.id,
					provider: model.provider,
					name: model.name,
					reasoning: model.reasoning,
					available: true,
				};
				this.get(id).thinkingLevel = level;
				this.get(id).error = undefined;
				this.emit(id, { type: "session.updated" });
				return;
			}
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
		}
	}
	async setAccessMode(id: string, accessMode: AccessMode): Promise<SessionDetail> {
		const detail = this.get(id);
		if (this.kernel) await this.writeAccessMode(id, accessMode);
		detail.accessMode = accessMode;
		this.emit(id, { type: "session.updated" });
		return detail;
	}
	async models(id?: string): Promise<ModelOption[]> {
		if (this.kernel && this.providers) {
			const models = await this.providers.models();
			if (id) this.selectInitialModel(id, models);
			return models;
		}
		const runtime = id ? (await this.agent(id)).modelRuntime : await ModelRuntime.create();
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
		if (this.kernel) {
			const client = (await this.kernelAgent(id)).client;
			const result = await client.request<{
				commands: Array<{ name: string; source: string; sourceInfo: { path?: string } }>;
			}>({ type: "get_commands" });
			const skills = result.commands
				.filter((command) => command.source === "skill")
				.map((command) => ({
					name: command.name,
					description: "技能",
					filePath: command.sourceInfo.path ?? command.name,
					status: "loaded" as const,
				}));
			const extensions = [
				...new Set(
					result.commands
						.filter((command) => command.source === "extension")
						.map((command) => command.sourceInfo.path ?? command.name),
				),
			];
			return { skills, extensions, diagnostics: [] };
		}
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
		if (this.busy.has(id)) throw new HttpError(409, "Stop the agent before deleting a session");
		await this.removeSession(id, true);
	}
	async deleteWorkspaceSessions(workspaceId: string): Promise<number> {
		const ids = [...this.records.values()]
			.filter((record) => record.detail.workspaceId === workspaceId)
			.map((record) => record.detail.id);
		if (ids.some((id) => this.busy.has(id))) {
			throw new HttpError(409, "Stop all running workspace sessions before removing this workspace");
		}
		for (const id of ids) await this.removeSession(id, false);
		return ids.length;
	}
	private async removeSession(id: string, removeTranscript: boolean): Promise<void> {
		const kernelPending = this.kernelAgents.get(id);
		if (kernelPending) await (await kernelPending).client.stop();
		this.kernelAgents.delete(id);
		const pending = this.agents.get(id);
		if (pending) (await pending).dispose();
		this.agents.delete(id);
		const file = this.records.get(id)?.file;
		if (removeTranscript && file) await rm(file, { force: true });
		this.records.delete(id);
		this.store.deleteSession(id);
	}
	async close(): Promise<void> {
		this.closing = true;
		for (const id of this.records.keys()) this.resolveApprovals(id);
		for (const pending of this.kernelAgents.values()) {
			const session = await pending;
			await session.client.request({ type: "abort" }).catch(() => undefined);
			await session.client.stop();
		}
		this.kernelAgents.clear();
		for (const pending of this.agents.values()) {
			const agent = await pending;
			await agent.abort();
			agent.dispose();
		}
	}
}
