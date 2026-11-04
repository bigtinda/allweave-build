import { NativeModelError, type NativeModelErrorKind } from "@allweave/kernel";

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "ENOTFOUND"]);
const CONTEXT_PATTERN =
	/context length|context window|maximum context|too many tokens|prompt is too long|input is too long/iu;
const AUTH_PATTERN = /unauthorized|invalid api key|authentication|forbidden|permission denied|invalid token/iu;
const RATE_LIMIT_PATTERN = /rate limit|too many requests|quota exceeded|overloaded/iu;
const NETWORK_PATTERN = /fetch failed|network|socket hang up|connection reset|temporarily unavailable|timeout/iu;

function field(error: unknown, key: string): unknown {
	if (typeof error !== "object" || error === null) return undefined;
	return (error as Record<string, unknown>)[key];
}

function statusOf(error: unknown): number | undefined {
	const status = field(error, "status") ?? field(error, "statusCode");
	return typeof status === "number" ? status : undefined;
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	const message = field(error, "message");
	return typeof message === "string" ? message : String(error);
}

function classify(message: string, status: number | undefined, code: string | undefined): NativeModelErrorKind {
	if (status === 401 || status === 403 || AUTH_PATTERN.test(message)) return "auth";
	if (status === 429 || RATE_LIMIT_PATTERN.test(message)) return "rate_limit";
	if (status === 413 || status === 422 || CONTEXT_PATTERN.test(message)) return "context_length";
	if (status !== undefined ? RETRYABLE_STATUS.has(status) : code !== undefined && NETWORK_CODES.has(code)) {
		return "network";
	}
	if (NETWORK_PATTERN.test(message)) return "network";
	return "provider";
}

/**
 * Maps provider and transport failures to the kernel's stable error contract.
 * The original error is kept as `cause`; callers can inspect `kind`, `status`, and `retryable`.
 */
export function toModelError(error: unknown, signal?: AbortSignal): NativeModelError {
	if (error instanceof NativeModelError) return error;
	const message = messageOf(error);
	if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
		return new NativeModelError(message || "模型请求已取消", {
			kind: "aborted",
			retryable: false,
			cause: error,
		});
	}
	const status = statusOf(error);
	const rawCode = field(error, "code");
	const code = typeof rawCode === "string" ? rawCode : undefined;
	const kind = classify(message, status, code);
	const retryable =
		kind === "rate_limit" ||
		kind === "network" ||
		(kind === "provider" && status !== undefined && RETRYABLE_STATUS.has(status));
	return new NativeModelError(message || "模型请求失败", { kind, retryable, status, cause: error });
}
