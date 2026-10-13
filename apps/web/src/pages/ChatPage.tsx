import {
	Alert,
	Box,
	Button,
	Chip,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Drawer,
	IconButton,
	LinearProgress,
	Tooltip,
	useMediaQuery,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Menu, PanelRight, Sparkles } from "lucide-react";
import type { CSSProperties, MutableRefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ModelOption, SessionSummary, Workspace } from "../../../shared/src/protocol.ts";
import { BuildMark } from "../components/BuildMark.tsx";
import { Composer } from "../components/Composer.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { SpringDisclosure } from "../components/SpringDisclosure.tsx";
import { SpringPages } from "../components/SpringPages.tsx";
import { SpringTransition } from "../components/SpringTransition.tsx";
import { ToolCard } from "../components/ToolCard.tsx";
import { WorkspacePanel } from "../components/WorkspacePanel.tsx";
import { useSession } from "../hooks/useSession.ts";
import { useSpringLayout } from "../hooks/useSpringLayout.ts";
import { api } from "../services/api.ts";
import { usePreferences } from "../stores/preferences.ts";
import { SpringValue } from "../theme/motion.ts";

const statusLabel = { idle: "就绪", running: "执行中", approval: "等待确认", error: "执行失败" };
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
	const [panelWidth, setPanelWidth] = useState(400);
	const [resizingPanel, setResizingPanel] = useState(false);
	const togglePanel = desktop ? preferences.togglePanel : () => setDrawerPanel((previous) => !previous);
	const [error, setError] = useState("");
	const [references, setReferences] = useState<string[]>([]);
	const [approving, setApproving] = useState(false);
	const scroll = useRef<HTMLDivElement>(null);
	const transcript = useRef<HTMLDivElement>(null);
	const chatLayout = useRef<HTMLElement>(null);
	const layoutReservation = useRef(new SpringValue());
	const layoutInitialized = useRef(false);
	const follow = useRef(true);
	const sidebarWidth = desktop && preferences.sidebar ? 276 : 0;
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
	const workspaceOpen = Boolean(session && workspace && (desktop ? preferences.panel : drawerPanel));
	useSpringLayout(
		transcript,
		`${session?.messages.map((message) => message.id).join("\0") ?? ""}|${session?.tools.map((tool) => tool.id).join("\0") ?? ""}`,
	);
	const targetReservation = desktop && workspaceOpen ? panelWidth + 32 : 0;
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
			"gentle",
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
		try {
			await api(`/sessions/${session.id}/approvals/${approval.id}`, { approved });
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setApproving(false);
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
					<Button variant="contained" size="large" onClick={onNew}>
						开始构建
					</Button>
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
				<CircularProgress />
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
							<IconButton aria-label="切换导航" onClick={preferences.toggleSidebar}>
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
						{!workspaceOpen && (
							<>
								<Chip
									className="status-chip"
									size="small"
									label={statusLabel[session.status]}
									color={
										session.status === "error" ? "error" : session.status === "idle" ? "default" : "primary"
									}
								/>
								<Tooltip title="切换工作区面板">
									<IconButton aria-label="切换工作区面板" onClick={togglePanel}>
										<PanelRight size={20} />
									</IconButton>
								</Tooltip>
							</>
						)}
					</header>
					{(session.status === "running" || session.status === "approval") && (
						<LinearProgress className="run-progress" />
					)}
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
							{session.messages.map((message) => (
								<article key={message.id} className={`message message-${message.role}`}>
									<div className="message-label">
										{message.role === "user" ? (
											"你"
										) : (
											<>
												<Sparkles size={16} />
												构序
											</>
										)}
										<time>
											{new Date(message.timestamp).toLocaleTimeString([], {
												hour: "2-digit",
												minute: "2-digit",
											})}
										</time>
									</div>
									{message.thinking && (
										<SpringDisclosure className="thinking" label="模型返回的推理内容">
											<Markdown text={message.thinking} />
										</SpringDisclosure>
									)}
									<Markdown text={message.text} />
									{!message.complete && <span className="stream-label">正在生成…</span>}
									{message.error && <Alert severity="error">{message.error}</Alert>}
								</article>
							))}
							{session.tools.length > 0 && (
								<div className="chat-tools">
									<span className="eyebrow">工具执行</span>
									{session.tools.slice(-8).map((tool) => (
										<ToolCard key={tool.id} tool={tool} />
									))}
								</div>
							)}
							{session.error && (
								<Alert severity={session.error.startsWith("No models available") ? "info" : "error"}>
									{session.error.startsWith("No models available") ? (
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
				<SpringTransition in={Boolean(preferences.panel && panel)} direction="right" mountOnEnter unmountOnExit>
					<div className="workspace-panel-transition">
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
					<Box sx={{ width: { xs: "min(100vw, 390px)", sm: 380 }, height: "100%" }}>
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
					<Button disabled={approving} onClick={() => void decide(false)}>
						拒绝
					</Button>
					<Button variant="contained" disabled={approving} onClick={() => void decide(true)}>
						允许此次执行
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
}
