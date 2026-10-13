import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredRoots, createApp } from "./app.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(process.env.PI_CONSOLE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PI_CONSOLE_PORT");
const { app } = await createApp({
	roots: configuredRoots(repository),
	port,
	directory: resolve(process.env.PI_CONSOLE_DATA_DIR ?? resolve(repository, ".pi-console")),
});
await app.listen({ host: "127.0.0.1", port });
process.stdout.write(
	process.env.PI_CONSOLE_DESKTOP === "1"
		? `\nKego Desktop backend ready at http://127.0.0.1:${port}\n\n`
		: `\nKego Web Console: http://127.0.0.1:5173\nProduction frontend (after build): http://127.0.0.1:${port}\n\n`,
);
const shutdown = () => {
	void app.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
