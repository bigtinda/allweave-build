import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

interface BashOperations {
	exec(
		command: string,
		cwd: string,
		options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
	): Promise<{ exitCode: number }>;
}

import type { Workspace } from "../../../shared/src/protocol.ts";
import type { RemoteWorkspaceService } from "../remote-workspaces.ts";
import { HttpError } from "../security.ts";

/**
 * Both backends use Pi's BashOperations contract (cwd, seconds, cancellation,
 * streamed bytes, exit status). Undefined selects the SDK's builtin local
 * backend, preserving its shell settings, prefix and spawn hook.
 */
export function workspaceCommandOperations(
	workspace: Workspace,
	cwd: string,
	remote?: RemoteWorkspaceService,
): BashOperations | undefined {
	if (!workspace.remote) return undefined;
	if (!remote) throw new HttpError(501, "远程主机服务不可用");
	return {
		exec: async (command, workingDirectory, { onData, signal, timeout }) => {
			const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
			const remoteCwd = await remote.toolPath(workspace, cwd, workingDirectory);
			const checked = await remote.checkedPath(workspace, remoteCwd);
			const result = await checked.env.exec(
				command,
				{
					cwd: remoteCwd,
					timeout,
					onOutput: (text) => onData(Buffer.from(text)),
				},
				context,
			);
			if (!result.ok) throw result.error;
			return { exitCode: result.value.exitCode };
		},
	};
}
