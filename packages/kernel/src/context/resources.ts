import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface NativeResourceInfo {
	name: string;
	description: string;
	filePath: string;
	kind: "skill" | "prompt";
}

function frontmatter(content: string): Record<string, string> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
	if (!match?.[1]) return {};
	const values: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/u)) {
		const field = /^([A-Za-z0-9_-]+):\s*(.+)$/u.exec(line.trim());
		if (field?.[1] && field[2]) values[field[1]] = field[2].replace(/^['"]|['"]$/gu, "").trim();
	}
	return values;
}

function firstLine(content: string): string {
	return (
		content
			.replace(/^---[\s\S]*?---/u, "")
			.trim()
			.split(/\r?\n/u)[0] ?? ""
	);
}

async function skills(root: string): Promise<NativeResourceInfo[]> {
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return [];
	}
	const resources: NativeResourceInfo[] = [];
	for (const entry of entries.sort()) {
		const filePath = join(root, entry, "SKILL.md");
		try {
			const content = await readFile(filePath, "utf8");
			const meta = frontmatter(content);
			resources.push({
				name: meta.name || entry,
				description: meta.description || firstLine(content),
				filePath,
				kind: "skill",
			});
		} catch {
			// A directory without SKILL.md is not a resource.
		}
	}
	return resources;
}

async function prompts(root: string): Promise<NativeResourceInfo[]> {
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return [];
	}
	const resources: NativeResourceInfo[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".md")) continue;
		const filePath = join(root, entry);
		const content = await readFile(filePath, "utf8").catch(() => undefined);
		if (content === undefined) continue;
		const meta = frontmatter(content);
		resources.push({
			name: meta.name || entry.slice(0, -3),
			description: meta.description || firstLine(content),
			filePath,
			kind: "prompt",
		});
	}
	return resources;
}

/** Discovers workspace skills and prompt templates without loading their bodies. */
export async function discoverResources(cwd: string): Promise<NativeResourceInfo[]> {
	return [...(await skills(join(cwd, ".pi", "skills"))), ...(await prompts(join(cwd, ".pi", "prompts")))];
}

/** Discovers user-level skills and prompts under the agent directory. */
export async function discoverAgentResources(agentDir: string): Promise<NativeResourceInfo[]> {
	return [...(await skills(join(agentDir, "skills"))), ...(await prompts(join(agentDir, "prompts")))];
}
