import Editor, { loader } from "@monaco-editor/react";
import {
	Alert,
	Button,
	Chip,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	IconButton,
	Tab,
	Tabs,
	TextField,
	Tooltip,
	useMediaQuery,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
	ArrowLeft,
	FileCode,
	Folder,
	GitBranch,
	Globe,
	Maximize2,
	Minimize2,
	RefreshCw,
	X,
} from "./WorkbenchIcons.tsx";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileContent, FileEntry, SessionDetail, Workspace } from "../../../shared/src/protocol.ts";
import { useSpringLayout } from "../hooks/useSpringLayout.ts";
import { api } from "../services/api.ts";
import { usePreferences } from "../stores/preferences.ts";
import { motionTokens, SpringValue } from "../theme/motion.ts";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { GitPanel } from "./GitPanel.tsx";
import { SpringPages } from "./SpringPages.tsx";
import { WorkspaceInspector } from "./WorkspaceInspector.tsx";
import "./workspace-panel.css";

// Bundle Monaco locally; loading an editor must not contact a public CDN.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });
monaco.editor.defineTheme("pi-light", {
	base: "vs",
	inherit: true,
	rules: [],
	colors: {
		"editor.background": "#f7f4f8",
		"editor.foreground": "#25232a",
		"editorGutter.background": "#f7f4f8",
		"editorLineNumber.foreground": "#8b8592",
		"editorLineNumber.activeForeground": "#51496a",
		"editor.lineHighlightBackground": "#efebf2",
		"editor.selectionBackground": "#dcd3eb",
	},
});
monaco.editor.defineTheme("pi-dark", {
	base: "vs-dark",
	inherit: true,
	rules: [],
	colors: {
		"editor.background": "#211f26",
		"editor.foreground": "#e6e0e9",
		"editorGutter.background": "#211f26",
		"editorLineNumber.foreground": "#938f99",
		"editorLineNumber.activeForeground": "#d0bcff",
		"editor.lineHighlightBackground": "#29262f",
		"editor.selectionBackground": "#4a4458",
	},
});

export function WorkspacePanel({
	workspace,
	session,
	fileRequest,
	onFileRequestHandled,
	panelWidth,
	onPanelWidthChange,
	onResizeStateChange,
	onFileOpen,
	onReference,
	onBrowserRequest,
	close,
}: {
	workspace: Workspace;
	session: SessionDetail;
	fileRequest?: { requestId: number; sessionId: string; workspaceId: string; path: string };
	onFileRequestHandled: (requestId: number) => void;
	panelWidth: number;
	onPanelWidthChange: (width: number) => void;
	onResizeStateChange: (resizing: boolean) => void;
	onFileOpen: () => void;
	onReference: (path: string) => void;
	onBrowserRequest: (text: string) => void;
	close: () => void;
}) {
	const [tab, setTab] = useState(4);
	const [directory, setDirectory] = useState(".");
	const [search, setSearch] = useState("");
	const [file, setFile] = useState<FileContent>();
	const [previewOpen, setPreviewOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState("");
	const [confirmSave, setConfirmSave] = useState(false);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [pendingFilePath, setPendingFilePath] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [savedPath, setSavedPath] = useState("");
	const [fileMaximized, setFileMaximized] = useState(false);
	const handledFileRequest = useRef<number | undefined>(undefined);
	const previewOpenRef = useRef(previewOpen);
	const previewTransitionId = useRef(0);
	previewOpenRef.current = previewOpen;
	const resizePointer = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
	const panelElement = useRef<HTMLElement>(null);
	const widthSpring = useRef(new SpringValue());
	const widthInitialized = useRef(false);
	const fileContentElement = useRef<HTMLDivElement>(null);
	const browserShareTarget = fileMaximized && previewOpen ? 0 : previewOpen ? 0.36 : 1;
	const browserShareSpring = useRef(new SpringValue());
	const browserShareInitialized = useRef(false);
	if (!browserShareInitialized.current) {
		browserShareSpring.current.set(browserShareTarget);
		browserShareInitialized.current = true;
	}
	const previousBrowserShareTarget = useRef(browserShareTarget);
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const resizing = useRef(false);
	const visualWidth = widthInitialized.current ? widthSpring.current.position : panelWidth;
	const client = useQueryClient();
	const dark = usePreferences((state) => state.dark);
	const files = useQuery({
		queryKey: ["files", workspace.id, directory],
		queryFn: () => api<FileEntry[]>(`/workspaces/${workspace.id}/files?path=${encodeURIComponent(directory)}`),
		refetchInterval: 10_000,
	});
	const visibleFiles = files.data?.filter((entry) => entry.name.toLowerCase().includes(search.toLowerCase())) ?? [];
	const fileList = useRef<HTMLDivElement>(null);
	useSpringLayout(fileList, visibleFiles.map((entry) => entry.path).join("\0"));
	const setFileContentElement = useCallback((element: HTMLDivElement | null) => {
		fileContentElement.current = element;
		if (element)
			element.style.setProperty("--workspace-browser-share", `${browserShareSpring.current.position * 100}%`);
	}, []);
	useLayoutEffect(() => {
		if (previousBrowserShareTarget.current === browserShareTarget && !reducedMotion) return;
		previousBrowserShareTarget.current = browserShareTarget;
		const transitionId = previewTransitionId.current;
		const element = fileContentElement.current;
		browserShareSpring.current.animate(
			browserShareTarget,
			motionTokens.transition.pageSlide.preset,
			(share) => element?.style.setProperty("--workspace-browser-share", `${share * 100}%`),
			() => {
				if (
					browserShareTarget === 1 &&
					!previewOpen &&
					!previewOpenRef.current &&
					transitionId === previewTransitionId.current
				) {
					setFile(undefined);
					setDraft("");
				}
			},
			reducedMotion,
		);
		return () => browserShareSpring.current.stop();
	}, [browserShareTarget, previewOpen, reducedMotion]);
	useLayoutEffect(() => {
		const element = panelElement.current;
		if (!element) return;
		if (!widthInitialized.current) {
			widthInitialized.current = true;
			widthSpring.current.set(panelWidth);
			element.style.setProperty("--workspace-panel-width", `${panelWidth}px`);
			return;
		}
		if (resizing.current) {
			widthSpring.current.set(panelWidth);
			element.style.setProperty("--workspace-panel-width", `${panelWidth}px`);
			return;
		}
		widthSpring.current.animate(
			panelWidth,
			"gentle",
			(position) => element.style.setProperty("--workspace-panel-width", `${position}px`),
			() => {},
			reducedMotion,
		);
		return () => widthSpring.current.stop();
	}, [panelWidth, reducedMotion]);
	const loadFile = useCallback(
		async (path: string) => {
			setSavedPath("");
			setTab(0);
			try {
				const content = await api<FileContent>(
					`/workspaces/${workspace.id}/file?path=${encodeURIComponent(path)}&preview=true`,
				);
				previewTransitionId.current += 1;
				previewOpenRef.current = true;
				setFile(content);
				setDraft(content.content);
				setFileMaximized(false);
				setPreviewOpen(true);
				onFileOpen();
				setError("");
			} catch (error) {
				setError(error instanceof Error ? error.message : String(error));
			}
		},
		[onFileOpen, workspace.id],
	);
	const open = useCallback(
		async (path: string) => {
			if (file && draft !== file.content) {
				setPendingFilePath(path);
				setConfirmDiscard(true);
				return;
			}
			await loadFile(path);
		},
		[draft, file, loadFile],
	);
	useEffect(() => {
		if (!fileRequest || fileRequest.requestId === handledFileRequest.current) return;
		handledFileRequest.current = fileRequest.requestId;
		if (fileRequest.sessionId !== session.id || fileRequest.workspaceId !== workspace.id) {
			onFileRequestHandled(fileRequest.requestId);
			return;
		}
		void open(fileRequest.path).finally(() => onFileRequestHandled(fileRequest.requestId));
	}, [fileRequest, onFileRequestHandled, open, session.id, workspace.id]);
	const save = async () => {
		if (!file) return;
		setSaving(true);
		try {
			const updated = await api<FileContent>(
				`/workspaces/${workspace.id}/file`,
				{ path: file.path, content: draft, revision: file.revision },
				"PUT",
			);
			setFile(updated);
			setConfirmSave(false);
			setSavedPath(file.path);
			setError("");
			void client.invalidateQueries({ queryKey: ["files", workspace.id] });
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};
	const closePreview = () => {
		if (!file) return;
		if (draft !== file.content) {
			setPendingFilePath(undefined);
			setConfirmDiscard(true);
			return;
		}
		setPreviewOpen(false);
		previewOpenRef.current = false;
		setFileMaximized(false);
	};
	const discardPreview = () => {
		const nextPath = pendingFilePath;
		setPendingFilePath(undefined);
		setConfirmDiscard(false);
		if (nextPath) {
			void loadFile(nextPath);
			return;
		}
		setPreviewOpen(false);
		previewOpenRef.current = false;
		setFileMaximized(false);
	};
	const cancelDiscard = () => {
		setPendingFilePath(undefined);
		setConfirmDiscard(false);
	};
	const extension = file?.path.split(".").pop() ?? "";
	const directoryDepth = directory === "." ? 0 : directory.split("/").length;
	const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		resizing.current = true;
		onResizeStateChange(true);
		resizePointer.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: panelWidth };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
		const activePointer = resizePointer.current;
		if (!activePointer || activePointer.pointerId !== event.pointerId) return;
		const maximum = maximumPanelWidth();
		const maximumBeforeOverlay = Math.max(360, maximum - 360);
		const canExpandToOverlay = activePointer.startWidth >= maximumBeforeOverlay - 1;
		onPanelWidthChange(
			Math.min(
				canExpandToOverlay ? maximum : maximumBeforeOverlay,
				Math.max(360, activePointer.startWidth + activePointer.startX - event.clientX),
			),
		);
	};
	const stopResize = () => {
		if (!resizing.current) return;
		resizing.current = false;
		resizePointer.current = null;
		onResizeStateChange(false);
	};
	const maximumPanelWidth = () => {
		const layoutWidth = document.querySelector<HTMLElement>(".console-layout")?.clientWidth ?? window.innerWidth;
		const sidebarWidth = document.querySelector<HTMLElement>(".console-layout > .sidebar-slot")?.offsetWidth ?? 0;
		return Math.max(360, layoutWidth - sidebarWidth);
	};
	const language =
		(
			{
				ts: "typescript",
				tsx: "typescript",
				js: "javascript",
				jsx: "javascript",
				py: "python",
				md: "markdown",
				yml: "yaml",
			} as Record<string, string>
		)[extension] ?? extension;
	return (
		<aside
			ref={panelElement}
			className={`workspace-panel${file ? " is-file-open" : ""}${fileMaximized ? " is-file-maximized" : ""}`}
			aria-label="项目工具面板"
			style={{ "--workspace-panel-width": `${visualWidth}px` } as CSSProperties}
		>
			<hr
				className="workspace-resize-handle"
				aria-label="调整工作区宽度"
				aria-orientation="vertical"
				aria-valuemin={360}
				aria-valuemax={maximumPanelWidth()}
				aria-valuenow={panelWidth}
				tabIndex={0}
				onPointerDown={startResize}
				onPointerMove={resize}
				onPointerUp={stopResize}
				onPointerCancel={stopResize}
				onLostPointerCapture={stopResize}
				onKeyDown={(event) => {
					const maximum = maximumPanelWidth();
					const maximumBeforeOverlay = Math.max(360, maximum - 360);
					const allowedMaximum = panelWidth >= maximumBeforeOverlay - 1 ? maximum : maximumBeforeOverlay;
					if (event.key === "ArrowLeft") onPanelWidthChange(Math.min(allowedMaximum, panelWidth + 24));
					if (event.key === "ArrowRight") onPanelWidthChange(Math.max(360, panelWidth - 24));
				}}
			/>
			<div className="panel-heading">
				{fileMaximized && file ? (
					<>
						<Tooltip title="返回工作区面板">
							<IconButton aria-label="返回文件列表" onClick={() => setFileMaximized(false)}>
								<ArrowLeft size={18} />
							</IconButton>
						</Tooltip>
						<div className="panel-heading-file-copy">
							<span>{workspace.name}</span>
							<strong>{file.path.split("/").pop() ?? file.path}</strong>
						</div>
						<span className="grow" />
					</>
				) : (
					<>
						<Folder size={16} />
						<span className="panel-project-name" title={workspace.path}>
							{workspace.name}
						</span>
						<span className="panel-project-label">{workspace.remote ? "SSH 远程项目" : "工作区"}</span>
						<span className="grow" />
					</>
				)}
				<Tooltip title={panelWidth >= maximumPanelWidth() - 8 ? "还原面板宽度" : "展开工具面板"}>
					<IconButton
						aria-label="切换工具面板宽度"
						onClick={() =>
							onPanelWidthChange(
								panelWidth >= maximumPanelWidth() - 8
									? Math.min(480, maximumPanelWidth())
									: maximumPanelWidth(),
							)
						}
					>
						{panelWidth >= maximumPanelWidth() - 8 ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
					</IconButton>
				</Tooltip>
				<Tooltip title="隐藏面板">
					<IconButton aria-label="隐藏工作区面板" onClick={close}>
						<X size={17} />
					</IconButton>
				</Tooltip>
			</div>
			<Tabs
				className="workspace-primary-tabs"
				value={tab}
				onChange={(_, value: number) => {
					setTab(value);
					if (value !== 0) setFileMaximized(false);
				}}
				variant="fullWidth"
				aria-label="工作区面板"
			>
				<Tab value={0} label="文件" icon={<FileCode size={16} />} iconPosition="start" />
				<Tab value={4} label="浏览器" icon={<Globe size={16} />} iconPosition="start" />
				<Tab value={3} label="Git" icon={<GitBranch size={16} />} iconPosition="start" />
			</Tabs>
			<div className="panel-content">
				{savedPath && (
					<Alert severity="success" aria-live="polite" onClose={() => setSavedPath("")}>
						已保存 {savedPath}
					</Alert>
				)}
				{error && (
					<Alert severity="error" onClose={() => setError("")}>
						{error}
					</Alert>
				)}
				<SpringPages className="workspace-tab-pages" pageKey={`tab-${tab}`} pageIndex={tab} axis="horizontal">
					{tab === 0 ? (
						<div
							ref={setFileContentElement}
							className={`workspace-tab-content panel-content-files${fileMaximized ? " is-file-maximized" : ""}`}
							style={
								{
									"--workspace-browser-share": `${browserShareSpring.current.position * 100}%`,
								} as CSSProperties
							}
						>
							<SpringPages
								className="workspace-directory-pages"
								pageKey={directory}
								pageIndex={directoryDepth}
								axis="horizontal"
							>
								<div className="workspace-directory-page">
									<div className="file-toolbar">
										{directory !== "." && (
											<Tooltip title="返回上级目录">
												<IconButton
													className="directory-back-button"
													aria-label="返回上级目录"
													onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/") || ".")}
												>
													<ArrowLeft size={17} />
												</IconButton>
											</Tooltip>
										)}
										<span className="path-label">{directory === "." ? workspace.name : directory}</span>
										<IconButton aria-label="刷新文件" onClick={() => void files.refetch()}>
											<RefreshCw size={16} />
										</IconButton>
									</div>
									<TextField
										fullWidth
										placeholder="筛选当前目录…"
										value={search}
										onChange={(event) => setSearch(event.target.value)}
										inputProps={{ "aria-label": "筛选文件" }}
									/>
									{files.error && <Alert severity="error">{files.error.message}</Alert>}
									{!!files.data?.length && !visibleFiles.length && (
										<p className="muted" aria-live="polite">
											没有匹配的文件，请修改筛选词。
										</p>
									)}
									<div ref={fileList} className="file-list">
										{visibleFiles.map((entry) => (
											<button
												type="button"
												className="file-row"
												key={entry.path}
												onClick={() => (entry.directory ? setDirectory(entry.path) : void open(entry.path))}
											>
												{entry.directory ? <Folder size={17} /> : <FileCode size={17} />}
												<span>{entry.name}</span>
												<small>
													{entry.directory ? "" : `${Math.max(1, Math.round(entry.size / 1024))} KB`}
												</small>
											</button>
										))}
									</div>
									{files.data?.length === 0 && <p className="muted">此目录没有可显示的文件。</p>}
								</div>
							</SpringPages>
							{file && (
								<div className={`file-preview-transition${previewOpen ? " is-open" : ""}`}>
									<div className="file-preview-content">
										<div className="file-preview">
											<div className="preview-title">
												<FileCode size={16} />
												<span className="path-label" title={file.path}>
													{file.path.split("/").pop() ?? file.path}
												</span>
												{draft !== file.content && <Chip size="small" label="未保存" />}
												<Tooltip title={fileMaximized ? "收起文件预览" : "展开文件预览"}>
													<IconButton
														aria-label={fileMaximized ? "收起文件预览" : "展开文件预览"}
														onClick={() => setFileMaximized((value) => !value)}
													>
														{fileMaximized ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
													</IconButton>
												</Tooltip>
												<Tooltip title="取消预览">
													<IconButton aria-label="取消文件预览" onClick={closePreview}>
														<X size={16} />
													</IconButton>
												</Tooltip>
											</div>
											{file.truncated && (
												<Alert severity="info">文件超过 1 MB，仅预览前 256 KB；该预览为只读。</Alert>
											)}
											<div className="file-editor-frame">
												<Editor
													height="100%"
													path={file.path}
													language={language}
													value={draft}
													theme={dark ? "pi-dark" : "pi-light"}
													onChange={(value) => {
														setDraft(value ?? "");
														setSavedPath("");
													}}
													options={{
														minimap: { enabled: false },
														fontSize: 13,
														readOnly: file.truncated,
														scrollBeyondLastLine: false,
														wordWrap: "on",
														automaticLayout: true,
													}}
												/>
											</div>
											<div className="preview-actions">
												<Button size="small" onClick={() => onReference(file.path)}>
													引用文件
												</Button>
												<Button
													size="small"
													disabled={draft !== file.content}
													onClick={() => void open(file.path)}
												>
													重新加载
												</Button>
												<Button
													size="small"
													variant="contained"
													disabled={draft === file.content || file.truncated}
													onClick={() => setConfirmSave(true)}
												>
													保存
												</Button>
											</div>
										</div>
									</div>
								</div>
							)}
						</div>
					) : tab === 4 ? (
						<BrowserPanel
							key={session.id}
							sessionId={session.id}
							onRequest={onBrowserRequest}
							running={session.tools.some(
								(tool) => tool.name === "browser" && (tool.status === "running" || tool.status === "approval"),
							)}
						/>
					) : (
						<GitPanel
							key={workspace.id}
							workspace={workspace}
							hasUnsavedFile={!!file && draft !== file.content}
							onBranchChange={() => {
								setFile(undefined);
								setDraft("");
								setPreviewOpen(false);
								setFileMaximized(false);
							}}
						/>
					)}
				</SpringPages>
			</div>
			<WorkspaceInspector key={session.id} session={session} />
			<Dialog open={confirmSave} onClose={() => !saving && setConfirmSave(false)}>
				<DialogTitle>保存工作区文件？</DialogTitle>
				<DialogContent>
					<p>将覆盖 {file?.path}。保存前会检查文件是否被其他操作修改。</p>
					{error && <Alert severity="error">{error}</Alert>}
				</DialogContent>
				<DialogActions>
					<Button disabled={saving} onClick={() => setConfirmSave(false)}>
						取消
					</Button>
					<Button disabled={saving} onClick={() => void save()}>
						{saving ? "保存中…" : "确认保存"}
					</Button>
				</DialogActions>
			</Dialog>
			<Dialog open={confirmDiscard} onClose={cancelDiscard}>
				<DialogTitle>{pendingFilePath ? "放弃修改并打开其他文件？" : "放弃未保存的修改？"}</DialogTitle>
				<DialogContent>
					<p>
						{pendingFilePath
							? `打开 ${pendingFilePath} 会丢弃当前文件尚未保存的修改。`
							: "取消预览会丢弃当前文件尚未保存的修改。"}
					</p>
				</DialogContent>
				<DialogActions>
					<Button onClick={cancelDiscard}>继续编辑</Button>
					<Button color="error" onClick={discardPreview}>
						{pendingFilePath ? "放弃并打开" : "放弃修改"}
					</Button>
				</DialogActions>
			</Dialog>
		</aside>
	);
}
