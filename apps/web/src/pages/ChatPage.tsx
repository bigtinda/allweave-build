import {
	Alert,
	Box,
	Button,
	Chip,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Drawer,
	IconButton,
	LinearProgress,
	Skeleton,
	Snackbar,
	Tooltip,
	useMediaQuery,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch as BranchIcon, Check, Copy, Undo2 } from "lucide-react";
import type { CSSProperties, MutableRefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
	ChatMessage,
	ModelOption,
	SessionDetail,
	SessionSummary,
	Workspace,
} from "../../../shared/src/protocol.ts";
import { BuildMark } from "../components/BuildMark.tsx";
import { Composer } from "../components/Composer.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { SpringDisclosure } from "../components/SpringDisclosure.tsx";
import { SpringPages } from "../components/SpringPages.tsx";
import { SpringTransition } from "../components/SpringTransition.tsx";
import { ChevronDown, FileCode, FolderOpen, Menu, PanelRight, Sparkles } from "../components/WorkbenchIcons.tsx";
import { WorkspacePanel } from "../components/WorkspacePanel.tsx";
import { useSession } from "../hooks/useSession.ts";
import { useSpringLayout } from "../hooks/useSpringLayout.ts";
import { api } from "../services/api.ts";
import { usePreferences } from "../stores/preferences.ts";
import { SpringValue } from "../theme/motion.ts";

const statusLabel = { idle: "就绪", running: "执行中", approval: "等待确认", error: "执行失败" };
const abortedMessage = "This operation was aborted";
function MessageChanges({ files }: { files: string[] }) {
	const [showAll, setShowAll] = useState(false);
	const visibleFiles = showAll ? files : files.slice(0, 3);
	return (
		<section className="message-changes" aria-label="本轮文件更改">
			<div className="message-changes-heading">
				<span className="message-changes-icon">
					<FileCode size={16} />
				</span>
				<strong>已编辑 {files.length} 个文件</strong>
			</div>
			<ul className="message-changes-list">
				{visibleFiles.map((path) => (
					<li key={path} title={path}>
						<FileCode size={14} />
						<span>{path}</span>
						<small>已修改</small>
					</li>
				))}
			</ul>
			{files.length > 3 && (
				<button className="message-changes-more" type="button" onClick={() => setShowAll((value) => !value)}>
					{showAll ? "收起" : `再显示 ${files.length - 3} 个文件`}
					<ChevronDown size={14} className={showAll ? "is-reversed" : undefined} />
				</button>
			)}
		</section>
	);
}

function MessageActions({
	message,
	busy,
	canNavigate,
	onRecall,
	onBranch,
}: {
	message: ChatMessage;
	busy: boolean;
	canNavigate: boolean;
	onRecall: () => void;
	onBranch: () => void;
}) {
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
	const copyTimer = useRef<number | undefined>(undefined);
	useEffect(
		() => () => {
			if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
		},
		[],
	);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(message.text);
			setCopyState("copied");
		} catch {
			setCopyState("failed");
		}
		if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
		copyTimer.current = window.setTimeout(() => setCopyState("idle"), 1400);
	};
	return (
		<div className={`message-actions message-actions-${message.role}`}>
			<Tooltip title={copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制消息"}>
				<span>
					<IconButton
						aria-label={copyState === "copied" ? "已复制消息" : "复制消息"}
						size="small"
						onClick={() => void copy()}
					>
						{copyState === "copied" ? <Check size={15} /> : <Copy size={15} />}
					</IconButton>
				</span>
			</Tooltip>
			{message.role === "user" ? (
				<Tooltip title="撤回此消息及后续回复，回到输入框编辑。已执行的操作会保留。">
					<span>
						<Button
							className="message-recall-action"
							aria-label="撤回并编辑消息"
							size="small"
							disabled={busy || !canNavigate}
							onClick={onRecall}
							startIcon={<Undo2 size={14} />}
						>
							撤回编辑
						</Button>
					</span>
				</Tooltip>
			) : (
				<Tooltip title="从此回复创建分支，后续输入会沿此回复继续">
					<span>
						<IconButton
							aria-label="从此回复创建分支"
							size="small"
							disabled={busy || !canNavigate}
							onClick={onBranch}
						>
							<BranchIcon size={15} />
						</IconButton>
					</span>
				</Tooltip>
			)}
		</div>
	);
}
function ModelRequestError({ message }: { message: string }) {
	return (
		<Alert severity={message === abortedMessage ? "info" : "error"}>
			{message === abortedMessage ? (
				"已停止生成，已生成的内容已保留。可以继续发送任务。"
			) : message === "Connection error." ? (
				<>
					无法连接模型供应商。请检查网络和 <Link to="/settings/providers">供应商配置</Link> 后重新发送。
					<br />
					<small>{message}</small>
				</>
			) : (
				message
			)}
		</Alert>
	);
}
function setSessionNode<T extends HTMLElement>(
	reference: MutableRefObject<T | null>,
	node: T | null,
	sessionId: string,
) {
	if (node) {
		node.dataset.sessionMotionId = sessionId;
		reference.current = node;
	} else if (reference.current?.dataset.sessionMotionId === sessionId) reference.current = null;
}

export function ChatPage({
	workspaces,
	sessions,
	onNew,
}: {
	workspaces: Workspace[];
	sessions: SessionSummary[];
	onNew: () => void;
}) {
	const { id } = useParams();
	const client = useQueryClient();
	const { data: fetchedSession, error: loadError, connection } = useSession(id);
	const previousSession = useRef<typeof fetchedSession>(undefined);
	if (fetchedSession?.id === id) previousSession.current = fetchedSession;
	const session = id ? (fetchedSession?.id === id ? fetchedSession : previousSession.current) : undefined;
	const changingSession = Boolean(session && session.id !== id);
	const interrupted = session?.error === abortedMessage || session?.messages.at(-1)?.error === abortedMessage;
	const pageIndex = session
		? Math.max(
				0,
				sessions.findIndex((item) => item.id === session.id),
			)
		: 0;
	const models = useQuery({
		queryKey: ["models", id],
		enabled: !!id,
		queryFn: () => api<ModelOption[]>(`/models?sessionId=${id}`),
	});
	const preferences = usePreferences();
	const desktop = useMediaQuery("(min-width:1200px)");
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const [drawerPanel, setDrawerPanel] = useState(false);
	const [panelWidth, setPanelWidth] = useState(480);
	const [resizingPanel, setResizingPanel] = useState(false);
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
	const togglePanel = desktop ? preferences.togglePanel : () => setDrawerPanel((previous) => !previous);
	const [error, setError] = useState("");
	const [conversationNotice, setConversationNotice] = useState("");
	const [references, setReferences] = useState<string[]>([]);
	const [approving, setApproving] = useState(false);
	const [navigatingConversation, setNavigatingConversation] = useState(false);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const draft = session ? (drafts[session.id] ?? "") : "";
	const scroll = useRef<HTMLDivElement>(null);
	const transcript = useRef<HTMLDivElement>(null);
	const chatLayout = useRef<HTMLElement>(null);
	const layoutReservation = useRef(new SpringValue());
	const layoutInitialized = useRef(false);
	const follow = useRef(true);
	const sidebarWidth = desktop ? (preferences.sidebar ? 276 : 64) : 0;
	useEffect(() => {
		const updateWidth = () => setViewportWidth(window.innerWidth);
		window.addEventListener("resize", updateWidth);
		return () => window.removeEventListener("resize", updateWidth);
	}, []);
	useEffect(() => {
		if (!id) return;
		follow.current = true;
		setReferences([]);
		setError("");
	}, [id]);
	useEffect(() => {
		if (session?.sequence === undefined) return;
		if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [session?.sequence]);
	const workspace = workspaces.find((workspace) => workspace.id === session?.workspaceId);
	const workspaceIndex = workspace
		? Math.max(
				0,
				workspaces.findIndex((item) => item.id === workspace.id),
			)
		: 0;
	const approval = session?.approvals[0];
	// A tool cycle may create several assistant messages for one user task.
	const conversation: ChatMessage[][] = [];
	for (const message of session?.messages ?? []) {
		const previous = conversation.at(-1);
		if (message.role === "assistant" && previous?.[0].role === "assistant") previous.push(message);
		else conversation.push([message]);
	}
	const workspaceOpen = Boolean(session && workspace && (desktop ? preferences.panel : drawerPanel));
	useSpringLayout(transcript, conversation.map((messages) => messages[0].id).join("\0"));
	const mainWidth = Math.max(0, viewportWidth - sidebarWidth);
	const panelOverlay = desktop && workspaceOpen && panelWidth > mainWidth - 360;
	const targetReservation = desktop && workspaceOpen && !panelOverlay ? panelWidth : 0;
	const visualReservation = layoutInitialized.current ? layoutReservation.current.position : targetReservation;
	useLayoutEffect(() => {
		const element = chatLayout.current;
		if (!element || !desktop) return;
		if (!layoutInitialized.current) {
			layoutInitialized.current = true;
			layoutReservation.current.set(targetReservation);
			element.style.setProperty("--workspace-layout-reserved", `${targetReservation}px`);
			return;
		}
		if (resizingPanel) {
			layoutReservation.current.set(targetReservation);
			element.style.setProperty("--workspace-layout-reserved", `${targetReservation}px`);
			return;
		}
		layoutReservation.current.animate(
			targetReservation,
			"smooth",
			(position) => element.style.setProperty("--workspace-layout-reserved", `${position}px`),
			() => {},
			reducedMotion,
		);
		return () => layoutReservation.current.stop();
	}, [desktop, reducedMotion, resizingPanel, targetReservation]);
	const expandPanelForFile = () => {
		const availablePanelWidth = window.innerWidth - sidebarWidth - 552;
		const preferredWidth = Math.max(360, Math.min(840, window.innerWidth * 0.42, availablePanelWidth));
		setPanelWidth((current) => Math.max(current, preferredWidth));
	};
	const decide = async (approved: boolean) => {
		if (!session || !approval) return;
		setApproving(true);
		setError("");
		try {
			await api(`/sessions/${session.id}/approvals/${approval.id}`, { approved });
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setApproving(false);
		}
	};
	const recall = async (messageId: string) => {
		if (!session || navigatingConversation || draft) return;
		const sessionId = session.id;
		setNavigatingConversation(true);
		setError("");
		try {
			const result = await api<{ session: SessionDetail; text: string; references: string[] }>(
				`/sessions/${sessionId}/recall`,
				{ messageId },
			);
			client.setQueryData(["session", sessionId], result.session);
			setDrafts((previous) => ({ ...previous, [sessionId]: result.text }));
			setReferences(result.references);
			void client.invalidateQueries({ queryKey: ["sessions"] });
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setNavigatingConversation(false);
		}
	};
	const branch = async (messageId: string) => {
		if (!session || navigatingConversation) return;
		const sessionId = session.id;
		setNavigatingConversation(true);
		setError("");
		try {
			const updated = await api<SessionDetail>(`/sessions/${sessionId}/branch`, { messageId });
			client.setQueryData(["session", sessionId], updated);
			void client.invalidateQueries({ queryKey: ["sessions"] });
			setConversationNotice("已从该回复创建分支，可以继续输入。");
			follow.current = true;
			document.querySelector<HTMLTextAreaElement>('textarea[aria-label="向构序发送任务"]')?.focus();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setNavigatingConversation(false);
		}
	};
	const panel =
		session && workspace ? (
			<WorkspacePanel
				key={workspace.id}
				workspace={workspace}
				session={session}
				panelWidth={panelWidth}
				onPanelWidthChange={setPanelWidth}
				onResizeStateChange={setResizingPanel}
				onFileOpen={expandPanelForFile}
				close={togglePanel}
				onReference={(path) =>
					setReferences((previous) => (previous.includes(path) ? previous : [...previous, path]))
				}
				onBrowserRequest={(text) => {
					setDrafts((previous) => ({
						...previous,
						[session.id]: [previous[session.id], text].filter(Boolean).join("\n\n"),
					}));
					document.querySelector<HTMLTextAreaElement>('textarea[aria-label="向构序发送任务"]')?.focus();
				}}
			/>
		) : null;
	if (!id)
		return (
			<main className="welcome-page">
				<IconButton aria-label="打开导航" className="mobile-menu" onClick={preferences.toggleSidebar}>
					<Menu />
				</IconButton>
				<div className="welcome-content">
					<span className="welcome-edition">ALLWEAVE / BUILD</span>
					<div className="welcome-mark">
						<BuildMark />
					</div>
					<span className="eyebrow">构序 · AI 编程工作台</span>
					<h1>
						让想法交织。
						<br />
						让代码成序。
					</h1>
					<p>
						连接模型、项目与工具，把构想写进真实代码。
						<br />
						从理解项目到完成修改，每一步执行都清晰可见。
					</p>
					<Button variant="contained" size="large" disabled={!workspaces.length} onClick={onNew}>
						新建会话
					</Button>
					<Button component={Link} to="/settings/providers">
						配置模型
					</Button>
					{!workspaces.length && <p>请打开导航，添加项目工作区后创建会话。</p>}
					{!!sessions.length && (
						<section className="recent-sessions" aria-label="最近会话">
							<h2>继续最近的工作</h2>
							{sessions.slice(0, 5).map((recent) => (
								<Link key={recent.id} to={`/sessions/${recent.id}`}>
									<span>{recent.title}</span>
									<small>
										{workspaces.find((item) => item.id === recent.workspaceId)?.name} ·{" "}
										{statusLabel[recent.status]}
									</small>
								</Link>
							))}
						</section>
					)}
					<div className="welcome-capabilities">
						<span>
							<FolderOpen size={18} />
							真实工作区
						</span>
						<span>
							<Sparkles size={18} />
							原生 Agent 能力
						</span>
						<span>
							<PanelRight size={18} />
							可见的执行过程
						</span>
					</div>
					<span className="welcome-signature">一念成潮，万象成序。</span>
				</div>
			</main>
		);
	if (loadError)
		return (
			<main className="page-padding">
				<Alert severity="error">{loadError.message}</Alert>
			</main>
		);
	if (!session)
		return (
			<main className="loading">
				<section className="session-loading" aria-busy="true" aria-label="正在加载会话">
					<Skeleton width="50%" height={32} />
					<Skeleton height={120} />
					<Skeleton height={80} />
				</section>
			</main>
		);
	return (
		<>
			<SpringPages className="chat-session-switch" pageKey={session.id} pageIndex={pageIndex} axis="vertical">
				<main
					ref={(node) => setSessionNode(chatLayout, node, session.id)}
					data-session-motion-id={session.id}
					inert={session.id !== id}
					aria-busy={session.id !== id}
					className={`chat-page${desktop ? " has-workspace-panel" : ""}`}
					style={
						desktop ? ({ "--workspace-layout-reserved": `${visualReservation}px` } as CSSProperties) : undefined
					}
				>
					<header className="chat-header">
						<Tooltip title="切换导航">
							<IconButton
								aria-label="切换导航"
								aria-expanded={preferences.sidebar}
								onClick={preferences.toggleSidebar}
							>
								<Menu size={20} />
							</IconButton>
						</Tooltip>
						<div className="session-heading">
							<div className="workspace-name">
								<FolderOpen size={14} />
								{workspace?.name}
							</div>
							<h1>{session.title}</h1>
						</div>
						<span className="grow" />
						{
							<>
								<Chip
									className={`status-chip status-${session.status}`}
									size="small"
									label={interrupted && session.status === "error" ? "已停止" : statusLabel[session.status]}
									color={
										interrupted && session.status === "error"
											? "default"
											: session.status === "error"
												? "error"
												: session.status === "approval"
													? "warning"
													: session.status === "idle"
														? "default"
														: "primary"
									}
								/>
								<Tooltip title="切换工作区面板">
									<IconButton aria-label="切换工作区面板" onClick={togglePanel}>
										<PanelRight size={20} />
									</IconButton>
								</Tooltip>
							</>
						}
					</header>
					{session.status === "running" && <LinearProgress className="run-progress" />}
					{connection !== "已连接" && (
						<Alert severity="warning" className="connection-alert">
							{connection}。恢复连接后自动同步服务端状态。
						</Alert>
					)}
					<div
						ref={(node) => setSessionNode(scroll, node, session.id)}
						data-session-motion-id={session.id}
						className="chat-scroll"
						onScroll={(event) => {
							const element = event.currentTarget;
							follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
						}}
					>
						<div
							ref={(node) => setSessionNode(transcript, node, session.id)}
							data-session-motion-id={session.id}
							className="transcript"
						>
							{!session.messages.length && (
								<div className="conversation-empty">
									<BuildMark className="conversation-build-mark" />
									<h2>今天要完成什么？</h2>
									<p>
										工作区已连接到 <strong>{workspace?.name}</strong>。<br />
										从解释代码、修复问题或实现功能开始。
									</p>
								</div>
							)}
							{conversation.map((messages) => {
								const role = messages[0].role;
								const finalMessage = messages[messages.length - 1];
								const actionMessage = role === "user" ? messages[0] : finalMessage;
								return (
									<article key={messages[0].id} className={`message message-${role}`}>
										<div className={`message-body message-body-${role}`}>
											<div className="message-label">
												{role === "user" ? (
													"你"
												) : (
													<>
														<Sparkles size={16} />
														构序
													</>
												)}
												<time>
													{new Date(messages[0].timestamp).toLocaleTimeString([], {
														hour: "2-digit",
														minute: "2-digit",
													})}
												</time>
											</div>
											{role === "assistant" &&
												messages.some(
													(message, index) =>
														message.thinking || (index < messages.length - 1 && message.text),
												) && (
													<SpringDisclosure className="thinking" label="本轮推理与过程 · 展开查看">
														{messages.map((message, index) => (
															<div key={message.id} className="thinking-segment">
																{message.thinking && <Markdown text={message.thinking} />}
																{index < messages.length - 1 && message.text && (
																	<div className="process-note">
																		<span className="muted">过程说明</span>
																		<Markdown text={message.text} />
																	</div>
																)}
															</div>
														))}
													</SpringDisclosure>
												)}
											<div className="message-answer">
												<Markdown text={finalMessage.text} />
											</div>
											{messages.some((message) => !message.complete) && (
												<span className="stream-label">正在生成…</span>
											)}
											{messages
												.filter((message) => message.error)
												.slice(-1)
												.map((message) => (
													<ModelRequestError key={message.id} message={message.error!} />
												))}
										</div>
										{role === "assistant" &&
											finalMessage.changedFiles &&
											finalMessage.changedFiles.length > 0 && (
												<MessageChanges files={finalMessage.changedFiles} />
											)}
										<MessageActions
											message={actionMessage}
											busy={navigatingConversation}
											canNavigate={
												connection === "已连接" && (role === "user" ? !draft : finalMessage.complete)
											}
											onRecall={() => void recall(messages[0].id)}
											onBranch={() => void branch(finalMessage.id)}
										/>
									</article>
								);
							})}
							{session.error && session.messages.at(-1)?.error !== session.error && (
								<Alert
									severity={
										session.error === abortedMessage || session.error.startsWith("No models available")
											? "info"
											: "error"
									}
								>
									{session.error === abortedMessage ? (
										"已停止生成，已生成的内容已保留。可以继续发送任务。"
									) : session.error.startsWith("No models available") ? (
										<>
											服务端尚未配置模型认证。请配置供应商凭据或环境变量并重启服务，再到{" "}
											<Link to="/settings">模型与设置</Link> 选择可用模型。
										</>
									) : (
										session.error
									)}
								</Alert>
							)}
							{models.error && <Alert severity="error">模型列表加载失败：{models.error.message}</Alert>}
							{error && (
								<Alert severity="error" onClose={() => setError("")}>
									{error}
								</Alert>
							)}
						</div>
					</div>
					<Composer
						key={session.id}
						session={session}
						locked={navigatingConversation}
						text={draft}
						onTextChange={(text) => setDrafts((previous) => ({ ...previous, [session.id]: text }))}
						models={models.data ?? []}
						references={references}
						removeReference={(path) => setReferences((previous) => previous.filter((item) => item !== path))}
						onError={setError}
						connected={connection === "已连接"}
						onSessionChange={(updated) => {
							client.setQueryData(["session", updated.id], updated);
							void client.invalidateQueries({ queryKey: ["sessions"] });
						}}
					/>
				</main>
			</SpringPages>
			{desktop ? (
				<SpringTransition
					in={Boolean(preferences.panel && panel)}
					direction="right"
					distance={16}
					preset="snappy"
					mountOnEnter
					unmountOnExit
				>
					<div className={`workspace-panel-transition${panelOverlay ? " is-overlay" : ""}`}>
						<SpringPages
							className="workspace-panel-pages"
							pageKey={workspace?.id ?? "empty"}
							pageIndex={workspaceIndex}
							axis="vertical"
						>
							{panel}
						</SpringPages>
					</div>
				</SpringTransition>
			) : (
				<Drawer
					anchor="right"
					open={drawerPanel}
					onClose={togglePanel}
					slotProps={{ transition: { preset: "smooth", direction: "right", distance: 22 } }}
				>
					<Box sx={{ width: { xs: "min(100vw, 560px)", sm: 560 }, height: "100%" }}>
						<SpringPages
							className="workspace-panel-pages"
							pageKey={workspace?.id ?? "empty"}
							pageIndex={workspaceIndex}
							axis="vertical"
						>
							{panel}
						</SpringPages>
					</Box>
				</Drawer>
			)}
			<Dialog open={!!approval && !changingSession} maxWidth="sm" fullWidth aria-labelledby="approval-title">
				<DialogTitle id="approval-title">确认工具执行 · {approval?.name}</DialogTitle>
				<DialogContent>
					<Alert severity="warning">命令和扩展工具可能访问主机资源。仅批准你已检查的操作。</Alert>
					<pre className="approval-input">{JSON.stringify(approval?.input, null, 2)}</pre>
					<p className="muted">此确认仅适用于当前调用，5 分钟后自动拒绝。</p>
					{error && <Alert severity="error">{error}</Alert>}
				</DialogContent>
				<DialogActions>
					<Button
						disabled={approving}
						onClick={() => {
							if (session)
								void api(`/sessions/${session.id}/abort`, {}).catch((error) => setError(String(error)));
						}}
					>
						停止任务
					</Button>
					<Button disabled={approving} onClick={() => void decide(false)}>
						拒绝
					</Button>
					<Button variant="contained" disabled={approving} onClick={() => void decide(true)}>
						{approving ? "处理中…" : "允许此次执行"}
					</Button>
				</DialogActions>
			</Dialog>
			<Snackbar open={!!conversationNotice} autoHideDuration={4000} onClose={() => setConversationNotice("")}>
				<Alert severity="success" onClose={() => setConversationNotice("")}>
					{conversationNotice}
				</Alert>
			</Snackbar>
		</>
	);
}
