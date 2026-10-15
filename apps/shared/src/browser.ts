export type BrowserCommand =
	| { action: "navigate"; url: string }
	| { action: "snapshot" | "back" | "forward" | "reload" | "close" }
	| { action: "click"; selector: string }
	| { action: "click"; x: number; y: number }
	| { action: "fill"; selector: string; text: string }
	| { action: "type"; text: string }
	| { action: "press"; key: string }
	| { action: "scroll"; deltaY: number };

export interface BrowserSnapshot {
	url: string;
	title: string;
	text: string;
	image: string;
	width: number;
	height: number;
}
