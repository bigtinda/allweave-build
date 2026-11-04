import type { AgentEngine, KernelRunContext } from "@allweave/kernel";
import type { AgentRuntime } from "./runtime.adapter.ts";

/**
 * Runtime engine adapter. Execution belongs to the native kernel loop; the
 * kernel actor owns lifecycle, run ids, cancellation and approval gates.
 */
export class RuntimeEngine implements AgentEngine {
	private readonly open: () => Promise<AgentRuntime>;
	private runtime?: Promise<AgentRuntime>;

	constructor(open: () => Promise<AgentRuntime>) {
		this.open = open;
	}

	async run(text: string, context: KernelRunContext): Promise<void> {
		const runtime = await this.resolve();
		await runtime.prompt(text, context.signal, context.takeSteering, context.images);
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
