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
	Tab,
	Tabs,
	TextField,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import type {
	DefaultPluginStatus,
	KernelInfo,
	PackageImportResult,
	PiConfiguredPackage,
	PiPackageJob,
	ProviderAuthPrompt,
	ProviderLoginType,
	ProviderLoginView,
	ProviderOption,
	ResourceImportFile,
	Resources,
	SessionDetail,
	SessionSummary,
	StorageSummary,
	ThinkingLevel,
	Workspace,
} from "../../../shared/src/protocol.ts";
import { PersonalizationPanel } from "../components/PersonalizationPanel.tsx";
import { type PluginFeatureId, PluginFeaturePanel } from "../components/PluginFeaturePanel.tsx";
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
	FolderUp,
	HardDrive,
	KeyRound,
	Menu,
	PackageOpen,
	Plus,
	RefreshCw,
	Search,
	Settings2,
	Trash2,
} from "../components/WorkbenchIcons.tsx";
import { useSpringLayout } from "../hooks/useSpringLayout.ts";
import { ApiError, api } from "../services/api.ts";
import { encodeResourceImportFiles } from "../services/resource-import.ts";
import { usePreferences } from "../stores/preferences.ts";
import { SpringValue } from "../theme/motion.ts";

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

type SettingsSection = "providers" | "plugins" | "storage" | "system";

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
	{ id: "pi-messages", label: "兼容消息接口" },
] as const;

const pluginCatalog: Array<{ id: PluginFeatureId; source: string; title: string; description: string }> = [
	{
		id: "pi-mcp-adapter",
		source: "npm:pi-mcp-adapter",
		title: "MCP Adapter",
		description: "配置 MCP 服务，按需发现并调用工具。",
	},
	{
		id: "pi-web-access",
		source: "npm:pi-web-access",
		title: "Web Access",
		description: "在会话中搜索网页、读取链接和整理来源。",
	},
	{
		id: "pi-subagents",
		source: "npm:pi-subagents",
		title: "Subagents",
		description: "把任务委派给分身并在主会话中汇总。",
	},
	{
		id: "pi-mcp-extension",
		source: "npm:pi-mcp-extension",
		title: "MCP Extension",
		description: "配置 stdio、HTTP 和 SSE MCP server。",
	},
	{
		id: "@agimon-ai/doompi-git",
		source: "npm:@agimon-ai/doompi-git",
		title: "Git 工作树",
		description: "在 Git 工作树中启动隔离的会话。",
	},
];

const packagePageSize = 8;

interface PackageCardData extends PiConfiguredPackage {
	configured: boolean;
	defaultStatus?: DefaultPluginStatus;
}

function packageIdentity(source: string): string {
	if (!source.startsWith("npm:")) return source;
	const name = source.slice(4);
	const versionAt = name.startsWith("@") ? name.indexOf("@", name.indexOf("/") + 1) : name.indexOf("@");
	return `npm:${versionAt === -1 ? name : name.slice(0, versionAt)}`;
}

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

function PackageManagerPanel({
	onError,
	sessions,
	workspaces,
}: {
	onError: (message: string) => void;
	sessions: SessionSummary[];
	workspaces: Workspace[];
}) {
	const client = useQueryClient();
	const [packageSearch, setPackageSearch] = useState("");
	const [installInput, setInstallInput] = useState("");
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [jobId, setJobId] = useState("");
	const [activePlugin, setActivePlugin] = useState<PluginFeatureId>();
	const [packagePage, setPackagePage] = useState(1);
	const [packageAction, setPackageAction] = useState<
		{ source: string; kind: "remove" } | { source: string; kind: "apply"; applied: boolean }
	>();
	const [packageActionPending, setPackageActionPending] = useState(false);
	const pluginFolderInput = useRef<HTMLInputElement>(null);
	const packageGrid = useRef<HTMLDivElement>(null);
	const [pendingPluginFiles, setPendingPluginFiles] = useState<ResourceImportFile[]>();
	const [preparingPlugin, setPreparingPlugin] = useState(false);
	useEffect(() => {
		pluginFolderInput.current?.setAttribute("webkitdirectory", "");
	}, []);
	const packages = useQuery({
		queryKey: ["packages"],
		queryFn: () => api<{ packages: PiConfiguredPackage[] }>("/packages"),
	});
	const defaults = useQuery({
		queryKey: ["default-plugins"],
		queryFn: () => api<DefaultPluginStatus[]>("/packages/defaults"),
		refetchInterval: (query) =>
			query.state.data?.some((item) => item.status === "pending" || item.status === "running") ? 800 : false,
	});
	const defaultsUnavailable = Boolean(defaults.error && !defaults.data);
	const job = useQuery({
		queryKey: ["package-job", jobId],
		enabled: !!jobId,
		queryFn: () => api<PiPackageJob>(`/packages/jobs/${jobId}`),
		refetchInterval: (query) => (query.state.data?.status === "running" ? 800 : false),
	});
	useEffect(() => {
		if (job.data?.status === "succeeded") {
			void client.invalidateQueries({ queryKey: ["packages"] });
			void client.invalidateQueries({ queryKey: ["default-plugins"] });
			void client.invalidateQueries({ queryKey: ["storage"] });
		}
	}, [job.data?.status, client]);
	const packageCards = useMemo(() => {
		const cards = new Map<string, PackageCardData>();
		for (const item of packages.data?.packages ?? []) {
			cards.set(packageIdentity(item.source), { ...item, configured: true });
		}
		for (const status of defaults.data ?? []) {
			const identity = packageIdentity(status.source);
			const existing = cards.get(identity);
			cards.set(identity, {
				...(existing ?? { source: status.source, applied: false, isDefault: true, configured: false }),
				isDefault: true,
				defaultStatus: status,
			});
		}
		if (defaultsUnavailable) {
			for (const plugin of pluginCatalog) {
				const identity = packageIdentity(plugin.source);
				const existing = cards.get(identity);
				cards.set(
					identity,
					existing
						? { ...existing, isDefault: true }
						: { source: plugin.source, applied: false, isDefault: true, configured: false },
				);
			}
		}
		return [...cards.values()].sort((left, right) => {
			if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
			return left.source.localeCompare(right.source);
		});
	}, [packages.data?.packages, defaults.data, defaultsUnavailable]);
	const packagePageCount = Math.max(1, Math.ceil(packageCards.length / packagePageSize));
	const visiblePackageCards = packageCards.slice((packagePage - 1) * packagePageSize, packagePage * packagePageSize);
	useSpringLayout(packageGrid, visiblePackageCards.map((item) => item.source).join("\0"));
	useEffect(() => {
		if (packagePage > packagePageCount) setPackagePage(packagePageCount);
	}, [packagePage, packagePageCount]);
	const install = async () => {
		try {
			let input = installInput.trim();
			if (pendingPluginFiles) {
				const staged = await api<PackageImportResult>("/packages/import", { files: pendingPluginFiles });
				input = staged.source;
				setInstallInput(input);
				setPendingPluginFiles(undefined);
			}
			const created = await api<PiPackageJob>("/packages/install", { input });
			setJobId(created.id);
			setConfirmOpen(false);
			onError("");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		}
	};
	const choosePluginFolder = async (files: FileList | null) => {
		if (!files?.length || preparingPlugin) return;
		setPreparingPlugin(true);
		onError("");
		try {
			const payload = await encodeResourceImportFiles(files);
			setPendingPluginFiles(payload);
			setInstallInput(`本机插件文件夹（${payload.length} 个文件）`);
			setConfirmOpen(true);
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setPreparingPlugin(false);
		}
	};
	const cancelInstall = () => {
		setConfirmOpen(false);
		if (pendingPluginFiles) {
			setPendingPluginFiles(undefined);
			setInstallInput("");
		}
	};
	const installDefault = async (source: string) => {
		try {
			const created = await api<PiPackageJob>("/packages/install", { input: source });
			setJobId(created.id);
			onError("");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		}
	};
	const managePackage = async () => {
		if (!packageAction) return;
		setPackageActionPending(true);
		try {
			if (packageAction.kind === "remove") {
				const created = await api<PiPackageJob>("/packages/remove", { source: packageAction.source });
				setJobId(created.id);
			} else {
				await api<PiConfiguredPackage>("/packages/apply", {
					source: packageAction.source,
					applied: packageAction.applied,
				});
				await Promise.all([
					client.invalidateQueries({ queryKey: ["packages"] }),
					client.invalidateQueries({ queryKey: ["storage"] }),
				]);
			}
			setPackageAction(undefined);
			onError("");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setPackageActionPending(false);
		}
	};
	if (activePlugin) {
		return (
			<PluginFeaturePanel
				pluginId={activePlugin}
				sessions={sessions}
				workspaces={workspaces}
				onBack={() => setActivePlugin(undefined)}
				onError={onError}
			/>
		);
	}
	const catalogUrl = packageSearch.trim()
		? `https://pi.dev/packages?name=${encodeURIComponent(packageSearch.trim())}`
		: "https://pi.dev/packages";
	return (
		<>
			<div className="package-setup-grid">
				<div className="package-search-card">
					<div>
						<h2>官方插件目录</h2>
						<p className="muted">按名称查找扩展、技能、提示模板和主题，再输入包名安装。</p>
					</div>
					<div className="package-search-row">
						<TextField
							fullWidth
							size="small"
							label="搜索官方目录"
							placeholder="输入插件包名"
							value={packageSearch}
							onChange={(event) => setPackageSearch(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") window.open(catalogUrl, "_blank", "noopener,noreferrer");
							}}
						/>
						<Button
							className="package-catalog-button"
							component="a"
							href={catalogUrl}
							target="_blank"
							rel="noreferrer"
							variant="outlined"
							endIcon={<ExternalLink size={16} />}
						>
							打开官网
						</Button>
					</div>
				</div>
				<div className="package-install-card">
					<div className="package-card-title">
						<PackageOpen size={20} />
						<strong>安装插件</strong>
					</div>
					<p className="muted">输入 npm 包名或安装命令，工作台会调用内核执行安装。</p>
					<div className="package-install-row">
						<TextField
							fullWidth
							label="安装指令或包名"
							placeholder="npm:package-name"
							value={installInput}
							onChange={(event) => {
								setPendingPluginFiles(undefined);
								setInstallInput(event.target.value);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" && installInput.trim() && job.data?.status !== "running")
									setConfirmOpen(true);
							}}
						/>
					</div>
					<input
						ref={pluginFolderInput}
						className="visually-hidden"
						type="file"
						multiple
						aria-label="选择本机插件文件夹"
						onChange={(event) => {
							void choosePluginFolder(event.currentTarget.files);
							event.currentTarget.value = "";
						}}
					/>
					<div className="plugin-import-row">
						<Button
							variant="outlined"
							startIcon={preparingPlugin ? <CircularProgress size={15} /> : <FolderUp size={16} />}
							disabled={preparingPlugin || job.data?.status === "running"}
							onClick={() => pluginFolderInput.current?.click()}
						>
							导入本机插件文件夹
						</Button>
						<span className="muted">选择包含 package.json 的文件夹，确认后由工作台安装。</span>
					</div>
					<div className="package-install-actions">
						<Button
							variant="contained"
							disabled={!installInput.trim() || preparingPlugin || job.data?.status === "running"}
							onClick={() => setConfirmOpen(true)}
						>
							安装
						</Button>
					</div>
				</div>
			</div>
			<Alert severity="warning">
				第三方插件 可能执行本机扩展代码或安装依赖。安装前请检查来源；工作台会重启空闲会话，下一次运行时加载新扩展。
			</Alert>
			{defaultsUnavailable && (
				<Alert severity={defaults.error instanceof ApiError && defaults.error.status === 404 ? "info" : "warning"}>
					内置插件状态暂不可用，已显示内置插件列表；可继续安装和管理插件，状态将在服务端恢复后同步。
				</Alert>
			)}
			<div className="section-heading-row">
				<div>
					<h2>已安装插件</h2>
					<p className="muted">插件按卡片分页展示；默认插件保留功能入口，无法卸载或取消应用。</p>
				</div>
				<IconButton
					aria-label="刷新插件"
					onClick={() => {
						void packages.refetch();
						void defaults.refetch();
					}}
				>
					<RefreshCw size={18} />
				</IconButton>
			</div>
			{packages.isPending ? (
				<CircularProgress size={22} />
			) : packages.error ? (
				<Alert severity="error">{packages.error.message}</Alert>
			) : packageCards.length ? (
				<>
					<div ref={packageGrid} className="installed-plugin-grid">
						{visiblePackageCards.map((item) => {
							const plugin = pluginCatalog.find(
								(candidate) => packageIdentity(candidate.source) === packageIdentity(item.source),
							);
							const defaultStatus = item.defaultStatus;
							const installed = item.configured || defaultStatus?.status === "succeeded";
							const busy = job.data?.status === "running" || packageActionPending;
							const statusLabel = item.configured
								? item.applied
									? "已应用"
									: "未应用"
								: defaultStatus?.status === "failed"
									? "安装失败"
									: defaultStatus?.status === "succeeded"
										? "已安装"
										: defaultStatus?.status === "running"
											? "安装中"
											: defaultsUnavailable
												? "状态暂不可用"
												: "等待安装";
							const statusColor =
								statusLabel === "已应用" || statusLabel === "已安装"
									? "success"
									: statusLabel === "安装失败"
										? "error"
										: "default";
							return (
								<article className="installed-plugin-card" key={item.source}>
									<div className="installed-plugin-main">
										<div className="package-card-title">
											<PackageOpen size={19} />
											<strong>{plugin?.title ?? item.source.replace(/^npm:/u, "")}</strong>
										</div>
										<code>{item.source}</code>
										{plugin?.description && <p className="muted">{plugin.description}</p>}
										{!installed && defaultStatus?.error && (
											<Alert severity="error">{defaultStatus.error}</Alert>
										)}
									</div>
									<div className="installed-plugin-footer">
										<div className="installed-plugin-badges">
											<Chip size="small" color={statusColor} label={statusLabel} />
											{item.isDefault && <Chip size="small" label="默认插件 · 受保护" />}
										</div>
										<div className="installed-plugin-actions">
											{plugin && installed && (
												<Button size="small" onClick={() => setActivePlugin(plugin.id)}>
													打开功能
												</Button>
											)}
											{item.isDefault &&
												!installed &&
												(defaultStatus?.status === "failed" || defaultsUnavailable) && (
													<Button
														size="small"
														disabled={busy}
														onClick={() => void installDefault(item.source)}
													>
														{defaultsUnavailable ? "安装" : "重试"}
													</Button>
												)}
											<Button
												size="small"
												disabled={item.isDefault || !item.configured || busy}
												title={item.isDefault ? "默认插件不可取消应用" : undefined}
												onClick={() =>
													setPackageAction({ source: item.source, kind: "apply", applied: !item.applied })
												}
											>
												{item.applied ? "取消应用" : "应用"}
											</Button>
											<Button
												size="small"
												color="error"
												disabled={item.isDefault || !item.configured || busy}
												title={item.isDefault ? "默认插件不可卸载" : undefined}
												onClick={() => setPackageAction({ source: item.source, kind: "remove" })}
											>
												卸载
											</Button>
										</div>
									</div>
								</article>
							);
						})}
					</div>
					{packagePageCount > 1 && (
						<div className="plugin-pagination">
							<span className="muted">
								共 {packageCards.length} 个插件，每页 {packagePageSize} 个
							</span>
							<Pagination
								count={packagePageCount}
								page={packagePage}
								size="small"
								color="primary"
								onChange={(_event, value) => setPackagePage(value)}
							/>
						</div>
					)}
				</>
			) : (
				<div className="plugin-empty-card muted">还没有安装插件。可以从上方官方目录搜索并安装。</div>
			)}
			{job.data && (
				<div className="package-job">
					<div className="section-heading-row">
						<div>
							<strong>{job.data.source}</strong>
							<p className="muted">
								{job.data.status === "running"
									? job.data.action === "remove"
										? "正在卸载…"
										: "正在安装…"
									: job.data.status === "succeeded"
										? job.data.action === "remove"
											? "卸载完成"
											: "安装完成"
										: job.data.action === "remove"
											? "卸载失败"
											: "安装失败"}
							</p>
						</div>
						{job.data.status === "running" && <CircularProgress size={20} />}
					</div>
					{job.data.error && <Alert severity="error">{job.data.error}</Alert>}
					{job.data.output && <pre className="package-output">{job.data.output}</pre>}
				</div>
			)}
			<Dialog open={confirmOpen} onClose={cancelInstall} maxWidth="sm" fullWidth>
				<DialogTitle>确认安装插件</DialogTitle>
				<DialogContent>
					<p>工作台将从此来源安装插件，并把它添加到个人配置中：</p>
					<code className="package-confirm-source">
						{pendingPluginFiles ? "本机插件文件夹（已准备上传，最多 7 MB）" : installInput.trim()}
					</code>
					<p className="muted">插件以本机服务进程权限运行。只安装你信任的来源。</p>
				</DialogContent>
				<DialogActions>
					<Button onClick={cancelInstall}>取消</Button>
					<Button variant="contained" onClick={() => void install()}>
						确认安装
					</Button>
				</DialogActions>
			</Dialog>
			<Dialog
				open={!!packageAction}
				onClose={() => {
					if (!packageActionPending) setPackageAction(undefined);
				}}
				maxWidth="sm"
				fullWidth
			>
				<DialogTitle>
					{packageAction?.kind === "remove"
						? "确认卸载插件"
						: packageAction?.applied
							? "确认应用插件"
							: "确认取消应用"}
				</DialogTitle>
				<DialogContent>
					<code className="package-confirm-source">{packageAction?.source}</code>
					<p>
						{packageAction?.kind === "remove"
							? "卸载会从配置中移除此插件，并删除其安装文件。"
							: packageAction?.applied
								? "将恢复该插件之前的应用配置。"
								: "取消应用会保留插件文件，但停止加载其 Extensions、Skills、提示模板和主题。"}
					</p>
				</DialogContent>
				<DialogActions>
					<Button disabled={packageActionPending} onClick={() => setPackageAction(undefined)}>
						返回
					</Button>
					<Button
						color={packageAction?.kind === "remove" ? "error" : "primary"}
						variant="contained"
						disabled={packageActionPending}
						onClick={() => void managePackage()}
					>
						{packageActionPending
							? "处理中…"
							: packageAction?.kind === "remove"
								? "确认卸载"
								: packageAction?.applied
									? "应用"
									: "取消应用"}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
}

function StoragePanel({ onError }: { onError: (message: string) => void }) {
	const client = useQueryClient();
	const [sessionPage, setSessionPage] = useState(1);
	const [selectedSession, setSelectedSession] = useState<StorageSummary["sessions"][number]>();
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
	const removeSession = async () => {
		if (!selectedSession) return;
		setPending(true);
		try {
			await api(`/sessions/${selectedSession.id}`, undefined, "DELETE");
			await Promise.all([
				client.invalidateQueries({ queryKey: ["storage"] }),
				client.invalidateQueries({ queryKey: ["sessions"] }),
			]);
			client.removeQueries({ queryKey: ["session", selectedSession.id] });
			setSelectedSession(undefined);
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
				<CircularProgress size={22} />
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
							<p className="muted">删除会话会同时移除内核记录和工作台历史。</p>
						</div>
						<Button
							startIcon={pending ? <CircularProgress size={16} /> : <RefreshCw size={16} />}
							disabled={pending}
							onClick={() => void storage.refetch()}
						>
							刷新
						</Button>
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
											{ idle: "就绪", running: "执行中", approval: "等待确认", error: "执行失败" }[
												session.status
											]
										}
									/>
									<IconButton
										aria-label={`删除会话 ${session.title}`}
										color="error"
										disabled={pending || session.status === "running" || session.status === "approval"}
										onClick={() => setSelectedSession(session)}
									>
										<Trash2 size={16} />
									</IconButton>
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
			<Dialog open={!!selectedSession} onClose={() => setSelectedSession(undefined)} maxWidth="xs" fullWidth>
				<DialogTitle>删除会话记录</DialogTitle>
				<DialogContent>
					<p>将永久删除“{selectedSession?.title}”的聊天记录和内核会话文件。</p>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setSelectedSession(undefined)}>取消</Button>
					<Button color="error" disabled={pending} onClick={() => void removeSession()}>
						删除会话
					</Button>
				</DialogActions>
			</Dialog>
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
	workspaces,
}: {
	kind: "skills" | "settings";
	section?: SettingsSection;
	sessions: SessionSummary[];
	workspaces: Workspace[];
}) {
	const [selected, setSelected] = useState("");
	const [resourceTab, setResourceTab] = useState<"skills" | "plugins">("skills");
	const id = selected || sessions[0]?.id;
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
				<h1>{kind === "skills" ? "技能与插件" : "设置"}</h1>
			</div>
			{kind === "skills" && <p className="muted">查看会话技能、管理插件，也可以导入自己的资源。</p>}
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
					{sessions.map((session) => (
						<MenuItem key={session.id} value={session.id}>
							{session.title}
						</MenuItem>
					))}
				</Select>
			)}
			{kind === "skills" && !id && <Alert severity="info">请先创建会话，以查看实际加载的资源。</Alert>}
			{kind === "settings" && section === "providers" && !!sessions.length && (
				<div className="settings-session-select">
					<span className="muted">当前会话</span>
					<Select
						size="small"
						value={id ?? ""}
						onChange={(event) => setSelected(event.target.value)}
						inputProps={{ "aria-label": "选择查看当前模型的会话" }}
					>
						{sessions.map((session) => (
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
					<Tabs
						className="resource-tabs"
						value={resourceTab}
						onChange={(_event, value: "skills" | "plugins") => setResourceTab(value)}
						aria-label="技能与插件"
					>
						<Tab value="skills" label="技能" />
						<Tab value="plugins" label="插件" />
					</Tabs>
					<SpringPages
						className="resource-page-switch"
						pageKey={resourceTab}
						pageIndex={resourceTab === "skills" ? 0 : 1}
						axis="horizontal"
					>
						{resourceTab === "skills" ? (
							<>
								<SkillLibraryPanel
									skills={resources.data?.skills ?? []}
									loading={resources.isPending && !!id}
								/>
								{resources.data?.diagnostics.map((message, index) => (
									<Alert key={`${index}:${message}`} severity="warning">
										{message}
									</Alert>
								))}
							</>
						) : (
							<>
								<PackageManagerPanel onError={setError} sessions={sessions} workspaces={workspaces} />
								<LoadedExtensionsPanel
									extensions={resources.data?.extensions ?? []}
									loading={resources.isPending && !!id}
								/>
								{resources.data?.diagnostics.map((message, index) => (
									<Alert key={`${index}:${message}`} severity="warning">
										{message}
									</Alert>
								))}
							</>
						)}
					</SpringPages>
				</section>
			)}
			{kind === "settings" && (
				<SpringPages
					className="settings-page-switch"
					pageKey={section ?? "providers"}
					pageIndex={["providers", "plugins", "storage", "system"].indexOf(section ?? "providers")}
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
										<CircularProgress size={22} />
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
					{section === "plugins" && (
						<PackageManagerPanel onError={setError} sessions={sessions} workspaces={workspaces} />
					)}
					{section === "storage" && <StoragePanel onError={setError} />}
					{section === "system" && (
						<>
							<PersonalizationPanel />
							<h2>Pi SDK 与本地设置</h2>
							<div className="settings-surface">
								<div className="system-setting-row">
									<span>Pi SDK 版本</span>
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
								<p>Pi SDK 与工作台在同一服务进程中运行，升级项目中的 Pi 源码后重新启动即可生效。</p>
								<p>单用户，本机服务仅监听 127.0.0.1。获准命令和可信扩展使用主机权限，工作台未提供安全沙箱。</p>
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
							<CircularProgress size={20} /> 等待认证流程…
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
