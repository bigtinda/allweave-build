import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	Api,
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
	Model,
	MutableModels,
	Provider,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { getApiProvider, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

type AuthFile = Record<string, Credential>;

/** auth.json compatible credential store with serialized, atomic writes. */
class FileCredentialStore implements CredentialStore {
	private file: string;
	private queue = Promise.resolve();

	constructor(file: string) {
		this.file = file;
	}

	private async load(): Promise<AuthFile> {
		const text = await readFile(this.file, "utf8").catch(() => "{}");
		const value: unknown = JSON.parse(text || "{}");
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		return value as AuthFile;
	}

	private async save(value: AuthFile): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, this.file);
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.queue.then(operation, operation);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return (await this.load())[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.load()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.serial(async () => {
			const value = await this.load();
			const next = await fn(value[providerId]);
			if (next === undefined) return value[providerId];
			value[providerId] = next;
			await this.save(value);
			return next;
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.serial(async () => {
			const value = await this.load();
			delete value[providerId];
			await this.save(value);
		});
	}
}

interface CustomProviderConfig {
	name?: string;
	baseUrl: string;
	api: Api;
	models: Array<{
		id: string;
		name?: string;
		reasoning?: boolean;
		contextWindow?: number;
		maxTokens?: number;
	}>;
}

function customProvider(id: string, config: CustomProviderConfig): Provider {
	registerBuiltInApiProviders();
	const streams = getApiProvider(config.api);
	if (!streams) throw new Error(`Unsupported API: ${config.api}`);
	const models: Model<Api>[] = config.models.map((model) => ({
		id: model.id,
		name: model.name ?? model.id,
		api: config.api,
		provider: id,
		baseUrl: config.baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: model.reasoning === true,
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 16_384,
	}));
	return createProvider({
		id,
		name: config.name ?? id,
		baseUrl: config.baseUrl,
		models,
		api: { stream: streams.stream, streamSimple: streams.streamSimple },
		auth: {
			apiKey: {
				name: `${config.name ?? id} API key`,
				async login(interaction) {
					const key = await interaction.prompt({ type: "secret", message: "API key" });
					return { type: "api_key", key };
				},
				async resolve({ ctx, credential }) {
					const key = credential?.type === "api_key" ? credential.key : await ctx.env("PI_CONSOLE_MODEL_KEY");
					if (!key) return undefined;
					return { auth: { apiKey: key }, source: "PI_CONSOLE_MODEL_KEY" };
				},
			},
		},
	});
}

async function loadCustomProviders(runtime: MutableModels, modelsPath: string): Promise<void> {
	const text = await readFile(modelsPath, "utf8").catch(() => undefined);
	if (!text) return;
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error("models.json 必须包含对象");
	const providers = "providers" in parsed ? parsed.providers : undefined;
	if (providers === undefined) return;
	if (typeof providers !== "object" || providers === null || Array.isArray(providers))
		throw new Error("models.json 的 providers 必须是一个对象");
	for (const [id, value] of Object.entries(providers)) {
		if (typeof value !== "object" || value === null) continue;
		const config = value as CustomProviderConfig;
		if (typeof config.baseUrl !== "string" || typeof config.api !== "string" || !Array.isArray(config.models))
			continue;
		runtime.setProvider(customProvider(id, config));
	}
}

export async function createModelRuntime(
	agentDir: string,
): Promise<MutableModels & { reloadCustomProviders(): Promise<void> }> {
	await mkdir(agentDir, { recursive: true });
	const runtime = createModels({
		credentials: new FileCredentialStore(join(agentDir, "auth.json")),
	});
	for (const provider of builtinProviders()) runtime.setProvider(provider);
	const modelsPath = join(agentDir, "models.json");
	const reload = async () => loadCustomProviders(runtime, modelsPath);
	await reload();
	return Object.assign(runtime, { reloadCustomProviders: reload });
}

export type WorkbenchModels = Awaited<ReturnType<typeof createModelRuntime>>;
