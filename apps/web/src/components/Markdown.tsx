import { Button } from "@mui/material";
import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Children, isValidElement, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function codeText(node: ReactNode): string {
	return Children.toArray(node)
		.map((child) =>
			typeof child === "string" || typeof child === "number"
				? String(child)
				: isValidElement<{ children?: ReactNode }>(child)
					? codeText(child.props.children)
					: "",
		)
		.join("");
}
function CodeBlock({ children }: { children?: ReactNode }) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState(false);
	const element = Children.toArray(children).find((child) => isValidElement(child));
	const language = isValidElement<{ className?: string }>(element)
		? (element.props.className?.match(/language-([^ ]+)/)?.[1] ?? "code")
		: "code";
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(codeText(children));
			setCopied(true);
			setError(false);
		} catch {
			setError(true);
		}
	};
	return (
		<details className="code-block" open>
			<summary>
				<span>{language}</span>
				<Button
					size="small"
					startIcon={copied ? <Check size={14} /> : <Copy size={14} />}
					onClick={(event) => {
						event.preventDefault();
						void copy();
					}}
				>
					{error ? "复制失败" : copied ? "已复制" : "复制"}
				</Button>
			</summary>
			<pre>{children}</pre>
		</details>
	);
}
export function Markdown({ text }: { text: string }) {
	return (
		<div className="markdown">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeHighlight]}
				components={{
					pre: CodeBlock,
					a: ({ children, ...props }) => (
						<a {...props} target="_blank" rel="noopener noreferrer">
							{children}
						</a>
					),
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}
