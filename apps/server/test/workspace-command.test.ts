import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Connection } from "@earendil-works/pi-env";
import { workspaceCommandOperations } from "../src/workspaces/command-operations.ts";
import { daemon, LoopbackRemoteWorkspaces } from "./remote-fixture.ts";

test(
	"command backends preserve Pi local selection and share output, timeout and cancellation semantics",
	{
		timeout: 15000,
		skip: !daemon || !existsSync(daemon) ? "Run npm run hydrate:env-daemons first" : false,
	},
	async () => {
		assert.ok(daemon);
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-command-")));
		const connection = new Connection({ command: [daemon] });
		const remote = new LoopbackRemoteWorkspaces(directory, connection);
		const local = { id: "w", name: "Fixture", path: directory };
		try {
			assert.equal(
				workspaceCommandOperations(local, directory),
				undefined,
				"SDK builtin keeps its settings and spawn hook",
			);
			const remoteOps = workspaceCommandOperations({ ...local, remote: { host: "loopback" } }, directory, remote)!;
			for (const operations of [createLocalBashOperations(), remoteOps]) {
				let output = "";
				const result = await operations.exec("printf 'shared output'", directory, {
					onData: (data) => {
						output += data.toString();
					},
				});
				assert.equal(result.exitCode, 0);
				assert.equal(output, "shared output");
				await assert.rejects(operations.exec("sleep 2", directory, { timeout: 0.05, onData: () => {} }));
				const controller = new AbortController();
				const pending = operations.exec("sleep 2", directory, { signal: controller.signal, onData: () => {} });
				controller.abort();
				await assert.rejects(pending);
			}
		} finally {
			connection.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
