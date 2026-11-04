import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importSkillPackage } from "../src/resource-imports.ts";

function upload(path: string, contents: string) {
	return { path, base64: Buffer.from(contents, "utf8").toString("base64") };
}

test("imports a skill folder into the AllWeave user skills directory", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "allweave-skill-import-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = await importSkillPackage(join(directory, "agent"), [
		upload("sample-skill/SKILL.md", "---\nname: sample-skill\ndescription: Example\n---\nUse this skill."),
		upload("sample-skill/references/guide.md", "Reference material"),
	]);
	assert.deepEqual(result, { name: "sample-skill", filesImported: 2 });
	assert.equal(
		await readFile(join(directory, "agent", "skills", "sample-skill", "references", "guide.md"), "utf8"),
		"Reference material",
	);
});

test("rejects imports that are missing manifests or escape the import directory", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "allweave-invalid-import-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(
		importSkillPackage(join(directory, "agent"), [upload("../escape/SKILL.md", "---\nname: unsafe\n---")]),
		{ statusCode: 400 },
	);
});
