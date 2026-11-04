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

/** Discovers workspace skills without loading their bodies into the prompt. */
export async function discoverResources(cwd: string): Promise<NativeResourceInfo[]> {
	const root = join(cwd, ".pi", "skills");
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
				description:
					meta.description ||
					content
						.replace(/^---[\s\S]*?---/u, "")
						.trim()
						.split(/\r?\n/u)[0] ||
					"",
				filePath,
				kind: "skill",
			});
		} catch {
			// A directory without SKILL.md is not a resource.
		}
	}
	return resources;
}
