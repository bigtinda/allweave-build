export type AgentStatus = "idle" | "running" | "approval" | "error";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AccessMode = "plan" | "ask" | "auto" | "full";
export interface Workspace {
	id: string;
	name: string;
	path: string;
}
export interface LocalFolder {
	name: string;
	path: string;
}
export interface LocalFolderListing {
	currentPath?: string;
	parentPath?: string;
	roots: LocalFolder[];
	directories: LocalFolder[];
}
export interface GitWorktree {
	path: string;
	branch: string;
}
export interface GitWorkspaceStatus {
	repositoryPath?: string;
	branch?: string;
	branches: string[];
	worktrees: GitWorktree[];
	changedFiles: string[];
}
export interface GitChange {
	path: string;
	index: string;
	working: string;
	conflict: boolean;
}
export interface GitChanges {
	branch: string;
	branches: string[];
	head: string;
	indexRevision: string;
	files: GitChange[];
}
export interface GitDiff {
	text: string;
	binary: boolean;
}
export interface ModelOption {
	id: string;
	provider: string;
	name: string;
	reasoning: boolean;
	available: boolean;
}
export type ProviderAuthPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: Array<{ id: string; label: string; description?: string }>;
	  };
export type ProviderAuthNotification =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };
export interface ProviderOption {
	id: string;
	name: string;
	category: string;
	modelCount: number;
	configured: boolean;
	authSource?: string;
	apiKey?: { name: string; interactive: boolean };
	oauth?: { name: string; label: string; subscription: boolean };
}
export type ProviderLoginType = "api_key" | "oauth";
export type ProviderLoginStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export interface ProviderLoginView {
	id: string;
	providerId: string;
	type: ProviderLoginType;
	status: ProviderLoginStatus;
	prompt?: ProviderAuthPrompt;
	notifications: ProviderAuthNotification[];
	error?: string;
}
export interface KernelInfo {
	version: string;
	integration: "in-process";
}
export interface PiPackageJob {
	id: string;
	source: string;
	action: "install" | "remove";
	status: "running" | "succeeded" | "failed";
	output: string;
	error?: string;
}
export interface PiConfiguredPackage {
	source: string;
	applied: boolean;
	isDefault: boolean;
}
export interface DefaultPluginStatus {
	source: string;
	status: "pending" | "running" | "succeeded" | "failed";
	output: string;
	error?: string;
}
export interface StorageCategory {
	id: string;
	label: string;
	path: string;
	bytes: number;
	files: number;
}
export interface StoredSession {
	id: string;
	title: string;
	status: AgentStatus;
	updatedAt: string;
	bytes: number;
}
export interface StorageSummary {
	categories: StorageCategory[];
	totalBytes: number;
	disk?: { totalBytes: number; freeBytes: number };
	sessions: StoredSession[];
}
export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	thinking: string;
	complete: boolean;
	timestamp: string;
	error?: string;
	changedFiles?: string[];
	input?: { text: string; references: string[] };
}
export interface ToolCall {
	id: string;
	name: string;
	input: unknown;
	output?: unknown;
	status: "approval" | "running" | "completed" | "failed";
	startedAt: string;
	durationMs?: number;
}
export interface Approval {
	id: string;
	toolCallId: string;
	name: string;
	input: unknown;
	expiresAt: string;
}
export interface Activity {
	id: number;
	type: string;
	timestamp: string;
	description: string;
}
export interface SessionSummary {
	id: string;
	workspaceId: string;
	title: string;
	status: AgentStatus;
	updatedAt: string;
	model?: ModelOption;
	thinkingLevel: ThinkingLevel;
	accessMode: AccessMode;
}
export interface SessionDetail extends SessionSummary {
	messages: ChatMessage[];
	tools: ToolCall[];
	approvals: Approval[];
	activity: Activity[];
	sequence: number;
	tokens?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number; cost?: number };
	error?: string;
}
export interface FileEntry {
	name: string;
	path: string;
	directory: boolean;
	size: number;
	modifiedAt: string;
}
export interface FileContent {
	path: string;
	content: string;
	revision: string;
}
export interface SkillInfo {
	name: string;
	description: string;
	filePath: string;
	status: "loaded";
}
export interface Resources {
	skills: SkillInfo[];
	extensions: string[];
	diagnostics: string[];
}
export interface ResourceImportFile {
	path: string;
	base64: string;
}
export interface SkillImportResult {
	name: string;
	filesImported: number;
}
export interface PackageImportResult extends SkillImportResult {
	source: string;
}
export type EventType =
	| "session.started"
	| "session.updated"
	| "message.delta"
	| "message.completed"
	| "conversation.rewound"
	| "conversation.branched"
	| "tool.started"
	| "tool.updated"
	| "tool.completed"
	| "agent.status"
	| "agent.error"
	| "approval.requested";
export interface SessionEvent {
	type: EventType;
	sessionId: string;
	eventId: number;
	messageId: string | null;
	timestamp: string;
	message?: ChatMessage;
	tool?: ToolCall;
	conversation?: { messages: ChatMessage[]; tools: ToolCall[] };
	// Summary state accompanies every event so reconnects and model/status changes agree.
	summary: SessionSummary;
	approvals: Approval[];
	tokens?: SessionDetail["tokens"];
	error?: string;
}
export type SocketMessage = { type: "session.snapshot"; session: SessionDetail } | SessionEvent;

export function applyEvent(session: SessionDetail, event: SessionEvent): SessionDetail {
	if (event.sessionId !== session.id || event.eventId <= session.sequence) return session;
	const messages = event.message
		? session.messages.some((message) => message.id === event.message?.id)
			? session.messages.map((message) => (message.id === event.message?.id ? event.message! : message))
			: [...session.messages, event.message]
		: session.messages;
	const tools = event.tool
		? session.tools.some((tool) => tool.id === event.tool?.id)
			? session.tools.map((tool) => (tool.id === event.tool?.id ? event.tool! : tool))
			: [...session.tools, event.tool]
		: session.tools;
	return {
		...session,
		...event.summary,
		messages: event.conversation?.messages ?? messages,
		tools: event.conversation?.tools ?? tools,
		sequence: event.eventId,
		approvals: event.approvals,
		tokens: event.tokens,
		error: event.error,
		activity: [
			...session.activity,
			{
				id: event.eventId,
				type: event.type,
				timestamp: event.timestamp,
				description: event.tool?.name ?? event.error ?? event.type,
			},
		].slice(-150),
	};
}
