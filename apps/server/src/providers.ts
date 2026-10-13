import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuthEvent, type AuthPrompt, type AuthType, isModelType } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { ModelOption } from "../../shared/src/protocol.ts";
import { HttpError } from "./security.ts";

const apiTypes = [
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"google-generative-ai",
	"google-vertex",
	"azure-openai-responses",
	"bedrock-converse-stream",
	"openai-codex-responses",
	"pi-messages",
] as const;

const customProviderSchema = z.object({
	id: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
	name: z.string().trim().min(1).max(100),
	baseUrl: z
		.string()
		.url()
		.refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
	api: z.enum(apiTypes),
	models: z
		.array(
			z.object({
				id: z.string().trim().min(1).max(160),
				name: z.string().trim().min(1).max(160).optional(),
				reasoning: z.boolean().default(false),
				contextWindow: z.number().int().positive().optional(),
				maxTokens: z.number().int().positive().optional(),
			}),
		)
		.min(1)
		.max(100),
});

export type PublicAuthPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: Array<{ id: string; label: string; description?: string }> };

interface WaitingPrompt {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

interface LoginJob {
	id: string;
	providerId: string;
	type: AuthType;
	status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
	prompt?: PublicAuthPrompt;
	notifications: AuthEvent[];
	error?: string;
	controller: AbortController;
	waiting?: WaitingPrompt;
	doneAt?: number;
}

export interface ProviderOption {
	id: string;
	name: string;
	category: string;
	modelCount: number;
	configured: boolean;
	authSource?: string;
	apiKey?: { name: string; interactive: boolean };
	oauth?: { name: string; label: string; subscription: boolean };
}

export interface ProviderLoginView {
	id: string;
	providerId: string;
	type: AuthType;
	status: LoginJob["status"];
	prompt?: PublicAuthPrompt;
	notifications: AuthEvent[];
	error?: string;
}

function providerCategory(providerId: string): string {
	if (["anthropic", "openai", "google", "deepseek", "mistral", "xai", "nvidia"].includes(providerId)) {
		return "主流模型供应商";
	}
	if (
		providerId.endsWith("-cn") ||
		providerId.includes("token-plan") ||
		["kimi-coding", "kimi", "moonshotai", "moonshotai-cn", "minimax", "minimax-cn", "zai", "zai-coding-cn"].includes(
			providerId,
		)
	) {
		return "中国模型与订阅计划";
	}
	if (
		["openrouter", "vercel-ai-gateway", "cloudflare-ai-gateway", "opencode", "opencode-go", "radius"].includes(
			providerId,
		)
	) {
		return "模型聚合与网关";
	}
	if (
		["amazon-bedrock", "azure", "google-vertex", "cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(
			providerId,
		)
	) {
		return "云平台与托管服务";
	}
	if (["ollama", "llama.cpp", "lm-studio", "vllm"].includes(providerId)) return "本地与自定义服务";
	return "其他与扩展供应商";
}

function publicPrompt(prompt: AuthPrompt): PublicAuthPrompt {
	if (prompt.type === "select") {
		return {
			type: prompt.type,
			message: prompt.message,
			options: prompt.options.map(({ id, label, description }) => ({ id, label, description })),
		};
	}
	return {
		type: prompt.type,
		message: prompt.message,
		...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
	};
}

function toModelOption(model: { id: string; provider: string; name: string; reasoning: boolean }): ModelOption {
	return { id: model.id, provider: model.provider, name: model.name, reasoning: model.reasoning, available: true };
}

export class ProviderManager {
	private agentDir: string;
	private runtimePromise: Promise<ModelRuntime>;
	private jobs = new Map<string, LoginJob>();
	private beforeChange: () => Promise<void> = async () => {};

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.runtimePromise = (async () => {
			await mkdir(agentDir, { recursive: true });
			return ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				modelsStorePath: join(agentDir, "models-store.json"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
		})();
	}

	setBeforeChange(handler: () => Promise<void>): void {
		this.beforeChange = handler;
	}

	async runtime(): Promise<ModelRuntime> {
		return this.runtimePromise;
	}

	async models(): Promise<ModelOption[]> {
		const runtime = await this.runtime();
		await runtime.refresh({ allowNetwork: false });
		const available = new Set((await runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`));
		return runtime
			.getAllModels()
			.filter((model) => isModelType(model, "chat"))
			.map((model) => ({ ...toModelOption(model), available: available.has(`${model.provider}/${model.id}`) }));
	}

	async list(): Promise<ProviderOption[]> {
		const runtime = await this.runtime();
		await runtime.refresh({ allowNetwork: false });
		await runtime.getAvailable();
		return runtime.getProviders().map((provider) => {
			const status = runtime.getProviderAuthStatus(provider.id);
			return {
				id: provider.id,
				name: provider.name,
				category: providerCategory(provider.id),
				modelCount: runtime.getModels(provider.id).length,
				configured: status.configured,
				...("source" in status && status.source ? { authSource: status.source } : {}),
				...(provider.auth.apiKey
					? { apiKey: { name: provider.auth.apiKey.name, interactive: !!provider.auth.apiKey.login } }
					: {}),
				...(provider.auth.oauth
					? {
							oauth: {
								name: provider.auth.oauth.name,
								label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
								subscription: provider.auth.oauth.isSubscription === true,
							},
						}
					: {}),
			};
		});
	}

	async startLogin(providerId: string, type: AuthType): Promise<ProviderLoginView> {
		await this.beforeChange();
		const runtime = await this.runtime();
		const provider = runtime.getProvider(providerId);
		if (!provider) throw new HttpError(404, "模型供应商不存在");
		if (type === "api_key" && !provider.auth.apiKey?.login)
			throw new HttpError(400, "This provider has no API key login flow");
		if (type === "oauth" && !provider.auth.oauth) throw new HttpError(400, "This provider has no OAuth login flow");
		const job: LoginJob = {
			id: randomUUID(),
			providerId,
			type,
			status: "running",
			notifications: [],
			controller: new AbortController(),
		};
		this.jobs.set(job.id, job);
		const interaction = {
			signal: job.controller.signal,
			prompt: (prompt: AuthPrompt) => this.waitForAnswer(job, prompt),
			notify: (event: AuthEvent) => {
				job.notifications = [...job.notifications, event].slice(-20);
			},
		};
		void runtime
			.login(providerId, type, interaction, { agentName: "AllWeave Build" })
			.then(() => {
				job.status = "succeeded";
			})
			.catch((error: unknown) => {
				job.status = job.controller.signal.aborted ? "cancelled" : "failed";
				job.error = job.status === "failed" ? (error instanceof Error ? error.message : String(error)) : undefined;
			})
			.finally(() => {
				job.prompt = undefined;
				job.doneAt = Date.now();
			});
		return this.view(job);
	}

	getLogin(id: string): ProviderLoginView {
		const job = this.jobs.get(id);
		if (!job) throw new HttpError(404, "Provider login expired");
		this.pruneJobs();
		return this.view(job);
	}

	answerLogin(id: string, answer: string): void {
		const job = this.jobs.get(id);
		if (!job?.waiting || !job.prompt) throw new HttpError(409, "No provider login question is waiting");
		if (job.prompt.type === "select" && !job.prompt.options.some((option) => option.id === answer)) {
			throw new HttpError(400, "Choose one of the listed options");
		}
		const waiting = job.waiting;
		job.waiting = undefined;
		job.prompt = undefined;
		job.status = "running";
		waiting.cleanup();
		waiting.resolve(answer);
	}

	cancelLogin(id: string): void {
		const job = this.jobs.get(id);
		if (!job) return;
		job.controller.abort();
		job.waiting?.reject(new Error("Provider login cancelled"));
		job.waiting?.cleanup();
		job.waiting = undefined;
		job.prompt = undefined;
		job.status = "cancelled";
		job.doneAt = Date.now();
	}

	async logout(providerId: string): Promise<void> {
		await this.beforeChange();
		const runtime = await this.runtime();
		if (!runtime.getProvider(providerId)) throw new HttpError(404, "模型供应商不存在");
		await runtime.logout(providerId);
	}

	async addCustomProvider(input: unknown): Promise<ProviderOption> {
		await this.beforeChange();
		const provider = customProviderSchema.parse(input);
		const runtime = await this.runtime();
		if (runtime.getProvider(provider.id)) throw new HttpError(409, "Provider ID already exists");
		const file = join(this.agentDir, "models.json");
		const previous = await readFile(file, "utf8").catch(() => undefined);
		let config: { providers: Record<string, unknown> } = { providers: {} };
		if (previous) {
			const parsed: unknown = JSON.parse(previous);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new HttpError(400, "models.json 必须包含一个对象");
			}
			const previousProviders = "providers" in parsed ? parsed.providers : undefined;
			if (typeof previousProviders !== "object" || previousProviders === null || Array.isArray(previousProviders)) {
				throw new HttpError(400, "models.json 的 providers 必须是一个对象");
			}
			config = { providers: { ...previousProviders } };
		}
		config.providers[provider.id] = {
			name: provider.name,
			baseUrl: provider.baseUrl,
			api: provider.api,
			apiKey: "$PI_CONSOLE_MODEL_KEY",
			models: provider.models,
		};
		const temporary = `${file}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, file);
		await runtime.refresh({ allowNetwork: false });
		const error = runtime.getError();
		if (error?.includes("models.json")) {
			if (previous === undefined) await rm(file, { force: true });
			else await writeFile(file, previous, { encoding: "utf8", mode: 0o600 });
			await runtime.refresh({ allowNetwork: false });
			throw new HttpError(400, error);
		}
		const created = runtime.getProvider(provider.id);
		if (!created) throw new HttpError(400, "自定义供应商注册失败");
		const status = runtime.getProviderAuthStatus(provider.id);
		return {
			id: created.id,
			name: created.name,
			category: providerCategory(created.id),
			modelCount: runtime.getModels(created.id).length,
			configured: status.configured,
			apiKey: created.auth.apiKey
				? { name: created.auth.apiKey.name, interactive: !!created.auth.apiKey.login }
				: undefined,
		};
	}

	async close(): Promise<void> {
		for (const job of this.jobs.values()) this.cancelLogin(job.id);
	}

	private waitForAnswer(job: LoginJob, prompt: AuthPrompt): Promise<string> {
		if (job.controller.signal.aborted) return Promise.reject(new Error("Provider login cancelled"));
		const signal = prompt.signal;
		if (signal?.aborted) return Promise.reject(new Error("Provider login prompt cancelled"));
		return new Promise((resolvePrompt, rejectPrompt) => {
			const onAbort = () => {
				job.waiting?.cleanup();
				job.waiting = undefined;
				job.prompt = undefined;
				job.status = "running";
				rejectPrompt(new Error("Provider login prompt cancelled"));
			};
			const cleanup = () => signal?.removeEventListener("abort", onAbort);
			job.waiting = { resolve: resolvePrompt, reject: rejectPrompt, cleanup };
			job.prompt = publicPrompt(prompt);
			job.status = "waiting";
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private view(job: LoginJob): ProviderLoginView {
		return {
			id: job.id,
			providerId: job.providerId,
			type: job.type,
			status: job.status,
			...(job.prompt ? { prompt: job.prompt } : {}),
			notifications: job.notifications,
			...(job.error ? { error: job.error } : {}),
		};
	}

	private pruneJobs(): void {
		const cutoff = Date.now() - 15 * 60_000;
		for (const [id, job] of this.jobs) if (job.doneAt && job.doneAt < cutoff) this.jobs.delete(id);
	}
}
