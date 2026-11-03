import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Bundled TypeScript daemon, or the test bundle selected by PI_ENV_DAEMON. */
export const daemon = process.env.PI_ENV_DAEMON ?? resolve(import.meta.dirname, "../bin/pi-env.mjs");
if (!existsSync(daemon)) {
	throw new Error(`Build the daemon first: npm run build:daemon in packages/env (missing ${daemon})`);
}
