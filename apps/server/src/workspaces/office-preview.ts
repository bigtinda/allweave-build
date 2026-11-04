import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HttpError } from "../security.ts";

const execute = promisify(execFile);
let queue: Promise<unknown> = Promise.resolve();

export function officePreview(buffer: Buffer, path: string): Promise<{ base64: string }> {
	const extension = extname(path).toLowerCase();
	if (![".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"].includes(extension))
		throw new HttpError(415, "不支持此文档格式");
	if (buffer.length > 20 * 1024 * 1024) throw new HttpError(413, "文档必须小于 20 MB");
	const job = queue
		.catch(() => {})
		.then(async () => {
			const directory = await mkdtemp(join(tmpdir(), "allweave-office-"));
			try {
				const input = join(directory, `document${extension}`);
				await writeFile(input, buffer);
				if (process.platform === "win32") {
					await execute(
						"powershell.exe",
						[
							"-NoProfile",
							"-NonInteractive",
							"-File",
							fileURLToPath(new URL("./office-preview.ps1", import.meta.url)),
							input,
							join(directory, "document.pdf"),
						],
						{ windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024 },
					);
				} else {
					await execute(
						"libreoffice",
						[
							"--headless",
							`-env:UserInstallation=file://${directory}/profile`,
							"--convert-to",
							"pdf",
							"--outdir",
							directory,
							input,
						],
						{ timeout: 90_000 },
					);
				}
				return { base64: (await readFile(join(directory, "document.pdf"))).toString("base64") };
			} catch {
				throw new HttpError(
					422,
					"文档转换失败。请确认已安装并初始化 WPS / Office（Linux 需 LibreOffice），然后重试。",
				);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	queue = job;
	return job;
}
