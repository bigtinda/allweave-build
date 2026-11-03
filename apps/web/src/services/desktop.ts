export interface DesktopWindow {
	minimize(): Promise<void>;
	toggleMaximize(): Promise<void>;
	close(): Promise<void>;
	isMaximized(): Promise<boolean>;
}
declare global {
	interface Window {
		allweaveDesktop?: DesktopWindow;
	}
}
export const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.allweaveDesktop);
