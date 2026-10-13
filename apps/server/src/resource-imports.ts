import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ResourceImportFile } from "../../shared/src/protocol.ts";
import { contained, HttpError } from "./security.ts";

const maximumFileCount = 300;
const maximumTotalBytes = 7 * 1024 * 1024;
const protectedSegments = new Set([".git", ".pi", ".pi-console", "node_modules", ".env"]);

interface DecodedImportFile {
	path: string;
	content: Buffer;
}

interface DecodedImport {
	nameHint?: string;
	files: DecodedImportFile[];
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function normalizeUploadPath(path: string): string[] {
	const normalized = path.replace(/\\/gu, "/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[a-z]:/iu.test(normalized) ||
		/[\u0000-\u001f\u007f]/u.test(normalized)
	) {
		throw new HttpError(400, "Import files must use relative paths");
	}
	const segments = normalized.split("/");
	if (
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				/[<>:"|?*]/u.test(segment) ||
				/[ .]$/u.test(segment) ||
				protectedSegments.has(segment.toLowerCase()) ||
				segment.toLowerCase().startsWith(".env."),
		)
	) {
		throw new HttpError(400, "Import path contains an unsupported or protected file name");
	}
	return segments;
}

function decodeUpload(files: ResourceImportFile[]): DecodedImport {
	if (files.length === 0 || files.length > maximumFileCount) {
		throw new HttpError(413, `Choose between 1 and ${maximumFileCount} import files`);
	}
	const rawFiles = files.map((file) => ({ file, segments: normalizeUploadPath(file.path) }));
	const firstSegment = rawFiles[0]?.segments[0];
	const hasSharedFolder = rawFiles.every(
		({ segments }) => segments.length > 1 && segments[0]?.toLocaleLowerCase() === firstSegment?.toLocaleLowerCase(),
	);
	const nameHint = hasSharedFolder ? firstSegment : undefined;
	const decoded: DecodedImportFile[] = [];
	const paths = new Set<string>();
	let totalBytes = 0;
	for (const { file, segments } of rawFiles) {
		const pathSegments = hasSharedFolder ? segments.slice(1) : segments;
		if (pathSegments.length === 0) throw new HttpError(400, "Import folder contains an empty file path");
		const path = pathSegments.join("/");
		if (paths.has(path.toLocaleLowerCase())) throw new HttpError(400, "Import folder contains duplicate file paths");
		paths.add(path.toLocaleLowerCase());
		if (file.base64 && !/^(?:[a-z\d+/]{4})*(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/iu.test(file.base64)) {
			throw new HttpError(400, `Invalid file encoding for ${basename(path)}`);
		}
		const content = Buffer.from(file.base64, "base64");
		totalBytes += content.byteLength;
		if (totalBytes > maximumTotalBytes) throw new HttpError(413, "Imported files must total 7 MB or less");
		decoded.push({ path, content });
	}
	return { ...(nameHint ? { nameHint } : {}), files: decoded };
}

function safeDirectoryName(name: string | undefined, fallback: string): string {
	const safeName = (name ?? "")
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/^[.-]+|[.-]+$/gu, "")
		.slice(0, 72);
	if (!safeName || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(safeName)) return fallback;
	return safeName;
}

function requireSkillFile(files: DecodedImportFile[]): void {
	if (!files.some((file) => basename(file.path) === "SKILL.md")) {
		throw new HttpError(400, "A skill folder must contain a SKILL.md file");
	}
}

function skillNameFromManifest(files: DecodedImportFile[]): string | undefined {
	const skill = files.find((file) => basename(file.path) === "SKILL.md");
	const frontmatter = skill?.content.toString("utf8").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1];
	const nameLine = frontmatter?.match(/^name:\s*(.+?)\s*$/mu)?.[1]?.trim();
	return nameLine?.replace(/^(["'])(.*)\1$/u, "$2");
}

function pluginPackageName(files: DecodedImportFile[]): string | undefined {
	const manifest = files.find((file) => file.path === "package.json");
	if (!manifest) throw new HttpError(400, "A plugin folder must contain package.json at its root");
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifest.content.toString("utf8")) as unknown;
	} catch {
		throw new HttpError(400, "Plugin package.json is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new HttpError(400, "Plugin package.json must contain an object");
	}
	const name = "name" in parsed && typeof parsed.name === "string" ? parsed.name : undefined;
	return name;
}

async function ensureImportParent(agentDirectory: string, category: "skills" | "imports"): Promise<string> {
	const agentRoot = resolve(agentDirectory);
	await mkdir(agentRoot, { recursive: true });
	const canonicalRoot = await realpath(agentRoot);
	const parent = join(canonicalRoot, category);
	await mkdir(parent, { recursive: true });
	const parentInfo = await lstat(parent);
	const canonicalParent = await realpath(parent);
	if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || !contained(canonicalRoot, canonicalParent)) {
		throw new HttpError(403, "Import destination must be a local directory");
	}
	return canonicalParent;
}

async function uniqueDestination(parent: string, name: string): Promise<string> {
	for (let index = 1; index <= 100; index += 1) {
		const candidateName = index === 1 ? name : `${name}-${index}`;
		const candidate = join(parent, candidateName);
		try {
			await lstat(candidate);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return candidate;
			throw error;
		}
	}
	throw new HttpError(409, "Too many imported folders use this name");
}

async function writeImportBundle(
	agentDirectory: string,
	category: "skills" | "imports",
	name: string,
	files: DecodedImportFile[],
): Promise<string> {
	const parent = await ensureImportParent(agentDirectory, category);
	let destination: string | undefined;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const candidateName = attempt === 0 ? name : `${name}-${randomUUID().slice(0, 6)}`;
		const candidate = await uniqueDestination(parent, candidateName);
		try {
			await mkdir(candidate);
			destination = candidate;
			break;
		} catch (error) {
			const code = errorCode(error);
			const candidateExists = code === "EPERM" && (await lstat(candidate).catch(() => undefined)) !== undefined;
			if (!candidateExists && code !== "EEXIST") throw error;
		}
	}
	if (!destination) throw new HttpError(409, "Could not choose a unique import folder name");
	try {
		const orderedFiles = [...files].sort((left, right) => {
			const leftManifest = /^(?:skill\.md|package\.json)$/iu.test(basename(left.path));
			const rightManifest = /^(?:skill\.md|package\.json)$/iu.test(basename(right.path));
			return Number(leftManifest) - Number(rightManifest);
		});
		for (const file of orderedFiles) {
			const filePath = resolve(destination, ...file.path.split("/"));
			if (!contained(destination, filePath)) throw new HttpError(400, "Import path escapes the destination folder");
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, file.content, { flag: "wx", mode: 0o600 });
		}
		return destination;
	} catch (error) {
		await rm(destination, { recursive: true, force: true });
		throw error;
	}
}

export async function importSkillPackage(
	agentDirectory: string,
	files: ResourceImportFile[],
): Promise<{ name: string; filesImported: number }> {
	const decoded = decodeUpload(files);
	requireSkillFile(decoded.files);
	const fallback = `skill-${randomUUID().slice(0, 8)}`;
	const name = safeDirectoryName(decoded.nameHint ?? skillNameFromManifest(decoded.files), fallback);
	await writeImportBundle(agentDirectory, "skills", name, decoded.files);
	return { name, filesImported: decoded.files.length };
}

export async function stagePluginPackage(
	agentDirectory: string,
	files: ResourceImportFile[],
): Promise<{ name: string; source: string; filesImported: number }> {
	const decoded = decodeUpload(files);
	const name = safeDirectoryName(
		pluginPackageName(decoded.files) ?? decoded.nameHint,
		`plugin-${randomUUID().slice(0, 8)}`,
	);
	const destination = await writeImportBundle(agentDirectory, "imports", name, decoded.files);
	const canonicalRoot = await realpath(resolve(agentDirectory));
	const path = relative(canonicalRoot, destination).replace(/\\/gu, "/");
	return { name, source: `./${path}`, filesImported: decoded.files.length };
}
