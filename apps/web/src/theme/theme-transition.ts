import { flushSync } from "react-dom";

export interface ThemeTransitionOrigin {
	x: number;
	y: number;
}

let activeTransition: ViewTransition | undefined;

export function transitionTheme(update: () => void, origin?: ThemeTransitionOrigin): void {
	activeTransition?.skipTransition();
	if (
		typeof document.startViewTransition !== "function" ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		update();
		return;
	}
	const root = document.documentElement;
	const x = origin?.x ?? window.innerWidth / 2;
	const y = origin?.y ?? window.innerHeight / 2;
	const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
	root.style.setProperty("--theme-transition-x", `${x}px`);
	root.style.setProperty("--theme-transition-y", `${y}px`);
	root.style.setProperty("--theme-transition-radius", `${radius}px`);
	const transition = document.startViewTransition(() => flushSync(update));
	activeTransition = transition;
	void transition.ready.catch(() => {});
	void transition.finished
		.catch(() => {})
		.finally(() => {
			if (activeTransition !== transition) return;
			activeTransition = undefined;
			root.style.removeProperty("--theme-transition-x");
			root.style.removeProperty("--theme-transition-y");
			root.style.removeProperty("--theme-transition-radius");
		});
}
