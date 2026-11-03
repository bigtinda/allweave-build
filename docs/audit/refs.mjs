// Read-only reference scanner: for each name, count mentions in repo text files
// (excluding node_modules, .git, backups, dist) and print sample locations.
// Also validates relative image/link targets inside docs/*.md.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? "D:/project/pi-main");
const toPosix = (p) => p.replaceAll("\\", "/");
const EXCLUDE = /(?:^|\/)(?:node_modules|\.git|backups|dist|\.artifacts|\.pi-console)(?:\/|$)/;
const TEXT = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs", ".json", ".md", ".yml", ".yaml", ".sh", ".ps1", ".bat", ".cmd", ".nix", ".grit", ".html", ".css", ".svg", ".txt", ".toml", ".snap"]);

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (EXCLUDE.test(toPosix(abs + "/"))) continue;
		if (entry.isDirectory()) walk(abs, out);
		else if (entry.isFile() && TEXT.has(extname(abs).toLowerCase())) out.push(abs);
	}
	return out;
}

const files = walk(ROOT);
const contents = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

function mentions(needle, opts = {}) {
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(escaped, "g");
	const hits = [];
	for (const [abs, text] of contents) {
		const count = (text.match(re) ?? []).length;
		if (count) hits.push({ file: toPosix(relative(ROOT, abs)), count });
	}
	hits.sort((a, b) => b.count - a.count);
	return hits;
}

// 1) Resolve script/asset basenames passed as args.
const names = process.argv.slice(3);
const results = {};
for (const name of names) {
	const hits = mentions(name);
	const self = hits.find((h) => h.file.endsWith(`/${name}`));
	results[name] = { total: hits.reduce((s, h) => s + h.count, 0), hits: hits.slice(0, 6), selfCount: self?.count ?? 0 };
}

// 2) Docs link/asset integrity: relative image + link targets in docs/**/*.md
const docsFiles = files.filter((f) => toPosix(f).includes("/docs/") && f.endsWith(".md"));
const brokenDocsLinks = [];
const allDocsLinks = [];
for (const abs of docsFiles) {
	const text = contents.get(abs);
	for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		let target = m[1];
		if (/^(?:https?:|mailto:|#)/.test(target)) continue;
		target = target.split("#")[0];
		const resolved = resolve(dirname(abs), decodeURIComponent(target));
		allDocsLinks.push({ doc: toPosix(relative(ROOT, abs)), target });
		if (!existsSync(resolved)) brokenDocsLinks.push({ doc: toPosix(relative(ROOT, abs)), target, resolved: toPosix(relative(ROOT, resolved)) });
	}
}

// 3) Root-level file mentions.
const rootFiles = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
const rootFileRefs = {};
for (const name of rootFiles) {
	const hits = mentions(name).filter((h) => h.file !== name);
	rootFileRefs[name] = hits.length;
}

console.log(JSON.stringify({ results, brokenDocsLinks, allDocsLinksCount: allDocsLinks.length, rootFileRefs }, null, 2));
