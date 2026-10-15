import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const vite = join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
const children = [
  spawn(process.execPath, ["--watch", "--env-file-if-exists=.env", "--import", "./packages/coding-agent/src/experimental/source-resolver.ts", "apps/server/src/main.ts"], { cwd: root, stdio: "inherit" }),
  spawn(process.execPath, [vite, "--host", "127.0.0.1"], { cwd: fileURLToPath(new URL("../apps/web", import.meta.url)), stdio: "inherit" }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", error => { console.error(error.message); stop(1); });
  child.on("exit", code => stop(code ?? 0));
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
