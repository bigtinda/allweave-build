import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DefaultPackageManager, type ProgressEvent, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { DefaultPluginStatus, PiConfiguredPackage, PiPackageJob } from "../../shared/src/protocol.ts";
import { HttpError } from "./security.ts";

interface PackageJob extends PiPackageJob {
	doneAt?: number;
}

export const DEFAULT_PLUGIN_SOURCES = [
	"npm:pi-mcp-adapter",
	"npm:pi-web-access",
	"npm:pi-subagents",
	"npm:pi-mcp-extension",
	"npm:@agimon-ai/doompi-git",
] as const;

function normalizeSource(input: string): string {
	let source = input.trim();
	if (!source || source.length > 512 || /[\u0000-\u001f\u007f]/u.test(source)) {
		throw new HttpError(400, "请输入 npm 包名或有效的安装命令");
	}
	const command = source.match(/^(?:\$\s*)?(?:pi|pi\.exe)\s+install\s+(.+)$/iu);
	if (command) source = command[1].trim();
	if ((source.startsWith('"') && source.endsWith('"')) || (source.startsWith("'") && source.endsWith("'"))) {
		source = source.slice(1, -1);
	}
	if (!source || source.startsWith("-") || /[\u0000-\u001f\u007f;&|`$<>]/u.test(source)) {
		throw new HttpError(
			400,
			"Only one package source is accepted; command options and shell syntax are not supported",
		);
	}
	if (!source.includes(":") && !source.startsWith(".") && !/^[A-Za-z]:[\\/]/u.test(source)) {
		const npmName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9*^~<>=|.+-]+)?$/iu;
		if (!npmName.test(source)) throw new HttpError(400, "请输入有效的 npm 包名，例如 @scope/package");
		return `npm:${source}`;
	}
	if (source.startsWith("npm:")) {
		const npmName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9*^~<>=|.+-]+)?$/iu;
		if (!npmName.test(source.slice(4))) throw new HttpError(400, "Enter a valid npm package source");
		return source;
	}
	if (source.startsWith("git:")) {
		if (/\s/u.test(source)) throw new HttpError(400, "Package sources must be a single argument");
		if (source.length <= 4) throw new HttpError(400, "Enter a valid git package source");
		return source;
	}
	if (/^https?:\/\//iu.test(source) || /^ssh:\/\//iu.test(source)) {
		try {
			const url = new URL(source);
			if (!["http:", "https:", "ssh:"].includes(url.protocol) || url.username || url.password) throw new Error();
		} catch {
			throw new HttpError(400, "Enter a valid HTTPS, HTTP, or SSH Git URL without embedded credentials");
		}
		if (/\s/u.test(source)) throw new HttpError(400, "Package sources must be a single argument");
		return source;
	}
	if (
		source.startsWith("./") ||
		source.startsWith("../") ||
		source.startsWith(".\\") ||
		source.startsWith("..\\") ||
		/^[A-Za-z]:[\\/]/u.test(source)
	) {
		return source;
	}
	throw new HttpError(400, "Supported sources are npm names, git: sources, Git URLs, or local paths");
}

function appendOutput(job: PackageJob, chunk: Buffer | string): void {
	job.output = `${job.output}${chunk.toString()}`.slice(-64_000);
}

const packageResourceTypes = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceFromDeclaration(declaration: unknown): string | undefined {
	if (typeof declaration === "string") return declaration;
	if (isObject(declaration) && typeof declaration.source === "string") return declaration.source;
	return undefined;
}

function packageIdentity(source: string): string {
	if (!source.startsWith("npm:")) return source;
	const name = source.slice(4);
	const versionAt = name.startsWith("@") ? name.indexOf("@", name.indexOf("/") + 1) : name.indexOf("@");
	return `npm:${versionAt === -1 ? name : name.slice(0, versionAt)}`;
}

function isDefaultSource(source: string): boolean {
	const identity = packageIdentity(source);
	return DEFAULT_PLUGIN_SOURCES.some((candidate) => packageIdentity(candidate) === identity);
}

function isDisabledDeclaration(declaration: unknown): boolean {
	return (
		isObject(declaration) &&
		declaration.autoload !== false &&
		packageResourceTypes.every(
			(resourceType) => Array.isArray(declaration[resourceType]) && declaration[resourceType].length === 0,
		)
	);
}

export class PiPackageManager {
	private cwd: string;
	private agentDirectory: string;
	private beforeInstall: () => Promise<void>;
	private jobs = new Map<string, PackageJob>();
	private defaultStatuses = new Map<string, DefaultPluginStatus>();
	private activeOperation: Promise<void> | undefined;
	private operationStarting = false;

	constructor(cwd: string | undefined, agentDirectory: string, beforeInstall: () => Promise<void>) {
		this.cwd = resolve(cwd ?? agentDirectory);
		this.agentDirectory = agentDirectory;
		this.beforeInstall = beforeInstall;
		for (const source of DEFAULT_PLUGIN_SOURCES) {
			this.defaultStatuses.set(source, { source, status: "pending", output: "" });
		}
	}

	defaultPlugins(): DefaultPluginStatus[] {
		return [...this.defaultStatuses.values()].map((item) => ({ ...item }));
	}

	async ensureDefaultPackages(): Promise<void> {
		const configured = await this.configuredSources();
		for (const source of DEFAULT_PLUGIN_SOURCES) {
			if (configured.has(source)) {
				this.defaultStatuses.set(source, { source, status: "succeeded", output: "已安装" });
				continue;
			}
			this.defaultStatuses.set(source, { source, status: "running", output: "" });
			try {
				const started = await this.install(source);
				let current = started;
				while (current.status === "running") {
					await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
					current = this.getJob(started.id);
				}
				this.defaultStatuses.set(source, {
					source,
					status: current.status,
					output: current.output,
					...(current.error ? { error: current.error } : {}),
				});
				if (current.status === "succeeded") configured.add(source);
			} catch (error) {
				this.defaultStatuses.set(source, {
					source,
					status: "failed",
					output: "",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	async list(): Promise<{ packages: PiConfiguredPackage[] }> {
		const settings = await this.readSettings();
		const configured = Array.isArray(settings.packages) ? settings.packages : [];
		return {
			packages: configured.flatMap((declaration): PiConfiguredPackage[] => {
				const source = sourceFromDeclaration(declaration);
				return source
					? [{ source, applied: !isDisabledDeclaration(declaration), isDefault: isDefaultSource(source) }]
					: [];
			}),
		};
	}

	async install(input: string): Promise<PiPackageJob> {
		const source = normalizeSource(input);
		return this.startCommand("install", source);
	}

	async remove(input: string): Promise<PiPackageJob> {
		const source = normalizeSource(input);
		if (isDefaultSource(source)) throw new HttpError(409, "默认插件无法卸载");
		return this.startCommand("remove", source);
	}

	async setApplied(input: string, applied: boolean): Promise<PiConfiguredPackage> {
		const source = normalizeSource(input);
		if (isDefaultSource(source)) throw new HttpError(409, "默认插件无法取消应用");
		this.assertNoRunningOperation();
		this.operationStarting = true;
		try {
			let settings = await this.readSettings();
			let declarations = Array.isArray(settings.packages) ? settings.packages : [];
			let index = declarations.findIndex(
				(declaration) => packageIdentity(sourceFromDeclaration(declaration) ?? "") === packageIdentity(source),
			);
			if (index === -1) throw new HttpError(404, "未找到已配置的插件");
			const currentlyApplied = !isDisabledDeclaration(declarations[index]);
			if (currentlyApplied !== applied) await this.beforeInstall();
			settings = await this.readSettings();
			declarations = Array.isArray(settings.packages) ? settings.packages : [];
			index = declarations.findIndex(
				(declaration) => packageIdentity(sourceFromDeclaration(declaration) ?? "") === packageIdentity(source),
			);
			if (index === -1) throw new HttpError(404, "未找到已配置的插件");
			const current = declarations[index];
			if (!isObject(current) && typeof current !== "string") {
				throw new HttpError(409, "插件声明格式不受支持");
			}
			if (!applied && isDisabledDeclaration(current)) {
				return { source: sourceFromDeclaration(current) ?? source, applied: false, isDefault: false };
			}
			if (applied && !isDisabledDeclaration(current)) {
				return { source: sourceFromDeclaration(current) ?? source, applied: true, isDefault: false };
			}
			const disabledState = await this.readDisabledState();
			if (applied) {
				const previous = disabledState[sourceFromDeclaration(current) ?? source];
				declarations[index] = isObject(previous) || typeof previous === "string" ? previous : source;
				delete disabledState[sourceFromDeclaration(current) ?? source];
				settings.packages = declarations;
				await this.writeJson(join(this.agentDirectory, "settings.json"), settings);
				await this.writeJson(join(this.agentDirectory, "pi-console-package-state.json"), disabledState);
			} else {
				const currentSource = sourceFromDeclaration(current) ?? source;
				disabledState[currentSource] = current;
				await this.writeJson(join(this.agentDirectory, "pi-console-package-state.json"), disabledState);
				declarations[index] = {
					...(isObject(current) ? current : {}),
					source: currentSource,
					autoload: true,
					extensions: [],
					skills: [],
					prompts: [],
					themes: [],
				};
				settings.packages = declarations;
				await this.writeJson(join(this.agentDirectory, "settings.json"), settings);
			}
			return { source: sourceFromDeclaration(declarations[index]) ?? source, applied, isDefault: false };
		} finally {
			this.operationStarting = false;
		}
	}

	getJob(id: string): PiPackageJob {
		this.pruneJobs();
		const job = this.jobs.get(id);
		if (!job) throw new HttpError(404, "插件操作已过期");
		return this.view(job);
	}

	async close(): Promise<void> {
		await this.activeOperation;
	}

	private async startCommand(action: "install" | "remove", source: string): Promise<PiPackageJob> {
		this.assertNoRunningOperation();
		this.operationStarting = true;
		try {
			await this.beforeInstall();
			await mkdir(this.agentDirectory, { recursive: true });
			const job: PackageJob = { id: randomUUID(), source, action, status: "running", output: "" };
			this.jobs.set(job.id, job);
			if (action === "install" && this.defaultStatuses.has(source)) {
				this.defaultStatuses.set(source, { source, status: "running", output: "" });
			}
			const settingsManager = SettingsManager.create(this.cwd, this.agentDirectory);
			settingsManager.setProjectTrusted(true);
			const packageManager = new DefaultPackageManager({
				cwd: this.cwd,
				agentDir: this.agentDirectory,
				settingsManager,
			});
			packageManager.setProgressCallback((event: ProgressEvent) => {
				appendOutput(job, `${event.message ?? `${event.action} ${event.source}`}\n`);
			});
			this.operationStarting = false;
			const operation = this.runPackageOperation(packageManager, job);
			this.activeOperation = operation;
			void operation.finally(() => {
				if (this.activeOperation === operation) this.activeOperation = undefined;
			});
			return this.view(job);
		} catch (error) {
			this.operationStarting = false;
			throw error;
		}
	}

	private async runPackageOperation(packageManager: DefaultPackageManager, job: PackageJob): Promise<void> {
		try {
			if (job.action === "install") await packageManager.installAndPersist(job.source);
			else await packageManager.removeAndPersist(job.source);
			this.finishJob(job, "succeeded");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			appendOutput(job, `${message}\n`);
			this.finishJob(job, "failed", message);
		}
	}

	private finishJob(job: PackageJob, status: "succeeded" | "failed", error?: string): void {
		if (job.status !== "running") return;
		job.status = status;
		job.error = error;
		job.doneAt = Date.now();
		if (job.action === "install" && this.defaultStatuses.has(job.source)) {
			this.defaultStatuses.set(job.source, {
				source: job.source,
				status,
				output: job.output,
				...(error ? { error } : {}),
			});
		}
		this.pruneJobs();
	}

	private view(job: PackageJob): PiPackageJob {
		return {
			id: job.id,
			source: job.source,
			action: job.action,
			status: job.status,
			output: job.output,
			...(job.error ? { error: job.error } : {}),
		};
	}

	private async configuredSources(): Promise<Set<string>> {
		const settings = await this.readSettings().catch((): Record<string, unknown> => ({}));
		return new Set(
			(Array.isArray(settings.packages) ? settings.packages : []).flatMap((entry) => {
				const source = sourceFromDeclaration(entry);
				return source ? [source] : [];
			}),
		);
	}

	private assertNoRunningOperation(): void {
		if (this.operationStarting || [...this.jobs.values()].some((job) => job.status === "running")) {
			throw new HttpError(409, "已有插件操作正在运行");
		}
	}

	private async readSettings(): Promise<Record<string, unknown>> {
		const path = join(this.agentDirectory, "settings.json");
		const content = await readFile(path, "utf8").catch((error: unknown) => {
			if (isObject(error) && error.code === "ENOENT") return "{}";
			throw error;
		});
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			throw new HttpError(500, "settings.json 不是有效的 JSON 文件");
		}
		if (!isObject(parsed)) throw new HttpError(500, "settings.json 必须包含 JSON 对象");
		return parsed;
	}

	private async readDisabledState(): Promise<Record<string, unknown>> {
		const path = join(this.agentDirectory, "pi-console-package-state.json");
		const content = await readFile(path, "utf8").catch((error: unknown) => {
			if (isObject(error) && error.code === "ENOENT") return "{}";
			throw error;
		});
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			throw new HttpError(500, "插件状态文件不是有效的 JSON 文件");
		}
		if (!isObject(parsed)) throw new HttpError(500, "插件状态文件必须包含 JSON 对象");
		return parsed;
	}

	private async writeJson(path: string, value: Record<string, unknown>): Promise<void> {
		await mkdir(this.agentDirectory, { recursive: true });
		await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	}

	private pruneJobs(): void {
		const cutoff = Date.now() - 30 * 60_000;
		for (const [id, job] of this.jobs) if (job.doneAt && job.doneAt < cutoff) this.jobs.delete(id);
	}
}
