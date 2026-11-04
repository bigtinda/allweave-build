import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { NativeTool, NativeToolContext, NativeToolResult } from "./types.ts";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_OUTPUT = 120_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".pi", "dist", "build", ".next"]);

function error(message: string): never {
	throw new Error(message);
}

function text(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) error(`Missing string parameter: ${key}`);
	return value;
}

async function inside(root: string, input: string, allowMissing = false): Promise<string> {
	const path = resolve(root, input);
	if (path !== root && !path.startsWith(root + sep)) error(`Path escapes workspace: ${input}`);
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) error(`Symbolic links are not allowed: ${input}`);
		const real = await realpath(path);
		if (real !== root && !real.startsWith(root + sep)) error(`Path escapes workspace: ${input}`);
		return real;
	} catch (cause) {
		if (!allowMissing) throw cause;
		const parent = await realpath(dirname(path)).catch(() => error(`Parent does not exist: ${input}`));
		if (parent !== root && !parent.startsWith(root + sep)) error(`Path escapes workspace: ${input}`);
		return join(parent, path.slice(dirname(path).length + 1));
	}
}

function clip(value: string, limit = MAX_OUTPUT): string {
	return value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} bytes truncated)` : value;
}

export function createBuiltinTools(): NativeTool[] {
	const tools: NativeTool[] = [
		{
			name: "read",
			description: "Read a UTF-8 file from the workspace. Use offset/limit for large files.",
			readOnly: true,
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative path" },
					offset: { type: "number" },
					limit: { type: "number" },
				},
				required: ["path"],
			},
			async execute(input, context) {
				const path = await inside(context.cwd, text(input, "path"));
				const info = await stat(path);
				if (!info.isFile()) error(`Not a file: ${input.path}`);
				if (info.size > MAX_READ_BYTES) error(`File is larger than 1 MB: ${input.path}`);
				const content = await readFile(path, "utf8");
				const offset = typeof input.offset === "number" ? Math.max(0, input.offset) : 0;
				const limit = typeof input.limit === "number" ? Math.max(1, input.limit) : undefined;
				return { content: clip(content.slice(offset, limit ? offset + limit : undefined)) };
			},
		},
		{
			name: "write",
			description: "Write a UTF-8 file in the workspace, creating parent directories.",
			readOnly: false,
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
			async execute(input, context) {
				const path = await inside(context.cwd, text(input, "path"), true);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, text(input, "content"), "utf8");
				return { content: `Wrote ${path}` };
			},
		},
		{
			name: "edit",
			description: "Replace exactly one occurrence of oldText with newText.",
			readOnly: false,
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					oldText: { type: "string" },
					newText: { type: "string" },
				},
				required: ["path", "oldText", "newText"],
			},
			async execute(input, context) {
				const path = await inside(context.cwd, text(input, "path"));
				const content = await readFile(path, "utf8");
				const oldText = text(input, "oldText");
				const index = content.indexOf(oldText);
				if (index < 0) error("oldText was not found");
				if (content.indexOf(oldText, index + oldText.length) >= 0) error("oldText is not unique");
				const next = content.slice(0, index) + text(input, "newText") + content.slice(index + oldText.length);
				await writeFile(path, next, "utf8");
				return { content: `Edited ${path}` };
			},
		},
		{
			name: "ls",
			description: "List a directory in the workspace.",
			readOnly: true,
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "Defaults to ." } },
			},
			async execute(input, context) {
				const path = await inside(context.cwd, typeof input.path === "string" ? input.path : ".");
				const entries = await readdir(path, { withFileTypes: true });
				return {
					content: entries
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
						.join("\n"),
				};
			},
		},
		{
			name: "grep",
			description: "Search text files with a JavaScript regular expression.",
			readOnly: true,
			parameters: {
				type: "object",
				properties: {
					pattern: { type: "string" },
					path: { type: "string", description: "Defaults to ." },
					include: { type: "string", description: "Optional filename substring" },
				},
				required: ["pattern"],
			},
			async execute(input, context) {
				const pattern = new RegExp(text(input, "pattern"), "u");
				const root = await inside(context.cwd, typeof input.path === "string" ? input.path : ".");
				const include = typeof input.include === "string" ? input.include : undefined;
				const lines: string[] = [];
				const visit = async (directory: string): Promise<void> => {
					if (lines.length >= 200) return;
					const entries = await readdir(directory, { withFileTypes: true });
					for (const entry of entries) {
						if (SKIP_DIRS.has(entry.name)) continue;
						const path = join(directory, entry.name);
						if (entry.isDirectory()) {
							await visit(path);
							continue;
						}
						if (!entry.isFile() || (include && !entry.name.includes(include))) continue;
						const content = await readFile(path, "utf8").catch(() => "");
						for (const [index, line] of content.split("\n").entries()) {
							if (pattern.test(line)) {
								lines.push(`${relative(root, path)}:${index + 1}:${line.slice(0, 300)}`);
								if (lines.length >= 200) break;
							}
						}
					}
				};
				await visit(root);
				return { content: lines.join("\n") || "No matches" };
			},
		},
		{
			name: "find",
			description: "Find workspace files whose name contains a pattern.",
			readOnly: true,
			parameters: {
				type: "object",
				properties: { pattern: { type: "string" }, path: { type: "string" } },
				required: ["pattern"],
			},
			async execute(input, context) {
				const pattern = text(input, "pattern").toLowerCase();
				const root = await inside(context.cwd, typeof input.path === "string" ? input.path : ".");
				const found: string[] = [];
				const visit = async (directory: string): Promise<void> => {
					if (found.length >= 200) return;
					for (const entry of await readdir(directory, { withFileTypes: true })) {
						if (SKIP_DIRS.has(entry.name)) continue;
						const path = join(directory, entry.name);
						if (entry.name.toLowerCase().includes(pattern)) found.push(relative(root, path));
						if (entry.isDirectory()) await visit(path);
					}
				};
				await visit(root);
				return { content: found.join("\n") || "No matches" };
			},
		},
		{
			name: "bash",
			description: "Run a shell command in the workspace. Output is truncated.",
			readOnly: false,
			parameters: {
				type: "object",
				properties: {
					command: { type: "string" },
					timeout: { type: "number", description: "Seconds, default 120" },
				},
				required: ["command"],
			},
			async execute(input, context) {
				return runBash(text(input, "command"), context, typeof input.timeout === "number" ? input.timeout : 120);
			},
		},
	];
	return tools;
}

function runBash(command: string, context: NativeToolContext, seconds: number): Promise<NativeToolResult> {
	return new Promise((resolve) => {
		const child = spawn(command, {
			cwd: context.cwd,
			shell: true,
			signal: context.signal,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: Math.min(Math.max(seconds, 1), 600) * 1000,
		});
		let output = "";
		const append = (chunk: Buffer): void => {
			if (output.length >= MAX_OUTPUT) return;
			output += chunk.toString("utf8");
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", (cause) => {
			resolve({ content: cause.message, isError: true });
		});
		child.on("close", (code, signal) => {
			const status = signal ? `signal ${signal}` : `exit ${code ?? 0}`;
			resolve({
				content: clip(`${output}${output.endsWith("\n") || !output ? "" : "\n"}[${status}]`),
				isError: (code ?? 0) !== 0,
			});
		});
	});
}
