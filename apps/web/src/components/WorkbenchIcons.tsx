import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number };

function icon(path: string) {
	return function WorkbenchIcon({ size = 20, strokeWidth = 2.4, ...props }: IconProps) {
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
				focusable="false"
				{...props}
			>
				<path d={path} />
			</svg>
		);
	};
}

export const ArrowLeft = icon("M20 12H4m6-6-6 6 6 6");
export const ArrowUp = icon("M12 20V4m-6 6 6-6 6 6");
export const ChevronDown = icon("m6 9 6 6 6-6");
export const ChevronLeft = icon("m15 6-6 6 6 6");
export const ChevronRight = icon("m9 6 6 6-6 6");
export const Check = icon("m5 12 4 4L19 6");
export const Plus = icon("M12 5v14M5 12h14");
export const X = icon("m6 6 12 12M6 18 18 6");
export const Menu = icon("M4 6h16M4 12h16M4 18h16");
export const Folder = icon("M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3");
export const FolderOpen = icon("M3 19V5h7l2 3h8v3M3 19l3-8h16l-3 8H3Z");
export const FolderUp = icon("M3 20V5h7l2 3h9v12H3Zm9-3v-6m-3 3 3-3 3 3");
export const BookOpen = icon("M12 6v15M3 4h5l4 2 4-2h5v15h-5l-4 2-4-2H3V4Z");
export const MessageSquare = icon("M3 4h18v13H8l-5 4V4ZM7 8h10M7 12h6");
export const Search = icon("M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1 5 6 6");
export const Settings2 = icon("M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10M10 3v6m4 0v6M6 15v6");
export const MoreHorizontal = icon("M5 12h.01M12 12h.01M19 12h.01");
export const Moon = icon("M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z");
export const Sun = icon(
	"M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
);
export const Trash2 = icon("M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7");
export const PanelRight = icon("M3 4h18v16H3V4Zm12 0v16");
export const Sparkles = icon("m12 3 2 6 6 3-6 2-2 7-2-7-6-2 6-3 2-6Z");
export const Square = icon("M6 6h12v12H6V6Z");
export const Terminal = icon("M3 4h18v16H3V4Zm4 4 4 4-4 4m6 0h4");
export const Shield = icon("M12 3 3 7v6l3 5 6 3 6-3 3-5V7l-9-4Z");
export const Lightbulb = icon("M8 17v-3a6 6 0 1 1 8 0v3H8Zm0 3h8m-6 3h4");
export const Hand = icon(
	"M8 12V5a2 2 0 0 1 4 0v7-9a2 2 0 0 1 4 0v9-6a2 2 0 0 1 4 0v8c0 5-3 7-7 7-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-2l2 2Z",
);
export const Zap = icon("m13 2-9 12h7l-1 8 10-13h-7V2Z");
export const Paperclip = icon("m9 14 7-7a2 2 0 0 1 3 3l-9 9a4 4 0 0 1-6-6L15 2");
export const ExternalLink = icon("M14 3h7v7m0-7L10 14M10 4H4v16h16v-6");
export const RefreshCw = icon("M20 9a8 8 0 0 0-14-3L3 9m0-6v6h6M4 15a8 8 0 0 0 14 3l3-3m0 6v-6h-6");
export const KeyRound = icon("M14 8a5 5 0 1 1 5 5h-3l-2 2h-3v3H7v3H3v-4l11-9Z");
export const Database = icon(
	"M21 5c0 2-4 3-9 3S3 7 3 5s4-3 9-3 9 1 9 3ZM3 5v14c0 2 4 3 9 3s9-1 9-3V5M3 12c0 2 4 3 9 3s9-1 9-3",
);
export const HardDrive = icon("M6 4h12l3 10v6H3v-6L6 4ZM3 14h18M16 17h2");
export const PackageOpen = icon("m12 3 9 5-9 5-9-5 9-5ZM3 8v10l9 4 9-4V8m-9 5v9M8 5l9 5");
export const FileCode = icon("M5 2h9l5 5v15H5V2Zm9 0v5h5m-9 5-3 3 3 3m4-6 3 3-3 3");
export const Maximize2 = icon("M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5");
export const Minimize2 = icon("M3 8h5V3m13 5h-5V3M3 16h5v5m13-5h-5v5");
export const Globe = icon("M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4 5 4 13 0 18-4-5-4-13 0-18Z");
export const GitBranch = icon(
	"M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 0c0-6 12 0 12-9m0-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
);
export const Clock = icon("M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2");
