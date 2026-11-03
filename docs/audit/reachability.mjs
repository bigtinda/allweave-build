// Read-only reachability + unused-export audit for the AllWeave workbench.
// Usage: node .audit/reachability.mjs [repoRoot]
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? "D:/project/pi-main");
const toPosix = (p) => p.replaceAll("\\", "/");
const rel = (p) => toPosix(relative(ROOT, p));

const SRC_EXTS = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs", ".css", ".json"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".audit", "backups", ".pi-console", "coverage"]);

function walk(absDir, out = []) {
	let entries;
	try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
	for (const entry of entries) {
		if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
		const abs = join(absDir, entry.name);
		if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(abs, out); }
		else if (entry.isFile()) out.push(abs);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Parse imports / re-exports from a source file.
function stripComments(source) {
	// Preserve newlines so line numbers stay stable. Naive but adequate: a
	// string containing "//" (URLs) could truncate the rest of that line only.
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/(^|[^:"'])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

const RE_FROM = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
const RE_SIDE_EFFECT = /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
const RE_DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const RE_REQUIRE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const RE_CSS_IMPORT = /@import\s+(?:url\()?\s*["']([^"']+)["']/g;

function parseImports(absFile) {
	const raw = readFileSync(absFile, "utf8");
	const code = stripComments(raw);
	const specs = new Set();
	for (const re of [RE_FROM, RE_SIDE_EFFECT, RE_DYNAMIC, RE_REQUIRE, RE_CSS_IMPORT]) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(code))) specs.add(m[1]);
	}
	// Commented-out import lines are evidence of dead code, not edges.
	const commented = [];
	for (const line of raw.split(/\r?\n/)) {
		if (/^\s*\/\/\s*(?:import|export)\b/.test(line) && /["']\.\.?\//.test(line)) commented.push(line.trim());
	}
	return { specs: [...specs], commented };
}

const candidates = (base) => [
	base,
	`${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}.css`, `${base}.json`,
	join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.mjs"),
];

function resolveSpecifier(fromAbs, spec) {
	if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // bare package / alias
	let clean = spec.split("?")[0].split("#")[0];
	let base = clean.startsWith("/") ? join(ROOT, clean) : resolve(dirname(fromAbs), clean);
	for (const candidate of candidates(base)) {
		try { if (statSync(candidate).isFile()) return candidate; } catch {}
	}
	return null;
}

// ---------------------------------------------------------------------------
const scope = [
	"apps/server/src",
	"apps/web/src",
	"apps/shared/src",
	"desktop/src",
	"scripts",
	"apps/server/scripts",
];
const allFiles = new Set();
for (const dir of scope) for (const abs of walk(join(ROOT, dir))) allFiles.add(abs);
for (const extra of ["apps/web/vite.config.ts", "apps/web/index.html"]) {
	const abs = join(ROOT, extra);
	if (existsSync(abs)) allFiles.add(abs);
}

const graph = new Map(); // abs -> resolved deps
const unresolved = new Map(); // abs -> specs
for (const abs of allFiles) {
	const { specs, commented } = parseImports(abs);
	const deps = new Set();
	const misses = [];
	for (const spec of specs) {
		const target = resolveSpecifier(abs, spec);
		if (target) deps.add(target);
		else if (spec.startsWith(".")) misses.push(spec);
	}
	graph.set(abs, { deps, commented, misses });
	if (misses.length) unresolved.set(abs, misses);
}

// ---------------------------------------------------------------------------
// Entry points.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const pkgScriptRefs = new Set();
for (const [name, value] of Object.entries(pkg.scripts)) {
	for (const m of String(value).matchAll(/[\w./-]*scripts\/[\w./-]+\.(?:mjs|js|ts|cjs)/g)) {
		const cleaned = m[0].replace(/^\.\//, "");
		const abs = join(ROOT, cleaned);
		if (existsSync(abs)) { pkgScriptRefs.add(abs); abs; }
	}
}
const prodEntries = [
	"apps/server/src/main.ts",
	"apps/web/src/main.tsx",
	"desktop/src/main.ts",
	"desktop/src/preload.ts",
].map((p) => join(ROOT, p)).filter(existsSync);
for (const abs of pkgScriptRefs) {
	if (!/\.test\.mjs$/.test(abs)) prodEntries.push(abs);
}

// test entry points: scripts/*.test.*, apps/*/test/*.test.ts
const testEntries = [];
for (const abs of allFiles) {
	if (/(?:^|\/)test\/.*\.test\.ts$/.test(toPosix(abs)) || /scripts\/.*\.test\.(?:mjs|ts)$/.test(toPosix(abs))) testEntries.push(abs);
}

function reachable(entries) {
	const seen = new Set();
	const stack = [...entries];
	while (stack.length) {
		const abs = stack.pop();
		if (seen.has(abs)) continue;
		seen.add(abs);
		const node = graph.get(abs);
		if (!node) continue; // package file or asset
		for (const dep of node.deps) if (!seen.has(dep)) stack.push(dep);
	}
	return seen;
}

const prodReach = reachable(prodEntries);
const allReach = reachable([...prodEntries, ...testEntries]);

const prodUnreachable = [...allFiles].filter((f) => !prodReach.has(f) && !testEntries.includes(f)).sort();
const fullyUnreachable = [...allFiles].filter((f) => !allReach.has(f) && !testEntries.includes(f)).sort();
const testOnly = [...allFiles].filter((f) => !prodReach.has(f) && allReach.has(f) && !testEntries.includes(f)).sort();

// ---------------------------------------------------------------------------
// Unused exported symbols across apps/desktop/scripts.
const searchRoots = ["apps", "desktop", "scripts"].map((d) => join(ROOT, d));
const searchFiles = [];
for (const root of searchRoots) for (const abs of walk(root)) if (SRC_EXTS.has(extname(abs))) searchFiles.push(abs);
const fileText = new Map(searchFiles.map((f) => [f, readFileSync(f, "utf8")]));

const EXPORT_PATTERNS = [
	/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
	/\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
	/\bexport\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
	/\bexport\s+(?:async\s+)?function\s*\*/g, // generator: name captured below
];
const exported = [];
for (const abs of allFiles) {
	const text = stripComments(readFileSync(abs, "utf8"));
	for (const re of EXPORT_PATTERNS.slice(0, 3)) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(text))) exported.push({ file: abs, name: m[1] });
	}
	// export { a, b as c }
	for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
		for (const part of m[1].split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (name && /^[A-Za-z_$][\w$]*$/.test(name)) exported.push({ file: abs, name });
		}
	}
}

function occurrences(name, file) {
	const re = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g");
	let self = 0;
	const others = [];
	for (const [abs, text] of fileText) {
		const count = (text.match(re) ?? []).length;
		if (count === 0) continue;
		if (abs === file) self += count;
		else others.push({ file: abs, count });
	}
	return { self, others };
}

const unusedExports = [];
for (const { file, name } of exported) {
	const { self, others } = occurrences(name, file);
	const nonTestOthers = others.filter((o) => !/\/test\/.*\.test\.ts$/.test(toPosix(o.file)) && !/\.test\.(?:mjs|ts)$/.test(o.file));
	if (others.length === 0) unusedExports.push({ file, name, self, scope: "unreferenced" });
	else if (nonTestOthers.length === 0) unusedExports.push({ file, name, self, scope: "test-only", testRefs: others });
}

// ---------------------------------------------------------------------------
const out = {
	root: ROOT,
	counts: { scopeFiles: allFiles.size, prodEntries: prodEntries.length, testEntries: testEntries.length },
	prodUnreachable: prodUnreachable.map(rel),
	testOnly: testOnly.map(rel),
	fullyUnreachable: fullyUnreachable.map(rel),
	unresolvedRelative: [...unresolved].map(([f, specs]) => ({ file: rel(f), specs })),
	entryScriptsFromPackageJson: [...pkgScriptRefs].map(rel),
	allPackageJsonScripts: pkg.scripts,
	unusedExports: unusedExports.map((u) => ({ file: rel(u.file), name: u.name, scope: u.scope, self: u.self })),
	commentedImports: [...graph].filter(([, n]) => n.commented.length).map(([f, n]) => ({ file: rel(f), lines: n.commented })),
};
console.log(JSON.stringify(out, null, 2));
