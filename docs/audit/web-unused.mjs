// Read-only: report imported bindings that are never referenced in the importing
// file (counts occurrences outside import statements), across apps and desktop.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? "D:/project/pi-main");
const DIRS = ["apps/server/src", "apps/web/src", "apps/shared/src", "desktop/src"];
const toPosix = (p) => p.replaceAll("\\", "/");

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, out);
		else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(abs);
	}
	return out;
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
const findings = [];

for (const file of files) {
	const text = readFileSync(file, "utf8");
	// Strip import statements but remember them.
	const imports = [];
	const importRe = /^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";?$/gm;
	let body = text;
	for (const m of text.matchAll(importRe)) {
		const clause = m[1].trim();
		const bindings = [];
		const named = clause.match(/\{([\s\S]*?)\}/);
		if (named) {
			for (const part of named[1].split(",")) {
				const p = part.trim();
				if (!p) continue;
				const [orig, alias] = p.split(/\s+as\s+/);
				bindings.push((alias ?? orig).trim());
			}
		}
		const def = clause.replace(/\{[\s\S]*?\}/, "").replace(/,/g, " ").trim();
		if (def && !def.startsWith("*") && !def.startsWith("type ")) bindings.push(def.split(/\s+/)[0]);
		if (def.startsWith("* as ")) bindings.push(def.slice(5).trim());
		imports.push({ bindings, source: m[2] });
		body = body.replace(m[0], "");
	}
	// Also side-effect imports are fine; type-only named imports too.
	for (const imp of imports) {
		for (const b of imp.bindings) {
			if (!b) continue;
			const re = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
			const count = (body.match(re) ?? []).length;
			if (count === 0) {
				findings.push({ file: toPosix(relative(ROOT, file)), binding: b, source: imp.source });
			}
		}
	}
}

const byFile = new Map();
for (const f of findings) {
	if (!byFile.has(f.file)) byFile.set(f.file, []);
	byFile.get(f.file).push(f);
}
for (const [file, list] of [...byFile].sort()) {
	console.log(`== ${file}`);
	for (const f of list) console.log(`   unused binding: ${f.binding}  (from "${f.source}")`);
}
console.log(`\ntotal unused bindings: ${findings.length} in ${byFile.size} files`);
