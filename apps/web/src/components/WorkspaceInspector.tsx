import { Button, IconButton, Tooltip } from "@mui/material";
import { useState } from "react";
import type { SessionDetail } from "../../../shared/src/protocol.ts";
import { ToolCard } from "./ToolCard.tsx";
import { ChevronDown, Clock, Terminal } from "./WorkbenchIcons.tsx";

export function WorkspaceInspector({ session }: { session: SessionDetail }) {
	const [view, setView] = useState<"tools" | "activity">("tools");
	const [open, setOpen] = useState(false);
	const pending = session.tools.filter((tool) => tool.status === "running" || tool.status === "approval");
	return (
		<section className={`workspace-inspector${open ? " is-open" : ""}`} aria-label="执行记录">
			<header className="inspector-toolbar">
				<Button
					aria-pressed={open && view === "tools"}
					onClick={() => {
						setOpen(!open || view !== "tools");
						setView("tools");
					}}
				>
					<Terminal size={15} />
					工具<span className="inspector-count">{session.tools.length}</span>
				</Button>
				<Button
					aria-pressed={open && view === "activity"}
					onClick={() => {
						setOpen(!open || view !== "activity");
						setView("activity");
					}}
				>
					<Clock size={15} />
					活动
				</Button>
				<span className="grow" />
				<span className={`inspector-status${pending.length ? " is-running" : ""}`}>
					<i />
					{pending.length
						? `${pending.length} 项${session.status === "approval" ? "待确认" : "执行中"}`
						: "无运行任务"}
				</span>
				<Tooltip title={open ? "收起执行记录" : "展开执行记录"}>
					<IconButton
						aria-label={open ? "收起执行记录" : "展开执行记录"}
						aria-expanded={open}
						aria-controls={`inspector-${session.id}`}
						onClick={() => setOpen(!open)}
					>
						<ChevronDown size={15} className={open ? "" : "is-collapsed"} />
					</IconButton>
				</Tooltip>
			</header>
			<div id={`inspector-${session.id}`} className="inspector-content" hidden={!open}>
				{view === "tools" ? (
					session.tools.length ? (
						[...session.tools].reverse().map((tool) => <ToolCard key={tool.id} tool={tool} />)
					) : (
						<p className="inspector-empty">工具调用会显示在这里。浏览器、文件和命令的输入与结果均可展开查看。</p>
					)
				) : (
					<>
						<div className="activity-summary">
							<strong>{session.title}</strong>
							<span>{session.model?.name ?? "尚未配置模型"}</span>
							<span className="muted">{session.model?.provider ?? ""}</span>
						</div>
						{session.tokens && (
							<div className="token-row">
								<div>
									<strong>{session.tokens.input.toLocaleString()}</strong>
									<small>输入 Token</small>
								</div>
								<div>
									<strong>{session.tokens.output.toLocaleString()}</strong>
									<small>输出 Token</small>
								</div>
							</div>
						)}
						<ol className="timeline">
							{session.activity
								.filter((item) => item.type !== "message.delta")
								.slice(-50)
								.reverse()
								.map((item) => (
									<li key={item.id}>
										<span>{item.description}</span>
										<small>{new Date(item.timestamp).toLocaleTimeString()}</small>
									</li>
								))}
						</ol>
					</>
				)}
			</div>
		</section>
	);
}
