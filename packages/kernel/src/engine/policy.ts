import type { NativeTool } from "./types.ts";

export type NativeAccessMode = "plan" | "ask" | "auto" | "full";

export type NativeToolDecision = { action: "allow" } | { action: "ask" } | { action: "deny"; reason: string };

/**
 * Kernel-owned access policy. It decides; the server only renders approvals.
 * Read-only tools are always allowed, including in plan mode.
 */
export function decideToolAccess(tool: NativeTool | undefined, mode: NativeAccessMode): NativeToolDecision {
	if (tool?.readOnly) return { action: "allow" };
	if (mode === "plan") {
		return { action: "deny", reason: "计划模式仅允许只读工具。切换权限模式后再执行此操作。" };
	}
	if (mode === "auto" || mode === "full") return { action: "allow" };
	return { action: "ask" };
}
