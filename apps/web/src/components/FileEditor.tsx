import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Keep the existing local worker and language contributions; no public CDN is used.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });
monaco.editor.defineTheme("pi-light", {
	base: "vs",
	inherit: true,
	rules: [],
	colors: {
		"editor.background": "#f7f4f8",
		"editor.foreground": "#25232a",
		"editorGutter.background": "#f7f4f8",
		"editorLineNumber.foreground": "#8b8592",
		"editorLineNumber.activeForeground": "#51496a",
		"editor.lineHighlightBackground": "#efebf2",
		"editor.selectionBackground": "#dcd3eb",
	},
});
monaco.editor.defineTheme("pi-dark", {
	base: "vs-dark",
	inherit: true,
	rules: [],
	colors: {
		"editor.background": "#211f26",
		"editor.foreground": "#e6e0e9",
		"editorGutter.background": "#211f26",
		"editorLineNumber.foreground": "#938f99",
		"editorLineNumber.activeForeground": "#d0bcff",
		"editor.lineHighlightBackground": "#29262f",
		"editor.selectionBackground": "#4a4458",
	},
});

export default function FileEditor({
	path,
	language,
	value,
	dark,
	readOnly,
	onChange,
}: {
	path: string;
	language: string;
	value: string;
	dark: boolean;
	readOnly: boolean;
	onChange: (value: string | undefined) => void;
}) {
	return (
		<Editor
			height="100%"
			path={path}
			language={language}
			value={value}
			theme={dark ? "pi-dark" : "pi-light"}
			onChange={onChange}
			options={{
				minimap: { enabled: false },
				fontSize: 13,
				readOnly,
				scrollBeyondLastLine: false,
				wordWrap: "on",
				automaticLayout: true,
			}}
		/>
	);
}
