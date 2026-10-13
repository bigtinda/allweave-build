import { timingSafeEqual } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class HttpError extends Error {
	statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

export function tokenMatches(actual: string, expected: string): boolean {
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function contained(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

// Reject links/junctions as well as lexical traversal. Resolve missing parents for writes.
// Trusted local processes must not swap directory links during an operation; this is not a sandbox.
export async function workspacePath(root: string, input: string, allowMissing = false): Promise<string> {
	if (input.includes("\0") || (process.platform === "win32" && input.replace(/^[A-Za-z]:/, "").includes(":"))) {
		throw new HttpError(403, "Invalid file path");
	}
	const canonicalRoot = await realpath(root);
	const target = resolve(canonicalRoot, input);
	if (!contained(canonicalRoot, target)) throw new HttpError(403, "Path is outside the authorized workspace");
	let current = target;
	while (true) {
		try {
			const stat = await lstat(current);
			if (stat.isSymbolicLink()) throw new HttpError(403, "Symbolic links and junctions are not allowed");
			const canonical = await realpath(current);
			if (!contained(canonicalRoot, canonical)) throw new HttpError(403, "Path escapes the workspace");
		} catch (error) {
			if (!(allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		if (current === canonicalRoot) break;
		current = dirname(current);
	}
	const parts = relative(canonicalRoot, target)
		.split(sep)
		.map((part) => (process.platform === "win32" ? part.replace(/[ .]+$/, "").toLowerCase() : part));
	if (parts.some((part) => [".git", ".pi", ".env", ".pi-console"].includes(part) || part.startsWith(".env."))) {
		throw new HttpError(403, "Private configuration paths cannot be accessed through the console");
	}
	return target;
}
