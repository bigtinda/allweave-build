import type { SessionDetail } from "@allweave/protocol";
import { IconButton, Tooltip } from "@mui/material";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { ToolCard } from "./ToolCard.tsx";
import { ChevronDown, Clock, FileCode, Globe, Sparkles } from "./WorkbenchIcons.tsx";

export function WorkspaceInspector({
	session,
	expanded = true,
	onOpenFile,
}: {
	session: SessionDetail;
	expanded?: boolean;
	onOpenFile: (path: string) => void;
}) {
	const [open, setOpen] = useState(expanded);
	const latestUserMessage = [...session.messages].reverse().find((message) => message.role === "user");
	const currentTurnMessages = latestUserMessage
		? session.messages.filter((message) => message.timestamp >= latestUserMessage.timestamp)
		: [];
	const referencedFiles = [...new Set(latestUserMessage?.input?.references ?? [])];
	const changedFiles = [...new Set(currentTurnMessages.flatMap((message) => message.changedFiles ?? []))];
	const currentTurnTools = latestUserMessage
		? session.tools.filter((tool) => tool.startedAt >= latestUserMessage.timestamp)
		: [];
	const recentTools = currentTurnTools.slice(-4).reverse();
	const activeTools = currentTurnTools.filter((tool) => tool.status === "running" || tool.status === "approval");
	return (
		<section className={`workspace-inspector context-activity${open ? " is-open" : ""}`} aria-label="会话上下文">
			<header className="inspector-toolbar">
				<div className="inspector-context-title">
					<Sparkles size={15} />
					<strong>会话上下文</strong>
				</div>
				<span
					className={`inspector-status${session.status === "running" || session.status === "approval" ? " is-running" : ""}`}
				>
					<i />
					{session.status === "running"
						? "执行中"
						: session.status === "approval"
							? "等待确认"
							: session.status === "error"
								? "上次失败"
								: "就绪"}
				</span>
				<Tooltip title={open ? "收起会话上下文" : "展开会话上下文"}>
					<IconButton
						aria-label={open ? "收起会话上下文" : "展开会话上下文"}
						aria-expanded={open}
						onClick={() => setOpen(!open)}
					>
						<ChevronDown size={15} className={open ? "" : "is-collapsed"} />
					</IconButton>
				</Tooltip>
			</header>
			<div className="inspector-content" hidden={!open}>
				<div className="context-task-summary">
					<span className="eyebrow">当前任务</span>
					<strong>{latestUserMessage?.text.trim() || session.title || "等待新任务"}</strong>
					<div className="context-session-meta">
						<span>{session.model?.name ?? "尚未配置模型"}</span>
						<span>
							{session.accessMode === "plan" ? "规划" : session.accessMode === "ask" ? "逐项确认" : "自动执行"}
						</span>
					</div>
				</div>
				{session.tokens && (
					<div className="token-row context-token-row">
						<div>
							<strong>{session.tokens.input.toLocaleString()}</strong>
							<small>输入 Token</small>
						</div>
						<div>
							<strong>{session.tokens.output.toLocaleString()}</strong>
							<small>输出 Token</small>
						</div>
						<div>
							<strong>{session.tokens.total.toLocaleString()}</strong>
							<small>累计 Token</small>
						</div>
					</div>
				)}
				<section className="context-activity-section" aria-label="本轮执行">
					<div className="context-section-heading">
						<strong>本轮执行</strong>
						<span>
							{activeTools.length ? `${activeTools.length} 项进行中` : `${currentTurnTools.length} 次工具调用`}
						</span>
					</div>
					{currentTurnTools.length ? (
						<div className="context-tool-list">
							{recentTools.map((tool) => (
								<ToolCard key={tool.id} tool={tool} />
							))}
							{currentTurnTools.length > recentTools.length && (
								<details className="context-more-tools">
									<summary>查看更早的 {currentTurnTools.length - recentTools.length} 次调用</summary>
									{currentTurnTools
										.slice(0, -recentTools.length)
										.reverse()
										.map((tool) => (
											<ToolCard key={tool.id} tool={tool} />
										))}
								</details>
							)}
						</div>
					) : (
						<div className="context-activity-empty">
							{session.status === "running" ? (
								<>
									<span className="context-live-dot" />
									正在等待模型响应
								</>
							) : (
								"开始执行后，工具调用和阶段状态会显示在这里。"
							)}
						</div>
					)}
					{session.status === "error" && session.error && (
						<p className="context-error" role="alert">
							{session.error}
						</p>
					)}
				</section>
				{(referencedFiles.length > 0 || changedFiles.length > 0) && (
					<section className="context-files-section" aria-label="本轮文件">
						<div className="context-section-heading">
							<strong>本轮文件</strong>
							<span>{referencedFiles.length + changedFiles.length} 个</span>
						</div>
						{referencedFiles.length > 0 && (
							<div className="context-file-list">
								<strong>已引用</strong>
								{referencedFiles.slice(0, 4).map((path) => (
									<button type="button" key={`ref:${path}`} onClick={() => onOpenFile(path)} title={path}>
										<FileCode size={13} />
										<span>{path}</span>
									</button>
								))}
							</div>
						)}
						{changedFiles.length > 0 && (
							<div className="context-file-list">
								<strong>已修改</strong>
								{changedFiles.slice(0, 4).map((path) => (
									<button type="button" key={`changed:${path}`} onClick={() => onOpenFile(path)} title={path}>
										<FileCode size={13} />
										<span>{path}</span>
									</button>
								))}
							</div>
						)}
					</section>
				)}
				{session.lastRunUsage && (
					<div className="last-run-summary">
						<Clock size={13} /> 最近运行 ·{" "}
						{session.lastRunUsage.durationMs < 60_000
							? `${(session.lastRunUsage.durationMs / 1000).toFixed(1)} 秒`
							: `${Math.floor(session.lastRunUsage.durationMs / 60_000)} 分钟`}{" "}
						· {session.lastRunUsage.tokens?.total.toLocaleString() ?? "用量未知"} Tokens
						<NavLink to="/settings/usage">使用统计</NavLink>
					</div>
				)}
				{currentTurnTools.length === 0 &&
					referencedFiles.length === 0 &&
					changedFiles.length === 0 &&
					!session.tokens &&
					!session.lastRunUsage && (
						<div className="context-empty-row">
							<Globe size={13} />
							页面、文件和工具活动会随当前任务显示在这里。
						</div>
					)}
			</div>
		</section>
	);
}
