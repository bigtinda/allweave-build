import {
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
	InputLabel,
	MenuItem,
	Paper,
	Select,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableRow,
	TextField,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
	AppPluginField,
	AppPluginRecord,
	AppPluginRegistry,
	InstalledAppPlugin,
} from "../../../shared/src/plugins.ts";
import { api } from "../services/api.ts";

type PluginValue = string | number | boolean;

function FieldInput({
	field,
	value,
	onChange,
}: {
	field: AppPluginField;
	value: PluginValue | undefined;
	onChange: (value: PluginValue) => void;
}) {
	if (field.type === "boolean") {
		return (
			<FormControlLabel
				control={<Checkbox checked={value === true} onChange={(event) => onChange(event.target.checked)} />}
				label={field.label}
			/>
		);
	}
	if (field.type === "select") {
		return (
			<FormControl fullWidth size="small" required={field.required}>
				<InputLabel>{field.label}</InputLabel>
				<Select
					label={field.label}
					value={typeof value === "string" ? value : ""}
					onChange={(event) => onChange(event.target.value)}
				>
					{(field.options ?? []).map((option) => (
						<MenuItem key={option} value={option}>
							{option}
						</MenuItem>
					))}
				</Select>
			</FormControl>
		);
	}
	return (
		<TextField
			fullWidth
			size="small"
			required={field.required}
			label={field.label}
			type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
			InputLabelProps={field.type === "date" ? { shrink: true } : undefined}
			value={value ?? ""}
			onChange={(event) =>
				onChange(
					field.type === "number"
						? event.target.value === ""
							? ""
							: Number(event.target.value)
						: event.target.value,
				)
			}
		/>
	);
}

function formatValue(value: PluginValue | undefined): string {
	if (typeof value === "boolean") return value ? "是" : "否";
	return value === undefined ? "—" : String(value);
}

export function AppPluginPage() {
	const { pluginId = "", viewId = "" } = useParams();
	const [searchParams] = useSearchParams();
	const workspaceId = searchParams.get("workspace") ?? "";
	const client = useQueryClient();
	const [editing, setEditing] = useState<AppPluginRecord>();
	const [formOpen, setFormOpen] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<AppPluginRecord>();
	const [values, setValues] = useState<Record<string, PluginValue>>({});
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const registry = useQuery({ queryKey: ["app-plugins"], queryFn: () => api<AppPluginRegistry>("/app-plugins") });
	const plugin = registry.data?.plugins.find((item) => item.manifest.id === pluginId && item.enabled);
	const records = useQuery({
		queryKey: ["app-plugin-records", pluginId, workspaceId],
		enabled: Boolean(plugin && workspaceId),
		queryFn: () => api<AppPluginRecord[]>(`/workspaces/${workspaceId}/app-plugins/${pluginId}/records`),
	});
	const manifest = plugin?.manifest;
	const view = manifest?.views.find((item) => item.id === viewId) ?? manifest?.views[0];
	const beginCreate = () => {
		setEditing(undefined);
		setValues(
			Object.fromEntries(manifest?.fields.map((field) => [field.id, field.type === "boolean" ? false : ""]) ?? []),
		);
		setError("");
		setFormOpen(true);
	};
	const beginEdit = (record: AppPluginRecord) => {
		setEditing(record);
		setValues(record.values);
		setError("");
		setFormOpen(true);
	};
	const save = async () => {
		if (!manifest) return;
		setPending(true);
		try {
			const path = `/workspaces/${workspaceId}/app-plugins/${pluginId}/records`;
			if (editing) await api<AppPluginRecord>(`${path}/${editing.id}`, values, "PATCH");
			else await api<AppPluginRecord>(path, values);
			await client.invalidateQueries({ queryKey: ["app-plugin-records", pluginId, workspaceId] });
			setEditing(undefined);
			setValues({});
			setFormOpen(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setPending(false);
		}
	};
	const remove = async (record: AppPluginRecord) => {
		try {
			await api(`/workspaces/${workspaceId}/app-plugins/${pluginId}/records/${record.id}`, undefined, "DELETE");
			await client.invalidateQueries({ queryKey: ["app-plugin-records", pluginId, workspaceId] });
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	if (registry.isPending)
		return (
			<div className="loading">
				<CircularProgress />
			</div>
		);
	if (registry.error) return <Alert severity="error">{registry.error.message}</Alert>;
	if (!plugin || !manifest || !view)
		return <Alert severity="warning">此插件功能已停用或入口不存在。可在“设置 → 插件”管理。</Alert>;
	if (!workspaceId) return <Alert severity="info">请先选择一个工作区。</Alert>;
	const displayRecords = records.data ?? [];
	const groupedRecords =
		view.type === "board" && view.groupBy
			? displayRecords.reduce((groups, record) => {
					const key = formatValue(record.values[view.groupBy ?? ""]);
					const items = groups.get(key) ?? [];
					items.push(record);
					groups.set(key, items);
					return groups;
				}, new Map<string, AppPluginRecord[]>())
			: undefined;
	return (
		<section className="app-plugin-page">
			<header className="app-plugin-page-heading">
				<div>
					<span className="eyebrow">
						{manifest.name} · {manifest.version}
					</span>
					<h1>{view.title}</h1>
					<p className="muted">{manifest.description || "由本地插件提供的工作区功能。"}</p>
				</div>
				{manifest.views.length > 1 && (
					<div className="app-plugin-view-links">
						{manifest.navigation
							.filter((entry) => manifest.views.some((item) => item.id === entry.viewId))
							.map((entry) => (
								<Button
									key={entry.id}
									disabled={entry.viewId === view.id}
									component={Link}
									to={`/plugins/${pluginId}/${entry.viewId}?workspace=${workspaceId}`}
								>
									{entry.title}
								</Button>
							))}
					</div>
				)}
				<Button variant="contained" onClick={beginCreate}>
					新增
				</Button>
			</header>
			{error && (
				<Alert severity="error" onClose={() => setError("")}>
					{error}
				</Alert>
			)}
			{records.error && <Alert severity="error">{records.error.message}</Alert>}
			{records.isPending ? (
				<div className="loading">
					<CircularProgress />
				</div>
			) : view.type === "board" ? (
				<div className="app-plugin-board">
					{[...(groupedRecords ?? new Map<string, AppPluginRecord[]>()).entries()].map(([group, groupRecords]) => (
						<Paper className="app-plugin-board-column" variant="outlined" key={group}>
							<header>
								<strong>{group}</strong>
								<Chip size="small" label={groupRecords.length} />
							</header>
							{groupRecords.map((record) => (
								<Paper key={record.id} className="app-plugin-board-record" variant="outlined">
									<strong>{formatValue(record.values[manifest.fields[0].id])}</strong>
									{manifest.fields.slice(1).map((field) => (
										<div key={field.id}>
											<span>{field.label}</span>
											<span>{formatValue(record.values[field.id])}</span>
										</div>
									))}
									<footer>
										<Button size="small" onClick={() => beginEdit(record)}>
											编辑
										</Button>
										<Button size="small" color="error" onClick={() => setDeleteTarget(record)}>
											删除
										</Button>
									</footer>
								</Paper>
							))}
						</Paper>
					))}
					{!displayRecords.length && (
						<Paper className="app-plugin-empty" variant="outlined">
							还没有记录。新增一条记录开始使用。
						</Paper>
					)}
				</div>
			) : (
				<Paper variant="outlined" className="app-plugin-table">
					<Table size="small">
						<TableHead>
							<TableRow>
								{manifest.fields.map((field) => (
									<TableCell key={field.id}>{field.label}</TableCell>
								))}
								<TableCell align="right">操作</TableCell>
							</TableRow>
						</TableHead>
						<TableBody>
							{displayRecords.map((record) => (
								<TableRow key={record.id} hover>
									{manifest.fields.map((field) => (
										<TableCell key={field.id}>{formatValue(record.values[field.id])}</TableCell>
									))}
									<TableCell align="right">
										<Button size="small" onClick={() => beginEdit(record)}>
											编辑
										</Button>
										<Button size="small" color="error" onClick={() => setDeleteTarget(record)}>
											删除
										</Button>
									</TableCell>
								</TableRow>
							))}
							{!displayRecords.length && (
								<TableRow>
									<TableCell colSpan={manifest.fields.length + 1} align="center">
										还没有记录。新增一条记录开始使用。
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</Paper>
			)}
			<Dialog
				open={formOpen}
				onClose={() => {
					setFormOpen(false);
					setEditing(undefined);
					setValues({});
				}}
				maxWidth="sm"
				fullWidth
			>
				<DialogTitle>{editing ? "编辑记录" : "新增记录"}</DialogTitle>
				<DialogContent className="app-plugin-form">
					{manifest.fields.map((field) => (
						<FieldInput
							key={field.id}
							field={field}
							value={values[field.id]}
							onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
						/>
					))}
					{error && <Alert severity="error">{error}</Alert>}
				</DialogContent>
				<DialogActions>
					<Button
						onClick={() => {
							setFormOpen(false);
							setEditing(undefined);
							setValues({});
						}}
					>
						取消
					</Button>
					<Button variant="contained" disabled={pending} onClick={() => void save()}>
						{pending ? "保存中…" : "保存"}
					</Button>
				</DialogActions>
			</Dialog>
			<Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(undefined)}>
				<DialogTitle>删除记录？</DialogTitle>
				<DialogContent>删除后无法从插件页面恢复此记录。</DialogContent>
				<DialogActions>
					<Button onClick={() => setDeleteTarget(undefined)}>取消</Button>
					<Button
						color="error"
						variant="contained"
						disabled={pending}
						onClick={async () => {
							if (!deleteTarget) return;
							setPending(true);
							await remove(deleteTarget);
							setPending(false);
							setDeleteTarget(undefined);
						}}
					>
						删除
					</Button>
				</DialogActions>
			</Dialog>
		</section>
	);
}

export type { AppPluginRegistry, InstalledAppPlugin };
