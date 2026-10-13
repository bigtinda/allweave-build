import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

export interface KernelInfo {
	version: string;
	archive: string;
	executable: string;
	updatedFromArchive: boolean;
}

interface KernelMetadata {
	version: string;
	archiveHash: string;
}

export interface RpcRecord {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: unknown;
	[key: string]: unknown;
}

interface PendingRequest {
	resolve: (record: RpcRecord) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export type KernelEventHandler = (event: RpcRecord) => void;

export async function prepareDoomCordisHostExtension(agentDirectory: string): Promise<string | undefined> {
	const settingsPath = join(agentDirectory, "settings.json");
	const settingsContent = await readFile(settingsPath, "utf8").catch((error: unknown) => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "{}";
		throw error;
	});
	let settings: unknown;
	try {
		settings = JSON.parse(settingsContent);
	} catch {
		return undefined;
	}
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return undefined;
	const declarations = "packages" in settings && Array.isArray(settings.packages) ? settings.packages : [];
	const hasDoomPiHost = declarations.some((declaration: unknown) => {
		const source =
			typeof declaration === "string"
				? declaration
				: typeof declaration === "object" && declaration !== null && "source" in declaration
					? declaration.source
					: undefined;
		return typeof source === "string" && /^npm:@agimon-ai\/doompi(?:@|\/|$)/u.test(source);
	});
	const extensionDeclarations =
		"extensions" in settings && Array.isArray(settings.extensions) ? settings.extensions : [];
	const hasDirectDoomPiHost = extensionDeclarations.some(
		(extension: unknown) =>
			typeof extension === "string" &&
			(/@agimon-ai[\\/]doompi(?:[\\/]|$)/u.test(extension) || /cordis-host/iu.test(extension)),
	);
	if (hasDoomPiHost || hasDirectDoomPiHost) return undefined;

	const require = createRequire(join(agentDirectory, "npm", "pi-console-resolve.cjs"));
	let corePackagePath: string;
	try {
		corePackagePath = require.resolve("@agimon-ai/doompi-core/package.json");
	} catch {
		return undefined;
	}
	const coreHostPath = join(dirname(corePackagePath), "dist", "cordisHost.mjs");
	if (
		!(await stat(coreHostPath)
			.then((entry) => entry.isFile())
			.catch(() => false))
	)
		return undefined;

	const extensionPath = join(agentDirectory, "pi-console-cordis-host.mjs");
	const source = [
		`import { installDoomCordisHost } from ${JSON.stringify(pathToFileURL(coreHostPath).href)};`,
		"export default async function installPiConsoleDoomCordisHost(pi) {",
		'  const host = await installDoomCordisHost(pi, { mode: "composed", source: "@agimon-ai/doompi/cordis-host" });',
		'  pi.on("session_shutdown", () => host.shutdown());',
		"}",
		"",
	].join("\n");
	const currentSource = await readFile(extensionPath, "utf8").catch(() => undefined);
	if (currentSource !== source) await writeFile(extensionPath, source, { encoding: "utf8", mode: 0o600 });
	return extensionPath;
}

function quotePowerShell(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function readJsonLineStream(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const onData = (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	};
	const onEnd = () => {
		buffer += decoder.end();
		if (buffer) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
		buffer = "";
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

function safeRpcData<T>(record: RpcRecord, command: string): T {
	if (record.type !== "response" || record.success !== true) {
		throw new Error(typeof record.error === "string" ? record.error : `RPC command failed: ${command}`);
	}
	return record.data as T;
}

export class PiKernelArchive {
	private archivePath: string;
	private directory: string;
	private info: KernelInfo | undefined;

	constructor(archivePath: string, directory: string) {
		this.archivePath = resolve(archivePath);
		this.directory = resolve(directory);
	}

	async prepare(): Promise<KernelInfo> {
		if (process.platform !== "win32") throw new Error("当前内核发行包仅支持 Windows");
		const archiveStats = await stat(this.archivePath).catch(() => undefined);
		if (!archiveStats?.isFile()) throw new Error(`内核发行包不存在：${this.archivePath}`);
		const archiveHash = await this.hashArchive();
		await mkdir(this.directory, { recursive: true });
		const parent = await realpath(this.directory);
		const kernelDir = join(parent, "pi-kernel");
		const markerPath = join(kernelDir, ".pi-console-kernel.json");
		let metadata: KernelMetadata | undefined;
		try {
			metadata = JSON.parse(await readFile(markerPath, "utf8")) as KernelMetadata;
		} catch {}
		const executablePath = join(kernelDir, "pi.exe");
		const validExecutable = await stat(executablePath)
			.then((entry) => entry.isFile())
			.catch(() => false);
		let updatedFromArchive = false;
		if (!validExecutable || metadata?.archiveHash !== archiveHash) {
			await this.extractAndSwap(parent, kernelDir);
			updatedFromArchive = true;
			metadata = undefined;
		}
		const packageJson = JSON.parse(await readFile(join(kernelDir, "package.json"), "utf8")) as { version?: unknown };
		if (typeof packageJson.version !== "string") throw new Error("内核发行包 package.json 缺少版本号");
		const versionOutput = await this.runVersion(executablePath);
		const version = versionOutput.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/u)?.[0] ?? packageJson.version;
		const nextMetadata = { version, archiveHash };
		if (updatedFromArchive || metadata?.version !== version || metadata.archiveHash !== archiveHash) {
			await writeFile(markerPath, `${JSON.stringify(nextMetadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		}
		this.info = { version, archive: basename(this.archivePath), executable: executablePath, updatedFromArchive };
		return this.info;
	}

	getInfo(): KernelInfo {
		if (!this.info) throw new Error("内核发行包尚未准备好");
		return this.info;
	}

	private async hashArchive(): Promise<string> {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(this.archivePath)) hash.update(chunk as Buffer);
		return hash.digest("hex");
	}

	private async extractAndSwap(parent: string, kernelDir: string): Promise<void> {
		const staging = join(parent, `pi-kernel-staging-${process.pid}`);
		const previous = join(parent, `pi-kernel-previous-${process.pid}`);
		for (const managedPath of [kernelDir, staging, previous]) {
			const entry = await lstat(managedPath).catch(() => undefined);
			if (entry?.isSymbolicLink()) throw new Error(`拒绝替换符号链接内核路径：${managedPath}`);
		}
		await rm(staging, { recursive: true, force: true });
		await mkdir(staging, { recursive: true });
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"Add-Type -AssemblyName System.IO.Compression.FileSystem",
			`$archivePath = ${quotePowerShell(this.archivePath)}`,
			`$destinationPath = ${quotePowerShell(staging)}`,
			"$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)",
			"try {",
			"  foreach ($entry in $archive.Entries) {",
			"    $entryName = $entry.FullName.Replace([char]92, [char]47)",
			"    if ([System.IO.Path]::IsPathRooted($entryName) -or $entryName -match '(^|/)\\.\\.(/|$)' -or $entryName -match '^[A-Za-z]:' -or $entryName.Contains(':')) { throw \"Unsafe path in release archive: $entryName\" }",
			"  }",
			"} finally { $archive.Dispose() }",
			"[System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $destinationPath)",
		].join("\n");
		await new Promise<void>((resolvePromise, rejectPromise) => {
			const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				windowsHide: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
			});
			child.once("error", rejectPromise);
			child.once("exit", (code) =>
				code === 0 ? resolvePromise() : rejectPromise(new Error(`内核归档解压失败：${stderr || code}`)),
			);
		});
		const extractedExecutable = join(staging, "pi.exe");
		const extractedPackage = join(staging, "package.json");
		const [binaryStat, packageData] = await Promise.all([
			stat(extractedExecutable).catch(() => undefined),
			readFile(extractedPackage, "utf8").catch(() => ""),
		]);
		if (!binaryStat?.isFile() || binaryStat.size < 10_000_000 || !packageData.includes('"version"')) {
			await rm(staging, { recursive: true, force: true });
			throw new Error("内核发行包缺少必要的可执行文件或版本信息");
		}
		await rm(previous, { recursive: true, force: true });
		const current = await lstat(kernelDir).catch(() => undefined);
		if (current) await rename(kernelDir, previous);
		try {
			await rename(staging, kernelDir);
		} catch (error) {
			if (current) await rename(previous, kernelDir);
			throw error;
		}
		await rm(previous, { recursive: true, force: true });
	}

	private runVersion(executablePath: string): Promise<string> {
		return new Promise((resolvePromise, rejectPromise) => {
			const child = spawn(executablePath, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			const timer = setTimeout(() => {
				child.kill();
				rejectPromise(new Error("读取内核版本超时"));
			}, 20_000);
			child.stdout?.on("data", (chunk: Buffer) => {
				output = `${output}${chunk.toString("utf8")}`.slice(-1000);
			});
			child.stderr?.resume();
			child.once("error", (error) => {
				clearTimeout(timer);
				rejectPromise(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				code === 0
					? resolvePromise(output.trim())
					: rejectPromise(new Error(`内核 --version 命令退出，状态码 ${code}`));
			});
		});
	}
}

export class PiRpcClient {
	private process: ReturnType<typeof spawn> | undefined;
	private stopReading: (() => void) | undefined;
	private handlers: KernelEventHandler;
	private pending = new Map<string, PendingRequest>();
	private nextId = 0;
	private stderr = "";
	private exitError: Error | undefined;
	private stopping = false;

	constructor(handler: KernelEventHandler) {
		this.handlers = handler;
	}

	async start(input: {
		executable: string;
		cwd: string;
		sessionDir: string;
		existingSessionFile?: string;
		agentDir: string;
		extensionPath: string;
		accessModeFile: string;
	}): Promise<void> {
		if (this.process) throw new Error("RPC 进程已经启动");
		await mkdir(input.sessionDir, { recursive: true });
		const cordisHostPath = await prepareDoomCordisHostExtension(input.agentDir);
		const args = ["--mode", "rpc", "--session-dir", input.sessionDir, "--approve"];
		// Pi loads CLI extensions before settings packages, so Cordis consumers can find this host at activation.
		for (const extensionPath of [cordisHostPath, input.extensionPath]) {
			if (extensionPath) args.push("--extension", extensionPath);
		}
		if (input.existingSessionFile) args.push("--session", input.existingSessionFile);
		const child = spawn(input.executable, args, {
			cwd: input.cwd,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: input.agentDir,
				PI_CONSOLE_ACCESS_MODE_FILE: input.accessModeFile,
			},
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
		});
		child.once("exit", (code, signal) => {
			if (this.process !== child) return;
			this.exitError = new Error(
				`内核进程已退出（code=${code}, signal=${signal}）${this.stderr ? `: ${this.stderr}` : ""}`,
			);
			this.rejectPending(this.exitError);
			if (!this.stopping) this.handlers({ type: "kernel_exit", error: this.exitError.message });
		});
		child.once("error", (error) => {
			if (this.process !== child) return;
			this.exitError = new Error(`无法启动内核：${error.message}`);
			this.rejectPending(this.exitError);
		});
		child.stdin?.on("error", (error) => {
			if (this.process !== child) return;
			this.exitError = new Error(`内核输入失败：${error.message}`);
			this.rejectPending(this.exitError);
		});
		this.stopReading = readJsonLineStream(child.stdout!, (line) => {
			try {
				const record = JSON.parse(line) as RpcRecord;
				if (record.type === "response" && typeof record.id === "string") {
					const request = this.pending.get(record.id);
					if (request) {
						this.pending.delete(record.id);
						clearTimeout(request.timer);
						request.resolve(record);
						return;
					}
				}
				this.handlers(record);
			} catch {
				if (line.trim()) this.handlers({ type: "kernel_protocol_error", message: "RPC 返回了无效 JSON" });
			}
		});
		await this.request<{ sessionFile?: string }>({ type: "get_state" });
	}

	async request<T>(command: Record<string, unknown>): Promise<T> {
		const child = this.process;
		const stdin = child?.stdin;
		if (!child || !stdin || child.exitCode !== null || !stdin.writable) {
			throw this.exitError ?? new Error("内核没有运行");
		}
		const id = `console-${++this.nextId}`;
		const record = await new Promise<RpcRecord>((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				rejectPromise(new Error(`等待 RPC ${String(command.type)} 超时`));
			}, 30_000);
			this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
			stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (pending) {
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.reject(error);
				}
			});
		});
		return safeRpcData<T>(record, String(command.type));
	}

	sendUiResponse(id: string, confirmed: boolean): void {
		const stdin = this.process?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return;
		stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, confirmed })}\n`);
	}

	sendUiCancelled(id: string): void {
		const stdin = this.process?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return;
		stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`);
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.stopping = true;
		this.stopReading?.();
		this.stopReading = undefined;
		child.stdin?.end();
		await new Promise<void>((resolvePromise) => {
			const timer = setTimeout(() => {
				child.kill();
				resolvePromise();
			}, 2_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolvePromise();
			});
		});
		this.process = undefined;
		this.stopping = false;
		this.rejectPending(new Error("内核已停止"));
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export function rpcValue<T>(record: RpcRecord, key: string): T | undefined {
	const value = record[key];
	return value === undefined ? undefined : (value as T);
}
