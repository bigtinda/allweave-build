import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredRoots, createApp } from "./bootstrap/create-app.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(process.env.ALLWEAVE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid ALLWEAVE_PORT");
const dataDirectory = resolve(process.env.ALLWEAVE_DATA_DIR ?? resolve(repository, ".allweave"));
const { app } = await createApp({
	roots: configuredRoots(repository),
	port,
	directory: dataDirectory,
});
await app.listen({ host: "127.0.0.1", port });
process.stdout.write(
	process.env.ALLWEAVE_DESKTOP === "1"
		? `\nAllWeave Build desktop backend ready at http://127.0.0.1:${port}\n\n`
		: `\nAllWeave Build: http://127.0.0.1:5173\nProduction frontend (after build): http://127.0.0.1:${port}\n\n`,
);
const shutdown = () => {
	void app.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
