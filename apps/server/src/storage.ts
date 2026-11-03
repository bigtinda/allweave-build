import { lstat, readdir, statfs } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StorageCategory, StorageSummary, StoredSession } from "../../shared/src/protocol.ts";
import type { AgentService } from "./agent.ts";
import type { ConsoleStore } from "./store.ts";

interface PathMeasure {
	bytes: number;
	files: number;
}

function inside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function measurePath(path: string): Promise<PathMeasure> {
	const entry = await lstat(path).catch((error: unknown) => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!entry || entry.isSymbolicLink()) return { bytes: 0, files: 0 };
	if (entry.isFile()) return { bytes: entry.size, files: 1 };
	if (!entry.isDirectory()) return { bytes: 0, files: 0 };
	let bytes = 0;
	let files = 0;
	for (const childName of await readdir(path)) {
		const child = await measurePath(join(path, childName));
		bytes += child.bytes;
		files += child.files;
	}
	return { bytes, files };
}

async function measureFiles(paths: string[]): Promise<PathMeasure> {
	const entries = await Promise.all(paths.map((path) => measurePath(path)));
	return entries.reduce((total, entry) => ({ bytes: total.bytes + entry.bytes, files: total.files + entry.files }), {
		bytes: 0,
		files: 0,
	});
}

export class StorageManager {
	private dataDirectory: string;
	private agentDirectory: string;
	private store: ConsoleStore;
	private agents: AgentService;

	constructor(dataDirectory: string, agentDirectory: string, store: ConsoleStore, agents: AgentService) {
		this.dataDirectory = resolve(dataDirectory);
		this.agentDirectory = resolve(agentDirectory);
		this.store = store;
		this.agents = agents;
	}

	async summary(): Promise<StorageSummary> {
		const sessionsDirectory = join(this.dataDirectory, "sessions");
		const databaseFiles = [
			"console.sqlite",
			"console.sqlite-wal",
			"console.sqlite-shm",
			"console.sqlite-journal",
		].map((name) => join(this.dataDirectory, name));
		const currentSessions = new Map(this.agents.list().map((session) => [session.id, session]));
		const sessionFiles = this.store.sessionFiles();
		const sessions = await Promise.all(
			[...currentSessions.values()].map(async (current): Promise<StoredSession> => {
				let bytes = 0;
				const transcript = sessionFiles.get(current.id);
				if (transcript) {
					const file = resolve(transcript);
					if (inside(resolve(sessionsDirectory), file)) {
						const fileStat = await lstat(file).catch(() => undefined);
						if (fileStat?.isFile() && !fileStat.isSymbolicLink()) bytes = fileStat.size;
					}
				}
				return {
					id: current.id,
					title: current.title,
					status: current.status,
					updatedAt: current.updatedAt,
					bytes,
				};
			}),
		);
		const agentRelative = relative(this.dataDirectory, this.agentDirectory);
		const managedNames = new Set([
			"sessions",
			...databaseFiles.map((path) => path.slice(this.dataDirectory.length + 1)),
		]);
		if (agentRelative && agentRelative !== ".." && !agentRelative.startsWith(`..${sep}`)) {
			managedNames.add(agentRelative.split(sep)[0]);
		}
		const otherPaths = (await readdir(this.dataDirectory, { withFileTypes: true }))
			.filter((entry) => !managedNames.has(entry.name))
			.map((entry) => join(this.dataDirectory, entry.name));
		const measures = await Promise.all([
			measurePath(sessionsDirectory),
			measurePath(this.agentDirectory),
			measureFiles(databaseFiles),
			measureFiles(otherPaths),
		]);
		const categories: StorageCategory[] = [
			{ id: "sessions", label: "会话记录", path: sessionsDirectory, ...measures[0] },
			{ id: "agent", label: "配置与插件", path: this.agentDirectory, ...measures[1] },
			{ id: "database", label: "工作台数据库", path: databaseFiles[0], ...measures[2] },
			{ id: "other", label: "其他运行文件", path: this.dataDirectory, ...measures[3] },
		];
		const diskStats = await statfs(this.dataDirectory).catch(() => undefined);
		const totalBytes = categories.reduce((total, category) => total + category.bytes, 0);
		return {
			categories,
			totalBytes,
			...(diskStats
				? {
						disk: {
							totalBytes: diskStats.blocks * diskStats.bsize,
							freeBytes: diskStats.bavail * diskStats.bsize,
						},
					}
				: {}),
			sessions: sessions.sort(
				(left, right) => right.bytes - left.bytes || right.updatedAt.localeCompare(left.updatedAt),
			),
		};
	}

	async compact(): Promise<StorageSummary> {
		this.store.compact();
		return this.summary();
	}
}
