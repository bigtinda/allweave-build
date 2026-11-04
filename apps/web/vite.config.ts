import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@allweave/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
		},
	},
	build: {
		manifest: true,
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes("commonjsHelpers") || id.includes("vite/preload-helper")) return "react-vendor";
					const path = id.replaceAll("\\", "/").split("/node_modules/").at(-1) ?? "";
					if (path.startsWith("@monaco-editor/")) return "monaco-react";
					if (path.startsWith("monaco-editor/esm/vs/")) {
						const parts = path.slice("monaco-editor/esm/vs/".length).split("/");
						// Keep the shared view bases separate from widgets that instantiate view parts.
						if (
							/\/editor\/browser\/(?:view\/(?:viewPart|viewLayer|renderingContext|dynamicViewOverlay)|config\/domFontInfo)\.js$/u.test(path)
						) return "monaco-view-foundation";
						if (parts[0] === "editor" && parts[1] === "common" && ["model", "services"].includes(parts[2]))
							return "monaco-model-services";
						if (parts[0] === "editor" && parts[1] === "browser" && parts[2] !== "viewParts")
							return "monaco-editor-browser";
						if (parts[0] === "platform" && ["actions", "contextview"].includes(parts[1]))
							return "monaco-platform-actions";
						if (parts[0] === "editor") return `monaco-editor-${parts[1]}-${parts[2]}`;
						return `monaco-${parts[0]}-${parts[1]}`;
					}
					if (path.startsWith("@mui/") || path.startsWith("@emotion/")) return "ui-vendor";
					if (/^(react(?:-dom)?|scheduler)\//u.test(path)) return "react-vendor";
					if (path.startsWith("highlight.js/")) return "syntax-highlighting";
					if (id.includes("/node_modules/")) return "vendor";
				},
			},
		},
	},
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": "http://127.0.0.1:8787",
			"/ws": { target: "ws://127.0.0.1:8787", ws: true },
		},
	},
});
