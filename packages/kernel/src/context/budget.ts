/**
 * Conservative, dependency-free token estimates. CJK text is roughly one token
 * per character for Latin tokenizers, with markup/punctuation overhead; Latin
 * text is roughly one token per four characters. The weights are calibrated
 * against cl100k_base on the checked-in corpus and stay conservative so a
 * budget check fails before the provider context window.
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

export function estimateText(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		if (CJK.test(char)) cjk++;
		else other++;
	}
	return Math.ceil(cjk * 1.38 + other * 0.24);
}

export function estimateMessage(message: { text: string; thinking?: string; toolCalls?: unknown[] }): number {
	return 4 + estimateText(message.text) + estimateText(message.thinking ?? "") + (message.toolCalls?.length ?? 0) * 8;
}

export function estimateMessages(
	messages: readonly { text: string; thinking?: string; toolCalls?: unknown[] }[],
	scale = 1,
): number {
	let total = 0;
	for (const message of messages) total += estimateMessage(message);
	return Math.ceil(total * scale);
}

export function fitsBudget(tokens: number, maxTokens: number, reserveTokens = 0): boolean {
	return tokens <= Math.max(0, maxTokens - reserveTokens);
}
