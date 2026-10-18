import {
	Alert,
	Button,
	Chip,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	FormControl,
	InputLabel,
	MenuItem,
	Select,
	TextField,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, GitBranch, Globe, Network, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GitWorkspaceStatus, SessionDetail, SessionSummary, Workspace } from "../../../shared/src/protocol.ts";
import { api } from "../services/api.ts";
import { ToolCard } from "./ToolCard.tsx";

export type PluginFeatureId =
	| "pi-mcp-adapter"
	| "pi-web-access"
	| "pi-subagents"
	| "pi-mcp-extension"
	| "@agimon-ai/doompi-git";

const pluginHeadings: Record<PluginFeatureId, { title: string; description: string }> = {
	"pi-mcp-adapter": {
		title: "MCP Adapter",
		description: "编辑项目 MCP 服务配置。MCP Adapter 会按需连接配置的服务。",
	},
	"pi-web-access": {
		title: "网页搜索与内容读取",
		description: "把搜索任务交给当前会话，查看搜索与抓取工具的执行结果。",
	},
	"pi-subagents": {
		title: "分身任务",
		description: "向当前会话提交委派任务，并在本页查看分身工具调用。",
	},
	"pi-mcp-extension": {
		title: "MCP 服务",
		description: "管理 MCP Extension 使用的项目级 MCP server 配置。",
	},
	"@agimon-ai/doompi-git": {
		title: "Git 工作树会话",
		description: "为现有分支或新分支创建隔离工作树，并直接打开对应会话。",
	},
};

export function PluginFeaturePanel({
	pluginId,
	sessions,
	workspaces,
	onBack,
	onError,
}: {
	pluginId: PluginFeatureId;
	sessions: SessionSummary[];
	workspaces: Workspace[];
	onBack: () => void;
	onError: (message: string) => void;
}) {
	const client = useQueryClient();
	const navigate = useNavigate();
	const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
	const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
	const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
	const [task, setTask] = useState("");
	const [sending, setSending] = useState(false);
	const [mcpContent, setMcpContent] = useState("");
	const [confirmMcpSave, setConfirmMcpSave] = useState(false);
	const [savingMcp, setSavingMcp] = useState(false);
	const [worktreeMode, setWorktreeMode] = useState<"existing" | "new">("existing");
	const [branch, setBranch] = useState("");
	const [baseBranch, setBaseBranch] = useState("");
	const [creatingWorktree, setCreatingWorktree] = useState(false);
	const detail = useQuery({
		queryKey: ["session", sessionId],
		enabled: !!sessionId && (pluginId === "pi-web-access" || pluginId === "pi-subagents"),
		queryFn: () => api<SessionDetail>(`/sessions/${sessionId}`),
	});
	const mcpKind = pluginId === "pi-mcp-adapter" ? "adapter" : "extension";
	const mcpConfig = useQuery({
		queryKey: ["mcp-config", workspaceId, mcpKind],
		enabled: !!workspaceId && (pluginId === "pi-mcp-adapter" || pluginId === "pi-mcp-extension"),
		queryFn: () =>
			api<{ path: string; content: string }>(`/plugins/mcp-config?workspaceId=${workspaceId}&kind=${mcpKind}`),
	});
	const gitStatus = useQuery({
		queryKey: ["plugin-git", workspaceId],
		enabled: !!workspaceId && pluginId === "@agimon-ai/doompi-git",
		queryFn: () => api<GitWorkspaceStatus>(`/plugins/git?workspaceId=${workspaceId}`),
	});
	useEffect(() => {
		if (!sessionId && sessions[0]) setSessionId(sessions[0].id);
	}, [sessionId, sessions]);
	useEffect(() => {
		if (!workspaces.some((workspace) => workspace.id === workspaceId)) setWorkspaceId(workspaces[0]?.id ?? "");
	}, [workspaceId, workspaces]);
	useEffect(() => {
		setMcpContent(mcpConfig.data?.content ?? "");
	}, [mcpConfig.data]);
	useEffect(() => {
		const status = gitStatus.data;
		if (!status) return;
		const availableBranches = status.branches.filter(
			(item) => !status.worktrees.some((worktree) => worktree.branch === item),
		);
		if (!branch && availableBranches[0]) setBranch(availableBranches[0]);
		if (!baseBranch && status.branches[0])
			setBaseBranch(status.branches.includes("main") ? "main" : status.branches[0]);
	}, [gitStatus.data, branch, baseBranch]);
	const heading = pluginHeadings[pluginId];
	const busy = detail.data?.status === "running" || detail.data?.status === "approval";
	const relatedTools = (detail.data?.tools ?? []).filter((tool) => {
		const name = tool.name.toLowerCase();
		return pluginId === "pi-web-access"
			? ["web_search", "fetch_content", "get_search_content", "source_check"].some((part) => name.includes(part))
			: ["subagent", "agent_spawn", "agent_send", "agent_wait"].some((part) => name.includes(part));
	});
	const sendTask = async (kind: "web" | "subagent") => {
		if (!sessionId || !task.trim() || sending || busy) return;
		setSending(true);
		try {
			const text =
				kind === "web"
					? `请使用网页搜索工具完成以下搜索与资料整理，并在答案中附上来源链接：\n\n${task.trim()}`
					: `请使用任务分身工具，将以下任务委派给合适的分身。完成后在主会话中汇总结果：\n\n${task.trim()}`;
			await api(`/sessions/${sessionId}/messages`, { text, references: [] });
			await client.invalidateQueries({ queryKey: ["sessions"] });
			navigate(`/sessions/${sessionId}`);
			onError("");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setSending(false);
		}
	};
	const saveMcpConfig = async () => {
		if (!workspaceId || !mcpConfig.data || mcpConfig.error) return;
		setSavingMcp(true);
		try {
			await api("/plugins/mcp-config", { workspaceId, kind: mcpKind, content: mcpContent }, "PUT");
			await client.invalidateQueries({ queryKey: ["mcp-config", workspaceId, mcpKind] });
			setConfirmMcpSave(false);
			onError("");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setSavingMcp(false);
		}
	};
	const createWorktree = async () => {
		if (!workspaceId || !branch.trim() || creatingWorktree) return;
		setCreatingWorktree(true);
		try {
			const result = await api<{ session: SessionDetail }>("/plugins/git/worktrees", {
				workspaceId,
				mode: worktreeMode,
				branch: branch.trim(),
				...(worktreeMode === "new" ? { baseBranch } : {}),
			});
			await Promise.all([
				client.invalidateQueries({ queryKey: ["workspaces"] }),
				client.invalidateQueries({ queryKey: ["sessions"] }),
				client.invalidateQueries({ queryKey: ["plugin-git"] }),
			]);
			navigate(`/sessions/${result.session.id}`);
			onError("");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setCreatingWorktree(false);
		}
	};
	return (
		<section className="plugin-feature-page">
			<div className="plugin-feature-heading">
				<Button startIcon={<ArrowLeft size={16} />} onClick={onBack}>
					返回插件
				</Button>
				<div>
					<span className="eyebrow">插件功能</span>
					<h2>{heading.title}</h2>
					<p className="muted">{heading.description}</p>
				</div>
			</div>
			{(pluginId === "pi-web-access" || pluginId === "pi-subagents") && (
				<div className="settings-surface plugin-workbench">
					<FormControl fullWidth size="small">
						<InputLabel>目标会话</InputLabel>
						<Select label="目标会话" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
							{sessions.map((session) => (
								<MenuItem key={session.id} value={session.id}>
									{session.title}
								</MenuItem>
							))}
						</Select>
					</FormControl>
					<TextField
						fullWidth
						multiline
						minRows={3}
						label={pluginId === "pi-web-access" ? "搜索内容" : "分身任务"}
						placeholder={
							pluginId === "pi-web-access"
								? "例如：查找 React 19 的官方迁移说明"
								: "例如：并行检查 API 权限与目录遍历风险"
						}
						value={task}
						onChange={(event) => setTask(event.target.value)}
					/>
					<Button
						variant="contained"
						startIcon={
							sending ? (
								<CircularProgress size={16} />
							) : pluginId === "pi-web-access" ? (
								<Globe size={16} />
							) : (
								<Play size={16} />
							)
						}
						disabled={!sessionId || !task.trim() || sending || busy}
						onClick={() => void sendTask(pluginId === "pi-web-access" ? "web" : "subagent")}
					>
						{pluginId === "pi-web-access" ? "开始搜索" : "委派分身任务"}
					</Button>
					{busy && <Alert severity="info">此会话正在运行，请等待当前任务完成后再提交。</Alert>}
				</div>
			)}
			{(pluginId === "pi-web-access" || pluginId === "pi-subagents") && (
				<div className="settings-surface plugin-activity">
					<div className="section-heading-row">
						<h3>最近工具活动</h3>
						<span className="muted">{relatedTools.length}</span>
					</div>
					{detail.error && <Alert severity="error">{detail.error.message}</Alert>}
					{relatedTools.length ? (
						relatedTools
							.slice(-8)
							.reverse()
							.map((tool) => <ToolCard key={tool.id} tool={tool} />)
					) : (
						<p className="muted">此会话还没有调用该插件的工具。</p>
					)}
				</div>
			)}
			{(pluginId === "pi-mcp-adapter" || pluginId === "pi-mcp-extension") && (
				<div className="settings-surface plugin-workbench">
					{!workspaces.length ? (
						<Alert severity="info">请先添加工作区，之后即可编辑此项目的 MCP 配置。</Alert>
					) : (
						<>
							<FormControl fullWidth size="small">
								<InputLabel>所属工作区</InputLabel>
								<Select
									label="所属工作区"
									value={workspaceId}
									onChange={(event) => setWorkspaceId(event.target.value)}
								>
									{workspaces.map((workspace) => (
										<MenuItem key={workspace.id} value={workspace.id}>
											{workspace.name} · {workspace.remote ? `SSH ${workspace.remote.host} · ` : ""}
											{workspace.path}
										</MenuItem>
									))}
								</Select>
							</FormControl>
							{mcpConfig.error && <Alert severity="error">{mcpConfig.error.message}</Alert>}
							{mcpConfig.isPending ? (
								<CircularProgress size={22} />
							) : (
								<>
									<div className="plugin-config-path">
										<Network size={16} />
										<code>{mcpConfig.data?.path}</code>
									</div>
									<TextField
										fullWidth
										multiline
										minRows={14}
										maxRows={28}
										label="MCP server JSON"
										value={mcpContent}
										onChange={(event) => setMcpContent(event.target.value)}
										inputProps={{ spellCheck: false, "aria-label": "MCP server JSON 配置" }}
									/>
									<Alert severity="warning">
										{selectedWorkspace?.remote
											? `配置保存到 ${selectedWorkspace.remote.host}。stdio 服务以 SSH 账号权限运行，HTTP 连接由本机工作台发起；会话下一次运行时加载。`
											: "MCP 插件可能启动本机命令或连接远程服务。会话下一次运行时读取此项目配置。"}
									</Alert>
									<Button
										variant="contained"
										disabled={
											!mcpConfig.data ||
											!!mcpConfig.error ||
											!mcpContent.trim() ||
											mcpContent === mcpConfig.data.content
										}
										onClick={() => setConfirmMcpSave(true)}
									>
										保存 MCP 配置
									</Button>
								</>
							)}
						</>
					)}
				</div>
			)}
			{pluginId === "@agimon-ai/doompi-git" && (
				<div className="plugin-git-layout">
					<div className="settings-surface plugin-workbench">
						<FormControl fullWidth size="small">
							<InputLabel>Git 工作区</InputLabel>
							<Select
								label="Git 工作区"
								value={workspaceId}
								onChange={(event) => setWorkspaceId(event.target.value)}
							>
								{workspaces.map((workspace) => (
									<MenuItem key={workspace.id} value={workspace.id}>
										{workspace.name} · {workspace.remote ? `SSH ${workspace.remote.host} · ` : ""}
										{workspace.path}
									</MenuItem>
								))}
							</Select>
						</FormControl>
						{gitStatus.error && <Alert severity="error">{gitStatus.error.message}</Alert>}
						{gitStatus.data && (
							<>
								<div className="plugin-config-path">
									<GitBranch size={16} />
									<code>{gitStatus.data.repositoryPath}</code>
									<Chip size="small" label={gitStatus.data.branch || "detached HEAD"} />
								</div>
								{gitStatus.data.changedFiles.length ? (
									<Alert severity="warning">
										当前工作区有 {gitStatus.data.changedFiles.length}{" "}
										项未提交更改；新建工作树不会移动这些更改。
									</Alert>
								) : (
									<Alert severity="success">当前工作区干净，可以创建隔离工作树。</Alert>
								)}
								<FormControl fullWidth size="small">
									<InputLabel>创建方式</InputLabel>
									<Select
										label="创建方式"
										value={worktreeMode}
										onChange={(event) => setWorktreeMode(event.target.value as "existing" | "new")}
									>
										<MenuItem value="existing">使用已有分支</MenuItem>
										<MenuItem value="new">从基准分支创建新分支</MenuItem>
									</Select>
								</FormControl>
								{worktreeMode === "existing" ? (
									<FormControl fullWidth size="small">
										<InputLabel>分支</InputLabel>
										<Select label="分支" value={branch} onChange={(event) => setBranch(event.target.value)}>
											{gitStatus.data.branches
												.filter(
													(item) => !gitStatus.data.worktrees.some((worktree) => worktree.branch === item),
												)
												.map((item) => (
													<MenuItem key={item} value={item}>
														{item}
													</MenuItem>
												))}
										</Select>
									</FormControl>
								) : (
									<>
										<TextField
											label="新分支名称"
											value={branch}
											onChange={(event) => setBranch(event.target.value)}
										/>
										<FormControl fullWidth size="small">
											<InputLabel>基准分支</InputLabel>
											<Select
												label="基准分支"
												value={baseBranch}
												onChange={(event) => setBaseBranch(event.target.value)}
											>
												{gitStatus.data.branches.map((item) => (
													<MenuItem key={item} value={item}>
														{item}
													</MenuItem>
												))}
											</Select>
										</FormControl>
									</>
								)}
								<Button
									variant="contained"
									startIcon={creatingWorktree ? <CircularProgress size={16} /> : <GitBranch size={16} />}
									disabled={!branch || creatingWorktree}
									onClick={() => void createWorktree()}
								>
									创建工作树并打开会话
								</Button>
							</>
						)}
					</div>
					<div className="settings-surface">
						<div className="section-heading-row">
							<strong>现有工作树</strong>
							<span className="muted">{gitStatus.data?.worktrees.length ?? 0}</span>
						</div>
						{gitStatus.data?.worktrees.map((worktree) => (
							<div className="git-worktree-row" key={worktree.path}>
								<GitBranch size={16} />
								<div>
									<strong>{worktree.branch || "detached HEAD"}</strong>
									<code>{worktree.path}</code>
								</div>
							</div>
						))}
					</div>
				</div>
			)}
			<Dialog open={confirmMcpSave} onClose={() => setConfirmMcpSave(false)} maxWidth="sm" fullWidth>
				<DialogTitle>确认保存 MCP 配置</DialogTitle>
				<DialogContent>
					<Alert severity="warning">
						{selectedWorkspace?.remote
							? `MCP 命令将在 ${selectedWorkspace.remote.host} 上以 SSH 账号权限执行；HTTP 服务由本机工作台连接。`
							: "MCP server 的 command、args、环境变量和 URL 会在当前会话中使用，并具有工作台进程权限。"}
					</Alert>
				</DialogContent>
				<DialogActions>
					<Button disabled={savingMcp} onClick={() => setConfirmMcpSave(false)}>
						取消
					</Button>
					<Button variant="contained" disabled={savingMcp} onClick={() => void saveMcpConfig()}>
						{savingMcp ? "保存中…" : "确认保存"}
					</Button>
				</DialogActions>
			</Dialog>
		</section>
	);
}
