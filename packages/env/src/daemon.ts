import { constants, type Dir, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { LineScanner, type WatchTarget } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Json } from "./connection.ts";
import { DaemonOutput } from "./daemon-output.ts";

const MAX_FRAME = 16 * 1024 * 1024;
type Handle = { path: string; file?: FileHandle; dir?: Dir; queue: Promise<unknown>; failed?: boolean };
const handles = new Map<number, Handle>();
const jobs = new Map<number, { controller: AbortController; env: NodeExecutionEnv }>();
let nextHandle = 1;
let lastSeen = Date.now();
let buffered = Buffer.alloc(0);
let output = Promise.resolve();
let ending = false;

function send(type: number, id: number, json: object, payload: Uint8Array = new Uint8Array(0)): void {
	const bytes = Buffer.from(JSON.stringify(json));
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + bytes.length + payload.length);
	header[4] = type;
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(bytes.length, 9);
	const frame = Buffer.concat([header, bytes, payload]);
	output = output.then(
		() =>
			new Promise<void>((resolve, reject) =>
				process.stdout.write(frame, (error) => (error ? reject(error) : resolve())),
			),
	);
	void output.catch(() => shutdown());
}
function info(path: string, stats: Stats) {
	return {
		name: basename(path),
		kind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other",
		size: stats.size,
		mtimeSec: Math.floor(stats.mtimeMs / 1000),
		mtimeNsec: Math.round((stats.mtimeMs % 1000) * 1e6),
		dev: stats.dev,
		ino: stats.ino,
	};
}
function failure(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}
function text(json: Json, key: string): string {
	const value = json[key];
	if (typeof value !== "string") throw failure("EINVAL", `Missing ${key}`);
	return value;
}
function number(json: Json, key: string): number {
	const value = json[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw failure("EINVAL", `Invalid ${key}`);
	return value;
}
function insert(handle: Handle): number {
	if (handles.size >= 4096) throw failure("EMFILE", "Too many handles");
	const id = nextHandle++;
	handles.set(id, handle);
	return id;
}
function handleFor(json: Json): Handle {
	const handle = handles.get(number(json, "handle"));
	if (!handle) throw failure("EBADF", "Unknown handle");
	return handle;
}
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!result.ok) throw result.error;
	return result.value;
}

async function dispatch(
	id: number,
	json: Json,
	payload: Uint8Array,
	job: { controller: AbortController; env: NodeExecutionEnv },
): Promise<{ json: object; payload?: Uint8Array }> {
	const context = withAbortSignal(job.controller.signal, BACKGROUND_CONTEXT);
	const path = typeof json.path === "string" ? json.path : "";
	const empty = { json: {} };
	switch (json.op) {
		case "hello":
			return {
				json: {
					protocol: 1,
					version: "1.1.0",
					os: process.platform === "win32" ? "windows" : process.platform,
					arch: process.arch,
					home: homedir(),
					tmpdir: tmpdir(),
					cwd: process.cwd(),
					separator: sep,
					driveCwds: Object.fromEntries(
						Object.entries(process.env)
							.filter(([key]) => /^=[a-z]:$/iu.test(key))
							.map(([key, value]) => [key.slice(1), value]),
					),
					pid: process.pid,
				},
			};
		case "lstat":
			return { json: info(path, await lstat(path)) };
		case "realpath":
			return { json: { path: await realpath(path) } };
		case "mkdir":
			await mkdir(path, { recursive: json.recursive === true });
			return empty;
		case "mkdtemp":
			return { json: { path: await mkdtemp(path) } };
		case "rm":
			await rm(path, { recursive: json.recursive === true, force: json.force === true });
			return empty;
		case "rename":
			await rename(path, text(json, "to"));
			return empty;
		case "truncate": {
			const file = await open(path, "r+");
			try {
				await file.truncate(number(json, "size"));
			} finally {
				await file.close();
			}
			return empty;
		}
		case "fsync": {
			const file = await open(path, "r+");
			try {
				if ((await file.stat()).isDirectory()) throw failure("EISDIR", "Is a directory");
				await file.sync();
			} finally {
				await file.close();
			}
			return empty;
		}
		case "write": {
			if (json.parents !== false) await mkdir(dirname(path), { recursive: true });
			const file = await open(path, json.append ? "a" : "w");
			try {
				await file.writeFile(payload);
				if (json.keep) return { json: { handle: insert({ path, file, queue: Promise.resolve() }) } };
			} catch (error) {
				await file.close();
				throw error;
			}
			await file.close();
			return empty;
		}
		case "writeChunk": {
			const handle = handleFor(json);
			if (!handle.file || handle.failed) throw failure("EBADF", "Invalid write handle");
			try {
				await handle.file.writeFile(payload);
			} catch (error) {
				handle.failed = true;
				throw error;
			}
			return empty;
		}
		case "open": {
			if (json.noFollow && (await lstat(path)).isSymbolicLink()) throw failure("EINVAL", "Refusing symbolic link");
			const file = await open(
				path,
				constants.O_RDONLY |
					(json.mode === "read" ? 0 : constants.O_NONBLOCK) |
					(json.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0),
			);
			try {
				const stats = await file.stat();
				if (json.mode !== "read" && !stats.isFile())
					throw failure(stats.isDirectory() ? "EISDIR" : "EINVAL", "Not a regular file");
				const handle = insert({ path, file, queue: Promise.resolve() });
				return { json: { handle, [json.mode === "read" ? "stat" : "info"]: info(path, stats) } };
			} catch (error) {
				await file.close();
				throw error;
			}
		}
		case "pread": {
			const handle = handleFor(json);
			if (!handle.file) throw failure("EBADF", "Not a file");
			const buffer = Buffer.alloc(Math.min(number(json, "length"), MAX_FRAME - 65536));
			const { bytesRead } = await handle.file.read(
				buffer,
				0,
				buffer.length,
				json.offset === undefined ? null : number(json, "offset"),
			);
			return { json: {}, payload: buffer.subarray(0, bytesRead) };
		}
		case "fstat": {
			const handle = handleFor(json);
			if (!handle.file) throw failure("EBADF", "Not a file");
			return { json: info(handle.path, await handle.file.stat()) };
		}
		case "scanLines": {
			const handle = handleFor(json);
			if (!handle.file) throw failure("EBADF", "Not a file");
			const scanner = new LineScanner(
				number(json, "startLine"),
				json.endLine === undefined ? undefined : number(json, "endLine"),
			);
			const buffer = Buffer.alloc(65536);
			for (let offset = 0; ; ) {
				if (job.controller.signal.aborted) throw failure("aborted", "aborted");
				const { bytesRead } = await handle.file.read(buffer, 0, buffer.length, offset);
				if (!bytesRead) break;
				scanner.push(buffer.subarray(0, bytesRead));
				offset += bytesRead;
			}
			return { json: scanner.finish() };
		}
		case "opendir": {
			const dir = await opendir(path);
			return { json: { handle: insert({ path, dir, queue: Promise.resolve() }) } };
		}
		case "readdir": {
			const handle = handleFor(json);
			if (!handle.dir) throw failure("EBADF", "Not a directory");
			const entries: object[] = [];
			let done = false;
			for (let i = 0; i < number(json, "max"); i++) {
				const entry = await handle.dir.read();
				if (!entry) {
					done = true;
					break;
				}
				const child = join(handle.path, entry.name);
				try {
					entries.push({ name: entry.name, info: info(child, await lstat(child)) });
				} catch (error) {
					entries.push({ name: entry.name, error: errorFields(error) });
				}
			}
			return { json: { entries, done } };
		}
		case "close": {
			const handle = handleFor(json);
			handles.delete(number(json, "handle"));
			await handle.file?.close();
			await handle.dir?.close();
			return empty;
		}
		case "exec": {
			const output = new DaemonOutput(
				json.window as
					| { maxBytes: number; maxLines: number; minIntervalMs: number; bytesPerSecond: number }
					| undefined,
				(chunk, outputInfo) => send(4, id, { kind: "output", ...outputInfo }, Buffer.from(chunk)),
			);
			try {
				const result = unwrap(
					await job.env.exec(
						typeof json.command === "string" ? json.command : (json.argv as string[]),
						{
							cwd: path || text(json, "cwd"),
							env: json.env as Record<string, string>,
							inheritEnv: json.inheritEnv !== false,
							timeout: typeof json.timeoutMs === "number" ? json.timeoutMs / 1000 : undefined,
							spill: json.spill as { afterBytes: number; afterLines: number } | undefined,
							onOutput: (chunk, _context, outputInfo) => output.push(chunk, outputInfo),
						},
						context,
					),
				);
				return { json: result };
			} finally {
				output.flush();
			}
		}
		case "watch": {
			const watcher = unwrap(
				await job.env.watch(
					json.targets as WatchTarget[],
					(change) =>
						send(
							4,
							id,
							"error" in change
								? { kind: "error", code: change.error.code, message: change.error.message }
								: { kind: "change", ...change },
						),
					context,
				),
			);
			send(4, id, { kind: "ready", mode: watcher.mode });
			await new Promise<void>((resolve) => {
				if (job.controller.signal.aborted) resolve();
				else job.controller.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			await watcher.close(BACKGROUND_CONTEXT);
			return empty;
		}
		default:
			throw failure("EINVAL", "Unknown operation");
	}
}
function errorFields(error: unknown): Json {
	const value =
		error instanceof Error ? (error as NodeJS.ErrnoException & { spillPath?: string }) : new Error(String(error));
	return {
		code: "code" in value ? value.code : "unknown",
		message: value.message,
		...("path" in value ? { path: value.path } : {}),
		...("spillPath" in value ? { spillPath: value.spillPath } : {}),
	};
}
async function shutdown(): Promise<void> {
	if (ending) return;
	ending = true;
	for (const job of jobs.values()) {
		job.controller.abort();
		await job.env.cleanup(BACKGROUND_CONTEXT);
	}
	for (const handle of handles.values()) {
		await handle.file?.close().catch(() => {});
		await handle.dir?.close().catch(() => {});
	}
	process.exit(0);
}
const token = process.argv[process.argv.indexOf("--token") + 1];
if (!process.argv.includes("serve") || !/^[a-f0-9]+$/u.test(token ?? ""))
	throw new Error("Usage: pi-env serve --token <hex>");
process.stdout.write(`PI-ENV ${token}\n`);
process.stdout.on("error", () => void shutdown());
const heartbeat = setInterval(() => {
	if (Date.now() - lastSeen > 30_000) void shutdown();
	else send(6, 0, {});
}, 5000);
heartbeat.unref();
process.stdin.on("end", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.stdin.on("data", (chunk: Buffer) => {
	lastSeen = Date.now();
	buffered = Buffer.concat([buffered, chunk]);
	while (buffered.length >= 4) {
		const length = buffered.readUInt32BE(0);
		if (length < 9 || length > MAX_FRAME) {
			void shutdown();
			return;
		}
		if (buffered.length < length + 4) return;
		const frame = buffered.subarray(4, length + 4);
		buffered = buffered.subarray(length + 4);
		const type = frame[0];
		const id = frame.readUInt32BE(1);
		const jsonLength = frame.readUInt32BE(5);
		let json: Json;
		try {
			if (jsonLength > length - 9) throw new Error();
			json = JSON.parse(frame.subarray(9, 9 + jsonLength).toString("utf8"));
			if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error();
		} catch {
			send(3, id, { code: "EINVAL", message: "Invalid JSON" });
			continue;
		}
		if (type === 6) continue;
		if (type === 5) {
			const job = jobs.get(id);
			if (json.mode === "kill") void job?.env.cleanup(BACKGROUND_CONTEXT);
			else job?.controller.abort();
			continue;
		}
		if (type !== 1) continue;
		const job = {
			controller: new AbortController(),
			env: new NodeExecutionEnv({
				cwd: process.cwd(),
				shellPath: typeof json.shellPath === "string" ? json.shellPath : undefined,
				watch: {
					mode: json.mode as "native" | "polling" | undefined,
					pollIntervalMs: json.pollIntervalMs as number | undefined,
					maxDirectories: json.maxDirectories as number | undefined,
				},
			}),
		};
		jobs.set(id, job);
		const run = () => dispatch(id, json, frame.subarray(9 + jsonLength), job);
		const handle = typeof json.handle === "number" ? handles.get(json.handle) : undefined;
		const result = handle ? handle.queue.catch(() => {}).then(run) : run();
		if (handle) handle.queue = result;
		void result
			.then(
				(reply) => send(2, id, reply.json, reply.payload),
				(error) => send(3, id, errorFields(error)),
			)
			.finally(() => jobs.delete(id));
	}
});
