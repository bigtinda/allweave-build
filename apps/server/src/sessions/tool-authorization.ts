import { randomUUID } from "node:crypto";
import type { AccessMode, Approval, SessionDetail } from "../../../shared/src/protocol.ts";
import type { AdaptedEvent } from "../adapter.ts";
import { HttpError } from "../security.ts";
import { toolPermission } from "../tool-policy.ts";

export type ToolPermission = "allow" | "ask" | "deny";

export interface ApprovalRequest {
	toolCallId: string;
	name: string;
	input: unknown;
}

export interface ToolAuthorizationOptions {
	/** Persist and broadcast a session change. */
	emit(sessionId: string, change: AdaptedEvent, mutate?: (draft: SessionDetail) => void): void;
	/** Access mode of the session, used by the permission policy. */
	accessMode(sessionId: string): AccessMode;
	/** Approvals are only accepted while the session is running. */
	canRequest(sessionId: string): boolean;
	/** Deadline of a pending approval. */
	timeoutMs?: number;
}

interface PendingApproval {
	sessionId: string;
	resolve: (approved: boolean) => void;
}

const approvalTimeoutMs = 300_000;

/**
 * Owns the approval flow of tool calls: the policy decision, the pending
 * approval, its five minute deadline and the approve/deny/cancel paths.
 * It never touches the transport: changes are handed to the session owner.
 */
export class ToolAuthorization {
	private approvals = new Map<string, PendingApproval>();
	private options: ToolAuthorizationOptions;
	private timeoutMs: number;

	constructor(options: ToolAuthorizationOptions) {
		this.options = options;
		this.timeoutMs = options.timeoutMs ?? approvalTimeoutMs;
	}

	/** Policy decision for a tool call in the current access mode. */
	permission(sessionId: string, toolName: string, readOnlyTools: Set<string>): ToolPermission {
		return toolPermission(this.options.accessMode(sessionId), toolName, readOnlyTools);
	}

	/** Ask the user to approve a tool call. Resolves false when it is not granted. */
	request(sessionId: string, request: ApprovalRequest): Promise<boolean> {
		if (!this.options.canRequest(sessionId)) return Promise.resolve(false);
		const approval: Approval = {
			id: randomUUID(),
			toolCallId: request.toolCallId,
			name: request.name,
			input: request.input,
			expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
		};
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.settle(approval.id, false, true), this.timeoutMs);
			this.approvals.set(approval.id, {
				sessionId,
				resolve: (approved) => {
					clearTimeout(timer);
					resolve(approved);
				},
			});
			this.options.emit(
				sessionId,
				{
					type: "approval.requested",
					tool: {
						id: request.toolCallId,
						name: request.name,
						input: request.input,
						status: "approval",
						startedAt: new Date().toISOString(),
					},
				},
				(draft) => {
					draft.approvals.push(approval);
					draft.status = "approval";
				},
			);
		});
	}

	/** Grant or deny a pending approval. */
	approve(sessionId: string, approvalId: string, allowed: boolean): void {
		const approval = this.approvals.get(approvalId);
		if (!approval || approval.sessionId !== sessionId) throw new HttpError(404, "Approval expired or not found");
		this.settle(approvalId, allowed);
	}

	/** Reject every pending approval of a session. */
	cancel(sessionId: string): void {
		for (const [id, approval] of [...this.approvals]) {
			if (approval.sessionId === sessionId) this.settle(id, false);
		}
	}

	/** Reject every pending approval. */
	cancelAll(): void {
		for (const id of [...this.approvals.keys()]) this.settle(id, false);
	}

	private settle(approvalId: string, approved: boolean, expired = false): void {
		const approval = this.approvals.get(approvalId);
		if (!approval) return;
		this.approvals.delete(approvalId);
		this.options.emit(approval.sessionId, { type: expired ? "approval.expired" : "agent.status" }, (draft) => {
			draft.approvals = draft.approvals.filter((item) => item.id !== approvalId);
			draft.status = draft.approvals.length ? "approval" : "running";
		});
		approval.resolve(approved);
	}
}
