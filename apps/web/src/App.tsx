import {
	Alert,
	Box,
	Button,
	Chip,
	CircularProgress,
	CssBaseline,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Drawer,
	IconButton,
	Snackbar,
	TextField,
	ThemeProvider,
	Tooltip,
	useMediaQuery,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { LocalFolderListing, SessionDetail, SessionSummary, Workspace } from "../../shared/src/protocol.ts";
import { BuildMark } from "./components/BuildMark.tsx";
import { SpringCollapse } from "./components/SpringCollapse.tsx";
import { SpringPages } from "./components/SpringPages.tsx";
import { SpringSize } from "./components/SpringSize.tsx";
import {
	ArrowLeft,
	BookOpen,
	ChevronDown,
	ChevronRight,
	Folder,
	FolderOpen,
	MessageSquare,
	Moon,
	MoreHorizontal,
	Plus,
	Search,
	Settings2,
	Sun,
	Trash2,
} from "./components/WorkbenchIcons.tsx";
import { useSpringLayout } from "./hooks/useSpringLayout.ts";
import { ChatPage } from "./pages/ChatPage.tsx";
import { ResourcesPage } from "./pages/ResourcesPage.tsx";
import { api } from "./services/api.ts";
import { usePreferences } from "./stores/preferences.ts";
import { motionTokens, SpringValue } from "./theme/motion.ts";
import { createThemeColors, getFontFamily } from "./theme/personalization.ts";
import { consoleTheme } from "./theme/theme.ts";

function ServiceUnavailable({ refresh, message }: { refresh: () => void; message: string }) {
	return (
		<div className="login-page">
			<div className="login-surface">
				<BuildMark className="service-brand-icon" />
				<h1>AllWeave Build · 构序</h1>
				<p>让想法交织，让代码成序。</p>
				<Alert severity="error">服务端未连接：{message}</Alert>
				<Button onClick={refresh}>重新连接</Button>
			</div>
		</div>
	);
}

function RouteSurface({ children }: { children: ReactNode }) {
	return <div className="route-surface">{children}</div>;
}

function SettingsRoute({ sessions, workspaces }: { sessions: SessionSummary[]; workspaces: Workspace[] }) {
	const { pathname } = useLocation();
	const section =
		pathname.startsWith("/settings/plugins") || pathname.startsWith("/settings/packages")
			? "plugins"
			: pathname.startsWith("/settings/storage")
				? "storage"
				: pathname.startsWith("/settings/system")
					? "system"
					: "providers";
	return (
		<RouteSurface>
			<ResourcesPage kind="settings" section={section} sessions={sessions} workspaces={workspaces} />
			<Outlet />
		</RouteSurface>
	);
}

function SlidingSelectionIndicator({
	containerRef,
	targetSelector,
	className,
	useParentRow = false,
}: {
	containerRef: RefObject<HTMLElement | null>;
	targetSelector: string;
	className: string;
	useParentRow?: boolean;
}) {
	const indicator = useRef<HTMLSpanElement>(null);
	const springs = useRef({
		x: new SpringValue(),
		y: new SpringValue(),
		width: new SpringValue(),
		height: new SpringValue(),
	});
	const initialized = useRef(false);
	const update = useCallback(() => {
		const container = containerRef.current;
		const element = indicator.current;
		if (!container || !element) return;
		const selected = container.querySelector<HTMLElement>(targetSelector);
		const targetElement =
			selected && useParentRow ? (selected.closest<HTMLElement>(".session-row") ?? selected) : selected;
		if (!targetElement) {
			for (const spring of Object.values(springs.current)) spring.stop();
			element.style.opacity = "0";
			return;
		}
		const containerBounds = container.getBoundingClientRect();
		const targetBounds = targetElement.getBoundingClientRect();
		const target = {
			x: targetBounds.left - containerBounds.left + container.scrollLeft,
			y: targetBounds.top - containerBounds.top + container.scrollTop,
			width: targetBounds.width,
			height: targetBounds.height,
		};
		const paint = () => {
			element.style.width = `${springs.current.width.position}px`;
			element.style.height = `${springs.current.height.position}px`;
			element.style.transform = `translate3d(${springs.current.x.position}px, ${springs.current.y.position}px, 0)`;
			element.style.opacity = "1";
		};
		if (!initialized.current) {
			initialized.current = true;
			for (const [key, value] of Object.entries(target) as Array<[keyof typeof target, number]>) {
				springs.current[key].set(value);
			}
			paint();
			return;
		}
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		for (const [key, value] of Object.entries(target) as Array<[keyof typeof target, number]>) {
			springs.current[key].animate(value, "smooth", paint, () => {}, reducedMotion);
		}
	}, [containerRef, targetSelector, useParentRow]);
	useLayoutEffect(() => {
		update();
		const container = containerRef.current;
		const observer = container && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
		if (container) observer?.observe(container);
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		reducedMotion.addEventListener("change", update);
		return () => {
			observer?.disconnect();
			reducedMotion.removeEventListener("change", update);
		};
	}, [containerRef, update]);
	useEffect(
		() => () => {
			for (const spring of Object.values(springs.current)) spring.stop();
		},
		[],
	);
	return <span ref={indicator} className={className} aria-hidden="true" />;
}

function Console() {
	const client = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const preferences = usePreferences();
	const desktop = useMediaQuery("(min-width:1024px)");
	useEffect(() => {
		if (!desktop && usePreferences.getState().sidebar) usePreferences.getState().toggleSidebar();
	}, [desktop]);
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => api<Workspace[]>("/workspaces") });
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api<SessionSummary[]>("/sessions") });
	const [workspaceId, setWorkspaceId] = useState("");
	const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() => new Set());
	const [expandedSessionWorkspaceIds, setExpandedSessionWorkspaceIds] = useState<Set<string>>(() => new Set());
	const selectedWorkspace = workspaceId || workspaces.data?.[0]?.id || "";
	const [search, setSearch] = useState("");
	const [error, setError] = useState("");
	const [creating, setCreating] = useState(false);
	const [workspaceDialog, setWorkspaceDialog] = useState(false);
	const [workspaceManage, setWorkspaceManage] = useState<Workspace>();
	const [workspaceName, setWorkspaceName] = useState("");
	const [workspaceSaving, setWorkspaceSaving] = useState(false);
	const [workspaceDeleteTarget, setWorkspaceDeleteTarget] = useState<Workspace>();
	const [workspaceDeleting, setWorkspaceDeleting] = useState(false);
	const [path, setPath] = useState("");
	const [browsePath, setBrowsePath] = useState("");
	const [pickingFolder, setPickingFolder] = useState(false);
	const [manage, setManage] = useState<SessionSummary>();
	const [title, setTitle] = useState("");
	const [deleting, setDeleting] = useState(false);
	const workspaceGroups = useMemo(() => {
		const query = search.trim().toLowerCase();
		return (workspaces.data ?? []).flatMap((workspace) => {
			const workspaceMatches = workspace.name.toLowerCase().includes(query);
			const groupedSessions = (sessions.data ?? []).filter(
				(session) =>
					session.workspaceId === workspace.id &&
					(!query || workspaceMatches || session.title.toLowerCase().includes(query)),
			);
			if (query && !workspaceMatches && groupedSessions.length === 0) return [];
			return [{ workspace, sessions: groupedSessions }];
		});
	}, [search, sessions.data, workspaces.data]);
	const sessionList = useRef<HTMLDivElement>(null);
	const sessionGroups = useRef<HTMLDivElement>(null);
	const navFooter = useRef<HTMLDivElement>(null);
	useSpringLayout(
		sessionGroups,
		workspaceGroups
			.map(
				({ workspace, sessions: groupedSessions }) =>
					`${workspace.id}:${groupedSessions.map((session) => session.id).join(",")}`,
			)
			.join("\0"),
	);
	const sessionMatch = location.pathname.match(/^\/sessions\/([^/]+)$/u);
	const routeSessionId = sessionMatch?.[1];
	const selectedSessionVisible = Boolean(
		routeSessionId &&
			workspaceGroups.some(
				({ workspace, sessions: groupedSessions }) =>
					!collapsedWorkspaceIds.has(workspace.id) &&
					(expandedSessionWorkspaceIds.has(workspace.id) ? groupedSessions : groupedSessions.slice(0, 5)).some(
						(session) => session.id === routeSessionId,
					),
			),
	);
	const synchronizedSessionId = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!routeSessionId) {
			synchronizedSessionId.current = undefined;
			return;
		}
		if (synchronizedSessionId.current === routeSessionId) return;
		const routeSession = sessions.data?.find((session) => session.id === routeSessionId);
		if (!routeSession) return;
		synchronizedSessionId.current = routeSessionId;
		setWorkspaceId(routeSession.workspaceId);
	}, [routeSessionId, sessions.data]);
	const routePage = location.pathname.startsWith("/settings")
		? "settings"
		: location.pathname === "/skills"
			? "skills"
			: sessionMatch
				? "session"
				: "welcome";
	const routePageIndex = { welcome: 0, session: 1, skills: 2, settings: 3 }[routePage];
	const workspaceDeleteSessions = workspaceDeleteTarget
		? (sessions.data ?? []).filter((session) => session.workspaceId === workspaceDeleteTarget.id)
		: [];
	const workspaceDeleteRunningSessions = workspaceDeleteSessions.filter(
		(session) => session.status === "running" || session.status === "approval",
	);
	const localFolders = useQuery({
		queryKey: ["local-folders", browsePath],
		enabled: workspaceDialog,
		queryFn: () =>
			api<LocalFolderListing>(`/local-folders${browsePath ? `?path=${encodeURIComponent(browsePath)}` : ""}`),
	});
	const newSession = async () => {
		if (!selectedWorkspace || creating) return;
		setCreating(true);
		try {
			const session = await api<SessionDetail>("/sessions", { workspaceId: selectedWorkspace });
			client.setQueryData(["session", session.id], session);
			navigate(`/sessions/${session.id}`);
			void client.invalidateQueries({ queryKey: ["sessions"] });
			if (!desktop && preferences.sidebar) preferences.toggleSidebar();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setCreating(false);
		}
	};
	const addWorkspace = async () => {
		try {
			const workspace = await api<Workspace>("/workspaces", { path, authorize: true });
			await client.invalidateQueries({ queryKey: ["workspaces"] });
			setWorkspaceId(workspace.id);
			setWorkspaceDialog(false);
			setPath("");
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	};
	const saveWorkspaceName = async () => {
		if (!workspaceManage || !workspaceName.trim()) return;
		setWorkspaceSaving(true);
		try {
			const updated = await api<Workspace>(
				`/workspaces/${workspaceManage.id}`,
				{ name: workspaceName.trim() },
				"PATCH",
			);
			client.setQueryData<Workspace[]>(["workspaces"], (previous) =>
				previous?.map((workspace) => (workspace.id === updated.id ? updated : workspace)),
			);
			setWorkspaceManage(undefined);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setWorkspaceSaving(false);
		}
	};
	const removeWorkspace = async () => {
		if (!workspaceDeleteTarget) return;
		setWorkspaceDeleting(true);
		try {
			await api(`/workspaces/${workspaceDeleteTarget.id}`, undefined, "DELETE");
			const removedSessions = (sessions.data ?? []).filter(
				(session) => session.workspaceId === workspaceDeleteTarget.id,
			);
			const remainingWorkspaces = (workspaces.data ?? []).filter(
				(workspace) => workspace.id !== workspaceDeleteTarget.id,
			);
			const remainingSessions = (sessions.data ?? []).filter(
				(session) => session.workspaceId !== workspaceDeleteTarget.id,
			);
			client.setQueryData(["workspaces"], remainingWorkspaces);
			client.setQueryData(["sessions"], remainingSessions);
			for (const session of removedSessions) client.removeQueries({ queryKey: ["session", session.id] });
			if (selectedWorkspace === workspaceDeleteTarget.id) setWorkspaceId(remainingWorkspaces[0]?.id ?? "");
			if (sessionMatch && removedSessions.some((session) => session.id === sessionMatch[1])) navigate("/");
			setWorkspaceDeleteTarget(undefined);
			await Promise.all([
				client.invalidateQueries({ queryKey: ["workspaces"] }),
				client.invalidateQueries({ queryKey: ["sessions"] }),
			]);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setWorkspaceDeleting(false);
		}
	};
	const pickWorkspaceFolder = async () => {
		setPickingFolder(true);
		try {
			const result = await api<{ path: string | null }>("/local-folders/pick", {}, "POST");
			if (result.path) {
				setPath(result.path);
				setBrowsePath(result.path);
			}
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setPickingFolder(false);
		}
	};
	const update = async () => {
		if (!manage) return;
		try {
			await api(`/sessions/${manage.id}`, { title }, "PATCH");
			await client.invalidateQueries({ queryKey: ["sessions"] });
			setManage(undefined);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	};
	const remove = async () => {
		if (!manage) return;
		setDeleting(true);
		try {
			await api(`/sessions/${manage.id}`, undefined, "DELETE");
			await client.invalidateQueries({ queryKey: ["sessions"] });
			client.removeQueries({ queryKey: ["session", manage.id] });
			setManage(undefined);
			navigate("/");
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setDeleting(false);
		}
	};
	const sidebar = (
		<nav className="sidebar" aria-label="主导航">
			<NavLink to="/" className="brand">
				<BuildMark className="brand-symbol" />
				<span className="brand-copy">
					<strong>
						AllWeave <span className="brand-product">Build</span>
					</strong>
					<small>构序 / 万象成序</small>
				</span>
			</NavLink>
			<Button
				className="new-session"
				variant="contained"
				startIcon={<Plus size={20} />}
				disabled={!selectedWorkspace || creating}
				onClick={() => void newSession()}
			>
				{creating ? "创建中…" : "新建会话"}
			</Button>
			<p
				className="session-target"
				title={workspaces.data?.find((workspace) => workspace.id === selectedWorkspace)?.path}
			>
				新会话将创建在{" "}
				<strong>
					{workspaces.data?.find((workspace) => workspace.id === selectedWorkspace)?.name ?? "请选择项目"}
				</strong>
			</p>
			<div className="nav-search">
				<Search size={17} />
				<input
					aria-label="搜索历史会话"
					placeholder="搜索项目或会话"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</div>
			<div className="workspace-list-heading">
				<span className="eyebrow">项目</span>
				<Button
					className="workspace-add-button"
					size="small"
					startIcon={<Plus size={14} />}
					onClick={() => {
						setPath("");
						setBrowsePath("");
						setWorkspaceDialog(true);
					}}
				>
					添加工作区
				</Button>
			</div>
			<div ref={sessionList} className="workspace-project-list">
				<SlidingSelectionIndicator
					containerRef={sessionList}
					targetSelector={selectedSessionVisible ? `a[href="${location.pathname}"].active` : ".no-session-link"}
					className="app-selection-indicator session-selection-indicator"
					useParentRow
				/>
				<div ref={sessionGroups} className="workspace-project-groups">
					{workspaceGroups.map(({ workspace, sessions: groupedSessions }) => (
						<section className="workspace-project-group" key={workspace.id}>
							<div className={`workspace-project-heading${workspace.id === selectedWorkspace ? " active" : ""}`}>
								<IconButton
									className="workspace-project-collapse"
									size="small"
									aria-label={`${collapsedWorkspaceIds.has(workspace.id) ? "展开" : "折叠"}项目 ${workspace.name} 中的会话`}
									aria-expanded={!collapsedWorkspaceIds.has(workspace.id)}
									aria-controls={`workspace-sessions-${workspace.id}`}
									onClick={() =>
										setCollapsedWorkspaceIds((current) => {
											const next = new Set(current);
											if (next.has(workspace.id)) next.delete(workspace.id);
											else next.add(workspace.id);
											return next;
										})
									}
								>
									<ChevronDown size={15} />
								</IconButton>
								<button
									className="workspace-project-button"
									type="button"
									aria-pressed={workspace.id === selectedWorkspace}
									title={workspace.path}
									onClick={() => setWorkspaceId(workspace.id)}
								>
									{workspace.id === selectedWorkspace ? <FolderOpen size={16} /> : <Folder size={16} />}
									<span>{workspace.name}</span>
								</button>
								<Tooltip title="工作区设置">
									<IconButton
										size="small"
										aria-label={`工作区设置 ${workspace.name}`}
										onClick={() => {
											setWorkspaceManage(workspace);
											setWorkspaceName(workspace.name);
										}}
									>
										<MoreHorizontal size={16} />
									</IconButton>
								</Tooltip>
							</div>
							<SpringCollapse
								id={`workspace-sessions-${workspace.id}`}
								className="workspace-project-sessions-collapse"
								contentClassName="workspace-project-sessions"
								in={!collapsedWorkspaceIds.has(workspace.id)}
								preset="smooth"
							>
								{(expandedSessionWorkspaceIds.has(workspace.id)
									? groupedSessions
									: groupedSessions.slice(0, 5)
								).map((session) => (
									<div className="session-row" key={session.id}>
										<NavLink
											to={`/sessions/${session.id}`}
											onClick={() => {
												setWorkspaceId(session.workspaceId);
												if (!desktop && preferences.sidebar) preferences.toggleSidebar();
											}}
										>
											<MessageSquare size={15} />
											<span>{session.title}</span>
											{(session.status === "running" || session.status === "approval") && (
												<span className="live-dot" />
											)}
										</NavLink>
										<Tooltip title="会话设置">
											<IconButton
												size="small"
												aria-label={`会话设置 ${session.title}`}
												onClick={() => {
													setManage(session);
													setTitle(session.title);
												}}
											>
												<MoreHorizontal size={15} />
											</IconButton>
										</Tooltip>
									</div>
								))}
								{groupedSessions.length > 5 && (
									<Button
										size="small"
										className="session-show-more"
										aria-expanded={expandedSessionWorkspaceIds.has(workspace.id)}
										aria-controls={`workspace-sessions-${workspace.id}`}
										onClick={() =>
											setExpandedSessionWorkspaceIds((current) => {
												const next = new Set(current);
												if (next.has(workspace.id)) next.delete(workspace.id);
												else next.add(workspace.id);
												return next;
											})
										}
									>
										{expandedSessionWorkspaceIds.has(workspace.id)
											? "收起更多会话"
											: `展开其余 ${groupedSessions.length - 5} 个会话`}
									</Button>
								)}
								{groupedSessions.length === 0 && !sessions.isPending && (
									<span className="workspace-empty-sessions">暂无会话</span>
								)}
							</SpringCollapse>
						</section>
					))}
					{workspaceGroups.length === 0 && (
						<p className="muted empty-history">{search ? "没有匹配的项目或会话" : "尚未添加工作区"}</p>
					)}
				</div>
			</div>
			<div ref={navFooter} className="nav-footer">
				<SlidingSelectionIndicator
					containerRef={navFooter}
					targetSelector={
						routePage === "skills"
							? 'a[href="/skills"].active'
							: routePage === "settings"
								? 'a[href="/settings"].active'
								: ".no-footer-link"
					}
					className="app-selection-indicator footer-selection-indicator"
				/>
				<NavLink to="/skills">
					<BookOpen size={18} />
					技能与插件
				</NavLink>
				<NavLink to="/settings">
					<Settings2 size={18} />
					模型与设置
				</NavLink>
				<div className="theme-row">
					<span>构序 · 本地工作台</span>
					<Tooltip title={preferences.dark ? "切换浅色主题" : "切换深色主题"}>
						<IconButton aria-label="切换主题" onClick={preferences.toggleTheme}>
							{preferences.dark ? <Sun size={18} /> : <Moon size={18} />}
						</IconButton>
					</Tooltip>
				</div>
			</div>
		</nav>
	);
	return (
		<div className="console-layout">
			<a className="skip-link" href="#workbench-content">
				跳到工作区内容
			</a>
			{desktop ? (
				<SpringSize
					open={preferences.sidebar}
					width={276}
					collapsedWidth={64}
					className="sidebar-slot"
					collapsedContent={
						<nav className="navigation-rail" aria-label="收起的主导航">
							<Tooltip title="AllWeave Build 首页">
								<NavLink
									to="/"
									aria-label="AllWeave Build 首页"
									className={`rail-home${routePage === "session" || routePage === "welcome" ? " active" : ""}`}
								>
									<BuildMark className="rail-build-mark" />
								</NavLink>
							</Tooltip>
							<Tooltip title="新建会话">
								<IconButton
									aria-label="新建会话"
									disabled={!selectedWorkspace || creating}
									onClick={() => void newSession()}
								>
									<Plus size={20} />
								</IconButton>
							</Tooltip>
							<Tooltip title="技能与插件">
								<NavLink to="/skills" aria-label="技能与插件">
									<BookOpen size={20} />
								</NavLink>
							</Tooltip>
							<Tooltip title="模型与设置">
								<NavLink to="/settings" aria-label="模型与设置">
									<Settings2 size={20} />
								</NavLink>
							</Tooltip>
						</nav>
					}
				>
					{sidebar}
				</SpringSize>
			) : (
				<Drawer open={preferences.sidebar} onClose={preferences.toggleSidebar}>
					<Box sx={{ height: "100%" }}>{sidebar}</Box>
				</Drawer>
			)}
			<SpringPages
				id="workbench-content"
				className="console-route-switch"
				pageKey={routePage}
				pageIndex={routePageIndex}
				axis="vertical"
			>
				<Routes location={location}>
					<Route
						path="/"
						element={
							<RouteSurface>
								<ChatPage
									workspaces={workspaces.data ?? []}
									sessions={sessions.data ?? []}
									onNew={() => void newSession()}
								/>
							</RouteSurface>
						}
					/>
					<Route
						path="/sessions/:id"
						element={
							<RouteSurface>
								<ChatPage
									workspaces={workspaces.data ?? []}
									sessions={sessions.data ?? []}
									onNew={() => void newSession()}
								/>
							</RouteSurface>
						}
					/>
					<Route
						path="/skills"
						element={
							<RouteSurface>
								<ResourcesPage
									kind="skills"
									sessions={sessions.data ?? []}
									workspaces={workspaces.data ?? []}
								/>
							</RouteSurface>
						}
					/>
					<Route
						path="/settings"
						element={<SettingsRoute sessions={sessions.data ?? []} workspaces={workspaces.data ?? []} />}
					>
						<Route index element={null} />
						<Route path="providers" element={null} />
						<Route path="plugins" element={null} />
						<Route path="packages" element={null} />
						<Route path="storage" element={null} />
						<Route path="system" element={null} />
					</Route>
					<Route
						path="*"
						element={
							<RouteSurface>
								<ChatPage
									workspaces={workspaces.data ?? []}
									sessions={sessions.data ?? []}
									onNew={() => void newSession()}
								/>
							</RouteSurface>
						}
					/>
				</Routes>
			</SpringPages>
			<Dialog
				open={workspaceDialog}
				onClose={() => setWorkspaceDialog(false)}
				maxWidth="lg"
				fullWidth
				className="workspace-picker-dialog"
			>
				<DialogTitle>添加工作区</DialogTitle>
				<DialogContent className="workspace-picker-content">
					<div className="workspace-picker">
						<div className="workspace-picker-browser">
							<div className="workspace-browser-toolbar">
								<IconButton
									aria-label="上级目录"
									disabled={!localFolders.data?.parentPath}
									onClick={() => setBrowsePath(localFolders.data?.parentPath ?? "")}
								>
									<ArrowLeft size={17} />
								</IconButton>
								<span className="path-label" title={localFolders.data?.currentPath ?? "此电脑"}>
									{localFolders.data?.currentPath ?? "此电脑"}
								</span>
								<Button
									size="small"
									variant="contained"
									className="workspace-select-folder-button"
									startIcon={<FolderOpen size={15} />}
									disabled={!localFolders.data?.currentPath}
									onClick={() => setPath(localFolders.data?.currentPath ?? "")}
								>
									选择此文件夹
								</Button>
							</div>
							{localFolders.error && (
								<Alert severity="error">
									{localFolders.error instanceof Error
										? `无法读取目录列表：${localFolders.error.message}`
										: "无法读取目录列表。可以使用 Windows 文件夹选择器，或输入完整路径。"}
								</Alert>
							)}
							{localFolders.isPending ? (
								<div className="workspace-folder-state">
									<CircularProgress size={22} />
									<span>正在读取本机目录…</span>
								</div>
							) : (
								<div className="workspace-folder-list">
									{localFolders.data?.roots.map((folder) => (
										<button
											className="workspace-folder-row"
											key={folder.path}
											type="button"
											onClick={() => setBrowsePath(folder.path)}
										>
											<Folder size={17} />
											<span>{folder.name}</span>
											<code>{folder.path}</code>
											<ChevronRight size={16} />
										</button>
									))}
									{localFolders.data?.directories.map((folder) => (
										<button
											className="workspace-folder-row"
											key={folder.path}
											type="button"
											onClick={() => setBrowsePath(folder.path)}
										>
											<Folder size={17} />
											<span>{folder.name}</span>
											<ChevronRight size={16} />
										</button>
									))}
									{!localFolders.error &&
										(localFolders.data?.roots.length ?? 0) + (localFolders.data?.directories.length ?? 0) ===
											0 && <div className="workspace-folder-state">此位置没有可浏览的文件夹</div>}
								</div>
							)}
						</div>
						<div className="workspace-picker-form">
							<div className="workspace-picker-intro">
								<strong>选择项目目录</strong>
								<p className="muted">使用 Windows 文件夹窗口选择，或输入文件夹绝对路径。</p>
							</div>
							<Button
								variant="outlined"
								startIcon={pickingFolder ? <CircularProgress size={16} /> : <FolderOpen size={17} />}
								disabled={pickingFolder}
								onClick={() => void pickWorkspaceFolder()}
							>
								{pickingFolder ? "等待 Windows 文件夹窗口…" : "从 Windows 选择文件夹"}
							</Button>
							<TextField
								fullWidth
								label="项目目录绝对路径"
								value={path}
								onChange={(event) => setPath(event.target.value)}
							/>
							<Alert severity="warning" className="workspace-picker-warning">
								授权后，构序可读写所选目录及其子目录。可信扩展和获准命令也会以当前 Windows 用户权限运行。
							</Alert>
						</div>
					</div>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setWorkspaceDialog(false)}>取消</Button>
					<Button variant="contained" disabled={!path.trim()} onClick={() => void addWorkspace()}>
						授权并添加
					</Button>
				</DialogActions>
			</Dialog>
			<Dialog
				open={!!workspaceManage}
				onClose={() => setWorkspaceManage(undefined)}
				maxWidth="xs"
				fullWidth
				className="workspace-manage-dialog"
			>
				<DialogTitle>工作区设置</DialogTitle>
				<DialogContent className="workspace-manage-content">
					<TextField
						id="workspace-name"
						autoFocus
						fullWidth
						label="项目别名"
						size="small"
						value={workspaceName}
						helperText="只修改构序中显示的名称，不会重命名或移动项目文件夹。"
						onChange={(event) => setWorkspaceName(event.target.value)}
					/>
					<div className="workspace-manage-path">
						<span className="muted">本机文件夹</span>
						<code>{workspaceManage?.path}</code>
					</div>
				</DialogContent>
				<DialogActions>
					<Button
						color="error"
						startIcon={<Trash2 size={15} />}
						disabled={workspaceSaving || workspaceDeleting}
						onClick={() => {
							if (!workspaceManage) return;
							setWorkspaceDeleteTarget(workspaceManage);
							setWorkspaceManage(undefined);
						}}
					>
						删除工作区
					</Button>
					<span className="grow" />
					<Button onClick={() => setWorkspaceManage(undefined)}>取消</Button>
					<Button disabled={!workspaceName.trim() || workspaceSaving} onClick={() => void saveWorkspaceName()}>
						{workspaceSaving ? "保存中…" : "保存别名"}
					</Button>
				</DialogActions>
			</Dialog>
			<Dialog
				open={!!workspaceDeleteTarget}
				onClose={() => {
					if (!workspaceDeleting) setWorkspaceDeleteTarget(undefined);
				}}
				maxWidth="xs"
				fullWidth
				className="workspace-manage-dialog"
			>
				<DialogTitle>确认删除工作区</DialogTitle>
				<DialogContent className="workspace-manage-content">
					<Alert severity="warning" className="workspace-delete-warning">
						<p>
							将从构序移除“{workspaceDeleteTarget?.name}”及其 {workspaceDeleteSessions.length} 个聊天。
						</p>
						<p>项目文件夹、其中的文件和已保存的会话文件都会保留。</p>
						{sessions.isPending && <p>正在读取会话状态…</p>}
						{workspaceDeleteRunningSessions.length > 0 && (
							<p>有 {workspaceDeleteRunningSessions.length} 个会话仍在运行或等待确认，请先停止它们。</p>
						)}
					</Alert>
					<code className="workspace-delete-path">{workspaceDeleteTarget?.path}</code>
				</DialogContent>
				<DialogActions>
					<Button disabled={workspaceDeleting} onClick={() => setWorkspaceDeleteTarget(undefined)}>
						取消
					</Button>
					<Button
						color="error"
						variant="contained"
						startIcon={workspaceDeleting ? <CircularProgress size={15} /> : <Trash2 size={15} />}
						disabled={workspaceDeleting || sessions.isPending || workspaceDeleteRunningSessions.length > 0}
						onClick={() => void removeWorkspace()}
					>
						{workspaceDeleting ? "正在删除…" : "确认删除"}
					</Button>
				</DialogActions>
			</Dialog>
			<Dialog
				open={!!manage}
				onClose={() => setManage(undefined)}
				maxWidth="xs"
				fullWidth
				className="session-manage-dialog"
			>
				<DialogTitle>管理会话</DialogTitle>
				<DialogContent className="session-manage-content">
					<div className="session-title-field">
						<label htmlFor="session-title">会话标题</label>
						<TextField
							id="session-title"
							autoFocus
							fullWidth
							size="small"
							inputProps={{ "aria-label": "会话标题" }}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
						/>
					</div>
					<p className="muted">删除会话将同时删除此控制台保存的原生会话文件和历史记录。</p>
					{manage && manage.status !== "idle" && (
						<Chip
							size="small"
							color={manage.status === "error" ? "error" : manage.status === "approval" ? "warning" : "primary"}
							label={
								manage.status === "running" ? "执行中" : manage.status === "approval" ? "等待确认" : "执行失败"
							}
						/>
					)}
				</DialogContent>
				<DialogActions>
					<Button
						color="error"
						disabled={deleting || manage?.status === "running" || manage?.status === "approval"}
						onClick={() => void remove()}
					>
						删除会话
					</Button>
					<span className="grow" />
					<Button onClick={() => setManage(undefined)}>取消</Button>
					<Button disabled={!title.trim()} onClick={() => void update()}>
						保存
					</Button>
				</DialogActions>
			</Dialog>
			<Snackbar
				open={!!(error || workspaces.error || sessions.error)}
				autoHideDuration={8000}
				onClose={() => setError("")}
			>
				<Alert severity="error" onClose={() => setError("")}>
					{error || workspaces.error?.message || sessions.error?.message}
				</Alert>
			</Snackbar>
		</div>
	);
}
export function App() {
	const dark = usePreferences((state) => state.dark);
	const accentColor = usePreferences((state) => state.accentColor);
	const fontId = usePreferences((state) => state.fontId);
	const wallpaper = usePreferences((state) => state.wallpaper);
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const theme = useMemo(
		() => consoleTheme(dark, accentColor, fontId, reducedMotion),
		[dark, accentColor, fontId, reducedMotion],
	);
	const themeVariables = useMemo(() => {
		const colors = createThemeColors(dark, accentColor);
		return {
			"--primary": colors.primary,
			"--on-primary": colors.onPrimary,
			"--surface": colors.surface,
			"--container": colors.container,
			"--container-low": colors.containerLow,
			"--selected": colors.selected,
			"--on-selected": colors.onSelected,
			"--text": colors.text,
			"--muted": colors.muted,
			"--outline": colors.outline,
			"--line": colors.line,
			"--font-ui": getFontFamily(fontId),
			"--motion-duration-instant": `${motionTokens.duration.instant}ms`,
			"--motion-duration-fast": `${motionTokens.duration.fast}ms`,
			"--motion-duration-normal": `${motionTokens.duration.normal}ms`,
			"--motion-duration-slow": `${motionTokens.duration.slow}ms`,
			"--motion-duration-layout": `${motionTokens.transition.layout.duration}ms`,
			"--motion-duration-shared-element": `${motionTokens.transition.sharedElement.duration}ms`,
			"--motion-easing-enter": motionTokens.easing.enter,
			"--motion-easing-exit": motionTokens.easing.exit,
			"--motion-easing-standard": motionTokens.easing.standard,
			"--motion-easing-spring": motionTokens.easing.spring,
			"--motion-fast": `${motionTokens.duration.fast}ms ${motionTokens.easing.standard}`,
			"--motion-normal": `${motionTokens.duration.normal}ms ${motionTokens.easing.standard}`,
			"--wallpaper-image": wallpaper ? `url("${wallpaper}")` : "none",
			"--wallpaper-overlay": wallpaper ? (dark ? "rgb(17 19 24 / 78%)" : "rgb(255 255 255 / 78%)") : "transparent",
		} as CSSProperties & Record<`--${string}`, string>;
	}, [dark, accentColor, fontId, wallpaper]);
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.dataset.theme = dark ? "dark" : "light";
		root.dataset.reducedMotion = reducedMotion ? "reduce" : "no-preference";
		for (const [property, value] of Object.entries(themeVariables)) {
			if (typeof value === "string") root.style.setProperty(property, value);
		}
	}, [dark, reducedMotion, themeVariables]);
	const health = useQuery({ queryKey: ["health"], queryFn: () => api("/health"), retry: false });
	return (
		<ThemeProvider theme={theme}>
			<CssBaseline />
			<div data-theme={dark ? "dark" : "light"} className="app-root" style={themeVariables}>
				{health.isPending ? (
					<div className="loading">
						<CircularProgress />
					</div>
				) : health.error ? (
					<ServiceUnavailable
						refresh={() => {
							void health.refetch();
						}}
						message={health.error.message}
					/>
				) : (
					<Console />
				)}
			</div>
		</ThemeProvider>
	);
}
