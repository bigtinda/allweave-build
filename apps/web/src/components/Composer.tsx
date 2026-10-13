import { Button, Chip, IconButton, Menu, MenuItem, Popover, Select, Tooltip } from "@mui/material";
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
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { AccessMode, ModelOption, SessionDetail, ThinkingLevel } from "../../../shared/src/protocol.ts";
import { api } from "../services/api.ts";
import { DEFAULT_COMPOSER_KEYBINDINGS } from "../stores/preferences.ts";

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

export function Composer({
	session,
	models,
	references,
	removeReference,
	onError,
	connected,
	onSessionChange,
}: {
	session: SessionDetail;
	models: ModelOption[];
	references: string[];
	removeReference: (path: string) => void;
	onError: (message: string) => void;
	connected: boolean;
	onSessionChange: (session: SessionDetail) => void;
}) {
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [pending, setPending] = useState(false);
	const [accessMenu, setAccessMenu] = useState<HTMLElement | null>(null);
	const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);
	const [modelPage, setModelPage] = useState(0);
	const fileInput = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const busy = session.status === "running" || session.status === "approval";
	const available = models.filter((model) => model.available);
	const modelPageCount = Math.max(1, Math.ceil(available.length / modelsPerPage));
	const visibleModelPage = Math.min(modelPage, modelPageCount - 1);
	const visibleModels = available.slice(visibleModelPage * modelsPerPage, (visibleModelPage + 1) * modelsPerPage);
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
		if (pending || busy || !text.trim() || !connected) return;
		setPending(true);
		try {
			const prompt =
				text +
				attachments
					.map(
						(file) =>
							`\n\nAttached text file ${JSON.stringify(file.name)}:\n<attachment>\n${file.content}\n</attachment>`,
					)
					.join("");
			await api(`/sessions/${session.id}/messages`, { text: prompt, references });
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
		if (!model) return;
		try {
			await api(`/sessions/${session.id}/model`, { provider: model.provider, modelId: model.id }, "PUT");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		}
	};
	const openModelPicker = (anchor: HTMLElement) => {
		const selectedIndex = available.findIndex(
			(model) => model.provider === session.model?.provider && model.id === session.model?.id,
		);
		setModelPage(Math.floor(Math.max(0, selectedIndex) / modelsPerPage));
		setModelAnchor(anchor);
	};
	const setAccessMode = async (accessMode: AccessMode) => {
		setAccessMenu(null);
		try {
			const updated = await api<SessionDetail>(`/sessions/${session.id}/access-mode`, { accessMode }, "PUT");
			onSessionChange(updated);
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		}
	};
	const setThinkingLevel = async (thinkingLevel: ThinkingLevel) => {
		if (!selectedModel) return;
		try {
			const updated = await api<SessionDetail>(
				`/sessions/${session.id}/model`,
				{ provider: selectedModel.provider, modelId: selectedModel.id, thinkingLevel },
				"PUT",
			);
			onSessionChange(updated);
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
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
					ref={textareaRef}
					aria-label="向 Kego 发送任务"
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
					<Tooltip title="权限与计划模式">
						<Button
							className="access-mode-button"
							variant="text"
							endIcon={<ChevronDown size={14} strokeWidth={2} />}
							aria-label={`当前权限：${activeAccessMode.label}`}
							aria-haspopup="menu"
							aria-expanded={!!accessMenu}
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
						<div className="model-picker">
							<div className="model-picker-heading">
								<strong>选择可用模型</strong>
								<span>{available.length} 个模型</span>
							</div>
							<div className="model-picker-options" role="listbox" aria-label="可用模型">
								{visibleModels.map((model) => {
									const selected = model.provider === selectedModel?.provider && model.id === selectedModel.id;
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
					{busy ? (
						<Button
							className="send-button"
							aria-label="停止 Agent"
							variant="contained"
							startIcon={<Square size={15} />}
							onClick={() => {
								void api(`/sessions/${session.id}/abort`, {}).catch((error) => onError(String(error)));
							}}
						>
							停止
						</Button>
					) : (
						<IconButton
							aria-label="发送任务"
							className="send-button"
							disabled={!text.trim() || pending || !connected || !selectedModel}
							onClick={() => void submit()}
						>
							<ArrowUp size={22} />
						</IconButton>
					)}
				</div>
			</div>
			<span className="composer-note">Enter 发送 · Shift + Enter 换行 · 命令与文件修改需确认</span>
		</div>
	);
}
