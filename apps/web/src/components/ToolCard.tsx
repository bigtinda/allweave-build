import { Chip } from "@mui/material";
import { Terminal } from "lucide-react";
import type { ToolCall } from "../../../shared/src/protocol.ts";
import { SpringDisclosure } from "./SpringDisclosure.tsx";

export function ToolCard({ tool }: { tool: ToolCall }) {
	const labels = { approval: "等待确认", running: "执行中", completed: "已完成", failed: "失败" };
	return (
		<SpringDisclosure
			className="tool-card"
			label={
				<>
					<Terminal size={17} />
					<strong>{tool.name}</strong>
					<Chip size="small" label={labels[tool.status]} color={tool.status === "failed" ? "error" : "default"} />
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
						<pre>{typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2)}</pre>
					</>
				)}
			</div>
		</SpringDisclosure>
	);
}
