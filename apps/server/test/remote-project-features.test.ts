import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { Connection } from "@earendil-works/pi-env";
import { resolveConfigValueOrThrow } from "../../../packages/coding-agent/src/core/resolve-config-value.ts";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";
import { McpClient, StdioTransport } from "../../../packages/mcp/src/index.ts";
import type { GitChanges, GitDiff, GitWorkspaceStatus, SessionDetail, Workspace } from "../../shared/src/protocol.ts";
import { createApp } from "../src/app.ts";
import { remoteMcpLaunchCommand, remoteMcpValueCommand, wrapRemoteMcpConfig } from "../src/remote-mcp.ts";
import { ConsoleStore } from "../src/store.ts";
import { daemon, LoopbackRemoteWorkspaces } from "./remote-fixture.ts";

test(
	"remote Git panel, worktree sessions and MCP configuration APIs",
	{
		timeout: 60_000,
		skip: !daemon || !existsSync(daemon) ? "Run npm run hydrate:env-daemons first" : false,
	},
	async (t) => {
		assert.ok(daemon);
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-remote-features-")));
		const root = join(directory, "project");
		const data = join(directory, "data");
		const outside = join(directory, "outside");
		await mkdir(root);
		await mkdir(outside);
		const previousReference = process.env.PI_MCP_TEST_REFERENCE;
		const previousPath = process.env.PATH;
		process.env.PI_MCP_TEST_REFERENCE = "remote environment value";
		const transport = new Connection({ command: [daemon] });
		const paths = process.platform === "win32" ? win32 : posix;
		const remote = new LoopbackRemoteWorkspaces(data, transport, paths, directory);
		const workspace: Workspace = { id: randomUUID(), name: "Remote", path: root, remote: { host: "loopback" } };
		const store = new ConsoleStore(data);
		store.saveWorkspace(workspace);
		store.close();
		const harness = await createHarness();
		const { app } = await createApp({
			directory: data,
			roots: [outside],
			port: 8787,
			logger: false,
			createSession: (options) =>
				createAgentSession({ ...options, model: harness.getModel(), modelRuntime: harness.session.modelRuntime }),
			remoteWorkspaces: remote,
		});
		const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" };
		const request = (method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
			app.inject({ method, url, headers, payload });
		const endpoint = `/api/workspaces/${workspace.id}/git`;
		try {
			await remote.execute(workspace, ["git", "init", "-b", "main"]);
			await remote.execute(workspace, ["git", "config", "user.name", "Remote fixture"]);
			await remote.execute(workspace, ["git", "config", "user.email", "remote@example.invalid"]);
			await t.test(
				"diff, exact staging, stale revisions and commits execute through the remote daemon",
				async () => {
					await writeFile(join(root, "first file.txt"), "original\n");
					await writeFile(join(root, "other.txt"), "keep untracked\n");
					let result = await request("GET", endpoint);
					assert.equal(result.statusCode, 200, result.body);
					let state = result.json<GitChanges>();
					const diff = await request("GET", `${endpoint}/diff?path=first%20file.txt`);
					assert.equal(diff.statusCode, 200, diff.body);
					assert.match(diff.json<GitDiff>().text, /\+original/u);
					result = await request("POST", `${endpoint}/index`, {
						path: "first file.txt",
						staged: true,
						revision: state.indexRevision,
					});
					assert.equal(result.statusCode, 200, result.body);
					state = result.json<GitChanges>();
					assert.equal(state.files.find((file) => file.path === "other.txt")?.index, "?");
					result = await request("POST", `${endpoint}/commit`, {
						message: "fixture: first",
						revision: state.indexRevision,
					});
					assert.equal(result.statusCode, 200, result.body);
					assert.equal((await remote.execute(workspace, ["git", "ls-files"])).trim(), "first file.txt");
					await writeFile(join(root, "first file.txt"), "updated\n");
					state = (await request("GET", endpoint)).json<GitChanges>();
					const previousRevision = state.indexRevision;
					state = (
						await request("POST", `${endpoint}/index`, {
							path: "first file.txt",
							staged: true,
							revision: previousRevision,
						})
					).json<GitChanges>();
					assert.equal(
						(await request("POST", `${endpoint}/commit`, { message: "stale", revision: previousRevision }))
							.statusCode,
						409,
					);
					assert.match(
						(await request("GET", `${endpoint}/diff?path=first%20file.txt&staged=true`)).json<GitDiff>().text,
						/\+updated/u,
					);
					await writeFile(join(root, ".env"), "secret\n");
					await remote.execute(workspace, ["git", "add", "--", ".env"]);
					state = (await request("GET", endpoint)).json<GitChanges>();
					assert.ok(!state.files.some((file) => file.path === ".env"));
					assert.equal(
						(await request("POST", `${endpoint}/commit`, { message: "private", revision: state.indexRevision }))
							.statusCode,
						403,
					);
					await remote.execute(workspace, ["git", "restore", "--staged", "--", ".env"]);
					await rm(join(root, ".env"));
					state = (await request("GET", endpoint)).json<GitChanges>();
					result = await request("POST", `${endpoint}/commit`, {
						message: "fixture: update",
						revision: state.indexRevision,
					});
					assert.equal(result.statusCode, 200, result.body);
					await rm(join(root, "other.txt"));
				},
			);
			await t.test("remote branches and worktrees retain the SSH host in new sessions", async () => {
				let state = (await request("GET", endpoint)).json<GitChanges>();
				let result = await request("POST", `${endpoint}/branches`, {
					action: "create",
					name: "spare",
					base: "main",
					revision: state.indexRevision,
				});
				assert.equal(result.statusCode, 200, result.body);
				state = result.json<GitChanges>();
				result = await request("POST", `${endpoint}/branches`, {
					action: "switch",
					name: "spare",
					revision: state.indexRevision,
				});
				assert.equal(result.statusCode, 200, result.body);
				state = result.json<GitChanges>();
				assert.equal(state.branch, "spare");
				assert.equal(
					(
						await request("POST", `${endpoint}/branches`, {
							action: "delete",
							name: "spare",
							revision: state.indexRevision,
						})
					).statusCode,
					409,
				);
				state = (
					await request("POST", `${endpoint}/branches`, {
						action: "switch",
						name: "main",
						revision: state.indexRevision,
					})
				).json<GitChanges>();
				assert.equal(
					(
						await request("POST", `${endpoint}/branches`, {
							action: "delete",
							name: "spare",
							revision: state.indexRevision,
						})
					).statusCode,
					200,
				);
				result = await request("POST", "/api/plugins/git/worktrees", {
					workspaceId: workspace.id,
					mode: "new",
					branch: "worktree-feature",
					baseBranch: "main",
				});
				assert.equal(result.statusCode, 200, result.body);
				const created = result.json<{ workspace: Workspace; session: SessionDetail }>();
				assert.equal(created.workspace.remote?.host, "loopback");
				assert.equal(created.session.workspaceId, created.workspace.id);
				assert.ok(paths.relative(directory, created.workspace.path).startsWith(".allweave"));
				const status = await request("GET", `/api/plugins/git?workspaceId=${workspace.id}`);
				assert.equal(status.statusCode, 200, status.body);
				assert.ok(
					status.json<GitWorkspaceStatus>().worktrees.some((worktree) => worktree.branch === "worktree-feature"),
				);
			});
			await t.test(
				"both remote MCP config formats persist without exposing private paths through file APIs",
				async () => {
					for (const kind of ["adapter", "extension"] as const) {
						const url = `/api/plugins/mcp-config?workspaceId=${workspace.id}&kind=${kind}`;
						let result = await request("GET", url);
						assert.equal(result.statusCode, 200, result.body);
						assert.deepEqual(JSON.parse(result.json<{ content: string }>().content), { mcpServers: {} });
						const config = {
							mcpServers: { fixture: { command: process.execPath, args: ["-e", "process.exit(0)"] } },
						};
						result = await request("PUT", "/api/plugins/mcp-config", {
							workspaceId: workspace.id,
							kind,
							content: JSON.stringify(config),
						});
						assert.equal(result.statusCode, 200, result.body);
						const content = (await request("GET", url)).json<{ content: string }>().content;
						assert.deepEqual(JSON.parse(content), config);
						assert.deepEqual(
							JSON.parse(await readFile(join(root, kind === "adapter" ? ".mcp.json" : ".pi/mcp.json"), "utf8")),
							config,
						);
						assert.equal(
							(
								await request("PUT", "/api/plugins/mcp-config", {
									workspaceId: workspace.id,
									kind,
									content: "{broken",
								})
							).statusCode,
							400,
						);
					}
					assert.equal(
						(await request("GET", `/api/workspaces/${workspace.id}/file?path=.pi/mcp.json`)).statusCode,
						403,
					);
					const proxy = join(data, "proxy");
					await remote.prepareMcpConfigs(workspace, proxy);
					const mirrored = JSON.parse(await readFile(join(proxy, ".pi/mcp.json"), "utf8")) as {
						mcpServers: { fixture: { command: string; args: string[]; env?: unknown } };
					};
					assert.equal(mirrored.mcpServers.fixture.command, "ssh");
					assert.ok(mirrored.mcpServers.fixture.args.includes("loopback"));
					assert.equal(mirrored.mcpServers.fixture.env, undefined);
					await rename(join(root, ".pi"), join(root, ".pi-original"));
					await writeFile(join(outside, "mcp.json"), "outside");
					await symlink(outside, join(root, ".pi"), process.platform === "win32" ? "junction" : "dir");
					assert.equal(
						(await request("GET", `/api/plugins/mcp-config?workspaceId=${workspace.id}&kind=extension`))
							.statusCode,
						403,
					);
					assert.equal(
						(
							await request("PUT", "/api/plugins/mcp-config", {
								workspaceId: workspace.id,
								kind: "extension",
								content: '{"mcpServers":{}}',
							})
						).statusCode,
						403,
					);
					assert.equal(await readFile(join(outside, "mcp.json"), "utf8"), "outside");
					await rm(join(root, ".pi"), { recursive: true, force: true });
					await rename(join(root, ".pi-original"), join(root, ".pi"));
				},
			);
			await t.test("MCP launchers preserve arguments and evaluate config values on the target host", async () => {
				const cwd = join(root, "directory with spaces");
				await mkdir(cwd);
				const code =
					"process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),literal:process.env.MCP_LITERAL,ref:process.env.MCP_REFERENCE,escaped:process.env.MCP_ESCAPED}))";
				const args = ["-e", code, "quote'\"; $(not-a-command)"];
				const config = {
					command: process.execPath,
					args,
					cwd,
					env: {
						MCP_LITERAL: "literal'\"",
						MCP_REFERENCE: `\${PI_MCP_TEST_REFERENCE}`,
						MCP_ESCAPED: "$!literal $$VALUE",
					},
				};
				const output = await remote.execute(workspace, remoteMcpLaunchCommand(paths, directory, root, config));
				const value = JSON.parse(output) as {
					cwd: string;
					args: string[];
					literal: string;
					ref: string;
					escaped: string;
				};
				assert.equal(await realpath(value.cwd), cwd);
				assert.deepEqual(value.args, args.slice(2));
				assert.equal(value.literal, "literal'\"");
				assert.equal(value.ref, "remote environment value");
				assert.equal(value.escaped, "!literal $VALUE");
				assert.equal(
					await remote.execute(workspace, remoteMcpValueCommand(paths, "$!literal $$VALUE")),
					"!literal $VALUE",
				);
				const toPosix = (path: string) =>
					process.platform === "win32"
						? path
								.replaceAll("\\", "/")
								.replace(/^([A-Za-z]):/u, (_match, drive: string) => `/${drive.toLowerCase()}`)
						: path;
				const posixOutput = await remote.execute(
					workspace,
					remoteMcpLaunchCommand(posix, toPosix(directory), toPosix(root), {
						...config,
						command: toPosix(process.execPath),
						cwd: toPosix(cwd),
					}),
				);
				assert.deepEqual(JSON.parse(posixOutput), value);
				if (process.platform === "win32") {
					const shim = join(root, "fixture shim.cmd");
					await writeFile(shim, `@echo off\r\n"${process.execPath}" %*\r\n`);
					const shimOutput = await remote.execute(
						workspace,
						remoteMcpLaunchCommand(paths, directory, root, { ...config, command: shim }),
					);
					assert.deepEqual(JSON.parse(shimOutput), value);
				}
			});
			await t.test(
				"native MCP tools connect through the generated SSH stdio transport in an agent session",
				async () => {
					const shimDirectory = join(directory, "ssh-shim");
					await mkdir(shimDirectory);
					const sshScript = join(shimDirectory, "ssh.mjs");
					await writeFile(
						sshScript,
						[
							"#!/usr/bin/env node",
							"import { spawn } from 'node:child_process';",
							"const command = process.argv.at(-1);",
							"const windows = process.platform === 'win32';",
							"const child = spawn(windows ? 'powershell.exe' : 'sh', windows ? command.slice('powershell '.length).split(' ') : ['-c', command], { stdio: 'inherit', windowsHide: true });",
							"child.on('error', () => process.exit(1));",
							"child.on('exit', (code) => process.exit(code ?? 1));",
						].join("\n"),
					);
					if (process.platform === "win32")
						await writeFile(
							join(shimDirectory, "ssh.cmd"),
							`@echo off\r\n"${process.execPath}" "${sshScript}" %*\r\n`,
						);
					else {
						await rename(sshScript, join(shimDirectory, "ssh"));
						await chmod(join(shimDirectory, "ssh"), 0o755);
					}
					process.env.PATH = `${shimDirectory}${delimiter}${previousPath ?? ""}`;
					const server = join(root, "mcp-fixture.mjs");
					await writeFile(
						server,
						[
							"import { createInterface } from 'node:readline';",
							"const input = createInterface({ input: process.stdin });",
							"input.on('line', (line) => {",
							"  const request = JSON.parse(line); if (request.id === undefined) return;",
							"  let result;",
							"  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };",
							"  else if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };",
							"  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: request.params.arguments.text }] };",
							"  else if (request.method === 'resources/list') result = { resources: [] };",
							"  else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] };",
							"  const response = result ? { result } : { error: { code: -32601, message: 'Method not found' } };",
							"  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');",
							"});",
							"input.on('close', () => process.exit(0));",
						].join("\n"),
					);
					const launch = remoteMcpLaunchCommand(paths, directory, root, {
						command: process.execPath,
						args: [server],
					});
					const stdio = new StdioTransport(
						process.platform === "win32"
							? { command: "powershell.exe", args: launch.slice("powershell ".length).split(" ") }
							: { command: "sh", args: ["-c", launch] },
					);
					const client = new McpClient({ name: "fixture-client", version: "1", requestTimeoutMs: 3000 });
					try {
						await client.connect(stdio);
						assert.equal((await client.callTool("echo", { text: "stdio roundtrip" })).content[0]?.type, "text");
					} catch (error) {
						throw new Error(`Native MCP launcher failed: ${stdio.stderr}`, { cause: error });
					} finally {
						await client.close();
					}
					const sshTransport = new StdioTransport({ command: "ssh", args: ["loopback", launch] });
					const sshClient = new McpClient({ name: "ssh-fixture-client", version: "1", requestTimeoutMs: 3000 });
					try {
						await sshClient.connect(sshTransport);
					} catch (error) {
						throw new Error(`SSH MCP launcher failed: ${sshTransport.stderr}`, { cause: error });
					} finally {
						await sshClient.close();
					}
					const saved = await request("PUT", "/api/plugins/mcp-config", {
						workspaceId: workspace.id,
						kind: "extension",
						content: JSON.stringify({
							mcpServers: { fixture: { command: process.execPath, args: [server], exposure: "direct" } },
						}),
					});
					assert.equal(saved.statusCode, 200, saved.body);
					const created = await request("POST", "/api/sessions", { workspaceId: workspace.id });
					assert.equal(created.statusCode, 200, created.body);
					const session = created.json<SessionDetail>();
					await request("PUT", `/api/sessions/${session.id}/access-mode`, { accessMode: "full" });
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { text: "remote rpc roundtrip" }), {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage("done"),
					]);
					const sent = await request("POST", `/api/sessions/${session.id}/messages`, {
						text: "Call the remote MCP fixture",
					});
					assert.equal(sent.statusCode, 202, sent.body);
					let completed = (await request("GET", `/api/sessions/${session.id}`)).json<SessionDetail>();
					const deadline = Date.now() + 15_000;
					while (completed.status === "running") {
						if (Date.now() > deadline)
							throw new Error(`MCP session did not finish: ${JSON.stringify(completed.tools)}`);
						await new Promise((resolve) => setTimeout(resolve, 20));
						completed = (await request("GET", `/api/sessions/${session.id}`)).json<SessionDetail>();
					}
					assert.equal(completed.status, "idle", completed.error);
					const tool = completed.tools.find((tool) => tool.name === "mcp__fixture__echo");
					assert.equal(
						tool?.status,
						"completed",
						`${JSON.stringify(tool?.output)}\n${(await request("GET", `/api/skills?sessionId=${session.id}`)).body}`,
					);
					assert.match(JSON.stringify(tool.output), /remote rpc roundtrip/u);
				},
			);
		} finally {
			await app.close();
			transport.close();
			harness.cleanup();
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousReference === undefined) delete process.env.PI_MCP_TEST_REFERENCE;
			else process.env.PI_MCP_TEST_REFERENCE = previousReference;
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("resolved remote HTTP credentials remain literal when the local MCP client reads them", async () => {
	const secret = `!never execute \${LOCAL_SECRET}`;
	const content = await wrapRemoteMcpConfig(
		JSON.stringify({
			mcpServers: {
				remote: {
					url: "https://example.invalid/mcp",
					headers: { Authorization: `\${REMOTE_TOKEN}` },
					oauth: { clientSecret: "!remote-command" },
				},
			},
		}),
		{
			paths: posix,
			home: "/home/remote",
			root: "/project",
			ssh: "ssh",
			sshArgs: [],
			resolveValue: async () => secret,
		},
	);
	const parsed = JSON.parse(content) as {
		mcpServers: { remote: { headers: { Authorization: string }; oauth: { clientSecret: string } } };
	};
	assert.equal(resolveConfigValueOrThrow(parsed.mcpServers.remote.headers.Authorization, "test header"), secret);
	assert.equal(resolveConfigValueOrThrow(parsed.mcpServers.remote.oauth.clientSecret, "test secret"), secret);
});
