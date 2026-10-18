import {
	Alert,
	Button,
	Card,
	CardActions,
	CardContent,
	CircularProgress,
	FormControl,
	InputLabel,
	MenuItem,
	Select,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AppPluginRegistry, InstalledAppPlugin } from "../../../shared/src/plugins.ts";
import type { Workspace } from "../../../shared/src/protocol.ts";
import { api } from "../services/api.ts";

export function AppPluginManagerPanel({
	workspaces,
	onError,
}: {
	workspaces: Workspace[];
	onError: (message: string) => void;
}) {
	const client = useQueryClient();
	const navigate = useNavigate();
	const [workspaceId, setWorkspaceId] = useState("");
	const selectedWorkspaceId = workspaceId || workspaces[0]?.id || "";
	const registry = useQuery({ queryKey: ["app-plugins"], queryFn: () => api<AppPluginRegistry>("/app-plugins") });

	const setEnabled = async (plugin: InstalledAppPlugin, enabled: boolean) => {
		try {
			await api(`/app-plugins/${plugin.manifest.id}/${enabled ? "enable" : "disable"}`, {});
			await client.invalidateQueries({ queryKey: ["app-plugins"] });
			onError("");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		}
	};

	const removePlugin = async (plugin: InstalledAppPlugin) => {
		try {
			await api(`/app-plugins/${plugin.manifest.id}`, undefined, "DELETE");
			await client.invalidateQueries({ queryKey: ["app-plugins"] });
			onError("");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<section className="app-plugin-manager">
			<div className="section-heading-row">
				<div>
					<h2>应用插件</h2>
					<p className="muted">插件由主聊天中的 AI 在默认插件开发工作区内创建。安装后页面和字段会加入工作台。</p>
				</div>
				<Button onClick={() => void registry.refetch()}>刷新</Button>
			</div>
			<Alert severity="info" className="app-plugin-development-link">
				在侧栏选择“插件开发”，直接描述需要的功能；AI 会在写入或安装插件时请求确认。
			</Alert>
			{workspaces.length > 1 && (
				<FormControl size="small" className="app-plugin-workspace-select">
					<InputLabel id="app-plugin-workspace-label">查看数据工作区</InputLabel>
					<Select
						labelId="app-plugin-workspace-label"
						label="查看数据工作区"
						value={selectedWorkspaceId}
						onChange={(event) => setWorkspaceId(event.target.value)}
					>
						{workspaces.map((workspace) => (
							<MenuItem key={workspace.id} value={workspace.id}>
								{workspace.name}
							</MenuItem>
						))}
					</Select>
				</FormControl>
			)}
			{registry.isPending ? (
				<CircularProgress size={22} />
			) : registry.error ? (
				<Alert severity="error">{registry.error.message}</Alert>
			) : registry.data?.plugins.length ? (
				<div className="app-plugin-card-grid">
					{registry.data.plugins.map((plugin) => (
						<Card variant="outlined" key={plugin.manifest.id}>
							<CardContent>
								<div className="section-heading-row">
									<strong>{plugin.manifest.name}</strong>
									<span className="muted">{plugin.manifest.version}</span>
								</div>
								<code>{plugin.manifest.id}</code>
								<p className="muted">
									{plugin.manifest.description ||
										`${plugin.manifest.fields.length} 个数据字段 · ${plugin.manifest.views.length} 个页面`}
								</p>
								<div className="app-plugin-card-links">
									{plugin.enabled &&
										plugin.manifest.navigation.map((entry) => (
											<Button
												key={entry.id}
												size="small"
												disabled={!selectedWorkspaceId}
												onClick={() =>
													navigate(
														`/plugins/${plugin.manifest.id}/${entry.viewId}?workspace=${selectedWorkspaceId}`,
													)
												}
											>
												打开 {entry.title}
											</Button>
										))}
								</div>
							</CardContent>
							<CardActions>
								<Button size="small" onClick={() => void setEnabled(plugin, !plugin.enabled)}>
									{plugin.enabled ? "停用" : "启用"}
								</Button>
								<Button size="small" color="error" onClick={() => void removePlugin(plugin)}>
									卸载
								</Button>
							</CardActions>
						</Card>
					))}
				</div>
			) : (
				<div className="app-plugin-empty muted">还没有应用插件。打开“插件开发”与 AI 描述你需要的功能。</div>
			)}
		</section>
	);
}
