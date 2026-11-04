import type { NativeMessage, NativeTool, NativeWorkspace } from "../engine/types.ts";
import { estimateMessages, estimateText, fitsBudget } from "./budget.ts";
import { compactMessages } from "./compaction.ts";

export interface ContextResource {
	name: string;
	description: string;
}

export interface ContextBuildOptions {
	cwd: string;
	workspace: NativeWorkspace;
	messages: NativeMessage[];
	tools: NativeTool[];
	system?: string;
	resources?: ContextResource[];
	maxTokens?: number;
	reserveTokens?: number;
	keepRecentTokens?: number;
	/** Multiplier learned from provider usage; 1 is the cold-start estimate. */
	estimateScale?: number;
	summarize?: (messages: NativeMessage[]) => Promise<string>;
}

export interface ContextBuildResult {
	system: string;
	messages: NativeMessage[];
	estimatedTokens: number;
	compacted: number;
	dropped: number;
}

const MAX_INSTRUCTIONS = 16_000;

async function readInstructions(workspace: NativeWorkspace): Promise<string | undefined> {
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		try {
			const path = await workspace.resolve(name);
			const content = await workspace.read(path);
			return content.slice(0, MAX_INSTRUCTIONS);
		} catch {
			// Try the next conventional file.
		}
	}
	return undefined;
}

/**
 * Builds a stable system prefix, then trims/compacts history if needed.
 * No timestamps or random values enter the prefix, so prompt caching survives.
 */
export async function buildContext(options: ContextBuildOptions): Promise<ContextBuildResult> {
	const instructions = await readInstructions(options.workspace);
	const sections = [
		options.system ?? "你是运行在本地工作区中的编码助手。",
		`工作目录: ${options.cwd}`,
		"使用工具读取和修改文件。路径必须是工作区相对路径。修改前先读取相关文件；完成后简要说明改动。",
		`可用工具: ${options.tools.map((tool) => tool.name).join(", ")}`,
	];
	if (options.resources?.length) {
		sections.push(`可用资源:\n${options.resources.map((item) => `- ${item.name}: ${item.description}`).join("\n")}`);
	}
	if (instructions) sections.push(`项目说明:\n${instructions}`);
	const system = sections.join("\n\n");

	let messages = options.messages;
	let compacted = 0;
	let dropped = 0;
	const scale = options.estimateScale ?? 1;
	if (options.maxTokens !== undefined) {
		const before = estimateMessages(messages, scale);
		if (
			!fitsBudget(
				before + Math.ceil(estimateText(system) * scale),
				options.maxTokens,
				options.reserveTokens ?? 16_384,
			)
		) {
			const result = await compactMessages(messages, {
				keepRecentTokens: options.keepRecentTokens ?? 20_000,
				summarize: options.summarize,
			});
			messages = result.messages;
			compacted = result.compacted ? 1 : 0;
			dropped = result.dropped;
		}
	}
	return {
		system,
		messages,
		estimatedTokens: estimateMessages(messages, scale) + Math.ceil(estimateText(system) * scale),
		compacted,
		dropped,
	};
}
