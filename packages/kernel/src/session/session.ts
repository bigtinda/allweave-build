import type { KernelRunContext, KernelSessionState, KernelSessionStatus } from "./types.ts";
import { KernelSessionConflict } from "./types.ts";

export interface KernelSessionOptions {
	id: string;
	/** Abort the underlying engine before waiting for the run to settle. */
	onAbort?: () => Promise<void>;
	now?: () => string;
}

type Listener = (state: KernelSessionState) => void;

/**
 * Serializes commands for one session. The actor owns the lifecycle and run id;
 * engines own execution. It is intentionally small: no I/O, no persistence, no
 * event projection, so it can be tested without an agent.
 */
export class KernelSession {
	readonly id: string;
	private readonly onAbort?: () => Promise<void>;
	private readonly now: () => string;
	private readonly listeners = new Set<Listener>();
	private status: KernelSessionStatus = "idle";
	private runId?: string;
	private error?: string;
	private startedAt?: string;
	private finishedAt?: string;
	private controller?: AbortController;
	private runPromise?: Promise<void>;
	private active = false;
	private approvals = 0;
	private closing = false;

	constructor(options: KernelSessionOptions) {
		this.id = options.id;
		this.onAbort = options.onAbort;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	state(): KernelSessionState {
		return {
			status: this.status,
			...(this.runId ? { runId: this.runId } : {}),
			...(this.error ? { error: this.error } : {}),
			...(this.startedAt ? { startedAt: this.startedAt } : {}),
			...(this.finishedAt ? { finishedAt: this.finishedAt } : {}),
		};
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Start a run. The returned promise settles when the operation settles. */
	start(operation: (context: KernelRunContext) => Promise<void>): Promise<void> {
		if (this.closing) throw new KernelSessionConflict("Session is shutting down");
		if (this.active) throw new KernelSessionConflict("Agent is already running");
		const runId = crypto.randomUUID();
		const controller = new AbortController();
		this.runId = runId;
		this.controller = controller;
		this.error = undefined;
		this.startedAt = this.now();
		this.finishedAt = undefined;
		this.approvals = 0;
		this.active = true;
		this.setStatus("running");
		let result: Promise<void>;
		try {
			result = operation({ sessionId: this.id, runId, signal: controller.signal });
		} catch (error) {
			result = Promise.reject(error);
		}
		this.runPromise = result
			.then(() => {
				if (!controller.signal.aborted) this.error = undefined;
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) {
					this.error = error instanceof Error ? error.message : String(error);
					this.status = "error";
					this.emit();
				}
			})
			.finally(() => {
				this.active = false;
				this.runPromise = undefined;
				this.controller = undefined;
				this.approvals = 0;
				this.finishedAt = this.now();
				if (this.status !== "error") this.setStatus("idle");
			});
		return this.runPromise;
	}

	async abort(): Promise<void> {
		if (!this.active) return;
		this.controller?.abort();
		await this.onAbort?.();
		await this.runPromise;
	}

	async wait(): Promise<void> {
		await this.runPromise;
	}

	/** Mark the session as interrupted after a crash/restart. */
	markInterrupted(): void {
		if (this.active) return;
		this.setStatus("interrupted");
	}

	/** An approval gate keeps the status at `approval` until it is settled. */
	enterApproval(): void {
		if (!this.active) throw new KernelSessionConflict("Session is not running");
		this.approvals += 1;
		this.setStatus("approval");
	}

	settleApproval(): void {
		this.approvals = Math.max(0, this.approvals - 1);
		if (this.active && this.status === "approval" && this.approvals === 0) this.setStatus("running");
	}

	async close(): Promise<void> {
		this.closing = true;
		await this.abort();
		this.listeners.clear();
	}

	private setStatus(status: KernelSessionStatus): void {
		this.status = status;
		this.emit();
	}

	private emit(): void {
		const state = this.state();
		for (const listener of this.listeners) listener(state);
	}
}
