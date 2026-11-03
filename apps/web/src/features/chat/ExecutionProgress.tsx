import { Alert, Collapse } from "@mui/material";
import { useEffect, useState } from "react";
import { formatDuration } from "../../../../shared/src/format.ts";
import type { SessionDetail, ToolCall } from "../../../../shared/src/protocol.ts";
import { ToolCard } from "../../components/ToolCard.tsx";
import { Check, ChevronDown, FileCode, Globe, Sparkles, Terminal } from "../../components/WorkbenchIcons.tsx";
import { executionProgress, toolAction } from "./execution-progress.ts";
import "./execution-progress.css";

const phases = ["理解需求", "调用工具", "分析结果", "生成回复"];

function toolIcon(tool: ToolCall) {
	if (tool.name === "browser") return <Globe size={14} />;
	if (["bash", "terminal", "exec"].includes(tool.name)) return <Terminal size={14} />;
	return <FileCode size={14} />;
}

function outputPreview(output: unknown): string {
	if (typeof output === "string") return output.replace(/\s+/gu, " ").trim();
	if (typeof output !== "object" || output === null) return "";
	if ("content" in output && Array.isArray(output.content)) {
		const text = output.content
			.flatMap((item: unknown) =>
				typeof item === "object" && item !== null && "text" in item && typeof item.text === "string"
					? [item.text]
					: [],
			)
			.join(" ")
			.replace(/\s+/gu, " ")
			.trim();
		if (text) return text;
	}
	if ("details" in output && typeof output.details === "object" && output.details !== null) {
		const details = output.details;
		if ("url" in details && typeof details.url === "string") return `页面：${details.url}`;
		if ("path" in details && typeof details.path === "string") return `文件：${details.path}`;
	}
	return "";
}

function toolStatus(tool: ToolCall): string {
	return tool.status === "completed"
		? "已完成"
		: tool.status === "failed"
			? "失败"
			: tool.status === "approval"
				? "等待确认"
				: "执行中";
}

export function ExecutionProgress({
	session,
	startAt,
	endAt,
	isCurrent = true,
}: {
	session: SessionDetail;
	startAt?: string;
	endAt?: string;
	isCurrent?: boolean;
}) {
	const [now, setNow] = useState(Date.now);
	const progress = executionProgress(session, now, { startAt, endAt, isCurrent });
	const [expanded, setExpanded] = useState(progress.active);
	useEffect(() => {
		if (!progress.active) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [progress.active]);
	if (
		!session.messages.length ||
		(!progress.active && !progress.tools.length && !progress.notes.length && session.status !== "error")
	)
		return null;
	const currentPhase = progress.pending.length
		? 1
		: progress.message && !progress.message.complete && progress.message.text
			? 3
			: progress.tools.length
				? 2
				: 0;
	const completed = progress.tools.filter((tool) => tool.status === "completed").length;
	const runStatus = progress.label;
	return (
		<section className={`execution-progress${progress.active ? " is-active" : ""}`} aria-label="本轮执行过程">
			<button
				className="execution-progress-toggle"
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded((value) => !value)}
			>
				<span className="execution-toggle-copy">
					<span className={`execution-dot${progress.active ? " is-live" : ""}`} aria-hidden="true" />
					<strong>{runStatus}</strong>
				</span>
				<span className="execution-toggle-meta">
					{progress.tools.length > 0 && `${completed}/${progress.tools.length} 项工具`}
					<span>用时 {formatDuration(progress.elapsedMs)}</span>
					<ChevronDown size={15} className={expanded ? "is-reversed" : undefined} />
				</span>
			</button>
			<Collapse in={expanded} timeout={180} unmountOnExit>
				<div className="execution-progress-content">
					<ol className="execution-phase-list" aria-label="任务阶段">
						{phases.map((phase, index) => {
							const done = !progress.active || index < currentPhase;
							const current = progress.active && index === currentPhase;
							const failed = progress.status === "error" && index === currentPhase;
							return (
								<li
									key={phase}
									className={`execution-phase${done ? " is-complete" : ""}${current ? " is-current" : ""}${failed ? " is-failed" : ""}`}
									aria-current={current ? "step" : undefined}
								>
									<span className="execution-phase-mark">{done ? <Check size={11} /> : index + 1}</span>
									<span>{phase}</span>
								</li>
							);
						})}
					</ol>
					<div className="execution-current" aria-live="polite">
						<Sparkles size={14} />
						<strong>{runStatus}</strong>
						{progress.active && progress.silentSeconds >= 30 && (
							<span className="execution-silence">
								{progress.silentSeconds >= 90
									? `已 ${progress.silentSeconds} 秒没有新反馈，可用输入框中的停止按钮结束任务。`
									: `已 ${progress.silentSeconds} 秒没有新反馈，正在等待模型或工具返回。`}
							</span>
						)}
					</div>
					{progress.status === "approval" && (
						<Alert severity="warning">工具正在等待你的确认，批准或拒绝后会继续。</Alert>
					)}
					{progress.status === "error" && session.error && <Alert severity="error">{session.error}</Alert>}
					{!!progress.tools.length && (
						<div className="execution-tool-list">
							{progress.tools.map((tool) => {
								const preview = outputPreview(tool.output);
								return (
									<article className={`execution-tool execution-tool-${tool.status}`} key={tool.id}>
										<div className="execution-tool-heading">
											<span className="execution-tool-icon">{toolIcon(tool)}</span>
											<strong>{toolAction(tool)}</strong>
											<span className="execution-tool-status">{toolStatus(tool)}</span>
											<time>
												{new Date(tool.startedAt).toLocaleTimeString([], {
													hour: "2-digit",
													minute: "2-digit",
												})}
											</time>
										</div>
										{preview && (
											<p className="execution-tool-preview">
												{preview.slice(0, 240)}
												{preview.length > 240 ? "…" : ""}
											</p>
										)}
										<ToolCard tool={tool} />
									</article>
								);
							})}
						</div>
					)}
					{progress.active && progress.pending.length === 0 && !progress.tools.length && (
						<p className="execution-empty-step">已收到任务，正在等待模型开始处理。</p>
					)}
				</div>
			</Collapse>
		</section>
	);
}
