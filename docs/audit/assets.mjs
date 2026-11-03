// Read-only: list static assets (public/, docs/, desktop icons) and count
// references by path substring across repo text files (excluding backups/dist).
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const ROOT = resolve("D:/project/pi-main");
const toPosix = (p) => p.replaceAll("\\", "/");
const EXCLUDE = /(?:^|\/)(?:node_modules|\.git|backups|dist|\.artifacts|\.pi-console)(?:\/|$)/;
const TEXT = /\.(?:ts|tsx|mjs|js|cjs|json|md|yml|yaml|sh|ps1|bat|cmd|html|css|svg|txt|nix|toml)$/i;

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

const ASSET_EXT = [".png", ".svg", ".ico", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".docx", ".xlsx"];
function walkAssets(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (EXCLUDE.test(toPosix(abs) + "/")) continue;
		if (entry.isDirectory()) walkAssets(abs, out);
		else if (ASSET_EXT.includes(extname(abs).toLowerCase())) out.push(abs);
	}
	return out;
}
const assetDirs = ["apps/web/public", "docs", "desktop/icons", "品牌设计"];
const assets = [];
for (const dir of assetDirs) {
	try {
		assets.push(...walkAssets(join(ROOT, dir)));
	} catch {}
}

const rows = [];
for (const abs of assets) {
	const rel = toPosix(relative(ROOT, abs));
	const base = rel.split("/").at(-1);
	const refs = [];
	for (const [file, text] of texts) {
		if (file === rel) continue;
		if (text.includes(base)) refs.push(file);
	}
	rows.push({ rel, kb: Math.round((readFileSync(abs).length / 1024) * 10) / 10, refs });
}
rows.sort((a, b) => a.refs.length - b.refs.length || b.kb - a.kb);
for (const r of rows) {
	console.log(`${String(r.refs.length).padStart(2)} refs  ${String(r.kb).padStart(8)} KB  ${r.rel}${r.refs.length ? "  <- " + r.refs.slice(0, 3).join(", ") : ""}`);
}
console.log(`\nassets: ${rows.length}, unreferenced: ${rows.filter((r) => !r.refs.length).length}`);
