import { Button, Chip, IconButton, Menu, MenuItem, Popover, Select, TextField, Tooltip } from "@mui/material";
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AccessMode, ModelOption, SessionDetail, ThinkingLevel } from "../../../shared/src/protocol.ts";
import { api } from "../services/api.ts";
import { DEFAULT_COMPOSER_KEYBINDINGS } from "../stores/preferences.ts";
import { UsageSummary } from "./UsageSummary.tsx";
import {
	ArrowUp,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Hand,
	Lightbulb,
	Paperclip,
	Shield,
	Square,
	Zap,
} from "./WorkbenchIcons.tsx";

interface Attachment {
	name: string;
	content: string;
}

const accessModes: Array<{ id: AccessMode; label: string; description: string; icon: typeof Shield }> = [
	{ id: "plan", label: "计划模式", description: "编辑前先出计划。", icon: Lightbulb },
	{ id: "ask", label: "变更前确认", description: "改文件或运行工具前先问我。", icon: Hand },
	{ id: "auto", label: "自动编辑", description: "自动编辑工作区文件。", icon: Zap },
	{ id: "full", label: "完全访问", description: "减少确认次数。", icon: Shield },
];

const thinkingLevels: Array<{ id: ThinkingLevel; label: string }> = [
	{ id: "off", label: "关闭" },
	{ id: "minimal", label: "最低" },
	{ id: "low", label: "低" },
	{ id: "medium", label: "中" },
	{ id: "high", label: "高" },
	{ id: "xhigh", label: "很高" },
	{ id: "max", label: "最大" },
];
const modelsPerPage = 10;
const longInputAttachmentThreshold = 8_000;
const maxTextAttachmentCharacters = 100_000;

export function Composer({
	session,
	models,
	references,
	removeReference,
	onError,
	connected,
	onSessionChange,
	text,
	onTextChange: setText,
	locked,
}: {
	session: SessionDetail;
	models: ModelOption[];
	references: string[];
	removeReference: (path: string) => void;
	onError: (message: string) => void;
	connected: boolean;
	onSessionChange: (session: SessionDetail) => void;
	text: string;
	onTextChange: (text: string) => void;
	locked: boolean;
}) {
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [working, setPending] = useState(false);
	const pending = working || locked;
	const [accessMenu, setAccessMenu] = useState<HTMLElement | null>(null);
	const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);
	const [modelPage, setModelPage] = useState(0);
	const [modelSearch, setModelSearch] = useState("");
	const [modelProvider, setModelProvider] = useState("");
	const [feedback, setFeedback] = useState("");
	const fileInput = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const busy = session.status === "running" || session.status === "approval";
	const available = models.filter((model) => model.available);
	const filteredModels = available.filter((model) =>
		`${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(modelSearch.trim().toLowerCase()),
	);
	const providers = [...new Set(filteredModels.map((model) => model.provider))];
	const activeProvider = providers.includes(modelProvider) ? modelProvider : (providers[0] ?? "");
	const providerModels = filteredModels.filter((model) => model.provider === activeProvider);
	const modelPageCount = Math.max(1, Math.ceil(providerModels.length / modelsPerPage));
	const visibleModelPage = Math.min(modelPage, modelPageCount - 1);
	const visibleModels = providerModels.slice(visibleModelPage * modelsPerPage, (visibleModelPage + 1) * modelsPerPage);
	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		if (textarea.value !== text) textarea.value = text;
		const maximumHeight = 240;
		const resizeTextarea = () => {
			textarea.style.height = "auto";
			const contentHeight = textarea.scrollHeight;
			textarea.style.height = `${Math.min(contentHeight, maximumHeight)}px`;
			textarea.style.overflowY = contentHeight > maximumHeight ? "auto" : "hidden";
		};
		resizeTextarea();
		window.addEventListener("resize", resizeTextarea);
		return () => window.removeEventListener("resize", resizeTextarea);
	}, [text]);
	const selectedModel = available.find(
		(model) => model.provider === session.model?.provider && model.id === session.model?.id,
	);
	const submit = async () => {
		if (pending || !text.trim() || !connected || !selectedModel) return;
		if (text.length > maxTextAttachmentCharacters) {
			onError("单个文本附件不能超过 100,000 个字符，请拆分后发送。");
			return;
		}
		setPending(true);
		onError("");
		setFeedback("");
		try {
			const attachLongInput = text.length > longInputAttachmentThreshold;
			const messageText = attachLongInput ? "请阅读附件“用户输入.txt”，并根据其中内容完成任务。" : text;
			const textAttachments = attachLongInput
				? [{ name: "用户输入.txt", content: text }, ...attachments]
				: attachments;
			await api(`/sessions/${session.id}/messages`, {
				text: messageText,
				attachments: textAttachments,
				references,
				interrupt: busy,
			});
			setText("");
			setAttachments([]);
			references.forEach(removeReference);
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	};
	const selectModel = async (value: string) => {
		const model = available.find((model) => `${model.provider}/${model.id}` === value);
		if (!model || pending || busy) return;
		setPending(true);
		onError("");
		setFeedback("");
		try {
			const updated = await api<SessionDetail>(
				`/sessions/${session.id}/model`,
				{ provider: model.provider, modelId: model.id },
				"PUT",
			);
			onSessionChange(updated);
			setFeedback(`已切换模型：${model.name}`);
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	};
	const openModelPicker = (anchor: HTMLElement) => {
		setModelSearch("");
		const provider = session.model?.provider ?? available[0]?.provider ?? "";
		setModelProvider(provider);
		const selectedIndex = available
			.filter((model) => model.provider === provider)
			.findIndex((model) => model.provider === session.model?.provider && model.id === session.model?.id);
		setModelPage(Math.floor(Math.max(0, selectedIndex) / modelsPerPage));
		setModelAnchor(anchor);
	};
	const setAccessMode = async (accessMode: AccessMode) => {
		if (pending || busy) return;
		setAccessMenu(null);
		setPending(true);
		onError("");
		setFeedback("");
		try {
			const updated = await api<SessionDetail>(`/sessions/${session.id}/access-mode`, { accessMode }, "PUT");
			onSessionChange(updated);
			setFeedback(`权限已保存：${accessModes.find((mode) => mode.id === accessMode)?.label}`);
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	};
	const setThinkingLevel = async (thinkingLevel: ThinkingLevel) => {
		if (!selectedModel || pending || busy) return;
		setPending(true);
		onError("");
		setFeedback("");
		try {
			const updated = await api<SessionDetail>(
				`/sessions/${session.id}/model`,
				{ provider: selectedModel.provider, modelId: selectedModel.id, thinkingLevel },
				"PUT",
			);
			onSessionChange(updated);
			setFeedback("思考强度已保存。");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	};
	const activeAccessMode = accessModes.find((mode) => mode.id === session.accessMode) ?? accessModes[1];
	return (
		<div className="composer-wrap">
			<div className="composer">
				{!!(references.length + attachments.length) && (
					<div className="attachments">
						{references.map((path) => (
							<Chip key={path} size="small" label={`@ ${path}`} onDelete={() => removeReference(path)} />
						))}
						{attachments.map((file, index) => (
							<Chip
								key={`${file.name}:${index}`}
								size="small"
								label={file.name}
								onDelete={() => setAttachments((files) => files.filter((_, i) => i !== index))}
							/>
						))}
					</div>
				)}
				<textarea
					disabled={pending}
					ref={textareaRef}
					aria-label="向构序发送任务"
					placeholder="描述你的任务，或引用工作区文件…"
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key === DEFAULT_COMPOSER_KEYBINDINGS.send &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							void submit();
						}
					}}
					rows={1}
				/>
				<div className="composer-actions">
					<Tooltip title="添加文本附件（每个不超过 32 KB）">
						<span className="attachment-control">
							<IconButton
								className="attachment-action"
								aria-label="添加文本附件"
								disabled={busy || pending}
								onClick={() => fileInput.current?.click()}
							>
								<Paperclip size={19} />
							</IconButton>
						</span>
					</Tooltip>
					<input
						hidden
						ref={fileInput}
						type="file"
						multiple
						accept=".txt,.md,.ts,.tsx,.js,.jsx,.json,.csv,.py,.css,.html,.yaml,.yml,.log"
						onChange={(event) => {
							const files = Array.from(event.target.files ?? []);
							event.target.value = "";
							void (async () => {
								try {
									if (attachments.length + files.length > 5) throw new Error("最多添加 5 个附件");
									const items = await Promise.all(
										files.map(async (file) => {
											if (file.size > 32_768) throw new Error(`${file.name} 超过 32 KB`);
											const content = await file.text();
											if (content.includes("\0")) throw new Error("仅支持文本附件");
											return { name: file.name, content };
										}),
									);
									setAttachments((previous) => [...previous, ...items]);
								} catch (error) {
									onError(error instanceof Error ? error.message : String(error));
								}
							})();
						}}
					/>
					{session.purpose === "plugin-development" ? (
						<span className="muted">默认插件开发工作区 · 文件修改与安装需确认</span>
					) : (
						<>
							<Tooltip title="权限与计划模式">
								<Button
									className="access-mode-button"
									variant="text"
									endIcon={<ChevronDown size={14} strokeWidth={2} />}
									aria-label={`当前权限：${activeAccessMode.label}`}
									aria-haspopup="menu"
									aria-expanded={!!accessMenu}
									disabled={busy || pending}
									onClick={(event) => setAccessMenu(event.currentTarget)}
								>
									{activeAccessMode.label}
								</Button>
							</Tooltip>
							<Menu
								className="access-mode-menu"
								anchorEl={accessMenu}
								open={!!accessMenu}
								onClose={() => setAccessMenu(null)}
								anchorOrigin={{ vertical: "top", horizontal: "left" }}
								transformOrigin={{ vertical: "bottom", horizontal: "left" }}
							>
								{accessModes.map((mode) => {
									const ModeIcon = mode.icon;
									return (
										<MenuItem
											key={mode.id}
											selected={session.accessMode === mode.id}
											onClick={() => void setAccessMode(mode.id)}
										>
											<ModeIcon size={17} />
											<span className="access-mode-copy">
												<strong>{mode.label}</strong>
												<small>{mode.description}</small>
											</span>
											{session.accessMode === mode.id && <Check size={16} />}
										</MenuItem>
									);
								})}
							</Menu>
						</>
					)}
					<span className="grow composer-actions-spacer" />
					<Button
						className="model-select"
						variant="text"
						disabled={busy || pending || !available.length}
						aria-label="选择模型"
						aria-haspopup="listbox"
						aria-expanded={!!modelAnchor}
						endIcon={<ChevronDown size={14} strokeWidth={2} />}
						onClick={(event) => openModelPicker(event.currentTarget)}
					>
						<span className="model-select-label">
							{selectedModel ? `${selectedModel.name} · ${selectedModel.provider}` : "选择可用模型"}
						</span>
					</Button>
					<Popover
						open={!!modelAnchor}
						anchorEl={modelAnchor}
						onClose={() => setModelAnchor(null)}
						anchorOrigin={{ vertical: "top", horizontal: "left" }}
						transformOrigin={{ vertical: "bottom", horizontal: "left" }}
						slotProps={{ paper: { className: "model-picker-popover-paper" } }}
					>
						<div className="model-picker grouped-model-picker">
							<div className="model-picker-heading">
								<strong>选择可用模型</strong>
								<span>
									{providers.length} 个供应商 · {filteredModels.length} 个模型
								</span>
							</div>
							<TextField
								autoFocus
								fullWidth
								placeholder="搜索模型或供应商"
								value={modelSearch}
								inputProps={{ "aria-label": "搜索模型或供应商" }}
								onChange={(event) => {
									setModelSearch(event.target.value);
									setModelPage(0);
								}}
							/>
							{!filteredModels.length && (
								<p className="model-search-empty" aria-live="polite">
									没有匹配的模型，请尝试其他名称。
								</p>
							)}
							<div className="model-picker-columns">
								<nav className="model-provider-list" aria-label="模型供应商">
									<span className="model-level-label">1 · 供应商</span>
									{providers.map((provider) => (
										<button
											key={provider}
											type="button"
											aria-pressed={provider === activeProvider}
											aria-controls={`model-list-${session.id}`}
											onClick={() => {
												setModelProvider(provider);
												setModelPage(0);
											}}
										>
											<span>{provider}</span>
											<small>{filteredModels.filter((model) => model.provider === provider).length}</small>
										</button>
									))}
								</nav>
								<section className="model-provider-models" aria-label="供应商模型">
									<div className="model-level-label">2 · {activeProvider || "模型"}</div>
									<div
										id={`model-list-${session.id}`}
										className="model-picker-options"
										role="listbox"
										aria-label="可用模型"
									>
										{visibleModels.map((model) => {
											const selected =
												model.provider === selectedModel?.provider && model.id === selectedModel.id;
											return (
												<button
													key={`${model.provider}/${model.id}`}
													type="button"
													className="model-picker-option"
													role="option"
													aria-selected={selected}
													title={`${model.name} · ${model.provider}`}
													onClick={() => {
														setModelAnchor(null);
														void selectModel(`${model.provider}/${model.id}`);
													}}
												>
													<span>{model.name}</span>
													<small>{model.provider}</small>
													{selected && <Check size={16} />}
												</button>
											);
										})}
									</div>
									<div className="model-picker-pagination">
										<IconButton
											aria-label="上一页模型"
											disabled={visibleModelPage === 0}
											onClick={() => setModelPage(visibleModelPage - 1)}
										>
											<ChevronLeft size={18} />
										</IconButton>
										<span>
											第 {visibleModelPage + 1} / {modelPageCount} 页
										</span>
										<IconButton
											aria-label="下一页模型"
											disabled={visibleModelPage >= modelPageCount - 1}
											onClick={() => setModelPage(visibleModelPage + 1)}
										>
											<ChevronRight size={18} />
										</IconButton>
									</div>
								</section>
							</div>
						</div>
					</Popover>
					<Tooltip title="设置模型思考强度">
						<span className="thinking-control">
							<Select
								className="thinking-select"
								variant="standard"
								size="small"
								IconComponent={ChevronDown}
								value={session.thinkingLevel}
								disabled={!selectedModel?.reasoning || busy || pending}
								renderValue={(value) =>
									`思考 · ${thinkingLevels.find((level) => level.id === value)?.label ?? value}`
								}
								inputProps={{ "aria-label": "思考强度" }}
								MenuProps={{
									anchorOrigin: { vertical: "top", horizontal: "left" },
									transformOrigin: { vertical: "bottom", horizontal: "left" },
									slotProps: {
										paper: { className: "thinking-menu-paper", sx: { maxHeight: "calc(100dvh - 24px)" } },
									},
								}}
								onChange={(event) => void setThinkingLevel(event.target.value as ThinkingLevel)}
							>
								{thinkingLevels.map((level) => (
									<MenuItem key={level.id} value={level.id}>
										{level.label}
									</MenuItem>
								))}
							</Select>
						</span>
					</Tooltip>
					{busy && (
						<Button
							className="send-button"
							aria-label="停止 Agent"
							disabled={pending || !connected}
							variant="contained"
							onClick={() => {
								void api(`/sessions/${session.id}/abort`, {}).catch((error) => onError(String(error)));
							}}
						>
							<Square size={15} />
						</Button>
					)}
					{(!busy || text.trim()) && (
						<Button
							aria-label={busy ? "打断并发送" : "发送任务"}
							className={`send-button${busy ? " interrupt-button" : ""}`}
							variant="contained"
							disabled={!text.trim() || pending || !connected || !selectedModel}
							onClick={() => void submit()}
						>
							{pending ? "…" : busy ? "打断并发送" : <ArrowUp size={17} />}
						</Button>
					)}
				</div>
			</div>
			<div className="composer-footer">
				<div className="composer-note" aria-live="polite">
					{!connected ? (
						"连接恢复后可发送，草稿已保留。"
					) : !selectedModel ? (
						<Link to="/settings/providers">配置供应商并选择可用模型</Link>
					) : (
						feedback ||
						(session.status === "approval" ? (
							"等待工具确认，请检查操作后批准或拒绝。"
						) : pending ? (
							"正在处理，请稍候…"
						) : (
							<>
								<kbd>Enter</kbd> 发送 · <kbd>Shift + Enter</kbd> 换行 · 超过 8,000 字符自动作为文本附件
							</>
						))
					)}
				</div>
				<UsageSummary tokens={session.tokens} />
			</div>
		</div>
	);
}
