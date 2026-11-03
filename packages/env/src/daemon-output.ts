import type { ShellOutputInfo, ShellOutputWindow } from "@earendil-works/pi-durable/env";

/** Coalesce command output while retaining more than the caller's tail window. */
export class DaemonOutput {
	private text = "";
	private stream: "stdout" | "stderr" = "stdout";
	private skipped = { bytes: 0, newlines: 0, endsWithNewline: false };
	private timer?: ReturnType<typeof setTimeout>;
	private window?: ShellOutputWindow;
	private emit: (text: string, info: ShellOutputInfo) => void;
	constructor(window: ShellOutputWindow | undefined, emit: (text: string, info: ShellOutputInfo) => void) {
		this.window = window;
		this.emit = emit;
	}
	push(text: string, info: ShellOutputInfo): void {
		if (!this.window) {
			this.emit(text, info);
			return;
		}
		this.text += text;
		this.stream = info.stream;
		const retain = Math.max(32768, this.window.maxBytes + 4);
		if (this.text.length > retain * 2) {
			let cut = this.text.length - retain;
			if (this.text.charCodeAt(cut) >= 0xdc00 && this.text.charCodeAt(cut) <= 0xdfff) cut--;
			const removed = this.text.slice(0, cut);
			this.text = this.text.slice(cut);
			this.skipped.bytes += Buffer.byteLength(removed);
			this.skipped.newlines += removed.split("\n").length - 1;
			this.skipped.endsWithNewline = removed.endsWith("\n");
		}
		if (!this.timer)
			this.timer = setTimeout(
				() => this.flush(),
				Math.max(
					1,
					this.window.minIntervalMs,
					(Buffer.byteLength(this.text) / Math.max(1, this.window.bytesPerSecond)) * 1000,
				),
			);
	}
	flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.text)
			this.emit(this.text, { stream: this.stream, ...(this.skipped.bytes ? { skipped: { ...this.skipped } } : {}) });
		this.text = "";
		this.skipped = { bytes: 0, newlines: 0, endsWithNewline: false };
	}
}
