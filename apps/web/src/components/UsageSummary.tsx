import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from "@mui/material";
import { useState } from "react";
import type { SessionDetail } from "../../../shared/src/protocol.ts";

export function UsageSummary({ tokens }: { tokens: SessionDetail["tokens"] }) {
	const [open, setOpen] = useState(false);
	const inputTotal = tokens ? tokens.input + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) : 0;
	const hitRate =
		tokens?.cacheRead !== undefined && inputTotal > 0
			? `${((tokens.cacheRead / inputTotal) * 100).toFixed(1)}%`
			: "暂无数据";
	return (
		<>
			<Button
				className="usage-summary-button"
				size="small"
				onClick={() => setOpen(true)}
				aria-label="查看 Token 用量与缓存统计"
				title="查看完整 Token 用量与缓存统计"
			>
				缓存命中 {hitRate} · {tokens ? `${tokens.total.toLocaleString()} Tokens` : "暂无用量"}
			</Button>
			<Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs" aria-labelledby="usage-title">
				<DialogTitle id="usage-title">会话用量与缓存</DialogTitle>
				<DialogContent>
					{tokens ? (
						<dl className="usage-details">
							<dt>缓存命中率</dt>
							<dd>{hitRate}</dd>
							<dt>累计 Token</dt>
							<dd>{tokens.total.toLocaleString()}</dd>
							<dt>未缓存输入</dt>
							<dd>{tokens.input.toLocaleString()}</dd>
							<dt>输出 Token</dt>
							<dd>{tokens.output.toLocaleString()}</dd>
							<dt>缓存读取</dt>
							<dd>{tokens.cacheRead?.toLocaleString() ?? "未记录"}</dd>
							<dt>缓存写入</dt>
							<dd>{tokens.cacheWrite?.toLocaleString() ?? "未记录"}</dd>
							<dt>估算费用（USD）</dt>
							<dd>{tokens.cost !== undefined ? `$${tokens.cost.toFixed(4)}` : "未记录"}</dd>
						</dl>
					) : (
						<p className="muted">模型完成回复后显示统计。</p>
					)}
					<p className="muted">
						统计为当前会话累计用量，包含重复发送的上下文。命中率 = 缓存读取 ÷（未缓存输入 + 缓存读取 +
						缓存写入）。
					</p>
					<p className="muted">缓存数据来自供应商；未报告时数值可能为 0。费用按模型价格估算，以供应商账单为准。</p>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setOpen(false)}>关闭</Button>
				</DialogActions>
			</Dialog>
		</>
	);
}
