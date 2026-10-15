import { Chip } from "@mui/material";
import type { ToolCall } from "../../../shared/src/protocol.ts";
import { SpringDisclosure } from "./SpringDisclosure.tsx";
import { Globe, Terminal } from "./WorkbenchIcons.tsx";

export function ToolCard({ tool }: { tool: ToolCall }) {
	const labels = { approval: "等待确认", running: "执行中", completed: "已完成", failed: "失败" };
	return (
		<SpringDisclosure
			className={`tool-card tool-${tool.status}`}
			label={
				<>
					{tool.name === "browser" ? <Globe size={17} /> : <Terminal size={17} />}
					<strong>{tool.name}</strong>
					<Chip
						size="small"
						label={labels[tool.status]}
						color={
							tool.status === "failed"
								? "error"
								: tool.status === "approval"
									? "warning"
									: tool.status === "completed"
										? "success"
										: "primary"
						}
					/>
					<span className="grow" />
					{tool.durationMs !== undefined && <small>{(tool.durationMs / 1000).toFixed(2)}s</small>}
				</>
			}
		>
			<div className="tool-details">
				<span className="eyebrow">输入</span>
				<pre>{JSON.stringify(tool.input, null, 2)}</pre>
				{tool.output !== undefined && (
					<>
						<span className="eyebrow">输出</span>
						{tool.name === "browser" &&
						typeof tool.output === "object" &&
						tool.output !== null &&
						"content" in tool.output &&
						Array.isArray(tool.output.content) ? (
							tool.output.content.map((block: unknown) => {
								if (typeof block !== "object" || block === null)
									return <pre key={JSON.stringify(block)}>{JSON.stringify(block)}</pre>;
								if (
									"type" in block &&
									block.type === "image" &&
									"mimeType" in block &&
									typeof block.mimeType === "string" &&
									["image/jpeg", "image/png", "image/webp"].includes(block.mimeType) &&
									"data" in block &&
									typeof block.data === "string"
								)
									return (
										<img
											key="screenshot"
											className="tool-browser-image"
											src={`data:${block.mimeType};base64,${block.data}`}
											alt="浏览器工具返回的页面截图"
										/>
									);
								return (
									<pre
										key={
											"text" in block && typeof block.text === "string" ? block.text : JSON.stringify(block)
										}
									>
										{"text" in block && typeof block.text === "string"
											? block.text
											: JSON.stringify(block, null, 2)}
									</pre>
								);
							})
						) : (
							<pre>{typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2)}</pre>
						)}
						{tool.name === "browser" &&
							typeof tool.output === "object" &&
							tool.output !== null &&
							"details" in tool.output && <pre>{JSON.stringify(tool.output.details, null, 2)}</pre>}
					</>
				)}
			</div>
		</SpringDisclosure>
	);
}
