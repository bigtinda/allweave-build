/** Lifecycle states owned by the kernel session actor. */
export type KernelSessionStatus = "idle" | "running" | "approval" | "error" | "interrupted";

export interface KernelSessionState {
	status: KernelSessionStatus;
	runId?: string;
	error?: string;
	startedAt?: string;
	finishedAt?: string;
}

export interface KernelRunContext {
	sessionId: string;
	runId: string;
	signal: AbortSignal;
	/** Take queued steering messages at a safe turn boundary. */
	takeSteering(): string[];
}

/** Thrown when a command conflicts with the current session state. */
export class KernelSessionConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KernelSessionConflict";
	}
}

/** The engine seam: Pi today, native loop later. */
export interface AgentEngine {
	run(text: string, context: KernelRunContext): Promise<void>;
	abort(): Promise<void>;
	steer?(text: string): Promise<void>;
	followUp?(text: string): Promise<void>;
	dispose?(reason: "quit" | "reload"): Promise<void>;
}
