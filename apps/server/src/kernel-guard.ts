import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccessMode } from "../../shared/src/protocol.ts";
import { workspacePath } from "./security.ts";
import { toolPermission } from "./tool-policy.ts";

export const APPROVAL_MARKER = "PI_CONSOLE_APPROVAL:";

export default function registerConsoleGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, context) => {
		const pathTools = new Set(["read", "write", "edit", "ls", "find", "grep"]);
		if (pathTools.has(event.toolName)) {
			const input = event.input as Record<string, unknown>;
			const path = typeof input.path === "string" ? input.path : ".";
			try {
				await workspacePath(process.cwd(), path, event.toolName === "write");
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : "Path denied" };
			}
		}
		const mode = await readAccessMode();
		const permission = toolPermission(mode, event.toolName);
		if (permission === "allow") return undefined;
		if (permission === "deny") {
			return { block: true, reason: "计划模式仅允许只读工具。切换权限模式后再执行此操作。" };
		}
		const payload = JSON.stringify({
			toolCallId: event.toolCallId,
			name: event.toolName,
			input: event.input,
		});
		const approved = await context.ui.confirm("PI Console tool approval", `${APPROVAL_MARKER}${payload}`, {
			timeout: 300_000,
			signal: context.signal,
		});
		return approved ? undefined : { block: true, reason: "User denied this tool call", terminate: true };
	});
}

async function readAccessMode(): Promise<AccessMode> {
	const path = process.env.PI_CONSOLE_ACCESS_MODE_FILE;
	if (!path) return "ask";
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof value === "object" &&
			value !== null &&
			"mode" in value &&
			(value.mode === "plan" || value.mode === "ask" || value.mode === "auto" || value.mode === "full")
		) {
			return value.mode;
		}
	} catch {}
	return "ask";
}
