import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { HttpError } from "../security.ts";
import type { WorkspaceTools } from "../workspaces/workspace-access.ts";
import { NativeAgentRuntime } from "./native-runtime.ts";
import type { RuntimeEvent } from "./pi-events.ts";

/** Token usage of a runtime, shaped like the persisted session projection. */
export type RuntimeUsage = NonNullable<SessionDetail["tokens"]>;

/** Outcome of a branch or rewind inside the session. */
export interface BranchOutcome {
	editorText?: string;
	/** Tool call ids that remain part of the selected branch. */
	toolIds: string[];
	usage: RuntimeUsage;
}

/** Model selection details owned by the runtime. */
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

/** The workbench view of a live agent runtime. */
export interface AgentRuntime {
	/** Native sessions persist in the kernel store, not a JSONL transcript. */
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
	cwd: string;
	tools: WorkspaceTools;
	state: () => SessionDetail;
	transcriptFile?: string;
	browser: BrowserService;
	appPlugins?: AppPluginManager;
	pluginWorkspaceId: string;
	accessMode: () => AccessMode;
	requestApproval: (toolCallId: string, name: string, input: unknown) => Promise<boolean>;
	refreshAfterPluginChange: () => Promise<void>;
	extensions?: ExtensionRegistry;
}

export interface AgentRuntimeFactoryOptions {
	directory: string;
	agentDirectory?: string;
	providers?: { runtime(): Promise<NativeModelRuntime> };
	/** Test seam: a native model gateway that replaces provider credentials. */
	gateway?: () => Promise<NativeModelRuntime> | NativeModelRuntime;
}

/** The runtime factory contract used by the session coordinator. */
export interface RuntimeFactory {
	open(input: AgentRuntimeInput): Promise<AgentRuntime>;
	listModels(): Promise<ModelOption[]>;
	modelDefaults(cwd: string): ProjectModelDefaults;
	defaultModelOrder(): Array<[provider: string, modelId: string]>;
}

type Settings = {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>;
};

function readSettings(path: string): Settings {
	if (!existsSync(path)) return {};
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return typeof value === "object" && value !== null ? (value as Settings) : {};
	} catch {
		return {};
	}
}

/** Creates native runtimes for workbench sessions. */
export class AgentRuntimeFactory implements RuntimeFactory {
	private directory: string;
	private agentDirectory: string;
	private providers?: { runtime(): Promise<NativeModelRuntime> };
	private gateway?: () => Promise<NativeModelRuntime> | NativeModelRuntime;

	constructor(options: AgentRuntimeFactoryOptions) {
		this.directory = options.directory;
		this.agentDirectory = options.agentDirectory ?? join(options.directory, "agent");
		this.providers = options.providers;
		this.gateway = options.gateway;
	}

	defaultModelOrder(): Array<[provider: string, modelId: string]> {
		return [];
	}

	async listModels(): Promise<ModelOption[]> {
		const runtime = this.gateway ? await this.gateway() : await this.providers?.runtime();
		if (!runtime) return [];
		return runtime.getModels().map((model) => ({
			id: model.id,
			provider: model.provider,
			name: model.name,
			reasoning: model.reasoning,
			available: true,
		}));
	}

	modelDefaults(cwd: string): ProjectModelDefaults {
		const global = readSettings(join(this.agentDirectory, "settings.json"));
		const project = readSettings(join(cwd, ".pi", "settings.json"));
		const settings = { ...global, ...project };
		return {
			provider: settings.defaultProvider,
			modelId: settings.defaultModel,
			thinkingLevel: (provider, modelId) => settings.modelThinkingLevels?.[`${provider}/${modelId}`],
			defaultThinkingLevel: () => settings.defaultThinkingLevel,
		};
	}

	async open(input: AgentRuntimeInput): Promise<AgentRuntime> {
		if (input.workspace.remote) throw new HttpError(410, "远程工作区已移除");
		const runtime = this.gateway ? await this.gateway() : await this.providers?.runtime();
		if (!runtime) throw new HttpError(503, "模型运行时不可用");
		return new NativeAgentRuntime(input, runtime, this.agentDirectory);
	}
}
