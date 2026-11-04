import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { KernelSession } from "@allweave/kernel";
import type {
	AccessMode,
	ChatImage,
	ChatMessage,
	ModelOption,
	Resources,
	SessionDetail,
	SessionPurpose,
	SessionSummary,
	ThinkingLevel,
	Workspace,
} from "../../../shared/src/protocol.ts";
import type { AdaptedEvent } from "../adapter.ts";
import type { AppPluginManager } from "../app-plugins.ts";
import type { BrowserService } from "../browser.ts";
import { captureGitSnapshot, changedGitFiles, type GitSnapshot } from "../git.ts";
import type { ProviderManager } from "../providers.ts";
import { HttpError } from "../security.ts";
import type { WorkspaceAccess } from "../workspaces/workspace-access.ts";
import { RuntimeEngine } from "./agent-engine.ts";
import type { EventHub, SessionEventListener } from "./event-hub.ts";
import type { EventProjector, SessionMutation } from "./event-projector.ts";
import { finishRunUsage } from "./run-usage.ts";
import type { AgentRuntime, RuntimeFactory } from "./runtime.adapter.ts";
import type { RuntimeEvent } from "./runtime-events.ts";
import { SessionRuntimeRegistry } from "./runtime-registry.ts";
import { type ApprovalStore, ToolAuthorization } from "./tool-authorization.ts";

export interface SessionCoordinatorOptions {
	directory: string;
	projector: EventProjector;
	approvalStore?: ApprovalStore;
	hub: EventHub;
	runtimeFactory: RuntimeFactory;
	workspaceAccess: WorkspaceAccess;
	browser: BrowserService;
	appPlugins?: AppPluginManager;
	providers?: ProviderManager;
}

/**
 * Owns the running state of the sessions: one run per session, the conflict
 * rules, the run errors, the status transitions and the event publication.
 * The projection itself belongs to the EventProjector, the approvals to the
 * ToolAuthorization and the kernel session to the runtime registry.
 */
export class SessionCoordinator {
	private directory: string;
	private projector: EventProjector;
	private hub: EventHub;
	private runtimeFactory: RuntimeFactory;
	private workspaceAccess: WorkspaceAccess;
	private browser: BrowserService;
	private appPlugins?: AppPluginManager;
	private providers?: ProviderManager;
	private runtimes: SessionRuntimeRegistry;
	private engines = new Map<string, RuntimeEngine>();
	private actors = new Map<string, KernelSession>();
	private authorizer: ToolAuthorization;
	private busy = new Set<string>();
	private cancelled = new Set<string>();
	private runs = new Map<string, Promise<void>>();
	private updating = new Set<string>();
	private refreshing = new Set<string>();
	private pendingPluginRefresh = new Set<string>();
	private inputs = new Map<string, { prompt: string; text: string; references: string[] }>();
	/** Sessions whose projection could not be persisted and need a transcript recovery. */
	private failed = new Map<string, string>();
	private closing = false;
	private pluginDevelopmentSessions = new Map<string, Promise<SessionDetail>>();

	constructor(options: SessionCoordinatorOptions) {
		this.directory = options.directory;
		this.projector = options.projector;
		this.hub = options.hub;
		this.runtimeFactory = options.runtimeFactory;
		this.workspaceAccess = options.workspaceAccess;
		this.browser = options.browser;
		this.appPlugins = options.appPlugins;
		this.providers = options.providers;
		this.runtimes = new SessionRuntimeRegistry({
			open: async (input) => {
				const runtime = await this.runtimeFactory.open(input);
				this.applyRuntime(input.sessionId, runtime);
				return runtime;
			},
		});
		this.authorizer = new ToolAuthorization({
			approvals: options.approvalStore,
			emit: (sessionId, change, mutate) => {
				this.emit(sessionId, change, mutate);
			},
			accessMode: (sessionId) => this.get(sessionId).accessMode,
			canRequest: (sessionId) => !this.closing && !this.cancelled.has(sessionId) && this.busy.has(sessionId),
		});
		// A projection failure is persisted; a restart must keep the session
		// blocked until it is explicitly rebuilt from the transcript.
		for (const [id, reason] of this.projector.failures()) this.failed.set(id, reason);
	}

	list(): SessionSummary[] {
		return this.projector.list();
	}

	usage() {
		return this.projector.usage();
	}

	get(id: string): SessionDetail {
		return this.projector.get(id);
	}

	replay(id: string, after: number): ReturnType<EventProjector["replay"]> {
		return this.projector.replay(id, after);
	}

	subscribe(id: string, listener: SessionEventListener): () => void {
		this.get(id);
		return this.hub.subscribe(id, listener);
	}

	private workspace(id: string): Workspace {
		return this.workspaceAccess.get(id);
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
		return this.projector.create(detail);
	}

	async createPluginDevelopmentSession(workspaceId: string, title: string): Promise<SessionDetail> {
		return this.create(workspaceId, title, "plugin-development");
	}

	getOrCreatePluginDevelopmentSession(workspaceId: string): Promise<SessionDetail> {
		const pending = this.pluginDevelopmentSessions.get(workspaceId);
		if (pending) return pending;
		const creation = Promise.resolve()
			.then(() => {
				const existing = this.list().find(
					(session) => session.purpose === "plugin-development" && session.workspaceId === workspaceId,
				);
				return existing ? this.get(existing.id) : this.createPluginDevelopmentSession(workspaceId, "插件开发");
			})
			.finally(() => this.pluginDevelopmentSessions.delete(workspaceId));
		this.pluginDevelopmentSessions.set(workspaceId, creation);
		return creation;
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
		const defaults = this.runtimeFactory.modelDefaults(settingsCwd);
		const preferred =
			defaults.provider && defaults.modelId
				? available.find((model) => model.provider === defaults.provider && model.id === defaults.modelId)
				: undefined;
		const model =
			preferred ??
			this.runtimeFactory
				.defaultModelOrder()
				.map(([provider, modelId]) =>
					available.find((candidate) => candidate.provider === provider && candidate.id === modelId),
				)
				.find((candidate) => candidate !== undefined) ??
			available[0];
		this.emit(id, { type: "session.updated" }, (draft) => {
			draft.model = model;
			draft.thinkingLevel =
				defaults.thinkingLevel(model.provider, model.id) ?? defaults.defaultThinkingLevel() ?? "medium";
		});
	}

	private engine(id: string): RuntimeEngine {
		let engine = this.engines.get(id);
		if (!engine) {
			engine = new RuntimeEngine(() => this.agent(id));
			this.engines.set(id, engine);
		}
		return engine;
	}

	private actor(id: string): KernelSession {
		let actor = this.actors.get(id);
		if (!actor) {
			actor = new KernelSession({
				id,
				onAbort: () => this.engine(id).abort(),
			});
			this.actors.set(id, actor);
		}
		return actor;
	}

	private agent(id: string): Promise<AgentRuntime> {
		const detail = this.get(id);
		const workspace = this.workspace(detail.workspaceId);
		const pluginDevelopment = detail.purpose === "plugin-development";
		const cwd = workspace.remote ? join(this.directory, "remote-projects", workspace.id) : workspace.path;
		return this.runtimes.get(id, {
			sessionId: id,
			workspace,
			pluginDevelopment,
			cwd,
			tools: this.workspaceAccess.tools(workspace, cwd),
			state: () => this.get(id),
			transcriptFile: this.projector.file(id),
			browser: this.browser,
			appPlugins: this.appPlugins,
			pluginWorkspaceId: detail.workspaceId,
			accessMode: () => this.get(id).accessMode,
			requestApproval: async (toolCallId, name, input) => {
				const actor = this.actor(id);
				actor.enterApproval();
				try {
					return await this.authorizer.request(id, { toolCallId, name, input });
				} finally {
					actor.settleApproval();
				}
			},
			refreshAfterPluginChange: () => this.refreshIdleAgentsForPluginChange(),
		});
	}

	/** Copy the runtime state into the session projection after the runtime was created. */
	private applyRuntime(id: string, runtime: AgentRuntime): void {
		this.projector.setFile(id, runtime.sessionFile);
		runtime.subscribe((event) => this.handleRuntimeEvent(id, runtime, event));
		const model = runtime.selectedModel();
		this.emit(id, { type: "session.updated" }, (draft) => {
			draft.model = model ? this.modelOption(model) : undefined;
			draft.thinkingLevel = runtime.thinkingLevel();
			draft.error = runtime.modelFallbackMessage();
		});
	}

	private handleRuntimeEvent(id: string, runtime: AgentRuntime, event: RuntimeEvent): void {
		const adapted = event.adapted;
		if (adapted.message?.role === "user") {
			const input = this.inputs.get(id);
			adapted.message.input =
				input?.prompt === adapted.message.text
					? { text: input.text, references: input.references }
					: this.get(id).messages.find((message) => message.id === adapted.message?.id)?.input;
		}
		this.emit(id, adapted, (draft) => {
			if (event.phase === "started") draft.status = "running";
			// prompt's finally owns idle status: agent_end can precede extension settlement.
			if (event.phase === "ended") draft.tokens = runtime.usage();
			if (adapted.error) draft.status = "error";
			if (adapted.message?.role === "assistant" && adapted.message.complete && !adapted.error && this.busy.has(id)) {
				draft.error = undefined;
				draft.status = "running";
			}
		});
	}

	/**
	 * Persist a workbench change and publish it. A failed projection stops the
	 * session: the event is not published and the session is marked as needing a
	 * transcript recovery.
	 */
	private emit(id: string, change: AdaptedEvent, mutate?: SessionMutation): void {
		try {
			const { event } = this.projector.project(id, change, mutate);
			this.hub.publish(id, event);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.failed.set(id, reason);
			this.projector.markFailed(id, reason);
		}
	}

	async prepareForProviderChange(): Promise<void> {
		if (this.busy.size > 0 || this.updating.size > 0)
			throw new HttpError(409, "请先停止运行中的会话，再修改供应商凭据");
		await this.runtimes.disposeAll("reload");
	}

	async refreshIdleAgentsForPluginChange(): Promise<void> {
		for (const id of this.runtimes.ids()) {
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
		const pending = this.runtimes.pending(id);
		if (!pending) {
			this.pendingPluginRefresh.delete(id);
			return;
		}
		this.refreshing.add(id);
		try {
			let runtime: AgentRuntime;
			try {
				runtime = await pending;
			} catch {
				if (this.runtimes.pending(id) === pending) this.runtimes.remove(id);
				this.pendingPluginRefresh.delete(id);
				return;
			}
			if (this.busy.has(id) || this.updating.has(id)) {
				this.pendingPluginRefresh.add(id);
				return;
			}
			if (this.runtimes.pending(id) !== pending) return;
			this.engines.get(id)?.forget();
			this.runtimes.remove(id);
			this.pendingPluginRefresh.delete(id);
			await runtime.dispose("reload");
		} finally {
			this.refreshing.delete(id);
		}
	}

	private promptForAccessMode(id: string, text: string): string {
		if (this.get(id).accessMode !== "plan") return text;
		return `计划模式已启用。请先分析任务并给出清晰的实施计划；可以使用只读工具检查工作区，但不要修改文件、运行命令或调用会改变外部状态的工具。等用户明确确认计划后，再切换权限模式执行。\n\n${text}`;
	}

	private modelOption(model: { id: string; provider: string; name: string; reasoning: boolean }): ModelOption {
		return { id: model.id, provider: model.provider, name: model.name, reasoning: model.reasoning, available: true };
	}

	async prompt(id: string, text: string, references: string[], images?: ChatImage[]): Promise<void> {
		if (this.closing) throw new HttpError(503, "Server is shutting down");
		if (this.get(id).archivedAt) throw new HttpError(409, "此会话已归档，请先恢复后继续");
		if (this.failed.has(id)) throw new HttpError(409, "会话状态未能保存，请从 transcript 恢复该会话后重试");
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
		let runtime: AgentRuntime;
		let fileSnapshot: GitSnapshot | undefined;
		let previousAssistantMessages = new Set<string>();
		try {
			runtime = await this.agent(id);
			if (!runtime.selectedModel() || !this.get(id).model)
				throw new HttpError(400, "未配置模型。请先配置供应商凭据并选择模型。");
			const workspace = this.workspace(this.get(id).workspaceId);
			const pluginDevelopment = this.get(id).purpose === "plugin-development";
			if (pluginDevelopment && references.length) {
				throw new HttpError(400, "插件开发会话不能引用工作区文件");
			}
			if (!pluginDevelopment) {
				const referenceTools = this.workspaceAccess.tools(workspace, workspace.path);
				for (const reference of references) await referenceTools.check(reference);
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
				(runtime.handlesPlanMode ? text : this.promptForAccessMode(id, text)) +
				(references.length
					? `\n\nWorkspace file references:\n${references.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`
					: "");
			this.inputs.set(id, { prompt, text, references: [...references] });
			const beforeUsage = runtime.usage();
			const beforeCompactions = runtime.compactions?.();
			const startedAt = new Date().toISOString();
			const started = performance.now();
			const previousTools = new Set(this.get(id).tools.map((tool) => tool.id));
			let runError = false;
			this.emit(id, { type: "agent.status" }, (draft) => {
				draft.error = undefined;
				draft.status = "running";
			});
			void this.actor(id).start(async (context) => {
				try {
					if (images?.length) context.images = images;
					await this.engine(id).run(prompt, context);
				} catch (error) {
					if (!context.signal.aborted) {
						runError = true;
						this.emit(
							id,
							{
								type: "agent.error",
								error: error instanceof Error ? error.message : String(error),
							},
							(draft) => {
								draft.status = "error";
							},
						);
						throw error;
					}
				} finally {
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
						const afterUsage = runtime.usage();
						const afterCompactions = runtime.compactions?.();
						const toolResults = this.get(id)
							.tools.filter((tool) => !previousTools.has(tool.id))
							.map((tool) => ({
								name: tool.name.slice(0, 256),
								characters: JSON.stringify(tool.output)?.length ?? 0,
							}));
						const lastRunUsage = finishRunUsage(beforeUsage, afterUsage, {
							startedAt,
							durationMs: performance.now() - started,
							model: { provider: this.get(id).model!.provider, id: this.get(id).model!.id },
							outcome: this.cancelled.has(id)
								? "aborted"
								: runError || this.get(id).status === "error"
									? "error"
									: "completed",
							...(beforeCompactions !== undefined &&
							afterCompactions !== undefined &&
							afterCompactions >= beforeCompactions
								? { compactions: afterCompactions - beforeCompactions }
								: {}),
							toolResultCharacters: toolResults.reduce((total, tool) => total + tool.characters, 0),
							toolResults: toolResults.slice(-50),
						});
						this.authorizer.cancel(id);
						this.busy.delete(id);
						this.cancelled.delete(id);
						this.inputs.delete(id);
						this.runs.delete(id);
						finishRun();
						await this.refreshAgentAfterPluginChange(id);
						this.emit(id, { type: "agent.status" }, (draft) => {
							draft.tokens = afterUsage;
							draft.lastRunUsage = lastRunUsage;
							if (draft.status !== "error") draft.status = "idle";
						});
					}
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

	async warm(id: string): Promise<void> {
		if (this.closing) return;
		await this.agent(id);
	}

	async abort(id: string): Promise<void> {
		this.get(id);
		const run = this.runs.get(id);
		if (this.busy.has(id)) this.cancelled.add(id);
		this.authorizer.cancel(id);
		const actor = this.actors.get(id);
		if (actor) await actor.abort();
		else {
			const pending = this.runtimes.pending(id);
			if (pending) await (await pending).abort();
		}
		await run;
	}

	/** Rebuild the workbench state from the session transcript after a failed projection. */
	async recover(id: string): Promise<SessionDetail> {
		this.get(id);
		if (this.busy.has(id) || this.updating.has(id) || this.refreshing.has(id))
			throw new HttpError(409, "请先停止运行中的会话，再从 transcript 恢复");
		this.engines.get(id)?.forget();
		this.engines.delete(id);
		await this.runtimes.dispose(id, "reload");
		const { event, detail } = this.projector.recover(id);
		this.failed.delete(id);
		this.hub.publish(id, event);
		return detail;
	}

	/** Queue a steering message into the active run. */
	async steer(id: string, text: string): Promise<void> {
		const session = this.get(id);
		if (session.status !== "running" && session.status !== "approval")
			throw new HttpError(409, "会话未在运行，无法插入消息");
		this.actor(id).steer(text);
	}

	/** Continue an interrupted session from its last completed turn. */
	async resume(id: string): Promise<void> {
		const session = this.get(id);
		if (session.status !== "interrupted") throw new HttpError(409, "会话未处于中断状态");
		await this.prompt(id, "继续上一次未完成的任务。基于当前对话继续，不要重复已经完成的写操作。", []);
	}

	async interrupt(id: string, text: string, references: string[], images?: ChatImage[]): Promise<void> {
		this.get(id);
		if (this.updating.has(id)) throw new HttpError(409, "会话正在更新，请稍后重试");
		this.updating.add(id);
		try {
			const workspace = this.workspace(this.get(id).workspaceId);
			const referenceTools = this.workspaceAccess.tools(workspace, workspace.path);
			for (const reference of references) await referenceTools.check(reference);
			await this.abort(id);
		} finally {
			this.updating.delete(id);
			await this.refreshAgentAfterPluginChange(id);
		}
		await this.prompt(id, text, references, images);
	}

	private async navigateToMessage(
		id: string,
		messageId: string,
		role: ChatMessage["role"],
	): Promise<{ target: ChatMessage; session: SessionDetail; editorText: string | undefined }> {
		const target = this.get(id).messages.find((message) => message.id === messageId && message.role === role);
		if (!target) throw new HttpError(404, role === "user" ? "用户消息不存在" : "AI 回复不存在");
		await this.abort(id);
		const runtime = await this.agent(id);
		const outcome = await runtime.navigate(target, role);
		this.emit(
			id,
			{
				type: role === "user" ? "conversation.rewound" : "conversation.branched",
				conversation: { messages: [], tools: [] },
			},
			(draft, change) => {
				const index = draft.messages.findIndex((message) => message.id === messageId);
				draft.messages = draft.messages.slice(0, index + (role === "assistant" ? 1 : 0));
				const toolIds = new Set(outcome.toolIds);
				draft.tools = draft.tools.filter((tool) => toolIds.has(tool.id));
				draft.status = "idle";
				draft.error = undefined;
				draft.tokens = outcome.usage;
				change.conversation = { messages: draft.messages, tools: draft.tools };
			},
		);
		const detail = this.get(id);
		return { target, session: detail, editorText: outcome.editorText };
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
		this.get(id);
		this.emit(id, { type: "session.updated" }, (draft) => {
			draft.title = title;
		});
	}

	archive(id: string): SessionSummary {
		if (this.busy.has(id) || this.updating.has(id)) throw new HttpError(409, "请先停止 Agent，再归档会话");
		return this.projector.setArchived(id, true);
	}

	restore(id: string): SessionSummary {
		return this.projector.setArchived(id, false);
	}

	async setModel(id: string, provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<void> {
		if (this.busy.has(id) || this.updating.has(id) || this.refreshing.has(id))
			throw new HttpError(409, "Stop the agent before changing models");
		this.busy.add(id);
		try {
			const runtime = await this.agent(id);
			await runtime.setModel(provider, modelId, thinkingLevel);
			const model = runtime.selectedModel();
			this.emit(id, { type: "session.updated" }, (draft) => {
				draft.model = model ? this.modelOption(model) : undefined;
				draft.thinkingLevel = runtime.thinkingLevel();
				draft.error = undefined;
			});
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
		this.emit(id, { type: "session.updated" }, (draft) => {
			draft.accessMode = accessMode;
		});
		return this.get(id);
	}

	async models(id?: string): Promise<ModelOption[]> {
		if (this.providers) {
			const models = await this.providers.models();
			if (id) this.selectInitialModel(id, models);
			return models;
		}
		return id ? (await this.agent(id)).listModels() : this.runtimeFactory.listModels();
	}

	async resources(id: string): Promise<Resources> {
		const runtime = await this.agent(id);
		return runtime.resources();
	}

	approve(sessionId: string, approvalId: string, allowed: boolean): void {
		this.authorizer.approve(sessionId, approvalId, allowed);
	}

	async delete(id: string): Promise<void> {
		if (!this.get(id).archivedAt) throw new HttpError(409, "请先归档会话，再从归档管理中永久删除");
		if (this.busy.has(id) || this.updating.has(id)) throw new HttpError(409, "请先停止 Agent，再删除会话");
		await this.removeSession(id, true);
	}

	async deleteWorkspaceSessions(workspaceId: string): Promise<number> {
		const ids = [...this.projector.list()]
			.filter((session) => session.workspaceId === workspaceId)
			.map((session) => session.id);
		if (ids.some((id) => this.busy.has(id) || this.updating.has(id))) {
			throw new HttpError(409, "Stop all running workspace sessions before removing this workspace");
		}
		for (const id of ids) await this.removeSession(id, false);
		return ids.length;
	}

	private async removeSession(id: string, removeTranscript: boolean): Promise<void> {
		await this.actors.get(id)?.close();
		this.actors.delete(id);
		this.engines.get(id)?.forget();
		this.engines.delete(id);
		await this.runtimes.dispose(id, "quit");
		await this.browser.release(id);
		const file = this.projector.file(id);
		if (removeTranscript && file) await rm(file, { force: true });
		this.failed.delete(id);
		this.projector.remove(id);
	}

	async close(): Promise<void> {
		this.closing = true;
		this.authorizer.cancelAll();
		for (const actor of this.actors.values()) await actor.close();
		this.actors.clear();
		for (const engine of this.engines.values()) engine.forget();
		this.engines.clear();
		for (const id of this.runtimes.ids()) {
			const pending = this.runtimes.pending(id);
			if (!pending) continue;
			const runtime = await pending;
			await runtime.abort();
			await this.runtimes.dispose(id, "quit");
		}
		await this.browser.close();
	}
}
