import type { AgentEngine, KernelRunContext } from "@pi-console/kernel";
import type { AgentRuntime } from "./pi-runtime.adapter.ts";

/**
 * M2 engine adapter. Execution still belongs to the Pi AgentSession; the
 * kernel actor owns lifecycle, run ids, cancellation and approval gates.
 */
export class PiEngine implements AgentEngine {
	private readonly open: () => Promise<AgentRuntime>;
	private runtime?: Promise<AgentRuntime>;

	constructor(open: () => Promise<AgentRuntime>) {
		this.open = open;
	}

	async run(text: string, context: KernelRunContext): Promise<void> {
		const runtime = await this.resolve();
		await runtime.prompt(text, context.signal, context.takeSteering);
	}

	async abort(): Promise<void> {
		if (!this.runtime) return;
		const runtime = await this.runtime;
		await runtime.abort();
	}

	/** Drop the cached runtime without disposing it; the runtime registry owns disposal. */
	forget(): void {
		this.runtime = undefined;
	}

	async dispose(reason: "quit" | "reload"): Promise<void> {
		if (!this.runtime) return;
		const runtime = await this.runtime;
		this.runtime = undefined;
		await runtime.dispose(reason);
	}

	private resolve(): Promise<AgentRuntime> {
		this.runtime ??= this.open();
		return this.runtime;
	}
}
