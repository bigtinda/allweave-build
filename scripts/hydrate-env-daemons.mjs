import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({ entryPoints: [`${root}/packages/env/src/daemon.ts`], outfile: `${root}/packages/env/bin/pi-env.mjs`, bundle: true, platform: "node", format: "esm", target: "node22", conditions: ["source"], tsconfig: `${root}/tsconfig.json`, sourcemap: false });
console.log("Bundled TypeScript execution daemon: packages/env/bin/pi-env.mjs");
