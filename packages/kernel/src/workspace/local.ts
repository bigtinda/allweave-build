import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { NativeWorkspace } from "../engine/types.ts";

function error(message: string): never {
	throw new Error(message);
}

/**
 * Local workspace boundary. Resolves every path through realpath, rejects
 * symlinks and serializes writes per path. No remote or sandbox semantics.
 */
export class LocalWorkspace implements NativeWorkspace {
	readonly root: string;
	private readonly spillRoot = join(tmpdir(), "allweave-spill");
	private readonly locks = new Map<string, Promise<void>>();

	constructor(root: string) {
		this.root = resolve(root);
	}

	async resolve(input: string, allowMissing = false): Promise<string> {
		const path = resolve(this.root, input);
		if (path === this.spillRoot || path.startsWith(this.spillRoot + sep)) {
			await mkdir(this.spillRoot, { recursive: true });
			const real = await realpath(path);
			if (real !== this.spillRoot && !real.startsWith(this.spillRoot + sep))
				error(`Path is outside the authorized workspace`);
			return real;
		}
		if (path !== this.root && !path.startsWith(this.root + sep)) error(`Path is outside the authorized workspace`);
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink()) error(`Symbolic links are not allowed: ${input}`);
			const real = await realpath(path);
			if (real !== this.root && !real.startsWith(this.root + sep)) error(`Path is outside the authorized workspace`);
			return real;
		} catch (cause) {
			if (!allowMissing) throw cause;
			const parent = await realpath(dirname(path)).catch(() => error(`Parent does not exist: ${input}`));
			if (parent !== this.root && !parent.startsWith(this.root + sep))
				error(`Path is outside the authorized workspace`);
			return join(parent, path.slice(dirname(path).length + 1));
		}
	}

	read(path: string): Promise<string> {
		return readFile(path, "utf8");
	}

	async spill(content: string): Promise<string> {
		await mkdir(this.spillRoot, { recursive: true });
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		for (const name of await readdir(this.spillRoot)) {
			const file = join(this.spillRoot, name);
			const info = await lstat(file).catch(() => undefined);
			if (info?.isFile() && info.mtimeMs < cutoff) await unlink(file).catch(() => undefined);
		}
		const path = join(this.spillRoot, `${randomUUID()}.txt`);
		await writeFile(path, content, "utf8");
		return path;
	}

	async write(path: string, content: string): Promise<void> {
		const previous = this.locks.get(path) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(() => writeFile(path, content, "utf8"));
		this.locks.set(path, next);
		try {
			await next;
		} finally {
			if (this.locks.get(path) === next) this.locks.delete(path);
		}
	}
}
