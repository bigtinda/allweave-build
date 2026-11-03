export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface StoredSession {
	readonly id: string;
	readonly data: string;
	readonly file?: string;
	readonly seq: number;
	readonly updatedAt: string;
}

export interface StoredEvent {
	readonly sessionId: string;
	readonly seq: number;
	readonly type: string;
	readonly data: string;
	readonly createdAt: string;
}

export interface StoredSnapshot {
	readonly sessionId: string;
	readonly seq: number;
	readonly data: string;
	readonly createdAt: string;
}

export interface StoredApproval {
	readonly id: string;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly data: string;
	readonly status: ApprovalStatus;
	readonly expiresAt: string;
	readonly createdAt: string;
}

export interface EventStore {
	createSession(session: StoredSession): void;
	putSession(session: StoredSession): void;
	getSession(id: string): StoredSession | undefined;
	listSessions(): StoredSession[];
	deleteSession(id: string): void;

	appendEvent(event: StoredEvent): void;
	eventsAfter(sessionId: string, afterSeq?: number): StoredEvent[];
	latestSeq(sessionId: string): number;

	saveSnapshot(snapshot: StoredSnapshot): void;
	getSnapshot(sessionId: string): StoredSnapshot | undefined;

	createApproval(approval: StoredApproval): void;
	settleApproval(id: string, status: Exclude<ApprovalStatus, "pending">): void;
	expireApprovals(sessionId?: string): number;
	getApproval(id: string): StoredApproval | undefined;
	listApprovals(sessionId: string): StoredApproval[];

	withTransaction<T>(operation: () => T): T;
	compact(): void;
	close(): void;
}
