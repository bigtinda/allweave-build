import {
	Alert,
	Button,
	Chip,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	LinearProgress,
	MenuItem,
	TextField,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { GitChange, GitChanges, GitDiff, Workspace } from "../../../shared/src/protocol.ts";
import { api } from "../services/api.ts";

const changeLabels: Record<string, string> = {
	M: "修改",
	A: "新增",
	D: "删除",
	T: "类型变化",
	U: "冲突",
	"?": "未跟踪",
};

export function GitPanel({
	workspace,
	hasUnsavedFile,
	onBranchChange,
}: {
	workspace: Workspace;
	hasUnsavedFile: boolean;
	onBranchChange: () => void;
}) {
	const client = useQueryClient();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [feedback, setFeedback] = useState("");
	const [message, setMessage] = useState("");
	const [confirmation, setConfirmation] = useState<GitChanges>();
	const [selection, setSelection] = useState<{ path: string; staged: boolean }>();
	const [wide, setWide] = useState(false);
	const [branchAction, setBranchAction] = useState<"create" | "switch" | "delete">();
	const [branchName, setBranchName] = useState("");
	const [baseBranch, setBaseBranch] = useState("");
	const [branchRevision, setBranchRevision] = useState("");
	const status = useQuery({
		queryKey: ["git-changes", workspace.id],
		queryFn: () => api<GitChanges>(`/workspaces/${workspace.id}/git`),
		refetchInterval: 10_000,
		retry: false,
	});
	const diff = useQuery({
		queryKey: ["git-diff", workspace.id, selection?.path, selection?.staged],
		enabled: !!selection,
		queryFn: () =>
			api<GitDiff>(
				`/workspaces/${workspace.id}/git/diff?path=${encodeURIComponent(selection!.path)}&staged=${selection!.staged}`,
			),
		retry: false,
	});
	const staged = status.data?.files.filter((file) => file.index !== " " && file.index !== "?") ?? [];
	const unstaged = status.data?.files.filter((file) => file.working !== " " || file.index === "?") ?? [];
	const refresh = async () => {
		await Promise.all([status.refetch(), client.invalidateQueries({ queryKey: ["git-diff", workspace.id] })]);
	};
	const changeIndex = async (file: GitChange, stage: boolean) => {
		if (!status.data || pending) return;
		setPending(true);
		setError("");
		setFeedback("");
		try {
			const updated = await api<GitChanges>(`/workspaces/${workspace.id}/git/index`, {
				path: file.path,
				staged: stage,
				revision: status.data.indexRevision,
			});
			client.setQueryData(["git-changes", workspace.id], updated);
			setFeedback(`${stage ? "已暂存" : "已取消暂存"}：${file.path}`);
			await client.invalidateQueries({ queryKey: ["git-diff", workspace.id] });
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
			await refresh();
		} finally {
			setPending(false);
		}
	};
	const commit = async () => {
		if (!confirmation || pending) return;
		setPending(true);
		setError("");
		setFeedback("");
		try {
			const result = await api<{ output: string }>(`/workspaces/${workspace.id}/git/commit`, {
				message,
				revision: confirmation.indexRevision,
			});
			setConfirmation(undefined);
			setMessage("");
			setFeedback(`提交成功：${result.output}`);
			await refresh();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	};
	const branchLabels = { create: "创建分支", switch: "切换分支", delete: "删除分支" };
	const changeBranch = async () => {
		if (!branchAction || pending) return;
		setPending(true);
		setError("");
		setFeedback("");
		try {
			const updated = await api<GitChanges>(`/workspaces/${workspace.id}/git/branches`, {
				action: branchAction,
				name: branchName,
				revision: branchRevision,
				...(branchAction === "create" ? { base: baseBranch } : {}),
			});
			client.setQueryData(["git-changes", workspace.id], updated);
			setFeedback(`${branchLabels[branchAction]}成功：${branchName}`);
			if (branchAction === "switch") {
				onBranchChange();
				await client.invalidateQueries({ queryKey: ["files", workspace.id] });
			}
			setBranchAction(undefined);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	};
	return (
		<div className="workspace-tab-content git-panel">
			<div className="git-toolbar">
				<strong>{status.data?.branch ?? "Git"}</strong>
				<Button disabled={pending || status.isFetching} onClick={() => void refresh()}>
					刷新
				</Button>
			</div>
			{status.isLoading && <LinearProgress aria-label="加载 Git 状态" />}
			{status.error && <Alert severity="info">{status.error.message}</Alert>}
			{!confirmation && !branchAction && error && (
				<Alert severity="error" onClose={() => setError("")}>
					{error}
				</Alert>
			)}
			{feedback && (
				<Alert severity="success" onClose={() => setFeedback("")}>
					{feedback}
				</Alert>
			)}
			{status.data && (
				<>
					<div className="git-branch-actions">
						{(["switch", "create", "delete"] as const).map((action) => (
							<Button
								key={action}
								size="small"
								disabled={pending || status.isFetching || (action === "switch" && hasUnsavedFile)}
								onClick={() => {
									setError("");
									setBranchAction(action);
									setBranchName(
										action === "create"
											? ""
											: (status.data.branches.find((branch) => branch !== status.data.branch) ?? ""),
									);
									setBaseBranch(
										status.data.branches.includes(status.data.branch)
											? status.data.branch
											: (status.data.branches[0] ?? ""),
									);
									setBranchRevision(status.data.indexRevision);
								}}
							>
								{branchLabels[action]}
							</Button>
						))}
					</div>
					{hasUnsavedFile && <p className="muted">文件预览中有未保存内容，请先保存后切换分支。</p>}
					<p className="muted">逐文件检查后暂存。提交只包含已暂存改动。</p>
					{status.data.files.some((file) => file.conflict) && (
						<Alert severity="warning">存在合并冲突，请先在编辑器或终端解决。</Alert>
					)}
					{[
						{ label: "未暂存", files: unstaged, staged: false },
						{ label: "已暂存", files: staged, staged: true },
					].map((group) => (
						<section key={group.label} className="git-file-group" aria-label={group.label}>
							<h3>
								{group.label} <small>{group.files.length}</small>
							</h3>
							{!group.files.length && (
								<p className="muted">{group.staged ? "还没有暂存文件。" : "没有未暂存改动。"}</p>
							)}
							{group.files.map((file) => (
								<div key={file.path} className="git-file-row">
									<button
										type="button"
										className="git-file-preview"
										onClick={() => {
											setSelection({ path: file.path, staged: group.staged });
											setWide(false);
										}}
										title={file.path}
									>
										<span>{file.path}</span>
										<small>
											{file.conflict
												? "冲突"
												: (changeLabels[group.staged ? file.index : file.working] ?? "修改")}
										</small>
									</button>
									<Button
										size="small"
										disabled={pending || file.conflict || status.isFetching}
										aria-label={`${group.staged ? "取消暂存" : "暂存"} ${file.path}`}
										onClick={() => void changeIndex(file, !group.staged)}
									>
										{group.staged ? "取消" : "暂存"}
									</Button>
								</div>
							))}
						</section>
					))}
					{!status.data.files.length && <Alert severity="success">工作区干净，没有待提交改动。</Alert>}
					<div className="git-commit-form">
						<TextField
							fullWidth
							multiline
							minRows={2}
							maxRows={5}
							label="提交说明"
							value={message}
							disabled={pending}
							onChange={(event) => setMessage(event.target.value)}
						/>
						<Button
							variant="contained"
							disabled={
								pending ||
								status.isFetching ||
								!message.trim() ||
								!staged.length ||
								status.data.files.some((file) => file.conflict)
							}
							onClick={() => {
								setError("");
								setConfirmation(status.data);
							}}
						>
							检查并提交 · {staged.length} 个文件
						</Button>
					</div>
				</>
			)}
			<Dialog
				open={!!selection}
				onClose={() => setSelection(undefined)}
				fullWidth
				maxWidth={wide ? "xl" : "md"}
				aria-labelledby="git-diff-title"
			>
				<DialogTitle id="git-diff-title" className="git-diff-title">
					{selection?.staged ? "已暂存差异" : "未暂存差异"}
					<Chip size="small" label={selection?.path ?? ""} />
				</DialogTitle>
				<DialogContent>
					{diff.isFetching && <LinearProgress />}
					{diff.error ? (
						<Alert severity="error">{diff.error.message}</Alert>
					) : (
						<pre className="git-diff">
							{diff.data?.text.split("\n").map((line, index) => (
								<span
									key={`${index}-${line}`}
									className={
										line.startsWith("+")
											? "diff-added"
											: line.startsWith("-")
												? "diff-removed"
												: line.startsWith("@@")
													? "diff-hunk"
													: undefined
									}
								>
									{line || " "}
								</span>
							))}
						</pre>
					)}
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setWide(!wide)}>{wide ? "恢复宽度" : "展开差异"}</Button>
					<Button onClick={() => setSelection(undefined)}>关闭</Button>
				</DialogActions>
			</Dialog>
			<Dialog
				open={!!branchAction}
				onClose={() => !pending && setBranchAction(undefined)}
				fullWidth
				maxWidth="sm"
				aria-labelledby="git-branch-title"
			>
				<DialogTitle id="git-branch-title">{branchAction ? branchLabels[branchAction] : "分支"}</DialogTitle>
				<DialogContent className="git-branch-dialog">
					{branchAction === "create" ? (
						<>
							<TextField
								autoFocus
								fullWidth
								label="新分支名称"
								value={branchName}
								onChange={(event) => setBranchName(event.target.value)}
								disabled={pending}
							/>
							<TextField
								select
								fullWidth
								label="起始分支"
								value={baseBranch}
								onChange={(event) => setBaseBranch(event.target.value)}
								disabled={pending}
							>
								{status.data?.branches.map((branch) => (
									<MenuItem key={branch} value={branch}>
										{branch}
									</MenuItem>
								))}
							</TextField>
							<p className="muted">从所选分支创建，完成后仍留在当前分支。</p>
						</>
					) : (
						<>
							<TextField
								select
								fullWidth
								label="目标分支"
								value={branchName}
								onChange={(event) => setBranchName(event.target.value)}
								disabled={pending}
							>
								{status.data?.branches
									.filter((branch) => branch !== status.data.branch)
									.map((branch) => (
										<MenuItem key={branch} value={branch}>
											{branch}
										</MenuItem>
									))}
							</TextField>
							<p className="muted">
								{branchAction === "switch"
									? "切换会更新项目文件；存在已暂存、未暂存或未跟踪改动时会阻止切换。"
									: "仅删除本地分支。未合并或被工作树占用的分支不会删除。"}
							</p>
							{!status.data?.branches.some((branch) => branch !== status.data.branch) && (
								<Alert severity="info">没有其他本地分支，请先创建分支。</Alert>
							)}
						</>
					)}
					{error && <Alert severity="error">{error}</Alert>}
				</DialogContent>
				<DialogActions>
					<Button disabled={pending} onClick={() => setBranchAction(undefined)}>
						取消
					</Button>
					<Button
						variant="contained"
						color={branchAction === "delete" ? "error" : "primary"}
						disabled={pending || !branchName.trim() || (branchAction === "create" && !baseBranch)}
						onClick={() => void changeBranch()}
					>
						{pending ? "处理中…" : `确认${branchAction ? branchLabels[branchAction] : ""}`}
					</Button>
				</DialogActions>
			</Dialog>
			<Dialog
				open={!!confirmation}
				onClose={() => !pending && setConfirmation(undefined)}
				fullWidth
				maxWidth="sm"
				aria-labelledby="git-commit-title"
			>
				<DialogTitle id="git-commit-title">确认提交到 {confirmation?.branch}</DialogTitle>
				<DialogContent>
					<p>以下全部已暂存文件将纳入提交，包括在其他工具中暂存的文件。</p>
					<ul className="git-confirm-files">
						{confirmation?.files
							.filter((file) => file.index !== " " && file.index !== "?")
							.map((file) => (
								<li key={file.path}>{file.path}</li>
							))}
					</ul>
					<pre className="git-commit-message">{message}</pre>
					{error && <Alert severity="error">{error}</Alert>}
				</DialogContent>
				<DialogActions>
					<Button disabled={pending} onClick={() => setConfirmation(undefined)}>
						取消
					</Button>
					<Button variant="contained" disabled={pending} onClick={() => void commit()}>
						{pending ? "提交中…" : "确认提交"}
					</Button>
				</DialogActions>
			</Dialog>
		</div>
	);
}
