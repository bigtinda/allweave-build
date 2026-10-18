import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
	AppPluginManifest,
	AppPluginRecord,
	AppPluginRegistry,
	InstalledAppPlugin,
} from "../../shared/src/plugins.ts";
import { HttpError } from "./security.ts";

const fieldId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u);
const fieldSchema = z.discriminatedUnion("type", [
	z
		.object({ id: fieldId, label: z.string().trim().min(1).max(60), type: z.literal("text"), required: z.boolean() })
		.strict(),
	z
		.object({
			id: fieldId,
			label: z.string().trim().min(1).max(60),
			type: z.literal("number"),
			required: z.boolean(),
		})
		.strict(),
	z
		.object({ id: fieldId, label: z.string().trim().min(1).max(60), type: z.literal("date"), required: z.boolean() })
		.strict(),
	z
		.object({
			id: fieldId,
			label: z.string().trim().min(1).max(60),
			type: z.literal("boolean"),
			required: z.boolean(),
		})
		.strict(),
	z
		.object({
			id: fieldId,
			label: z.string().trim().min(1).max(60),
			type: z.literal("select"),
			required: z.boolean(),
			options: z.array(z.string().trim().min(1).max(80)).min(1).max(30),
		})
		.strict(),
]);

const manifestSchema = z
	.object({
		manifestVersion: z.literal(1),
		id: z.string().regex(/^[a-z][a-z0-9-]{2,48}$/u),
		name: z.string().trim().min(1).max(80),
		version: z.string().regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u),
		description: z.string().trim().max(500).default(""),
		fields: z.array(fieldSchema).min(1).max(24),
		views: z
			.array(
				z
					.object({
						id: fieldId,
						title: z.string().trim().min(1).max(80),
						type: z.enum(["table", "board"]),
						groupBy: fieldId.optional(),
					})
					.strict(),
			)
			.min(1)
			.max(8),
		navigation: z
			.array(
				z
					.object({
						id: fieldId,
						title: z.string().trim().min(1).max(80),
						viewId: fieldId,
					})
					.strict(),
			)
			.min(1)
			.max(8),
	})
	.strict()
	.superRefine((manifest, context) => {
		const fieldIds = new Set<string>();
		for (const field of manifest.fields) {
			if (fieldIds.has(field.id)) context.addIssue({ code: "custom", message: `Duplicate field id: ${field.id}` });
			fieldIds.add(field.id);
		}
		const viewIds = new Set<string>();
		for (const view of manifest.views) {
			if (viewIds.has(view.id)) context.addIssue({ code: "custom", message: `Duplicate view id: ${view.id}` });
			viewIds.add(view.id);
			if (view.type === "board" && (!view.groupBy || !fieldIds.has(view.groupBy))) {
				context.addIssue({ code: "custom", message: `Board view ${view.id} must group by an existing field` });
			}
			if (view.groupBy && !fieldIds.has(view.groupBy)) {
				context.addIssue({ code: "custom", message: `Unknown groupBy field: ${view.groupBy}` });
			}
		}
		const navigationIds = new Set<string>();
		for (const entry of manifest.navigation) {
			if (navigationIds.has(entry.id)) {
				context.addIssue({ code: "custom", message: `Duplicate navigation id: ${entry.id}` });
			}
			navigationIds.add(entry.id);
			if (!viewIds.has(entry.viewId)) {
				context.addIssue({ code: "custom", message: `Unknown navigation view: ${entry.viewId}` });
			}
		}
	});

const recordSchema = z
	.object({
		id: z.string().uuid(),
		values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
	})
	.strict();

interface RegistryFile {
	revision: number;
	plugins: InstalledAppPlugin[];
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function validateValues(manifest: AppPluginManifest, input: unknown): Record<string, string | number | boolean> {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		throw new HttpError(400, "插件数据必须是对象");
	const values = input as Record<string, unknown>;
	const allowed = new Set(manifest.fields.map((field) => field.id));
	for (const key of Object.keys(values)) {
		if (!allowed.has(key)) throw new HttpError(400, `插件清单中没有字段 ${key}`);
	}
	const normalized: Record<string, string | number | boolean> = {};
	for (const field of manifest.fields) {
		const value = values[field.id];
		if (value === undefined || value === null || value === "") {
			if (field.required) throw new HttpError(400, `${field.label} 为必填项`);
			continue;
		}
		if (field.type === "text" && typeof value === "string" && value.length <= 4000) normalized[field.id] = value;
		else if (field.type === "number" && typeof value === "number" && Number.isFinite(value))
			normalized[field.id] = value;
		else if (field.type === "boolean" && typeof value === "boolean") normalized[field.id] = value;
		else if (field.type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
			normalized[field.id] = value;
		} else if (field.type === "select" && typeof value === "string" && (field.options ?? []).includes(value)) {
			normalized[field.id] = value;
		} else throw new HttpError(400, `${field.label} 的值与字段类型不匹配`);
	}
	return normalized;
}

function compareVersions(left: string, right: string): number {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
	}
	return 0;
}

function hasCompatibleFields(current: AppPluginManifest, next: AppPluginManifest): boolean {
	const shape = (manifest: AppPluginManifest) =>
		manifest.fields
			.map((field) => ({
				id: field.id,
				type: field.type,
				required: field.required,
				options: field.type === "select" ? field.options : undefined,
			}))
			.sort((left, right) => left.id.localeCompare(right.id));
	return JSON.stringify(shape(current)) === JSON.stringify(shape(next));
}

export function parseAppPluginManifest(content: string): AppPluginManifest {
	if (Buffer.byteLength(content, "utf8") > 96_000) throw new HttpError(413, "插件清单不能超过 96 KB");
	let input: unknown;
	try {
		input = JSON.parse(content);
	} catch {
		throw new HttpError(400, "插件清单不是有效的 JSON");
	}
	const result = manifestSchema.safeParse(input);
	if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => issue.message).join("; "));
	return result.data;
}

export class AppPluginManager {
	private directory: string;
	private recordsDirectory: string;
	private registryPath: string;
	private mutations = new Map<string, Promise<void>>();

	constructor(directory: string) {
		this.directory = join(directory, "plugins");
		this.recordsDirectory = join(directory, "plugin-data");
		this.registryPath = join(this.directory, "registry.json");
	}

	async list(): Promise<AppPluginRegistry> {
		const registry = await this.readRegistry();
		return {
			revision: registry.revision,
			plugins: registry.plugins.map((plugin) => ({ ...plugin })),
		};
	}

	async enabledManifests(): Promise<AppPluginManifest[]> {
		const registry = await this.readRegistry();
		return registry.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.manifest);
	}

	async validate(
		manifest: AppPluginManifest,
	): Promise<{ valid: true; pluginId: string; version: string; replacesVersion?: string }> {
		const registry = await this.readRegistry();
		const current = registry.plugins.find((entry) => entry.manifest.id === manifest.id);
		const digest = createHash("sha256")
			.update(`${JSON.stringify(manifest, null, 2)}\n`)
			.digest("hex");
		if (current?.digest === digest) {
			return {
				valid: true,
				pluginId: manifest.id,
				version: manifest.version,
				replacesVersion: current.manifest.version,
			};
		}
		this.assertUpdateCompatible(current, manifest);
		return {
			valid: true,
			pluginId: manifest.id,
			version: manifest.version,
			...(current ? { replacesVersion: current.manifest.version } : {}),
		};
	}

	async install(manifest: AppPluginManifest): Promise<InstalledAppPlugin> {
		const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
		const digest = createHash("sha256").update(serialized).digest("hex");
		const installedAt = new Date().toISOString();
		const releasePath = join(this.directory, "releases", manifest.id, digest, "plugin.json");
		return this.mutateRegistry(async (registry) => {
			const current = registry.plugins.find((entry) => entry.manifest.id === manifest.id);
			if (current && current.digest === digest) {
				if (!current.enabled) {
					current.enabled = true;
					registry.revision += 1;
				}
				return { ...current };
			}
			this.assertUpdateCompatible(current, manifest);
			await this.writeJson(releasePath, manifest);
			const next: InstalledAppPlugin = { digest, enabled: true, installedAt, manifest };
			if (current) registry.plugins[registry.plugins.indexOf(current)] = next;
			else registry.plugins.push(next);
			registry.revision += 1;
			return { ...next };
		});
	}

	private assertUpdateCompatible(current: InstalledAppPlugin | undefined, manifest: AppPluginManifest): void {
		if (!current) return;
		if (compareVersions(manifest.version, current.manifest.version) <= 0) {
			throw new HttpError(409, "插件更新版本必须高于当前版本");
		}
		if (!hasCompatibleFields(current.manifest, manifest)) {
			throw new HttpError(
				409,
				"此版本修改了数据字段；当前版本尚不支持字段迁移，请保持字段 ID、类型、必填状态和选项不变",
			);
		}
	}

	async setEnabled(pluginId: string, enabled: boolean): Promise<InstalledAppPlugin> {
		return this.mutateRegistry((registry) => {
			const plugin = registry.plugins.find((entry) => entry.manifest.id === pluginId);
			if (!plugin) throw new HttpError(404, "未找到应用插件");
			if (plugin.enabled !== enabled) {
				plugin.enabled = enabled;
				registry.revision += 1;
			}
			return { ...plugin };
		});
	}

	async remove(pluginId: string): Promise<void> {
		await this.mutateRegistry((registry) => {
			const index = registry.plugins.findIndex((entry) => entry.manifest.id === pluginId);
			if (index === -1) throw new HttpError(404, "未找到应用插件");
			registry.plugins.splice(index, 1);
			registry.revision += 1;
		});
	}

	async getManifest(pluginId: string): Promise<AppPluginManifest> {
		const plugin = (await this.readRegistry()).plugins.find(
			(entry) => entry.manifest.id === pluginId && entry.enabled,
		);
		if (!plugin) throw new HttpError(404, "应用插件不存在或已停用");
		return plugin.manifest;
	}

	async listRecords(pluginId: string, workspaceId: string): Promise<AppPluginRecord[]> {
		const manifest = await this.getManifest(pluginId);
		return this.readRecords(pluginId, workspaceId, manifest);
	}

	async createRecord(pluginId: string, workspaceId: string, input: unknown): Promise<AppPluginRecord> {
		const manifest = await this.getManifest(pluginId);
		const values = validateValues(manifest, input);
		return this.mutateRecords(pluginId, workspaceId, async (records) => {
			const timestamp = new Date().toISOString();
			const record = { id: randomUUID(), values, createdAt: timestamp, updatedAt: timestamp };
			records.push(record);
			return record;
		});
	}

	async updateRecord(
		pluginId: string,
		workspaceId: string,
		recordId: string,
		input: unknown,
	): Promise<AppPluginRecord> {
		const manifest = await this.getManifest(pluginId);
		const result = await this.mutateRecords(pluginId, workspaceId, async (records) => {
			const index = records.findIndex((record) => record.id === recordId);
			if (index === -1) throw new HttpError(404, "未找到插件数据");
			const current = records[index];
			const updated: AppPluginRecord = {
				...current,
				values: validateValues(manifest, { ...current.values, ...(input as object) }),
				updatedAt: new Date().toISOString(),
			};
			records[index] = updated;
			return updated;
		});
		return result;
	}

	async deleteRecord(pluginId: string, workspaceId: string, recordId: string): Promise<void> {
		await this.getManifest(pluginId);
		await this.mutateRecords(pluginId, workspaceId, async (records) => {
			const index = records.findIndex((record) => record.id === recordId);
			if (index === -1) throw new HttpError(404, "未找到插件数据");
			records.splice(index, 1);
		});
	}

	private async readRegistry(): Promise<RegistryFile> {
		const content = await readFile(this.registryPath, "utf8").catch((error: unknown) => {
			if (isMissing(error)) return "";
			throw error;
		});
		if (!content) return { revision: 0, plugins: [] };
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			throw new HttpError(500, "插件注册表损坏，无法读取");
		}
		const result = z
			.object({
				revision: z.number().int().nonnegative(),
				plugins: z.array(
					z
						.object({
							digest: z.string().regex(/^[a-f0-9]{64}$/u),
							enabled: z.boolean(),
							installedAt: z.string().datetime(),
							manifest: manifestSchema,
						})
						.strict(),
				),
			})
			.strict()
			.safeParse(parsed);
		if (!result.success) throw new HttpError(500, "插件注册表格式无效");
		return result.data;
	}

	private async mutateRegistry<T>(mutate: (registry: RegistryFile) => T | Promise<T>): Promise<T> {
		return this.serialized("registry", async () => {
			const registry = await this.readRegistry();
			const result = await mutate(registry);
			await this.writeJson(this.registryPath, registry);
			return result;
		});
	}

	private async readRecords(
		pluginId: string,
		workspaceId: string,
		manifest: AppPluginManifest,
	): Promise<AppPluginRecord[]> {
		const path = this.recordsPath(pluginId, workspaceId);
		const content = await readFile(path, "utf8").catch((error: unknown) => {
			if (isMissing(error)) return "[]";
			throw error;
		});
		if (Buffer.byteLength(content, "utf8") > 4_000_000) throw new HttpError(413, "插件工作区数据超过 4 MB 限额");
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			throw new HttpError(500, "插件工作区数据损坏");
		}
		const result = z.array(recordSchema).max(5000).safeParse(parsed);
		if (!result.success) throw new HttpError(500, "插件工作区数据格式无效");
		for (const record of result.data) {
			record.values = validateValues(manifest, record.values);
		}
		return result.data;
	}

	private async mutateRecords<T>(
		pluginId: string,
		workspaceId: string,
		mutate: (records: AppPluginRecord[]) => Promise<T>,
	): Promise<T> {
		const key = `${pluginId}:${workspaceId}`;
		return this.serialized(key, async () => {
			const manifest = await this.getManifest(pluginId);
			const records = await this.readRecords(pluginId, workspaceId, manifest);
			const result = await mutate(records);
			if (records.length > 5000) throw new HttpError(413, "插件记录不能超过 5000 条");
			const content = `${JSON.stringify(records, null, 2)}\n`;
			if (Buffer.byteLength(content, "utf8") > 4_000_000) throw new HttpError(413, "插件工作区数据超过 4 MB 限额");
			await this.writeJson(this.recordsPath(pluginId, workspaceId), records);
			return result;
		});
	}

	private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.mutations.get(key) ?? Promise.resolve();
		let finish: () => void = () => {};
		const current = new Promise<void>((resolvePromise) => {
			finish = resolvePromise;
		});
		const tail = previous.then(
			() => current,
			() => current,
		);
		this.mutations.set(key, tail);
		await previous;
		try {
			return await operation();
		} finally {
			finish();
			if (this.mutations.get(key) === tail) this.mutations.delete(key);
		}
	}

	private recordsPath(pluginId: string, workspaceId: string): string {
		return join(this.recordsDirectory, pluginId, `${workspaceId}.json`);
	}

	private async writeJson(path: string, value: unknown): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	}
}
