/** Provider error classification and abortable backoff. */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"]);

function statusOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const status =
		(error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
	return typeof status === "number" ? status : undefined;
}

export function isRetryable(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || /aborted/u.test(error.message))) return false;
	const status = statusOf(error);
	if (status !== undefined) return RETRYABLE_STATUS.has(status);
	if (typeof error === "object" && error !== null) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/context length|context window|invalid request|model not found|unauthorized|forbidden/iu.test(message))
		return false;
	return /fetch failed|network|rate limit|overloaded|timeout|temporar/iu.test(message);
}

export function retryDelay(attempt: number, baseMs = 500): number {
	return baseMs * 2 ** attempt + Math.floor(Math.random() * 250);
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
