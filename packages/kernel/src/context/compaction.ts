import type { NativeMessage } from "../engine/types.ts";
import { estimateMessages } from "./budget.ts";

export interface CompactionOptions {
	keepRecentTokens: number;
	summarize?: (messages: NativeMessage[]) => Promise<string>;
}

export interface CompactionResult {
	messages: NativeMessage[];
	summary?: string;
	dropped: number;
	compacted: boolean;
}

function cutAtUserTurn(messages: NativeMessage[], keepRecentTokens: number): number {
	let tokens = 0;
	let index = messages.length;
	while (index > 0 && tokens < keepRecentTokens) {
		index--;
		tokens += estimateMessages([messages[index] as NativeMessage]);
	}
	while (index < messages.length && messages[index]?.role !== "user") index++;
	return index >= messages.length ? Math.max(0, messages.length - 1) : index;
}

/** Drops old turns and replaces them with a summary. Callers own persistence/events. */
export async function compactMessages(
	messages: NativeMessage[],
	options: CompactionOptions,
): Promise<CompactionResult> {
	if (messages.length === 0) return { messages, dropped: 0, compacted: false };
	const cut = cutAtUserTurn(messages, options.keepRecentTokens);
	if (cut <= 0) return { messages, dropped: 0, compacted: false };
	const dropped = messages.slice(0, cut);
	const recent = messages.slice(cut);
	const summary = options.summarize
		? await options.summarize(dropped)
		: `Earlier conversation was compacted (${dropped.length} messages).`;
	return {
		messages: [{ role: "user", text: `[Context summary]\n${summary}`, timestamp: Date.now() }, ...recent],
		summary,
		dropped: dropped.length,
		compacted: true,
	};
}
