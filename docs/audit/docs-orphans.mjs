// Read-only: find markdown docs with no inbound references, and images referenced
// with a different extension than the one that exists.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve("D:/project/pi-main");
const toPosix = (p) => p.replaceAll("\\", "/");
const EXCLUDE = /(?:^|\/)(?:node_modules|\.git|backups|dist|\.artifacts|\.pi-console)(?:\/|$)/;
const TEXT = /\.(?:ts|tsx|mjs|js|cjs|json|md|yml|yaml|sh|ps1|bat|cmd|html|css|svg|txt|nix|toml|nsi|grit)$/i;

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (EXCLUDE.test(toPosix(abs) + "/")) continue;
		if (entry.isDirectory()) walk(abs, out);
		else if (TEXT.test(entry.name)) out.push(abs);
	}
	return out;
}

const files = walk(ROOT);
const texts = files.map((f) => [toPosix(relative(ROOT, f)), readFileSync(f, "utf8")]);
const mds = files.filter((f) => f.endsWith(".md")).map((f) => toPosix(relative(ROOT, f)));
const orphans = [];
for (const rel of mds) {
	const base = rel.split("/").at(-1);
	const refs = texts.filter(([f, t]) => f !== rel && t.includes(base)).map(([f]) => f);
	if (!refs.length) orphans.push(rel);
}
console.log("== markdown with no inbound references");
for (const o of orphans.sort()) console.log(`   ${o}`);
console.log(`\nmarkdown files: ${mds.length}, orphan: ${orphans.length}`);
