import type { NativeModelRuntime } from "@allweave/kernel-adapters";
import type { AssistantMessage, Context, Model } from "@allweave/model";

export type FauxResponse = AssistantMessage | ((context: Context) => AssistantMessage | Promise<AssistantMessage>);

function createModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		provider: "faux",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as Model<"openai-completions">;
}

/** Minimal faux-provider harness for native runtime tests. */
export interface FauxHarness {
	getModel(): Model<"openai-completions">;
	getModels(): Array<Model<"openai-completions">>;
	setResponses(responses: FauxResponse[]): void;
	getPendingResponseCount(): number;
	next(context: Context): Promise<AssistantMessage>;
	cleanup(): void;
}

export async function createHarness(options: { models?: Array<{ id: string }> } = {}): Promise<FauxHarness> {
	const models = (options.models ?? [{ id: "faux-1" }]).map((item) => createModel(item.id));
	let responses: FauxResponse[] = [];
	return {
		getModel: () => models[0] ?? createModel("faux-1"),
		getModels: () => models,
		setResponses: (next) => {
			responses = [...next];
		},
		getPendingResponseCount: () => responses.length,
		next: async (context) => {
			const response = responses.shift();
			if (!response) throw new Error("No faux response queued");
			return typeof response === "function" ? await response(context) : response;
		},
		cleanup: () => {
			responses = [];
		},
	};
}

/** Adapt the faux harness to the native model gateway contract. */
export function nativeGateway(harness: FauxHarness): NativeModelRuntime {
	const models = new Map(harness.getModels().map((item) => [item.id, item] as const));
	return {
		getModel: (provider: string, id: string) =>
			provider === "faux"
				? (models.get(id) ?? (id === harness.getModel().id ? harness.getModel() : undefined))
				: undefined,
		getModels: () => harness.getModels(),
		async *streamSimple(_model: Model<string>, context: Context, options?: { signal?: AbortSignal }) {
			const message = await harness.next(Object.assign(context, { signal: options?.signal }));
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			if (text) yield { type: "text_delta", delta: text };
			yield { type: "done", reason: message.stopReason, message };
		},
	} as unknown as NativeModelRuntime;
}

export function getMessageText(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text")
		.map((block) => block.text)
		.join("");
}
