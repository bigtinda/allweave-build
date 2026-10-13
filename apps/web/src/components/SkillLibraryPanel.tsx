import { Alert, Button, Chip, CircularProgress, Pagination } from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, FolderUp, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SkillImportResult, SkillInfo } from "../../../shared/src/protocol.ts";
import { useSpringLayout } from "../hooks/useSpringLayout.ts";
import { api } from "../services/api.ts";
import { encodeResourceImportFiles } from "../services/resource-import.ts";

const pageSize = 8;

function ImportControls() {
	const client = useQueryClient();
	const fileInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [success, setSuccess] = useState("");
	useEffect(() => {
		folderInput.current?.setAttribute("webkitdirectory", "");
	}, []);
	const importFiles = async (files: FileList | null) => {
		if (!files?.length || pending) return;
		setPending(true);
		setError("");
		setSuccess("");
		try {
			const payload = await encodeResourceImportFiles(files);
			const result = await api<SkillImportResult>("/skills/import", { files: payload });
			setSuccess(`已导入“${result.name}”，共 ${result.filesImported} 个文件。新建会话后即可使用。`);
			await client.invalidateQueries({ queryKey: ["resources"] });
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setPending(false);
		}
	};
	return (
		<div className="skill-import-controls">
			<input
				ref={fileInput}
				className="visually-hidden"
				type="file"
				accept=".md,text/markdown"
				aria-label="选择 SKILL.md 文件"
				onChange={(event) => {
					void importFiles(event.currentTarget.files);
					event.currentTarget.value = "";
				}}
			/>
			<input
				ref={folderInput}
				className="visually-hidden"
				type="file"
				multiple
				aria-label="选择技能文件夹"
				onChange={(event) => {
					void importFiles(event.currentTarget.files);
					event.currentTarget.value = "";
				}}
			/>
			<div className="skill-import-actions">
				<Button
					variant="outlined"
					startIcon={pending ? <CircularProgress size={15} /> : <FileUp size={16} />}
					disabled={pending}
					onClick={() => fileInput.current?.click()}
				>
					导入 SKILL.md
				</Button>
				<Button
					variant="outlined"
					startIcon={<FolderUp size={16} />}
					disabled={pending}
					onClick={() => folderInput.current?.click()}
				>
					导入技能文件夹
				</Button>
				<span className="muted">支持 SKILL.md 及其资源文件，单次最多 7 MB。</span>
			</div>
			{error && (
				<Alert severity="error" onClose={() => setError("")}>
					{error}
				</Alert>
			)}
			{success && (
				<Alert severity="success" onClose={() => setSuccess("")}>
					{success}
				</Alert>
			)}
		</div>
	);
}

function ResourcePagination({
	count,
	page,
	onChange,
}: {
	count: number;
	page: number;
	onChange: (page: number) => void;
}) {
	const pages = Math.ceil(count / pageSize);
	if (pages <= 1) return null;
	return (
		<div className="resource-pagination">
			<span className="muted">
				共 {count} 项，每页 {pageSize} 项
			</span>
			<Pagination count={pages} page={page} size="small" onChange={(_event, value) => onChange(value)} />
		</div>
	);
}

export function SkillLibraryPanel({ skills, loading }: { skills: SkillInfo[]; loading: boolean }) {
	const [skillPage, setSkillPage] = useState(1);
	const visibleSkills = skills.slice((skillPage - 1) * pageSize, skillPage * pageSize);
	const skillGrid = useRef<HTMLDivElement>(null);
	useSpringLayout(skillGrid, visibleSkills.map((skill) => skill.filePath).join("\0"));
	useEffect(() => {
		setSkillPage((page) => Math.min(page, Math.max(1, Math.ceil(skills.length / pageSize))));
	}, [skills.length]);
	return (
		<section className="skill-library">
			<div className="section-heading-row skill-section-heading">
				<div>
					<h2>
						当前会话已加载技能 <Chip size="small" label={skills.length} />
					</h2>
					<p className="muted">从当前会话读取技能；新导入的技能会在新会话中加载。</p>
				</div>
				<ImportControls />
			</div>
			{loading ? (
				<CircularProgress size={22} />
			) : skills.length ? (
				<>
					<div ref={skillGrid} className="skill-card-grid">
						{visibleSkills.map((skill) => (
							<article className="skill-card" key={skill.filePath}>
								<div className="skill-card-heading">
									<Sparkles size={17} />
									<strong title={skill.name}>{skill.name}</strong>
								</div>
								<p className="skill-description">{skill.description}</p>
								<code title={skill.filePath}>{skill.filePath}</code>
								<Chip size="small" label="已加载" />
							</article>
						))}
					</div>
					<ResourcePagination count={skills.length} page={skillPage} onChange={setSkillPage} />
				</>
			) : (
				<div className="resource-empty-card muted">此会话没有已加载技能。可以导入 SKILL.md 或技能文件夹。</div>
			)}
		</section>
	);
}

export function LoadedExtensionsPanel({ extensions, loading }: { extensions: string[]; loading: boolean }) {
	const [page, setPage] = useState(1);
	const visibleExtensions = extensions.slice((page - 1) * pageSize, page * pageSize);
	const extensionGrid = useRef<HTMLDivElement>(null);
	useSpringLayout(extensionGrid, visibleExtensions.join("\0"));
	useEffect(() => {
		setPage((current) => Math.min(current, Math.max(1, Math.ceil(extensions.length / pageSize))));
	}, [extensions.length]);
	return (
		<section className="loaded-extensions">
			<div className="section-heading-row">
				<div>
					<h2>
						当前会话已加载插件入口 <Chip size="small" label={extensions.length} />
					</h2>
					<p className="muted">这些入口由已安装插件提供；可在上方管理插件安装和应用状态。</p>
				</div>
			</div>
			{loading ? (
				<CircularProgress size={22} />
			) : extensions.length ? (
				<>
					<div ref={extensionGrid} className="loaded-plugin-grid">
						{visibleExtensions.map((path) => (
							<article className="loaded-plugin-card" key={path}>
								<div className="skill-card-heading">
									<Sparkles size={17} />
									<strong>插件入口</strong>
								</div>
								<code title={path}>{path}</code>
								<Chip size="small" label="已加载" />
							</article>
						))}
					</div>
					<ResourcePagination count={extensions.length} page={page} onChange={setPage} />
				</>
			) : (
				<div className="resource-empty-card muted">当前会话没有已加载的插件入口。</div>
			)}
		</section>
	);
}
