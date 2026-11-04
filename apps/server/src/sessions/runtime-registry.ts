import type { AgentRuntime, AgentRuntimeInput } from "./runtime.adapter.ts";

export interface RuntimeFactory {
	open(input: AgentRuntimeInput): Promise<AgentRuntime>;
}

/**
 * Owns the live runtimes of the workbench: one runtime per session,
 * created lazily and reused until it is disposed.
 */
export class SessionRuntimeRegistry {
	private factory: RuntimeFactory;
	private runtimes = new Map<string, Promise<AgentRuntime>>();

	constructor(factory: RuntimeFactory) {
		this.factory = factory;
	}

	/** Runtime of a session, created on first use. */
	get(id: string, input: AgentRuntimeInput): Promise<AgentRuntime> {
		const existing = this.runtimes.get(id);
		if (existing) return existing;
		const creating = this.factory.open(input).catch((error) => {
			if (this.runtimes.get(id) === creating) this.runtimes.delete(id);
			throw error;
		});
		this.runtimes.set(id, creating);
		return creating;
	}

	/** The pending or resolved runtime of a session, without creating one. */
	pending(id: string): Promise<AgentRuntime> | undefined {
		return this.runtimes.get(id);
	}

	has(id: string): boolean {
		return this.runtimes.has(id);
	}

	ids(): string[] {
		return [...this.runtimes.keys()];
	}

	/** Forget a runtime without disposing it. */
	remove(id: string): boolean {
		return this.runtimes.delete(id);
	}

	/** Dispose the runtime of a session and forget it. */
	async dispose(id: string, reason: "quit" | "reload"): Promise<void> {
		const pending = this.runtimes.get(id);
		if (!pending) return;
		this.runtimes.delete(id);
		const runtime = await pending;
		await runtime.dispose(reason);
	}

	/** Dispose every runtime. */
	async disposeAll(reason: "quit" | "reload"): Promise<void> {
		const ids = [...this.runtimes.keys()];
		for (const id of ids) await this.dispose(id, reason);
	}
}
