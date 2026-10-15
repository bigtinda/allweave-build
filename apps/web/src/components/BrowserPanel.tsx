import { Alert, Button, IconButton, LinearProgress, MenuItem, Select, Tooltip } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { BrowserCommand, BrowserSnapshot } from "../../../shared/src/browser.ts";
import { ApiError, api } from "../services/api.ts";
import {
	ArrowUp,
	ChevronLeft,
	ChevronRight,
	Globe,
	Maximize2,
	Minimize2,
	RefreshCw,
	Sparkles,
	X,
} from "./WorkbenchIcons.tsx";

function browserErrorMessage(error: unknown): string {
	if (error instanceof ApiError && error.status === 404) return "内置浏览器接口尚未加载，请重启工作台服务后重试。";
	return error instanceof Error ? error.message : String(error);
}

export function BrowserPanel({
	sessionId,
	onRequest,
	running,
}: {
	sessionId: string;
	onRequest: (text: string) => void;
	running: boolean;
}) {
	const client = useQueryClient();
	const [addressDraft, setAddressDraft] = useState<string | null>(null);
	const [text, setText] = useState("");
	const [task, setTask] = useState("");
	const [key, setKey] = useState("Enter");
	const [fit, setFit] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const queryKey = ["browser", sessionId];
	const browser = useQuery({
		queryKey,
		queryFn: () => api<BrowserSnapshot | null>(`/sessions/${sessionId}/browser`),
		refetchInterval: pending ? false : 2000,
		retry: false,
	});
	const snapshot = browser.data;
	const url = addressDraft ?? (snapshot?.url === "about:blank" ? "" : snapshot?.url) ?? "";
	const disabled = pending || running;
	const run = async (command: BrowserCommand) => {
		if (disabled) return false;
		setPending(true);
		setError("");
		try {
			await client.cancelQueries({ queryKey });
			const result = await api<BrowserSnapshot | null>(`/sessions/${sessionId}/browser`, command);
			client.setQueryData(queryKey, result);
			if (result) setAddressDraft(null);
			return true;
		} catch (error) {
			setError(browserErrorMessage(error));
			return false;
		} finally {
			setPending(false);
		}
	};
	const request = (instruction: string) => {
		onRequest(
			`请使用内置 browser 工具${snapshot ? `操作当前页面 ${snapshot.url}` : "打开并操作网页"}：${instruction}`,
		);
		setTask("");
	};
	return (
		<section className="browser-panel" aria-label="内置浏览器">
			<form
				className="browser-addressbar"
				onSubmit={(event) => {
					event.preventDefault();
					const address = url.trim();
					if (address)
						void run({
							action: "navigate",
							url:
								/^[a-z][a-z\d+.-]*:/iu.test(address) && !/^[\w.-]+:\d+(?:\/|$)/u.test(address)
									? address
									: `http${/^(?:localhost|127\.)/u.test(address) ? "" : "s"}://${address}`,
						});
				}}
			>
				<Tooltip title="后退">
					<span>
						<IconButton
							aria-label="浏览器后退"
							disabled={disabled || !snapshot}
							onClick={() => void run({ action: "back" })}
						>
							<ChevronLeft size={16} />
						</IconButton>
					</span>
				</Tooltip>
				<Tooltip title="前进">
					<span>
						<IconButton
							aria-label="浏览器前进"
							disabled={disabled || !snapshot}
							onClick={() => void run({ action: "forward" })}
						>
							<ChevronRight size={16} />
						</IconButton>
					</span>
				</Tooltip>
				<Tooltip title="刷新页面">
					<span>
						<IconButton
							aria-label="刷新浏览器页面"
							disabled={disabled || !snapshot}
							onClick={() => void run({ action: "reload" })}
						>
							<RefreshCw size={15} />
						</IconButton>
					</span>
				</Tooltip>
				<div className="browser-address-field">
					<Globe size={14} />
					<input
						aria-label="浏览器网址"
						placeholder="输入网址或 localhost:端口"
						value={url}
						onChange={(event) => setAddressDraft(event.target.value)}
						disabled={disabled}
						spellCheck={false}
					/>
					<Tooltip title="打开网址">
						<span>
							<IconButton type="submit" aria-label="打开网址" disabled={disabled || !url.trim()}>
								<ChevronRight size={15} />
							</IconButton>
						</span>
					</Tooltip>
				</div>
			</form>
			<div className="browser-pagebar">
				<span className="browser-page-title">
					<Globe size={13} />
					{snapshot?.title || "新页面"}
				</span>
				<span className={`browser-session-state${running || pending ? " is-running" : ""}`}>
					<i />
					{running ? "Agent 正在操作" : pending ? "操作中" : "与 Agent 共享"}
				</span>
				<Tooltip title={fit ? "按实际尺寸查看" : "适应面板宽度"}>
					<IconButton aria-label={fit ? "按实际尺寸查看" : "适应面板宽度"} onClick={() => setFit(!fit)}>
						{fit ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
					</IconButton>
				</Tooltip>
				<Tooltip title="关闭页面并清除浏览器状态">
					<span>
						<IconButton
							aria-label="关闭浏览器页面"
							disabled={disabled || !snapshot}
							onClick={() => void run({ action: "close" })}
						>
							<X size={14} />
						</IconButton>
					</span>
				</Tooltip>
			</div>
			<div className="browser-progress">
				{(pending || running) && <LinearProgress aria-label="浏览器操作进行中" />}
			</div>
			{(error || browser.error) && (
				<Alert severity="error" className="browser-error" onClose={() => setError("")}>
					{error || browserErrorMessage(browser.error)}
				</Alert>
			)}
			<div className={`browser-viewport${fit ? " is-fit" : " is-actual"}`}>
				{snapshot ? (
					<button
						type="button"
						className="browser-screen"
						disabled={disabled}
						aria-label="点击浏览器页面"
						onClick={(event) => {
							const rect = event.currentTarget.getBoundingClientRect();
							const x = event.detail ? (event.clientX - rect.left) / rect.width : 0.5;
							const y = event.detail ? (event.clientY - rect.top) / rect.height : 0.5;
							void run({
								action: "click",
								x: Math.min(1279, Math.max(0, x * snapshot.width)),
								y: Math.min(799, Math.max(0, y * snapshot.height)),
							});
						}}
					>
						<img
							src={`data:image/jpeg;base64,${snapshot.image}`}
							alt={snapshot.title || "浏览器页面"}
							draggable={false}
						/>
					</button>
				) : (
					<div className="browser-empty">
						<span className="browser-empty-icon">
							<Globe size={30} strokeWidth={1.5} />
						</span>
						<h2>在这里打开网页</h2>
						<p>
							预览本地项目，浏览网站，
							<br />
							或交给 Agent 操作当前页面。
						</p>
						<span className="browser-empty-hint">在上方输入网址开始</span>
					</div>
				)}
			</div>
			{snapshot && (
				<details className="browser-manual">
					<summary>
						手动操作与网页内容<span>点击画面定位</span>
					</summary>
					<form
						className="browser-type-form"
						onSubmit={(event) => {
							event.preventDefault();
							if (text)
								void run({ action: "type", text }).then((sent) => {
									if (sent) setText("");
								});
						}}
					>
						<input
							aria-label="输入到页面焦点"
							placeholder="向选中的页面元素输入文字"
							value={text}
							onChange={(event) => setText(event.target.value)}
							disabled={disabled}
						/>
						<Button type="submit" disabled={disabled || !text}>
							输入
						</Button>
					</form>
					<div className="browser-manual-actions">
						<Select
							size="small"
							value={key}
							onChange={(event) => setKey(event.target.value)}
							inputProps={{ "aria-label": "浏览器按键" }}
							disabled={disabled}
						>
							{["Enter", "Tab", "Shift+Tab", "Backspace", "Escape", "ControlOrMeta+A"].map((value) => (
								<MenuItem key={value} value={value}>
									{value}
								</MenuItem>
							))}
						</Select>
						<Button disabled={disabled} onClick={() => void run({ action: "press", key })}>
							按键
						</Button>
						<span className="grow" />
						<Button disabled={disabled} onClick={() => void run({ action: "scroll", deltaY: -600 })}>
							上滚
						</Button>
						<Button disabled={disabled} onClick={() => void run({ action: "scroll", deltaY: 600 })}>
							下滚
						</Button>
					</div>
					<pre className="browser-page-text">{snapshot.text}</pre>
				</details>
			)}
			<div className="browser-agent-actions">
				<div className="browser-agent-heading">
					<Sparkles size={14} />
					<span>交给 Agent</span>
					<small>任务填入聊天后发送</small>
				</div>
				<div className="browser-quick-actions">
					<Button disabled={!snapshot} onClick={() => request("检查页面布局与可用性，并报告发现的问题。")}>
						检查页面
					</Button>
					<Button disabled={!snapshot} onClick={() => request("检查页面交互，验证主要按钮、表单与导航是否正常。")}>
						验证交互
					</Button>
				</div>
				<form
					className="browser-agent-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (task.trim()) request(task.trim());
					}}
				>
					<input
						aria-label="浏览器任务"
						placeholder="让 Agent 在浏览器中做什么？"
						value={task}
						onChange={(event) => setTask(event.target.value)}
					/>
					<Tooltip title="填入聊天输入框">
						<span>
							<IconButton type="submit" aria-label="填入浏览器任务" disabled={!task.trim()}>
								<ArrowUp size={16} />
							</IconButton>
						</span>
					</Tooltip>
				</form>
			</div>
		</section>
	);
}
