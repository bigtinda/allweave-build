/** Conservative, dependency-free token estimates. Calibrated by provider usage later. */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

export function estimateText(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		if (CJK.test(char)) cjk++;
		else other++;
	}
	return Math.ceil(cjk + other / 4);
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
