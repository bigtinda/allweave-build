import type { AccessMode } from "../../shared/src/protocol.ts";

const readOnlyTools = new Set(["read", "ls", "find", "grep"]);
const fileMutationTools = new Set(["write", "edit"]);

export type ToolPermission = "allow" | "ask" | "deny";

export function toolPermission(
	mode: AccessMode,
	toolName: string,
	additionalReadOnlyTools: ReadonlySet<string> = new Set(),
): ToolPermission {
	if (readOnlyTools.has(toolName) || additionalReadOnlyTools.has(toolName)) return "allow";
	if (mode === "plan") return "deny";
	if (mode === "full" || (mode === "auto" && fileMutationTools.has(toolName))) return "allow";
	return "ask";
}
