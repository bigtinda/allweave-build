export type BrowserCommand =
	| { action: "navigate"; url: string }
	| { action: "resize"; width: number; height: number }
	| { action: "snapshot" | "back" | "forward" | "reload" | "close" }
	| { action: "click"; selector: string }
	| { action: "click"; x: number; y: number }
	| {
			action: "pointer";
			phase: "move" | "down" | "up";
			x: number;
			y: number;
			button?: "left" | "middle" | "right";
			clickCount?: number;
	  }
	| { action: "fill"; selector: string; text: string }
	| { action: "hover"; selector: string }
	| { action: "select"; selector: string; values: string[] }
	| { action: "check"; selector: string; checked: boolean }
	| { action: "drag"; selector: string; target: string }
	| { action: "wait"; selector: string }
	| { action: "newTab"; url?: string }
	| { action: "switchTab" | "closeTab"; tabId: string }
	| { action: "dialog"; accept: boolean; text?: string }
	| { action: "copy"; cut?: boolean }
	| { action: "type"; text: string }
	| { action: "press"; key: string }
	| { action: "scroll"; deltaY: number; deltaX?: number; x?: number; y?: number };

export interface BrowserTab {
	id: string;
	url: string;
	title: string;
}

export type BrowserStreamEvent =
	| { type: "frame"; image: string; tabId: string; width: number; height: number }
	| { type: "state"; snapshot: BrowserSnapshot | null }
	| { type: "error"; error: string };

export interface BrowserSnapshot {
	url: string;
	title: string;
	text: string;
	image: string;
	width: number;
	height: number;
	tabId: string;
	tabs: BrowserTab[];
	dialog?: { type: string; message: string; defaultValue: string };
	clipboard?: string;
}
