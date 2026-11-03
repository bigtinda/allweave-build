import type { RunUsage, SessionDetail } from "../../../shared/src/protocol.ts";

type Usage = NonNullable<SessionDetail["tokens"]>;

/** Never guess a delta when a counter disappears or moves backwards. */
export function usageDelta(before: Usage, after: Usage): Usage | undefined {
	const delta: Usage = { input: 0, output: 0, total: 0 };
	for (const key of ["input", "output", "total", "cacheRead", "cacheWrite", "cost"] as const) {
		const start = before[key];
		const end = after[key];
		if (start === undefined && end === undefined) continue;
		if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start)
			return undefined;
		delta[key] = end - start;
	}
	return delta;
}

export function finishRunUsage(before: Usage, after: Usage, info: Omit<RunUsage, "tokens" | "status">): RunUsage {
	const tokens = usageDelta(before, after);
	return { ...info, status: tokens ? "available" : "unavailable", ...(tokens ? { tokens } : {}) };
}
