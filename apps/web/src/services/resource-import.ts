import type { ResourceImportFile } from "../../../shared/src/protocol.ts";

const maximumFileCount = 300;
const maximumTotalBytes = 7 * 1024 * 1024;
const excludedSegments = new Set([".git", ".pi", ".pi-console", "node_modules", "__macosx"]);

function isExcluded(path: string): boolean {
	return path.split(/[\\/]/u).some((segment) => {
		const normalized = segment.toLowerCase();
		return excludedSegments.has(normalized) || normalized === ".env" || normalized.startsWith(".env.");
	});
}

async function encodeFile(file: File, path: string): Promise<ResourceImportFile> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return { path, base64: btoa(binary) };
}

export async function encodeResourceImportFiles(
	selectedFiles: FileList | readonly File[],
): Promise<ResourceImportFile[]> {
	const files = Array.from(selectedFiles)
		.map((file) => ({ file, path: file.webkitRelativePath || file.name }))
		.filter(({ path }) => !isExcluded(path));
	if (!files.length) throw new Error("所选内容中没有可导入文件。");
	if (files.length > maximumFileCount) throw new Error(`最多可导入 ${maximumFileCount} 个文件。`);
	const totalBytes = files.reduce((total, { file }) => total + file.size, 0);
	if (totalBytes > maximumTotalBytes) throw new Error("导入内容不能超过 7 MB；请移除大型资源或依赖目录后重试。");
	return Promise.all(files.map(({ file, path }) => encodeFile(file, path)));
}
