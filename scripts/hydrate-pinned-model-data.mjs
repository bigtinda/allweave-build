import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateModelCatalog } from "../packages/ai/scripts/hydrate-model-catalog.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { revision } = JSON.parse(readFileSync(join(root, "nix/model-catalog.json"), "utf8"));
if (!/^sha256-[0-9a-f]{64}$/.test(revision)) throw new Error("Invalid pinned model catalog revision");
const response = await fetch(`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`);
if (!response.ok) throw new Error(`Pinned model catalog returned HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== revision) throw new Error("Pinned model catalog integrity mismatch");
const directory = mkdtempSync(join(tmpdir(), "pi-pinned-models-"));
try {
	const file = join(directory, "models.all.json");
	writeFileSync(file, bytes);
	hydrateModelCatalog(join(root, "packages/ai"), file);
	console.log(`Hydrated pinned model catalog ${revision}`);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
