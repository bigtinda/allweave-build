import type { SessionDetail, ToolCall } from "../../../../shared/src/protocol.ts";

export function toolAction(tool: ToolCall): string {
	const input = typeof tool.input === "object" && tool.input !== null ? (tool.input as Record<string, unknown>) : {};
	const target = [input.path, input.file_path, input.url, input.command, input.pattern].find(
		(value) => typeof value === "string",
	) as string | undefined;
	const verb =
		(
			{
				read: "读取文件",
				write: "写入文件",
				edit: "编辑文件",
				bash: "执行命令",
				grep: "搜索代码",
				find: "查找文件",
				ls: "列出目录",
				browser: "操作浏览器",
			} as Record<string, string>
		)[tool.name] ?? `调用 ${tool.name}`;
	return `${verb}${target ? ` · ${target.replace(/\s+/gu, " ").slice(0, 160)}` : ""}`;
}

export function executionProgress(
	session: SessionDetail,
	now: number,
	turn: { startAt?: string; endAt?: string; isCurrent?: boolean } = {},
) {
	const user = [...session.messages].reverse().find((message) => message.role === "user");
	const start = turn.startAt ?? user?.timestamp ?? session.updatedAt;
	const inTurn = (timestamp: string) => timestamp >= start && (!turn.endAt || timestamp < turn.endAt);
	const tools = session.tools.filter((tool) => inTurn(tool.startedAt));
	const pending = tools.filter((tool) => tool.status === "running" || tool.status === "approval");
	const turnMessages = session.messages.filter((item) => item.role === "assistant" && inTurn(item.timestamp));
	const message = turnMessages.at(-1);
	const notes = turnMessages
		.slice(0, -1)
		.filter((item) => item.text.trim())
		.map((item) => ({ id: item.id, text: item.text, timestamp: item.timestamp }));
	const lastEvent = session.activity.filter((item) => inTurn(item.timestamp)).at(-1)?.timestamp ?? start;
	const silentSeconds = Math.max(0, Math.floor((now - Date.parse(lastEvent)) / 1000));
	const status = (turn.isCurrent ?? true) ? session.status : "idle";
	const active = status === "running" || status === "approval";
	const endedAt = Math.max(
		Date.parse(start),
		...turnMessages.map((item) => Date.parse(item.timestamp)),
		...tools.map((tool) => Date.parse(tool.startedAt) + (tool.durationMs ?? 0)),
	);
	const latestTool = pending.at(-1);
	const label =
		status === "error"
			? "执行已停止"
			: status === "approval"
				? "等待你确认工具执行"
				: !active
					? "本轮执行结束"
					: latestTool
						? toolAction(latestTool)
						: message && !message.complete && message.text
							? "正在生成回复"
							: tools.length
								? "正在分析工具结果"
								: message?.thinking
									? "正在分析需求与方案"
									: "正在理解任务并规划步骤";
	return {
		label,
		status,
		active,
		tools,
		pending,
		message,
		notes,
		startedAt: start,
		elapsedMs: Math.max(0, (active ? now : endedAt) - Date.parse(start)),
		silentSeconds,
		completed: tools.filter((tool) => tool.status === "completed").length,
		failed: tools.filter((tool) => tool.status === "failed").length,
	};
}
