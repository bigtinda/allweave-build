import { useCallback, useEffect, useState } from "react";
import { BuildMark } from "./BuildMark.tsx";
import { Minus, Restore, Square, X } from "./WorkbenchIcons.tsx";

/** Draggable desktop title bar with in-app window controls. */
export function WindowTitleBar() {
	const appWindow = window.allweaveDesktop;
	const [maximized, setMaximized] = useState(false);
	const syncMaximized = useCallback(() => {
		void appWindow?.isMaximized().then(setMaximized, () => {});
	}, [appWindow]);

	useEffect(() => {
		syncMaximized();
		window.addEventListener("resize", syncMaximized);
		return () => window.removeEventListener("resize", syncMaximized);
	}, [syncMaximized]);

	return (
		<header className="window-titlebar">
			<div className="window-titlebar-brand">
				<BuildMark className="window-titlebar-mark" />
				<span>AllWeave Build · 构序</span>
			</div>
			<div className="window-titlebar-controls">
				<button
					type="button"
					className="window-control"
					aria-label="最小化"
					title="最小化"
					onClick={() => void appWindow?.minimize()}
				>
					<Minus size={14} strokeWidth={1.6} />
				</button>
				<button
					type="button"
					className="window-control"
					aria-label={maximized ? "还原窗口" : "最大化"}
					title={maximized ? "还原窗口" : "最大化"}
					onClick={() => void appWindow?.toggleMaximize().then(syncMaximized, () => {})}
				>
					{maximized ? <Restore size={13} strokeWidth={1.6} /> : <Square size={12} strokeWidth={1.6} />}
				</button>
				<button
					type="button"
					className="window-control is-close"
					aria-label="关闭窗口"
					title="关闭"
					onClick={() => void appWindow?.close()}
				>
					<X size={15} strokeWidth={1.6} />
				</button>
			</div>
		</header>
	);
}
