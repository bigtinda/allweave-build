import type { NativeModelRuntime } from "@pi-console/kernel-adapters";
import type {
	AccessMode,
	ModelOption,
	Resources,
	SessionDetail,
	SessionEvent,
	SessionPurpose,
	SessionSummary,
	SessionUsageRecord,
	ThinkingLevel,
} from "../../shared/src/protocol.ts";
import type { AppPluginManager } from "./app-plugins.ts";
import { BrowserService } from "./browser.ts";
import { KernelSessionStore } from "./persistence/kernel-session-store.ts";
import type { ProviderManager } from "./providers.ts";
import { SessionCoordinator } from "./sessions/coordinator.ts";
import { EventHub } from "./sessions/event-hub.ts";
import { EventProjector, type SessionStore } from "./sessions/event-projector.ts";
import { AgentRuntimeFactory } from "./sessions/pi-runtime.adapter.ts";
import type { ApprovalStore } from "./sessions/tool-authorization.ts";
import type { ConsoleStore } from "./store.ts";
import { WorkspaceAccess } from "./workspaces/workspace-access.ts";

export interface AgentServiceOptions {
	gateway?: () => Promise<NativeModelRuntime> | NativeModelRuntime;
	providers?: ProviderManager;
	agentDirectory?: string;
	browser?: BrowserService;
	appPlugins?: AppPluginManager;
	/** Authorized workspace access; it also owns the remote host service. */
	workspaceAccess?: WorkspaceAccess;
	/** Session event storage; defaults to the combined console store. */
	sessionStore?: SessionStore & ApprovalStore;
}

/**
 * Façade of the session subsystem. The run state, the projection, the approvals
 * and the event publication are owned by the coordinator and its collaborators.
 */
export class AgentService {
	private coordinator: SessionCoordinator;
	private readonly sessionStore: SessionStore & ApprovalStore;
	private readonly ownedSessionStore?: KernelSessionStore;

	constructor(store: ConsoleStore, directory: string, options: AgentServiceOptions = {}) {
		const sessionStore = options.sessionStore ?? new KernelSessionStore(directory, store.db);
		this.sessionStore = sessionStore;
		this.ownedSessionStore = options.sessionStore ? undefined : (sessionStore as KernelSessionStore);
		const workspaceAccess =
			options.workspaceAccess ??
			// Standalone use (tests, scripts) has no root registry: every stored workspace is authorized.
			new WorkspaceAccess({
				store,
				roots: () =>
					store
						.workspaces()
						.filter((workspace) => !workspace.remote)
						.map((workspace) => workspace.path),
			});
		this.coordinator = new SessionCoordinator({
			directory,
			projector: new EventProjector(sessionStore),
			approvalStore: sessionStore,
			hub: new EventHub(),
			runtimeFactory: new AgentRuntimeFactory({
				gateway: options.gateway,
				directory,
				agentDirectory: options.agentDirectory,
				providers: options.providers,
			}),
			workspaceAccess,
			browser: options.browser ?? new BrowserService(),
			appPlugins: options.appPlugins,
			providers: options.providers,
		});
	}

	list(): SessionSummary[] {
		return this.coordinator.list();
	}
	usage(): SessionUsageRecord[] {
		return this.coordinator.usage();
	}
	get(id: string): SessionDetail {
		return this.coordinator.get(id);
	}
	async create(workspaceId: string, title: string, purpose?: SessionPurpose): Promise<SessionDetail> {
		return this.coordinator.create(workspaceId, title, purpose);
	}
	async createPluginDevelopmentSession(workspaceId: string, title: string): Promise<SessionDetail> {
		return this.coordinator.createPluginDevelopmentSession(workspaceId, title);
	}
	getOrCreatePluginDevelopmentSession(workspaceId: string): Promise<SessionDetail> {
		return this.coordinator.getOrCreatePluginDevelopmentSession(workspaceId);
	}
	replay(id: string, after: number): SessionEvent[] {
		return this.coordinator.replay(id, after);
	}

	subscribe(id: string, listener: (event: SessionEvent) => void): () => void {
		return this.coordinator.subscribe(id, listener);
	}
	async prompt(id: string, text: string, references: string[]): Promise<void> {
		await this.coordinator.prompt(id, text, references);
	}
	async warm(id: string): Promise<void> {
		await this.coordinator.warm(id);
	}
	async abort(id: string): Promise<void> {
		await this.coordinator.abort(id);
	}
	async recover(id: string): Promise<SessionDetail> {
		return this.coordinator.recover(id);
	}
	async interrupt(id: string, text: string, references: string[]): Promise<void> {
		await this.coordinator.interrupt(id, text, references);
	}
	async resume(id: string): Promise<void> {
		await this.coordinator.resume(id);
	}
	async steer(id: string, text: string): Promise<void> {
		await this.coordinator.steer(id, text);
	}
	async recall(
		id: string,
		messageId: string,
	): Promise<{ session: SessionDetail; text: string; references: string[] }> {
		return this.coordinator.recall(id, messageId);
	}
	async branch(id: string, messageId: string): Promise<SessionDetail> {
		return this.coordinator.branch(id, messageId);
	}
	rename(id: string, title: string): void {
		this.coordinator.rename(id, title);
	}
	archive(id: string): SessionSummary {
		return this.coordinator.archive(id);
	}
	restore(id: string): SessionSummary {
		return this.coordinator.restore(id);
	}
	async setModel(id: string, provider: string, modelId: string, thinkingLevel?: ThinkingLevel): Promise<void> {
		await this.coordinator.setModel(id, provider, modelId, thinkingLevel);
	}
	async setAccessMode(id: string, accessMode: AccessMode): Promise<SessionDetail> {
		return this.coordinator.setAccessMode(id, accessMode);
	}
	async models(id?: string): Promise<ModelOption[]> {
		return this.coordinator.models(id);
	}
	async resources(id: string): Promise<Resources> {
		return this.coordinator.resources(id);
	}
	approve(sessionId: string, approvalId: string, allowed: boolean): void {
		this.coordinator.approve(sessionId, approvalId, allowed);
	}
	async delete(id: string): Promise<void> {
		await this.coordinator.delete(id);
	}
	async deleteWorkspaceSessions(workspaceId: string): Promise<number> {
		return this.coordinator.deleteWorkspaceSessions(workspaceId);
	}
	async prepareForProviderChange(): Promise<void> {
		await this.coordinator.prepareForProviderChange();
	}
	async refreshIdleAgentsForPluginChange(): Promise<void> {
		await this.coordinator.refreshIdleAgentsForPluginChange();
	}
	async close(): Promise<void> {
		await this.coordinator.close();
		this.sessionStore.flushPending?.();
		this.ownedSessionStore?.close();
	}
}
