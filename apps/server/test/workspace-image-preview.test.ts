import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceAccess } from "../src/workspaces/workspace-access.ts";

test("image preview checks file type and workspace boundaries", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-image-preview-")));
	const workspace = { id: "fixture", name: "fixture", path: root };
	const access = new WorkspaceAccess({ store: { workspaces: () => [workspace] }, roots: () => [root] });
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=",
		"base64",
	);
	try {
		await writeFile(join(root, "image.png"), png);
		await writeFile(join(root, "text.png"), "not an image");
		const image = await access.files(workspace).readImage("image.png");
		assert.equal(image.mime, "image/png");
		assert.deepEqual(Buffer.from(image.base64, "base64"), png);
		await assert.rejects(access.files(workspace).readImage("text.png"));
		await assert.rejects(access.files(workspace).readImage("../outside.png"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
