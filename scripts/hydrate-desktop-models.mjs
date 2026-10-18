import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateModelCatalog } from "../packages/ai/scripts/hydrate-model-catalog.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = readFileSync(join(root, "packages/ai/model-catalog.snapshot.json.sha256"), "utf8").trim();
if (typeof revision !== "string" || !/^sha256-[0-9a-f]{64}$/.test(revision)) {
	throw new Error("Invalid desktop model catalog snapshot hash.");
}
const catalogPath = join(root, "packages/ai/model-catalog.snapshot.json");
const bytes = readFileSync(catalogPath);
if (`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== revision) {
	throw new Error("Desktop model catalog snapshot checksum mismatch.");
}
hydrateModelCatalog(join(root, "packages/ai"), catalogPath);
console.log(`Hydrated verified desktop model catalog ${revision}`);
