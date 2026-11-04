import type {
	KernelInfo,
	ProviderAuthPrompt,
	ProviderLoginType,
	ProviderLoginView,
	ProviderOption,
	Resources,
	SessionDetail,
	SessionSummary,
	StorageSummary,
	ThinkingLevel,
	Workspace,
} from "@allweave/protocol";
import {
	Accordion,
	AccordionDetails,
	AccordionSummary,
	Alert,
	Button,
	Checkbox,
	Chip,
	CircularProgress,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	FormControl,
	FormControlLabel,
	IconButton,
	InputAdornment,
	InputLabel,
	LinearProgress,
	MenuItem,
	Pagination,
	Select,
	TextField,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { AppPluginManagerPanel } from "../components/AppPluginManagerPanel.tsx";
import { LoadingState } from "../components/LoadingState.tsx";
import { PersonalizationPanel } from "../components/PersonalizationPanel.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { LoadedExtensionsPanel, SkillLibraryPanel } from "../components/SkillLibraryPanel.tsx";
import { SpringPages } from "../components/SpringPages.tsx";
import {
	ArrowLeft,
	BookOpen,
	ChevronDown,
	ChevronRight,
	Database,
	ExternalLink,
	HardDrive,
	KeyRound,
	Menu,
	PackageOpen,
	Plus,
	RefreshCw,
	Search,
	Settings2,
} from "../components/WorkbenchIcons.tsx";
import { useSpringLayout } from "../hooks/useSpringLayout.ts";
import { api } from "../services/api.ts";
import { usePreferences } from "../stores/preferences.ts";
import { SpringValue } from "../theme/motion.ts";
import { ArchiveManagementPanel, BrowserManagementPanel, UsageStatisticsPanel } from "./WorkbenchSettingsPanels.tsx";

interface Settings {
	mode: string;
	roots: string[];
	approvals: string;
	isolation: string;
	authentication: string;
	credentialStorage: string;
	agentDirectory: string;
	kernel?: KernelInfo;
}

type SettingsSection = "providers" | "plugins" | "browser" | "subagents" | "usage" | "archive" | "storage" | "system";

function SettingsNavigation({ section }: { section: SettingsSection }) {
	const root = useRef<HTMLElement>(null);
	const indicator = useRef<HTMLSpanElement>(null);
	const springs = useRef({
		x: new SpringValue(),
		y: new SpringValue(),
		width: new SpringValue(),
		height: new SpringValue(),
	});
	const initialized = useRef(false);
	const updateIndicator = useCallback(() => {
		const navigation = root.current;
		const activeLink = navigation?.querySelector<HTMLElement>(`a[href="/settings/${section}"]`);
		const movingBackground = indicator.current;
		if (!navigation || !activeLink || !movingBackground) return;
		const navigationBounds = navigation.getBoundingClientRect();
		const activeBounds = activeLink.getBoundingClientRect();
		const target = {
			x: activeBounds.left - navigationBounds.left,
			y: activeBounds.top - navigationBounds.top,
			width: activeBounds.width,
			height: activeBounds.height,
		};
		const paint = () => {
			movingBackground.style.width = `${springs.current.width.position}px`;
			movingBackground.style.height = `${springs.current.height.position}px`;
			movingBackground.style.transform = `translate3d(${springs.current.x.position}px, ${springs.current.y.position}px, 0)`;
			movingBackground.style.opacity = "1";
		};
		if (!initialized.current) {
			initialized.current = true;
			springs.current.x.set(target.x);
			springs.current.y.set(target.y);
			springs.current.width.set(target.width);
			springs.current.height.set(target.height);
			paint();
			return;
		}
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		for (const [key, value] of Object.entries(target) as Array<[keyof typeof target, number]>) {
			springs.current[key].animate(value, "smooth", paint, () => {}, reducedMotion);
		}
	}, [section]);
	useLayoutEffect(() => {
		updateIndicator();
		const navigation = root.current;
		const observer = navigation && typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateIndicator) : null;
		if (navigation) observer?.observe(navigation);
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		reducedMotion.addEventListener("change", updateIndicator);
		return () => {
			observer?.disconnect();
			reducedMotion.removeEventListener("change", updateIndicator);
		};
	}, [updateIndicator]);
	useEffect(
		() => () => {
			for (const spring of Object.values(springs.current)) spring.stop();
		},
		[],
	);
	return (
		<nav ref={root} className="settings-nav" aria-label="设置分类">
			<span ref={indicator} className="settings-nav-indicator" aria-hidden="true" />
			<NavLink
				to="/settings/providers"
				className={section === "providers" ? "active" : ""}
				aria-current={section === "providers" ? "page" : undefined}
			>
				模型供应商
			</NavLink>
			<NavLink
				to="/settings/plugins"
				className={section === "plugins" ? "active" : ""}
				aria-current={section === "plugins" ? "page" : undefined}
			>
				插件
			</NavLink>
			<NavLink
				to="/settings/browser"
				className={section === "browser" ? "active" : ""}
				aria-current={section === "browser" ? "page" : undefined}
			>
				浏览器
			</NavLink>
			<NavLink
				to="/settings/usage"
				className={section === "usage" ? "active" : ""}
				aria-current={section === "usage" ? "page" : undefined}
			>
				使用统计
			</NavLink>
			<NavLink
				to="/settings/archive"
				className={section === "archive" ? "active" : ""}
				aria-current={section === "archive" ? "page" : undefined}
			>
				归档管理
			</NavLink>
			<NavLink
				to="/settings/storage"
				className={section === "storage" ? "active" : ""}
				aria-current={section === "storage" ? "page" : undefined}
			>
				存储管理
			</NavLink>
			<NavLink
				to="/settings/system"
				className={section === "system" ? "active" : ""}
				aria-current={section === "system" ? "page" : undefined}
			>
				内核与本地设置
			</NavLink>
		</nav>
	);
}

const customApis = [
	{ id: "openai-completions", label: "OpenAI Compatible (Chat Completions)" },
	{ id: "openai-responses", label: "OpenAI Responses" },
	{ id: "anthropic-messages", label: "Anthropic Messages" },
	{ id: "google-generative-ai", label: "Google Generative AI" },
	{ id: "allweave-messages", label: "兼容消息接口" },
] as const;

function promptIsSelect(prompt: ProviderAuthPrompt): prompt is Extract<ProviderAuthPrompt, { type: "select" }> {
	return prompt.type === "select";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = units[0];
	for (let index = 1; value >= 1024 && index < units.length; index += 1) {
		value /= 1024;
		unit = units[index];
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

function StoragePanel({ onError }: { onError: (message: string) => void }) {
	const client = useQueryClient();
	const [sessionPage, setSessionPage] = useState(1);
	const [pending, setPending] = useState(false);
	const sessionsList = useRef<HTMLDivElement>(null);
	const storage = useQuery({ queryKey: ["storage"], queryFn: () => api<StorageSummary>("/storage") });
	const pageCount = Math.max(1, Math.ceil((storage.data?.sessions.length ?? 0) / 8));
	const visiblePage = Math.min(sessionPage, pageCount);
	const visibleSessions = storage.data?.sessions.slice((visiblePage - 1) * 8, visiblePage * 8) ?? [];
	useSpringLayout(sessionsList, visibleSessions.map((session) => session.id).join("\0"));
	useEffect(() => {
		if (sessionPage > pageCount) setSessionPage(pageCount);
	}, [sessionPage, pageCount]);
	const compact = async () => {
		setPending(true);
		try {
			const updated = await api<StorageSummary>("/storage/compact", undefined, "POST");
			client.setQueryData(["storage"], updated);
			onError("");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	};
	return (
		<>
			{storage.isPending ? (
				<LoadingState label="正在读取存储数据…" />
			) : storage.error ? (
				<Alert severity="error">{storage.error.message}</Alert>
			) : (
				<>
					<div className="storage-summary">
						<div className="storage-total">
							<HardDrive size={22} />
							<div>
								<span className="muted">工作台数据</span>
								<strong>{formatBytes(storage.data?.totalBytes ?? 0)}</strong>
							</div>
						</div>
						{storage.data?.disk && (
							<div className="storage-disk">
								<div className="section-heading-row">
									<strong>所在磁盘剩余空间</strong>
									<span>
										{formatBytes(storage.data.disk.freeBytes)} / {formatBytes(storage.data.disk.totalBytes)}
									</span>
								</div>
								<LinearProgress
									variant="determinate"
									value={
										storage.data.disk.totalBytes > 0
											? (storage.data.disk.freeBytes / storage.data.disk.totalBytes) * 100
											: 0
									}
								/>
							</div>
						)}
					</div>
					<div className="storage-grid">
						{storage.data?.categories.map((category) => (
							<div className="storage-card" key={category.id}>
								<div className="storage-card-heading">
									{category.id === "database" ? <Database size={18} /> : <PackageOpen size={18} />}
									<strong>{category.label}</strong>
								</div>
								<strong className="storage-bytes">{formatBytes(category.bytes)}</strong>
								<LinearProgress
									variant="determinate"
									value={storage.data.totalBytes ? (category.bytes / storage.data.totalBytes) * 100 : 0}
								/>
								<span className="muted">{category.files.toLocaleString()} 个文件</span>
								<code>{category.path}</code>
							</div>
						))}
					</div>
					<div className="section-heading-row storage-sessions-heading">
						<div>
							<h2>会话记录</h2>
							<p className="muted">归档与永久删除在归档管理中完成。</p>
						</div>
						<div className="storage-session-actions">
							<Button component={NavLink} to="/settings/archive" size="small">
								归档管理
							</Button>
							<Button
								startIcon={pending ? <CircularProgress size={16} /> : <RefreshCw size={16} />}
								disabled={pending}
								onClick={() => void storage.refetch()}
							>
								刷新
							</Button>
						</div>
					</div>
					{storage.data?.sessions.length ? (
						<div ref={sessionsList} className="stored-session-cards">
							{visibleSessions.map((session) => (
								<article className="stored-session-card" key={session.id}>
									<div className="stored-session-name">
										<NavLink to={`/sessions/${session.id}`}>
											<strong>{session.title}</strong>
										</NavLink>
										<span className="muted">{new Date(session.updatedAt).toLocaleString()}</span>
									</div>
									<span className="muted">{formatBytes(session.bytes)}</span>
									<Chip
										size="small"
										label={
											{
												idle: "就绪",
												running: "执行中",
												approval: "等待确认",
												error: "执行失败",
												interrupted: "已中断",
											}[session.status]
										}
									/>
								</article>
							))}
						</div>
					) : (
						<p className="muted">还没有保存的会话。</p>
					)}
					{!!storage.data?.sessions.length && (
						<div className="storage-session-pagination">
							<span className="muted">共 {storage.data.sessions.length} 个会话 · 每页 8 个</span>
							<Pagination
								count={pageCount}
								page={visiblePage}
								onChange={(_, page) => setSessionPage(page)}
								aria-label="会话记录分页"
							/>
						</div>
					)}
					<div className="storage-maintenance">
						<div>
							<strong>压缩工作台数据库</strong>
							<p className="muted">回收数据库中已删除记录占用的空间，不会删除现有会话。</p>
						</div>
						<Button variant="outlined" disabled={pending} onClick={() => void compact()}>
							{pending ? <CircularProgress size={18} /> : "立即压缩"}
						</Button>
					</div>
				</>
			)}
		</>
	);
}

function providerLoginNotification(event: ProviderLoginView["notifications"][number]) {
	if (event.type === "auth_url") {
		return (
			<Alert key={`${event.type}:${event.url}`} severity="info">
				{event.instructions && <div>{event.instructions}</div>}
				<a href={event.url} target="_blank" rel="noreferrer">
					{event.url} <ExternalLink size={14} />
				</a>
			</Alert>
		);
	}
	if (event.type === "device_code") {
		return (
			<Alert key={`${event.type}:${event.userCode}`} severity="info">
				<div>
					在授权页面输入设备码：<strong>{event.userCode}</strong>
				</div>
				<a href={event.verificationUri} target="_blank" rel="noreferrer">
					{event.verificationUri} <ExternalLink size={14} />
				</a>
			</Alert>
		);
	}
	return (
		<Alert key={`${event.type}:${event.message}`} severity={event.type === "info" ? "info" : "warning"}>
			{event.message}
			{event.type === "info" &&
				event.links?.map((link) => (
					<a key={link.url} href={link.url} target="_blank" rel="noreferrer">
						{link.label ?? link.url} <ExternalLink size={14} />
					</a>
				))}
		</Alert>
	);
}

export function ResourcesPage({
	kind,
	section = "providers",
	sessions,
	sessionsLoading = false,
	workspaces,
	onBrowserRequest,
}: {
	kind: "skills" | "settings";
	section?: SettingsSection;
	sessions: SessionSummary[];
	sessionsLoading?: boolean;
	workspaces: Workspace[];
	onBrowserRequest?: (sessionId: string, text: string) => void;
}) {
	const [selected, setSelected] = useState("");
	const activeSessions = sessions.filter((session) => !session.archivedAt && session.purpose !== "plugin-development");
	const id = selected || activeSessions[0]?.id;
	const [error, setError] = useState("");
	const [loginId, setLoginId] = useState("");
	const [loginProvider, setLoginProvider] = useState<ProviderOption>();
	const [answer, setAnswer] = useState("");
	const [answering, setAnswering] = useState(false);
	const [customOpen, setCustomOpen] = useState(false);
	const [customId, setCustomId] = useState("");
	const [customName, setCustomName] = useState("");
	const [customUrl, setCustomUrl] = useState("");
	const [customApi, setCustomApi] = useState<(typeof customApis)[number]["id"]>("openai-completions");
	const [customModels, setCustomModels] = useState("");
	const [customReasoning, setCustomReasoning] = useState(false);
	const [savingCustom, setSavingCustom] = useState(false);
	const [customError, setCustomError] = useState("");
	const [success, setSuccess] = useState("");
	const [providerPicker, setProviderPicker] = useState(false);
	const [providerSearch, setProviderSearch] = useState("");
	const [providerToAddId, setProviderToAddId] = useState("");
	const client = useQueryClient();
	const toggleSidebar = usePreferences((state) => state.toggleSidebar);
	const resources = useQuery({
		queryKey: ["resources", id],
		enabled: kind === "skills" && !!id,
		queryFn: () => api<Resources>(`/skills?sessionId=${id}`),
	});
	const providers = useQuery({
		queryKey: ["providers"],
		enabled: kind === "settings" && section === "providers",
		queryFn: () => api<ProviderOption[]>("/providers"),
	});
	const settings = useQuery({
		queryKey: ["settings"],
		enabled: kind === "settings" && section === "system",
		queryFn: () => api<Settings>("/settings"),
	});
	const detail = useQuery({
		queryKey: ["session", id],
		enabled: kind === "settings" && section === "providers" && !!id,
		queryFn: () => api<SessionDetail>(`/sessions/${id}`),
	});
	const login = useQuery({
		queryKey: ["provider-login", loginId],
		enabled: !!loginId,
		queryFn: () => api<ProviderLoginView>(`/provider-logins/${loginId}`),
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "running" || status === "waiting" ? 600 : false;
		},
	});
	const groups = useMemo(() => {
		const result = new Map<string, ProviderOption[]>();
		for (const provider of providers.data ?? []) {
			const group = result.get(provider.category) ?? [];
			group.push(provider);
			result.set(provider.category, group);
		}
		return [...result.entries()];
	}, [providers.data]);
	const availableProviderGroups = useMemo(() => {
		const query = providerSearch.trim().toLocaleLowerCase();
		return groups
			.map(
				([category, items]) =>
					[
						category,
						items.filter(
							(provider) =>
								!query ||
								`${provider.name} ${provider.id} ${provider.category}`.toLocaleLowerCase().includes(query),
						),
					] as const,
			)
			.filter(([, items]) => items.length > 0);
	}, [groups, providerSearch]);
	const configuredProviderGroups = useMemo(
		() =>
			groups
				.map(([category, items]) => [category, items.filter((provider) => provider.configured)] as const)
				.filter(([, items]) => items.length > 0),
		[groups],
	);
	const providerToAdd = providers.data?.find((provider) => provider.id === providerToAddId);
	const providerPickerLayout = useRef<HTMLElement>(null);
	useSpringLayout(
		providerPickerLayout,
		availableProviderGroups
			.map(([category, items]) => `${category}:${items.map((item) => item.id).join(",")}`)
			.join("\0"),
	);
	useEffect(() => {
		if (login.data?.status === "succeeded") {
			void client.invalidateQueries({ queryKey: ["providers"] });
			void client.invalidateQueries({ queryKey: ["models"] });
			void client.invalidateQueries({ queryKey: ["session"] });
		}
	}, [login.data?.status, client]);
	const setThinkingLevel = async (thinkingLevel: ThinkingLevel) => {
		const model = detail.data?.model;
		if (!id || !model) return;
		try {
			const updated = await api<SessionDetail>(
				`/sessions/${id}/model`,
				{ provider: model.provider, modelId: model.id, thinkingLevel },
				"PUT",
			);
			client.setQueryData(["session", id], updated);
			void client.invalidateQueries({ queryKey: ["sessions"] });
			setError("");
			setSuccess("推理等级已保存。");
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	};
	const startLogin = async (provider: ProviderOption, type: ProviderLoginType) => {
		try {
			const created = await api<ProviderLoginView>("/provider-logins", { providerId: provider.id, type });
			setAnswer("");
			setLoginProvider(provider);
			setLoginId(created.id);
			client.setQueryData(["provider-login", created.id], created);
			setError("");
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	};
	const answerLogin = async () => {
		if (!loginId || !login.data?.prompt || answering) return;
		setAnswering(true);
		try {
			await api(`/provider-logins/${loginId}/answer`, { answer }, "POST");
			setAnswer("");
			void login.refetch();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setAnswering(false);
		}
	};
	const cancelLogin = async () => {
		if (loginId && (login.data?.status === "running" || login.data?.status === "waiting")) {
			await api(`/provider-logins/${loginId}`, undefined, "DELETE").catch(() => undefined);
		}
		setLoginId("");
		setLoginProvider(undefined);
	};
	const logoutProvider = async (provider: ProviderOption) => {
		try {
			await api(`/providers/${encodeURIComponent(provider.id)}/credentials`, undefined, "DELETE");
			await Promise.all([
				client.invalidateQueries({ queryKey: ["providers"] }),
				client.invalidateQueries({ queryKey: ["models"] }),
			]);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	};
	const addCustomProvider = async () => {
		if (savingCustom) return;
		setCustomError("");
		setSuccess("");
		if (!/^[a-z][a-z0-9-]{1,62}$/u.test(customId.trim().toLowerCase())) {
			setCustomError("供应商 ID 须为 2–63 个字符，以英文字母开头，仅包含英文、数字和连字符。");
			return;
		}
		try {
			const url = new URL(customUrl.trim());
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid protocol");
		} catch {
			setCustomError("请输入完整的 HTTP 或 HTTPS 接口地址。");
			return;
		}
		const modelList = customModels
			.split(/\r?\n/u)
			.map((model) => model.trim())
			.filter(Boolean)
			.map((model) => ({ id: model, reasoning: customReasoning }));
		setSavingCustom(true);
		try {
			await api("/providers/custom", {
				id: customId.trim().toLowerCase(),
				name: customName.trim(),
				baseUrl: customUrl.trim(),
				api: customApi,
				models: modelList,
			});
			await Promise.all([
				client.invalidateQueries({ queryKey: ["providers"] }),
				client.invalidateQueries({ queryKey: ["models"] }),
			]);
			setCustomOpen(false);
			setProviderPicker(false);
			setCustomId("");
			setCustomName("");
			setCustomUrl("");
			setCustomModels("");
			setError("");
			setSuccess("兼容接口已添加。请在供应商列表中配置凭据。");
		} catch (error) {
			setCustomError(error instanceof Error ? error.message : String(error));
		} finally {
			setSavingCustom(false);
		}
	};
	return (
		<main className="resources-page">
			<div className="resources-heading">
				<IconButton aria-label="切换导航" onClick={toggleSidebar}>
					<Menu size={20} />
				</IconButton>
				{kind === "skills" ? <BookOpen size={24} /> : <Settings2 size={24} />}
				<h1>{kind === "skills" ? "技能" : "设置"}</h1>
			</div>
			{kind === "skills" && <p className="muted">查看当前会话加载的技能，并导入自己的资源。</p>}
			{kind === "settings" && <SettingsNavigation section={section ?? "providers"} />}
			{kind === "settings" && section === "providers" && (
				<p className="muted">按供应商分类配置认证；全部供应商均从当前内核读取。</p>
			)}
			{kind === "skills" && !!sessions.length && (
				<Select
					fullWidth
					size="small"
					value={id ?? ""}
					onChange={(event) => setSelected(event.target.value)}
					inputProps={{ "aria-label": "选择设置对应的会话" }}
				>
					{activeSessions.map((session) => (
						<MenuItem key={session.id} value={session.id}>
							{session.title}
						</MenuItem>
					))}
				</Select>
			)}
			{kind === "skills" && !id && <Alert severity="info">请先创建会话，以查看实际加载的资源。</Alert>}
			{kind === "settings" && section === "providers" && !!activeSessions.length && (
				<div className="settings-session-select">
					<span className="muted">当前会话</span>
					<Select
						size="small"
						value={id ?? ""}
						onChange={(event) => setSelected(event.target.value)}
						inputProps={{ "aria-label": "选择查看当前模型的会话" }}
					>
						{activeSessions.map((session) => (
							<MenuItem key={session.id} value={session.id}>
								{session.title}
							</MenuItem>
						))}
					</Select>
				</div>
			)}
			{error && (
				<Alert severity="error" onClose={() => setError("")}>
					{error}
				</Alert>
			)}
			{success && (
				<Alert severity="success" aria-live="polite" onClose={() => setSuccess("")}>
					{success}
				</Alert>
			)}
			{(resources.error ||
				(section === "providers" && providers.error) ||
				(section === "system" && settings.error)) && (
				<Alert severity="error">
					{resources.error?.message ?? providers.error?.message ?? settings.error?.message}
				</Alert>
			)}
			{kind === "skills" && (
				<section className="resource-library">
					<SkillLibraryPanel skills={resources.data?.skills ?? []} loading={resources.isPending && !!id} />
					{resources.data?.diagnostics.map((message, index) => (
						<Alert key={`${index}:${message}`} severity="warning">
							{message}
						</Alert>
					))}
					<LoadedExtensionsPanel
						extensions={resources.data?.extensions ?? []}
						loading={resources.isPending && !!id}
					/>
				</section>
			)}
			{kind === "settings" && (
				<SpringPages
					className="settings-page-switch"
					pageKey={section ?? "providers"}
					pageIndex={["providers", "plugins", "browser", "usage", "archive", "storage", "system"].indexOf(
						section ?? "providers",
					)}
					axis="horizontal"
				>
					{section === "providers" && (
						<>
							<div className={`provider-overview-row${detail.data?.model ? "" : " single-card"}`}>
								<div className="provider-heading">
									<div>
										<h2>模型供应商</h2>
										<p className="muted">当前内核支持的所有供应商都可在此搜索并接入。</p>
									</div>
									<Button
										startIcon={<Plus size={16} />}
										variant="contained"
										onClick={() => {
											setProviderPicker(true);
											setProviderToAddId("");
											setProviderSearch("");
										}}
									>
										添加供应商
									</Button>
								</div>
								{detail.data?.model && (
									<div className="settings-surface current-model-card">
										<div>
											<span className="muted">当前会话模型</span>
											<strong>{detail.data.model.name}</strong>
											<code>
												{detail.data.model.provider} · {detail.data.model.id}
											</code>
										</div>
										{detail.data.model.reasoning && (
											<Select
												size="small"
												value={detail.data.thinkingLevel}
												inputProps={{ "aria-label": "推理等级" }}
												disabled={detail.data.status === "running" || detail.data.status === "approval"}
												onChange={(event) => void setThinkingLevel(event.target.value as ThinkingLevel)}
											>
												{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => (
													<MenuItem key={level} value={level}>
														{level}
													</MenuItem>
												))}
											</Select>
										)}
									</div>
								)}
							</div>
							{providerPicker ? (
								<section ref={providerPickerLayout} className="provider-picker">
									<div className="provider-picker-title">
										<Button startIcon={<ArrowLeft size={16} />} onClick={() => setProviderPicker(false)}>
											返回供应商
										</Button>
										<div>
											<h2>添加供应商</h2>
											<p className="muted">搜索并选择供应商，然后配置 API Key 或登录方式。</p>
										</div>
									</div>
									<TextField
										fullWidth
										placeholder="搜索供应商名称或 ID"
										value={providerSearch}
										inputProps={{ "aria-label": "搜索供应商名称或 ID" }}
										InputProps={{
											startAdornment: (
												<InputAdornment position="start">
													<Search size={17} />
												</InputAdornment>
											),
										}}
										onChange={(event) => setProviderSearch(event.target.value)}
									/>
									{providerToAdd && (
										<div className="provider-detail-card">
											<div className="provider-detail-identity">
												<ProviderLogo providerId={providerToAdd.id} />
												<div>
													<span className="eyebrow">供应商配置</span>
													<h3>{providerToAdd.name}</h3>
													<code>{providerToAdd.id}</code>
													<p className="muted">
														{providerToAdd.modelCount} 个模型 · {providerToAdd.category}
													</p>
												</div>
											</div>
											<div className="provider-actions">
												{providerToAdd.configured && <Chip size="small" color="success" label="已接入" />}
												{providerToAdd.apiKey?.interactive && (
													<Button
														size="small"
														startIcon={<KeyRound size={15} />}
														onClick={() => void startLogin(providerToAdd, "api_key")}
													>
														{providerToAdd.apiKey.name}
													</Button>
												)}
												{providerToAdd.oauth && (
													<Button size="small" onClick={() => void startLogin(providerToAdd, "oauth")}>
														{providerToAdd.oauth.label}
													</Button>
												)}
												{providerToAdd.apiKey && !providerToAdd.apiKey.interactive && (
													<Chip size="small" variant="outlined" label="使用本机环境凭据" />
												)}
												{providerToAdd.authSource === "stored" && (
													<Button
														size="small"
														color="inherit"
														onClick={() => void logoutProvider(providerToAdd)}
													>
														移除凭据
													</Button>
												)}
												{!providerToAdd.apiKey && !providerToAdd.oauth && (
													<span className="muted">在配置目录或环境变量中提供此供应商凭据。</span>
												)}
											</div>
										</div>
									)}
									{!providers.isPending && !availableProviderGroups.length && (
										<p className="muted" aria-live="polite">
											没有匹配的供应商。请修改搜索词，或创建兼容接口。
										</p>
									)}
									<Button
										startIcon={<Plus size={16} />}
										onClick={() => {
											setCustomError("");
											setCustomOpen(true);
										}}
									>
										添加兼容接口
									</Button>
									{providers.isPending ? (
										<LoadingState label="正在读取模型供应商…" />
									) : (
										availableProviderGroups.map(([category, items]) => (
											<section className="provider-picker-group" key={category}>
												<h3>{category}</h3>
												<div className="provider-picker-grid">
													{items.map((provider) => (
														<button
															className="provider-picker-card"
															key={provider.id}
															type="button"
															onClick={() => setProviderToAddId(provider.id)}
														>
															<ProviderLogo providerId={provider.id} />
															<span className="provider-picker-name">
																<strong>{provider.name}</strong>
																<small>{provider.configured ? "已接入" : provider.id}</small>
															</span>
															<ChevronRight size={17} />
														</button>
													))}
													<button
														className="provider-picker-card custom-provider-card"
														type="button"
														onClick={() => {
															setCustomError("");
															setCustomOpen(true);
														}}
													>
														<span className="provider-logo-tile">
															<Plus size={18} />
														</span>
														<span className="provider-picker-name">
															<strong>创建自定义供应商</strong>
															<small>兼容 OpenAI、Anthropic 等 API</small>
														</span>
														<ChevronRight size={17} />
													</button>
												</div>
											</section>
										))
									)}
								</section>
							) : configuredProviderGroups.length ? (
								configuredProviderGroups.map(([category, items], index) => (
									<Accordion key={category} defaultExpanded={index === 0} disableGutters>
										<AccordionSummary expandIcon={<ChevronDown size={18} />}>
											<strong>{category}</strong>
											<Chip size="small" label={items.length} />
										</AccordionSummary>
										<AccordionDetails>
											{items.map((provider) => (
												<div className="provider-row" key={provider.id}>
													<div className="provider-name">
														<ProviderLogo providerId={provider.id} />
														<div className="provider-name-details">
															<strong>{provider.name}</strong>
															<code>{provider.id}</code>
															<span className="muted">{provider.modelCount} 个模型</span>
															{provider.authSource && (
																<span className="muted">认证来源：{provider.authSource}</span>
															)}
														</div>
													</div>
													<div className="provider-actions">
														<Chip size="small" color="success" label="已接入" />
														{provider.apiKey?.interactive && (
															<Button
																size="small"
																startIcon={<KeyRound size={15} />}
																onClick={() => void startLogin(provider, "api_key")}
															>
																{provider.apiKey.name}
															</Button>
														)}
														{provider.oauth && (
															<Button size="small" onClick={() => void startLogin(provider, "oauth")}>
																{provider.oauth.label}
															</Button>
														)}
														{provider.authSource === "stored" && (
															<Button
																size="small"
																color="inherit"
																onClick={() => void logoutProvider(provider)}
															>
																移除凭据
															</Button>
														)}
													</div>
												</div>
											))}
										</AccordionDetails>
									</Accordion>
								))
							) : (
								<div className="settings-surface">
									<strong>还没有接入模型供应商</strong>
									<span className="muted">点击“添加供应商”，搜索并选择支持的服务。</span>
								</div>
							)}
						</>
					)}
					{section === "plugins" && <AppPluginManagerPanel onError={setError} workspaces={workspaces} />}
					{section === "browser" && (
						<BrowserManagementPanel
							sessions={activeSessions}
							sessionsLoading={sessionsLoading}
							onRequest={onBrowserRequest ?? (() => {})}
						/>
					)}
					{section === "usage" && <UsageStatisticsPanel workspaces={workspaces} />}
					{section === "archive" && (
						<ArchiveManagementPanel
							sessions={sessions}
							sessionsLoading={sessionsLoading}
							workspaces={workspaces}
						/>
					)}
					{section === "storage" && <StoragePanel onError={setError} />}
					{section === "system" && (
						<>
							<PersonalizationPanel />
							<h2>AllWeave Runtime 与本地设置</h2>
							<div className="settings-surface">
								<div className="system-setting-row">
									<span>Runtime 版本</span>
									<strong>{settings.data?.kernel?.version ?? "不可用"}</strong>
								</div>
								<div className="system-setting-row">
									<span>集成方式</span>
									<strong>
										{settings.data?.kernel?.integration === "in-process" ? "项目内源码 SDK" : "不可用"}
									</strong>
								</div>
								<div className="system-setting-row">
									<span>配置目录</span>
									<code>{settings.data?.agentDirectory}</code>
								</div>
								<p>内核与工作台在同一服务进程中运行，升级项目源码后重新启动即可生效。</p>
								<p>
									单用户，本机服务仅监听 127.0.0.1。获准命令以主机权限执行；代码模式脚本运行在进程内 QuickJS
									沙箱中。
								</p>
								<div className="system-roots">
									<span>授权目录</span>
									{settings.data?.roots.map((root) => (
										<code key={root}>{root}</code>
									))}
								</div>
							</div>
						</>
					)}
				</SpringPages>
			)}
			<Dialog open={!!loginId} onClose={() => void cancelLogin()} maxWidth="sm" fullWidth>
				<DialogTitle>{loginProvider?.name ?? "供应商认证"}</DialogTitle>
				<DialogContent className="provider-login-content" sx={{ pt: 1.5 }}>
					{error && <Alert severity="error">{error}</Alert>}
					{login.data?.notifications.map(providerLoginNotification)}
					{login.data?.error && <Alert severity="error">{login.data.error}</Alert>}
					{login.data?.status === "succeeded" && <Alert severity="success">认证已保存到配置目录。</Alert>}
					{login.data?.status === "cancelled" && <Alert severity="info">认证已取消。</Alert>}
					{login.data?.prompt && (
						<div className="provider-login-prompt">
							{promptIsSelect(login.data.prompt) ? (
								<FormControl fullWidth>
									<InputLabel>{login.data.prompt.message}</InputLabel>
									<Select
										label={login.data.prompt.message}
										value={answer}
										onChange={(event) => setAnswer(event.target.value)}
									>
										{login.data.prompt.options.map((option) => (
											<MenuItem key={option.id} value={option.id}>
												{option.label}
												{option.description ? ` — ${option.description}` : ""}
											</MenuItem>
										))}
									</Select>
								</FormControl>
							) : (
								<TextField
									fullWidth
									label={login.data.prompt.message}
									placeholder={login.data.prompt.placeholder}
									type={login.data.prompt.type === "secret" ? "password" : "text"}
									value={answer}
									autoComplete="off"
									onChange={(event) => setAnswer(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void answerLogin();
									}}
								/>
							)}
							<Button disabled={!answer || answering} onClick={() => void answerLogin()}>
								{answering ? <CircularProgress size={18} /> : "继续"}
							</Button>
						</div>
					)}
					{(login.data?.status === "running" || login.isFetching) && !login.data?.prompt && (
						<div className="provider-login-waiting">
							<LoadingState label="等待认证流程…" />
						</div>
					)}
				</DialogContent>
				<DialogActions>
					<Button onClick={() => void cancelLogin()}>
						{login.data?.status === "succeeded" ? "完成" : "取消"}
					</Button>
				</DialogActions>
			</Dialog>
			<Dialog open={customOpen} onClose={() => !savingCustom && setCustomOpen(false)} maxWidth="sm" fullWidth>
				<DialogTitle>添加兼容接口</DialogTitle>
				<DialogContent className="provider-login-content">
					<p className="muted">创建一个自定义供应商；保存后可在供应商列表中为它配置 API Key。</p>
					{customError && <Alert severity="error">{customError}</Alert>}
					<TextField
						label="供应商 ID（小写英文）"
						value={customId}
						onChange={(event) => setCustomId(event.target.value)}
					/>
					<TextField label="显示名称" value={customName} onChange={(event) => setCustomName(event.target.value)} />
					<TextField
						label="API Base URL"
						type="url"
						value={customUrl}
						onChange={(event) => setCustomUrl(event.target.value)}
					/>
					<FormControl fullWidth>
						<InputLabel>API 协议</InputLabel>
						<Select
							label="API 协议"
							value={customApi}
							onChange={(event) => setCustomApi(event.target.value as typeof customApi)}
						>
							{customApis.map((option) => (
								<MenuItem key={option.id} value={option.id}>
									{option.label}
								</MenuItem>
							))}
						</Select>
					</FormControl>
					<TextField
						label="模型 ID（每行一个）"
						multiline
						minRows={3}
						value={customModels}
						onChange={(event) => setCustomModels(event.target.value)}
					/>
					<FormControlLabel
						control={
							<Checkbox
								checked={customReasoning}
								onChange={(event) => setCustomReasoning(event.target.checked)}
							/>
						}
						label="这些模型支持推理等级"
					/>
				</DialogContent>
				<DialogActions>
					<Button disabled={savingCustom} onClick={() => setCustomOpen(false)}>
						取消
					</Button>
					<Button
						variant="contained"
						disabled={
							savingCustom || !customId.trim() || !customName.trim() || !customUrl.trim() || !customModels.trim()
						}
						onClick={() => void addCustomProvider()}
					>
						{savingCustom ? <CircularProgress size={18} /> : "保存并添加"}
					</Button>
				</DialogActions>
			</Dialog>
		</main>
	);
}
