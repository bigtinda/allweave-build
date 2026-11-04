import type {
	RunUsage,
	SessionDetail,
	SessionSummary,
	SessionUsageRecord,
	UsageSummary,
	Workspace,
} from "@allweave/protocol";
import {
	Alert,
	Button,
	Chip,
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
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatDuration } from "../../../shared/src/format.ts";
import { BrowserPanel } from "../components/BrowserPanel.tsx";
import { LoadingState } from "../components/LoadingState.tsx";
import { ChevronDown, Clock, Globe, Restore, Trash2 } from "../components/WorkbenchIcons.tsx";
import { api } from "../services/api.ts";

function SettingsSectionHeading({ title, description, badge }: { title: string; description: string; badge?: string }) {
	return (
		<header className="management-heading">
			<div>
				<div className="management-heading-title">
					<h2>{title}</h2>
					{badge && <Chip size="small" label={badge} />}
				</div>
				<p className="muted">{description}</p>
			</div>
		</header>
	);
}

function SessionSelector({
	sessions,
	value,
	onChange,
}: {
	sessions: SessionSummary[];
	value: string;
	onChange: (id: string) => void;
}) {
	return (
		<FormControl size="small" className="management-session-select">
			<InputLabel id="management-session-label">会话</InputLabel>
			<Select
				labelId="management-session-label"
				label="会话"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			>
				{sessions.map((session) => (
					<MenuItem key={session.id} value={session.id}>
						{session.title}
					</MenuItem>
				))}
			</Select>
		</FormControl>
	);
}

export function BrowserManagementPanel({
	sessions,
	sessionsLoading,
	onRequest,
}: {
	sessions: SessionSummary[];
	sessionsLoading: boolean;
	onRequest: (sessionId: string, text: string) => void;
}) {
	const [selectedId, setSelectedId] = useState("");
	const [browserExpanded, setBrowserExpanded] = useState(false);
	const activeSessions = sessions.filter((session) => !session.archivedAt && session.purpose !== "plugin-development");
	const selected = activeSessions.find((session) => session.id === selectedId) ?? activeSessions[0];
	return (
		<section className="management-panel browser-management" aria-label="浏览器管理">
			<SettingsSectionHeading title="浏览器" description="管理会话共享的内置浏览器，并查看当前页面的使用范围。" />
			<div className="browser-feature-card">
				<div className="management-panel-icon">
					<Globe size={19} />
				</div>
				<div className="management-panel-copy">
					<strong>内置浏览器</strong>
					<span className="muted">每个会话使用独立的临时页面，用户和 Agent 可以实时协作。</span>
				</div>
				<Chip size="small" label="按会话隔离" />
			</div>
			<section className="browser-management-section" aria-label="常规浏览器设置">
				<h3>常规</h3>
				<div className="browser-settings-card">
					<div className="browser-setting-row">
						<div>
							<strong>当前会话</strong>
							<p className="muted">选择要查看和管理的会话浏览器。</p>
						</div>
						{selected ? (
							<SessionSelector sessions={activeSessions} value={selected.id} onChange={setSelectedId} />
						) : (
							<Chip size="small" label={sessionsLoading ? "正在读取…" : "暂无活动会话"} />
						)}
					</div>
					<div className="browser-setting-row">
						<div>
							<strong>页面操作</strong>
							<p className="muted">可打开网页、切换标签、检查页面并将任务交给 Agent。</p>
						</div>
						<Chip
							size="small"
							color={
								selected?.status === "running"
									? "primary"
									: selected?.status === "approval"
										? "warning"
										: selected?.status === "error"
											? "error"
											: "default"
							}
							label={
								selected?.status === "running"
									? "Agent 正在操作"
									: selected?.status === "approval"
										? "等待确认"
										: selected?.status === "error"
											? "上次失败"
											: "就绪"
							}
						/>
					</div>
					<div className="browser-setting-row">
						<div>
							<strong>浏览器数据</strong>
							<p className="muted">页面状态只保存在当前会话；关闭页面会清除该会话的浏览器状态。</p>
						</div>
						<Button size="small" disabled={!selected} onClick={() => setBrowserExpanded(true)}>
							管理页面
						</Button>
					</div>
				</div>
			</section>
			{sessionsLoading ? (
				<LoadingState label="正在读取会话浏览器…" />
			) : !activeSessions.length ? (
				<div className="management-empty">
					<strong>还没有可管理的浏览器会话</strong>
					<p>打开一个项目并创建会话后，浏览器页面会显示在这里。</p>
					<Button component={Link} to="/">
						返回工作台
					</Button>
				</div>
			) : (
				<details
					className="browser-live-session"
					open={browserExpanded}
					onToggle={(event) => setBrowserExpanded(event.currentTarget.open)}
				>
					<summary>
						<span>
							<strong>会话实时页面</strong>
							<small className="muted">按需展开浏览器工具与页面预览</small>
						</span>
						<ChevronDown size={16} />
					</summary>
					{browserExpanded && selected && (
						<BrowserPanel
							key={selected.id}
							sessionId={selected.id}
							onRequest={(text) => onRequest(selected.id, text)}
							running={selected.status === "running" || selected.status === "approval"}
						/>
					)}
				</details>
			)}
			<section className="browser-management-section" aria-label="浏览器权限">
				<h3>浏览器权限</h3>
				<div className="browser-settings-card">
					<div className="browser-setting-row">
						<div>
							<strong>网站访问</strong>
							<p className="muted">内置浏览器支持 HTTP 和 HTTPS 网页。</p>
						</div>
						<span className="browser-setting-note">HTTP · HTTPS</span>
					</div>
					<div className="browser-setting-row">
						<div>
							<strong>受限内容</strong>
							<p className="muted">工作台内部页面和网页下载会被拦截。</p>
						</div>
						<span className="browser-setting-note">默认阻止</span>
					</div>
					<div className="browser-setting-row">
						<div>
							<strong>Agent 页面访问</strong>
							<p className="muted">Agent 只能在当前会话运行时访问该会话共享的浏览器。</p>
						</div>
						<span className="browser-setting-note">会话隔离</span>
					</div>
				</div>
			</section>
		</section>
	);
}

function formatTokens(value: number): string {
	return new Intl.NumberFormat("zh-CN", {
		notation: value >= 1_000_000 ? "compact" : "standard",
		maximumFractionDigits: 1,
	}).format(value);
}

function formatModelLabel(model: RunUsage["model"]): string {
	return model ? `${model.provider} · ${model.id}` : "模型未知";
}

function utcDayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function usageStreaks(activeDays: Set<string>, today: Date) {
	let longest = 0;
	let streak = 0;
	let previousDay = 0;
	for (const key of [...activeDays].sort()) {
		const day = Date.parse(`${key}T00:00:00.000Z`);
		streak = day === previousDay + 86_400_000 ? streak + 1 : 1;
		longest = Math.max(longest, streak);
		previousDay = day;
	}
	const cursor = new Date(today);
	cursor.setUTCHours(0, 0, 0, 0);
	if (!activeDays.has(utcDayKey(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
	let current = 0;
	while (activeDays.has(utcDayKey(cursor))) {
		current += 1;
		cursor.setUTCDate(cursor.getUTCDate() - 1);
	}
	return { current, longest };
}

export function UsageStatisticsPanel({ workspaces }: { workspaces: Workspace[] }) {
	const [rangeDays, setRangeDays] = useState<7 | 30>(7);
	const [heatmapMode, setHeatmapMode] = useState<"daily" | "weekly" | "cumulative">("daily");
	const usage = useQuery({ queryKey: ["usage"], queryFn: () => api<UsageSummary>("/usage") });
	const workspaceNames = useMemo(
		() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
		[workspaces],
	);
	if (usage.isPending) return <LoadingState label="正在汇总会话用量…" />;
	if (usage.error) return <Alert severity="error">用量数据读取失败：{usage.error.message}</Alert>;
	const records: SessionUsageRecord[] = usage.data ?? [];
	const runs = records
		.flatMap((record) => record.runs.map((run) => ({ record, run })))
		.sort((left, right) => right.run.startedAt.localeCompare(left.run.startedAt));
	const today = new Date();
	const dailyTokens = new Map<string, number>();
	const dailyModelTokens = new Map<string, Map<string, number>>();
	const modelTokens = new Map<string, { key: string; label: string; total: number }>();
	for (const { run } of runs) {
		const dayKey = utcDayKey(new Date(run.startedAt));
		const tokenCount = run.tokens?.total ?? 0;
		dailyTokens.set(dayKey, (dailyTokens.get(dayKey) ?? 0) + tokenCount);
		const modelKey = run.model ? `${run.model.provider}/${run.model.id}` : "unknown";
		const model = modelTokens.get(modelKey) ?? { key: modelKey, label: formatModelLabel(run.model), total: 0 };
		model.total += tokenCount;
		modelTokens.set(modelKey, model);
		const modelDays = dailyModelTokens.get(modelKey) ?? new Map<string, number>();
		modelDays.set(dayKey, (modelDays.get(dayKey) ?? 0) + tokenCount);
		dailyModelTokens.set(modelKey, modelDays);
	}
	const activeDays = new Set(runs.map(({ run }) => utcDayKey(new Date(run.startedAt))));
	const streaks = usageStreaks(activeDays, today);
	const dailySeries = Array.from({ length: rangeDays }, (_, index) => {
		const date = new Date(today);
		date.setUTCHours(0, 0, 0, 0);
		date.setUTCDate(date.getUTCDate() - (rangeDays - index - 1));
		const key = utcDayKey(date);
		return { key, date, tokens: dailyTokens.get(key) ?? 0 };
	});
	const modelList = [...modelTokens.values()]
		.filter((model) => model.total > 0)
		.sort((left, right) => right.total - left.total);
	const trendModels = modelList
		.filter((model) => dailySeries.some((day) => (dailyModelTokens.get(model.key)?.get(day.key) ?? 0) > 0))
		.slice(0, 5);
	const maxDaily = Math.max(1, ...dailySeries.map((day) => day.tokens));
	const trendLines = trendModels.map((model, modelIndex) => ({
		...model,
		modelIndex,
		path: dailySeries
			.map((day, index) => {
				const x = 38 + (index * 706) / Math.max(1, dailySeries.length - 1);
				const value = dailyModelTokens.get(model.key)?.get(day.key) ?? 0;
				const y = 176 - (value / maxDaily) * 150;
				return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(" "),
	}));
	const heatmapEnd = new Date(today);
	heatmapEnd.setUTCHours(0, 0, 0, 0);
	const heatmapWindowStart = new Date(heatmapEnd);
	heatmapWindowStart.setUTCDate(heatmapWindowStart.getUTCDate() - 364);
	const heatmapStart = new Date(heatmapWindowStart);
	heatmapStart.setUTCDate(heatmapStart.getUTCDate() - heatmapStart.getUTCDay());
	const heatmapDays = Array.from(
		{ length: Math.floor((heatmapEnd.getTime() - heatmapStart.getTime()) / 86_400_000) + 1 },
		(_, index) => {
			const date = new Date(heatmapStart);
			date.setUTCDate(date.getUTCDate() + index);
			const key = utcDayKey(date);
			return { key, date, tokens: date < heatmapWindowStart ? 0 : (dailyTokens.get(key) ?? 0) };
		},
	);
	const heatmapWeeks = Array.from({ length: Math.ceil(heatmapDays.length / 7) }, (_, weekIndex) =>
		Array.from({ length: 7 }, (_, dayIndex) => heatmapDays[weekIndex * 7 + dayIndex]),
	);
	const weeklyTokens = heatmapWeeks.map((week) => week.reduce((sum, day) => sum + (day?.tokens ?? 0), 0));
	let cumulativeTokens = 0;
	const cumulativeDays = heatmapDays.map((day) => {
		cumulativeTokens += day.tokens;
		return { ...day, tokens: cumulativeTokens };
	});
	const heatmapValues =
		heatmapMode === "weekly"
			? weeklyTokens
			: (heatmapMode === "cumulative" ? cumulativeDays : heatmapDays).map((day) => day.tokens);
	const maxHeatmap = Math.max(1, ...heatmapValues);
	let lastHeatmapMonth = -1;
	const heatmapMonthLabels = heatmapWeeks.map((week) => {
		const monthStart = week.find((day) => day?.date.getUTCDate() === 1) ?? week.find((day) => day);
		const month = monthStart?.date.getUTCMonth() ?? -1;
		const label =
			month !== lastHeatmapMonth
				? monthStart?.date.toLocaleDateString("zh-CN", { month: "numeric", timeZone: "UTC" })
				: "";
		lastHeatmapMonth = month;
		return label;
	});
	const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"] as const;
	const totals = records.reduce(
		(result, record) => ({
			input: result.input + (record.tokens?.input ?? 0),
			output: result.output + (record.tokens?.output ?? 0),
			total: result.total + (record.tokens?.total ?? 0),
			cacheRead: result.cacheRead + (record.tokens?.cacheRead ?? 0),
			cost: result.cost + (record.tokens?.cost ?? 0),
			costSessions: result.costSessions + Number(record.tokens?.cost !== undefined),
		}),
		{ input: 0, output: 0, total: 0, cacheRead: 0, cost: 0, costSessions: 0 },
	);
	const peak = Math.max(0, ...records.map((record) => record.tokens?.total ?? 0));
	const longestRun = Math.max(0, ...runs.map(({ run }) => run.durationMs));
	const donutModels = modelList.slice(0, 5).map((model) => ({ ...model }));
	const otherModels = modelList.slice(5);
	if (otherModels.length) {
		donutModels.push({
			key: "other",
			label: "其他模型",
			total: otherModels.reduce((sum, model) => sum + model.total, 0),
		});
	}
	const modelTotal = donutModels.reduce((sum, model) => sum + model.total, 0);
	let donutOffset = 0;
	const donutSegments = donutModels.map((model, index) => {
		const circumference = 2 * Math.PI * 57;
		const length = modelTotal ? (model.total / modelTotal) * circumference : 0;
		const segment = { ...model, index, length, offset: donutOffset };
		donutOffset += length;
		return segment;
	});
	const latestRuns = runs.slice(0, 20);
	return (
		<section className="usage-management" aria-label="使用统计">
			<SettingsSectionHeading
				title="使用统计"
				description="汇总会话用量，并查看每日活动、模型分布与最近运行。"
				badge="应用用量"
			/>
			<div className="usage-metric-grid">
				<article>
					<span>累计 Token 数</span>
					<strong>{formatTokens(totals.total)}</strong>
				</article>
				<article>
					<span>峰值 Token 数</span>
					<strong>{formatTokens(peak)}</strong>
				</article>
				<article>
					<span>最长聊天时长</span>
					<strong>{runs.length ? formatDuration(longestRun) : "暂无数据"}</strong>
				</article>
				<article>
					<span>当前连续天数</span>
					<strong>{streaks.current} 天</strong>
				</article>
				<article>
					<span>最长连续天数</span>
					<strong>{streaks.longest} 天</strong>
				</article>
			</div>
			<section className="usage-section usage-activity-section" aria-label="Token 活动">
				<header className="usage-section-heading">
					<div>
						<h3>Token 活动</h3>
						<p className="muted">最近一年 · {heatmapMode === "weekly" ? "每格一周" : "每格一天"}</p>
					</div>
					<fieldset className="usage-range-switch">
						<legend className="visually-hidden">Token 活动粒度</legend>
						{(["daily", "weekly", "cumulative"] as const).map((mode) => (
							<button
								type="button"
								key={mode}
								aria-pressed={heatmapMode === mode}
								onClick={() => setHeatmapMode(mode)}
							>
								{mode === "daily" ? "每日" : mode === "weekly" ? "每周" : "累计"}
							</button>
						))}
					</fieldset>
				</header>
				{runs.length ? (
					<div className="usage-chart-card usage-heatmap-card">
						{heatmapMode !== "weekly" && (
							<div
								className="usage-heatmap-months"
								style={{ gridTemplateColumns: `repeat(${heatmapWeeks.length}, 12px)` }}
								aria-hidden="true"
							>
								{heatmapMonthLabels.map((label, index) => (
									<span key={heatmapWeeks[index]?.[0]?.key}>{label}</span>
								))}
							</div>
						)}
						<div className="usage-heatmap-scroll">
							<table
								className={`usage-heatmap${heatmapMode === "weekly" ? " is-weekly" : ""}`}
								aria-label={`最近一年${heatmapMode === "weekly" ? "每周" : heatmapMode === "cumulative" ? "累计" : "每日"} Token 活动`}
							>
								<caption className="visually-hidden">
									每格代表一天或一周；选择累计时显示截至当天的累计 Token 数。
								</caption>
								<tbody>
									{heatmapMode === "weekly" ? (
										<tr>
											<th scope="row" className="visually-hidden">
												每周
											</th>
											{weeklyTokens.map((tokens, index) => {
												const firstDay = heatmapWeeks[index].find((day) => day);
												const label = `${firstDay?.key ?? ""} 起的一周 · ${formatTokens(tokens)} tokens`;
												const level = tokens ? Math.max(1, Math.ceil((tokens / maxHeatmap) * 4)) : 0;
												return (
													<td key={firstDay?.key} title={label} aria-label={label}>
														<span className={`usage-heatmap-cell is-level-${level}`} />
													</td>
												);
											})}
										</tr>
									) : (
										weekdayLabels.map((weekday, dayIndex) => (
											<tr key={weekday}>
												<th scope="row" className="visually-hidden">
													星期{weekday}
												</th>
												{heatmapWeeks.map((week) => {
													const day = week[dayIndex];
													if (!day) return <td key={week[0]?.key ?? "empty"} aria-hidden="true" />;
													const tokens =
														heatmapMode === "cumulative"
															? (cumulativeDays.find((entry) => entry.key === day.key)?.tokens ?? 0)
															: day.tokens;
													const level = tokens ? Math.max(1, Math.ceil((tokens / maxHeatmap) * 4)) : 0;
													const label = `${day.key} · ${formatTokens(tokens)} tokens${heatmapMode === "cumulative" ? " 累计" : ""}`;
													return (
														<td key={day.key} title={label} aria-label={label}>
															<span className={`usage-heatmap-cell is-level-${level}`} />
														</td>
													);
												})}
											</tr>
										))
									)}
								</tbody>
							</table>
						</div>
						<div className="usage-heatmap-legend">
							<span>少</span>
							{[0, 1, 2, 3, 4].map((level) => (
								<i className={`is-level-${level}`} key={level} />
							))}
							<span>多</span>
						</div>
					</div>
				) : (
					<div className="usage-chart-card usage-empty-state">
						<strong>还没有 Token 活动</strong>
						<span>完成模型运行后，这里会显示每日和每周用量。</span>
					</div>
				)}
			</section>
			<div className="usage-period-row">
				<strong>时间范围</strong>
				<fieldset className="usage-range-switch">
					<legend className="visually-hidden">趋势图时间范围</legend>
					{([7, 30] as const).map((days) => (
						<button type="button" key={days} aria-pressed={rangeDays === days} onClick={() => setRangeDays(days)}>
							近 {days} 天
						</button>
					))}
				</fieldset>
			</div>
			<section className="usage-section" aria-label="每日 Token 趋势">
				<div className="usage-chart-card usage-trend-card">
					<h3>每日 Token 趋势</h3>
					{trendLines.length ? (
						<>
							<div className="usage-chart-legend">
								{trendLines.map((model) => (
									<span key={model.key}>
										<i className={`usage-color-${model.modelIndex % 6}`} />
										{model.label}
									</span>
								))}
							</div>
							<svg
								className="usage-trend-chart"
								viewBox="0 0 760 210"
								role="img"
								aria-label={`近 ${rangeDays} 天各模型每日 Token 趋势`}
							>
								{[26, 63.5, 101, 138.5, 176].map((y) => (
									<line key={y} x1="38" x2="744" y1={y} y2={y} className="usage-chart-gridline" />
								))}
								{trendLines.map((model) => (
									<path
										key={model.key}
										d={model.path}
										className={`usage-trend-line usage-color-${model.modelIndex % 6}`}
									/>
								))}
							</svg>
							<div className={`usage-chart-x-labels${rangeDays === 30 ? " is-month" : ""}`}>
								{dailySeries.map((day, index) => (
									<span key={day.key}>
										{rangeDays === 7 || index % 5 === 0 || index === dailySeries.length - 1
											? day.date.toLocaleDateString("zh-CN", {
													month: "numeric",
													day: "numeric",
													timeZone: "UTC",
												})
											: ""}
									</span>
								))}
							</div>
						</>
					) : (
						<div className="usage-empty-state">
							<strong>还没有可展示的数据</strong>
							<span>完成一次模型运行后，这里会显示每日 Token 趋势。</span>
						</div>
					)}
				</div>
			</section>
			<section className="usage-section" aria-label="模型用量">
				<div className="usage-chart-card usage-model-card">
					<h3>模型用量</h3>
					{donutSegments.length ? (
						<div className="usage-donut-layout">
							<div className="usage-donut-wrap">
								<svg
									className="usage-donut"
									viewBox="0 0 180 180"
									role="img"
									aria-label={`模型总用量 ${formatTokens(modelTotal)} tokens`}
								>
									<circle cx="90" cy="90" r="57" className="usage-donut-track" />
									{donutSegments.map((segment) => (
										<circle
											key={segment.key}
											cx="90"
											cy="90"
											r="57"
											className={`usage-donut-segment usage-color-${segment.index % 6}`}
											strokeDasharray={`${segment.length} ${2 * Math.PI * 57 - segment.length}`}
											strokeDashoffset={-segment.offset}
										/>
									))}
								</svg>
								<div className="usage-donut-center">
									<strong>{formatTokens(modelTotal)}</strong>
									<span>tokens</span>
								</div>
							</div>
							<div className="usage-model-legend">
								{donutSegments.map((model) => (
									<div key={model.key}>
										<i className={`usage-color-${model.index % 6}`} />
										<span>
											{model.label}
											<small>{formatTokens(model.total)} tokens</small>
										</span>
										<strong>{modelTotal ? `${((model.total / modelTotal) * 100).toFixed(0)}%` : "0%"}</strong>
									</div>
								))}
							</div>
						</div>
					) : (
						<div className="usage-empty-state">
							<strong>暂无模型用量</strong>
							<span>运行完成后，模型分布会显示在这里。</span>
						</div>
					)}
				</div>
			</section>
			<details className="usage-recent-runs">
				<summary>
					<span>最近运行</span>
					<small>{runs.length ? `最近 ${latestRuns.length} 次运行` : "暂无运行记录"}</small>
					<ChevronDown size={15} />
				</summary>
				{latestRuns.length ? (
					<div className="usage-run-list">
						{latestRuns.map(({ record, run }) => (
							<article className="usage-run-row" key={`${record.id}:${run.startedAt}`}>
								<div className="usage-run-main">
									<strong>
										<Link to={`/sessions/${record.id}`}>{record.title}</Link>
									</strong>
									<span className="muted">
										{workspaceNames.get(record.workspaceId) ?? "已移除的工作区"} ·{" "}
										{formatModelLabel(run.model)}
									</span>
								</div>
								<span>{run.tokens ? `${formatTokens(run.tokens.total)} tokens` : "用量不可用"}</span>
								<span className="muted">
									<Clock size={13} /> {formatDuration(run.durationMs)}
								</span>
								<time>{new Date(run.startedAt).toLocaleString()}</time>
							</article>
						))}
					</div>
				) : (
					<div className="usage-empty-state">
						<span>完成一次模型请求后，运行记录会显示在这里。</span>
					</div>
				)}
				<p className="muted usage-disclaimer">
					累计值按会话汇总。趋势最多使用最近 5,000 次运行，每个会话保存最近 500 次；更早历史仍计入累计 Token
					和费用，但不参与趋势。
				</p>
			</details>
			<details className="usage-extra-stats">
				<summary>
					更多用量明细 <ChevronDown size={14} />
				</summary>
				<div>
					<span>
						输入 / 输出
						<strong>
							{formatTokens(totals.input)} / {formatTokens(totals.output)}
						</strong>
					</span>
					<span>
						缓存读取<strong>{formatTokens(totals.cacheRead)}</strong>
					</span>
					<span>
						估算费用<strong>{totals.costSessions ? `$${totals.cost.toFixed(4)}` : "暂无数据"}</strong>
					</span>
					<span>
						已记录用量的会话<strong>{records.filter((record) => record.tokens).length}</strong>
					</span>
					<span>
						会话总数<strong>{records.length}</strong>
					</span>
				</div>
			</details>
		</section>
	);
}

type ArchiveDialog = { kind: "one"; session: SessionSummary } | { kind: "all" };

export function ArchiveManagementPanel({
	sessions,
	sessionsLoading,
	workspaces,
}: {
	sessions: SessionSummary[];
	sessionsLoading: boolean;
	workspaces: Workspace[];
}) {
	const client = useQueryClient();
	const [query, setQuery] = useState("");
	const [workspaceId, setWorkspaceId] = useState("all");
	const [dialog, setDialog] = useState<ArchiveDialog>();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const archived = sessions.filter((session) => !!session.archivedAt);
	const visible = archived
		.filter((session) => workspaceId === "all" || session.workspaceId === workspaceId)
		.filter(
			(session) => !query.trim() || session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
		)
		.sort((left, right) => (right.archivedAt ?? right.updatedAt).localeCompare(left.archivedAt ?? left.updatedAt));
	const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
	const refresh = async () => {
		await Promise.all([
			client.invalidateQueries({ queryKey: ["sessions"] }),
			client.invalidateQueries({ queryKey: ["storage"] }),
			client.invalidateQueries({ queryKey: ["usage"] }),
		]);
	};
	const restore = async (session: SessionSummary) => {
		setPending(true);
		setError("");
		try {
			const restored = await api<SessionSummary>(`/sessions/${session.id}/restore`, {}, "POST");
			client.setQueryData<SessionDetail>(["session", session.id], (current) =>
				current ? { ...current, ...restored } : current,
			);
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setPending(false);
		}
	};
	const permanentlyDelete = async () => {
		if (!dialog) return;
		setPending(true);
		setError("");
		try {
			const targets = dialog.kind === "one" ? [dialog.session] : archived;
			for (const session of targets) {
				await api(`/sessions/${session.id}`, undefined, "DELETE");
				client.removeQueries({ queryKey: ["session", session.id] });
			}
			setDialog(undefined);
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			await refresh();
		} finally {
			setPending(false);
		}
	};
	return (
		<section className="archive-management" aria-label="归档管理">
			<SettingsSectionHeading title="归档管理" description="先归档会话以保留历史；需要彻底删除时再从这里处理。" />
			<div className="archive-policy-row">
				<div>
					<strong>归档优先</strong>
					<p className="muted">从会话菜单归档会保留聊天记录和工作区文件。永久删除只在本页执行。</p>
				</div>
				<Chip size="small" label={`${archived.length} 个已归档`} />
			</div>
			<div className="archive-list-heading">
				<div>
					<h3>已归档的会话</h3>
					<p className="muted">恢复后会重新出现在项目会话列表。</p>
				</div>
				<Button
					color="error"
					size="small"
					startIcon={<Trash2 size={15} />}
					disabled={!archived.length || pending}
					onClick={() => setDialog({ kind: "all" })}
				>
					全部删除
				</Button>
			</div>
			<div className="archive-filters">
				<TextField
					size="small"
					placeholder="搜索已归档会话"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					inputProps={{ "aria-label": "搜索已归档会话" }}
				/>
				<FormControl size="small">
					<InputLabel id="archive-workspace-label">项目</InputLabel>
					<Select
						labelId="archive-workspace-label"
						label="项目"
						value={workspaceId}
						onChange={(event) => setWorkspaceId(event.target.value)}
					>
						<MenuItem value="all">所有项目</MenuItem>
						{workspaces.map((workspace) => (
							<MenuItem key={workspace.id} value={workspace.id}>
								{workspace.name}
							</MenuItem>
						))}
					</Select>
				</FormControl>
			</div>
			{error && (
				<Alert severity="error" onClose={() => setError("")}>
					{error}
				</Alert>
			)}
			{sessionsLoading ? (
				<LoadingState label="正在读取归档会话…" />
			) : visible.length ? (
				<div className="archive-session-list">
					{visible.map((session) => (
						<article className="archive-session-row" key={session.id}>
							<div className="archive-session-main">
								<strong>{session.title}</strong>
								<span className="muted">
									{workspaceNames.get(session.workspaceId) ?? "已移除的工作区"} · 归档于{" "}
									{new Date(session.archivedAt ?? session.updatedAt).toLocaleString()}
								</span>
							</div>
							<div className="archive-session-actions">
								<Button
									size="small"
									startIcon={<Restore size={15} />}
									disabled={pending}
									onClick={() => void restore(session)}
								>
									恢复
								</Button>
								<Button
									size="small"
									color="error"
									startIcon={<Trash2 size={14} />}
									disabled={pending}
									onClick={() => setDialog({ kind: "one", session })}
								>
									删除
								</Button>
							</div>
						</article>
					))}
				</div>
			) : (
				<div className="management-empty">
					<strong>{archived.length ? "没有匹配的归档会话" : "归档列表为空"}</strong>
					<p>{archived.length ? "调整搜索词或项目筛选。" : "在项目会话菜单中归档后，会话会显示在这里。"}</p>
				</div>
			)}
			<Dialog open={!!dialog} onClose={() => !pending && setDialog(undefined)} maxWidth="xs" fullWidth>
				<DialogTitle>永久删除会话</DialogTitle>
				<DialogContent>
					<Alert severity="warning">
						{dialog?.kind === "all"
							? `将永久删除全部 ${archived.length} 个已归档会话及其历史记录。`
							: `将永久删除“${dialog?.kind === "one" ? dialog.session.title : ""}”及其历史记录。此操作无法撤销。`}
					</Alert>
				</DialogContent>
				<DialogActions>
					<Button disabled={pending} onClick={() => setDialog(undefined)}>
						取消
					</Button>
					<Button color="error" variant="contained" disabled={pending} onClick={() => void permanentlyDelete()}>
						{pending ? "删除中…" : "永久删除"}
					</Button>
				</DialogActions>
			</Dialog>
		</section>
	);
}
