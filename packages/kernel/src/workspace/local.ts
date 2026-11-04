import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
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
	private readonly locks = new Map<string, Promise<void>>();

	constructor(root: string) {
		this.root = resolve(root);
	}

	async resolve(input: string, allowMissing = false): Promise<string> {
		const path = resolve(this.root, input);
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
