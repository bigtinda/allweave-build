import { useEffect, useRef } from "react";
import type { BrowserCommand, BrowserSnapshot } from "../../../shared/src/browser.ts";

export function BrowserSurface({
	snapshot,
	image,
	disabled,
	input,
	copy,
}: {
	snapshot: BrowserSnapshot;
	image: string;
	disabled: boolean;
	input: (command: BrowserCommand) => void;
	copy: (cut: boolean) => void;
}) {
	const surface = useRef<HTMLFieldSetElement>(null);
	const keyboard = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const move = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const point = (clientX: number, clientY: number) => {
		const rect = surface.current!.getBoundingClientRect();
		return {
			x: Math.min(snapshot.width - 1, Math.max(0, ((clientX - rect.left) * snapshot.width) / rect.width)),
			y: Math.min(snapshot.height - 1, Math.max(0, ((clientY - rect.top) * snapshot.height) / rect.height)),
		};
	};
	useEffect(() => {
		const element = surface.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			if (disabled) return;
			const rect = element.getBoundingClientRect();
			const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? snapshot.height : 1;
			input({
				action: "scroll",
				deltaY: Math.max(-4000, Math.min(4000, event.deltaY * scale)),
				deltaX: Math.max(-4000, Math.min(4000, event.deltaX * scale)),
				x: Math.min(snapshot.width - 1, Math.max(0, ((event.clientX - rect.left) * snapshot.width) / rect.width)),
				y: Math.min(snapshot.height - 1, Math.max(0, ((event.clientY - rect.top) * snapshot.height) / rect.height)),
			});
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => {
			element.removeEventListener("wheel", wheel);
			clearTimeout(move.current);
		};
	}, [disabled, input, snapshot.width, snapshot.height]);
	return (
		<fieldset
			ref={surface}
			className="browser-screen browser-interactive-screen"
			style={{ aspectRatio: `${snapshot.width} / ${snapshot.height}` }}
			aria-label="网页交互区域，点击后可直接输入、使用快捷键和滚轮"
			onContextMenu={(event) => event.preventDefault()}
			onPointerDown={(event) => {
				if (disabled) return;
				event.preventDefault();
				keyboard.current?.focus({ preventScroll: true });
				event.currentTarget.setPointerCapture(event.pointerId);
				clearTimeout(move.current);
				input({
					action: "pointer",
					phase: "down",
					...point(event.clientX, event.clientY),
					button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
					clickCount: Math.min(3, event.detail || 1),
				});
			}}
			onPointerMove={(event) => {
				if (disabled) return;
				clearTimeout(move.current);
				const position = point(event.clientX, event.clientY);
				move.current = setTimeout(() => input({ action: "pointer", phase: "move", ...position }), 35);
			}}
			onPointerUp={(event) => {
				if (disabled) return;
				clearTimeout(move.current);
				input({
					action: "pointer",
					phase: "up",
					...point(event.clientX, event.clientY),
					button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
					clickCount: Math.min(3, event.detail || 1),
				});
				if (event.currentTarget.hasPointerCapture(event.pointerId))
					event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={(event) => {
				if (!disabled) input({ action: "pointer", phase: "up", ...point(event.clientX, event.clientY) });
			}}
		>
			{image && (
				<img src={`data:image/jpeg;base64,${image}`} alt={snapshot.title || "浏览器页面"} draggable={false} />
			)}
			<textarea
				ref={keyboard}
				className="browser-keyboard-input"
				aria-label="网页键盘输入"
				disabled={disabled}
				autoComplete="off"
				autoCapitalize="off"
				spellCheck={false}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={(event) => {
					composing.current = false;
					if (event.currentTarget.value) input({ action: "type", text: event.currentTarget.value });
					event.currentTarget.value = "";
				}}
				onChange={(event) => {
					if (composing.current) return;
					if (event.currentTarget.value) input({ action: "type", text: event.currentTarget.value });
					event.currentTarget.value = "";
				}}
				onPaste={(event) => {
					event.preventDefault();
					input({ action: "type", text: event.clipboardData.getData("text/plain") });
				}}
				onKeyDown={(event) => {
					if (
						event.nativeEvent.isComposing ||
						composing.current ||
						["Control", "Meta", "Alt", "Shift", "Process", "Dead"].includes(event.key)
					)
						return;
					if ((event.ctrlKey || event.metaKey) && ["c", "x"].includes(event.key.toLowerCase())) {
						event.preventDefault();
						copy(event.key.toLowerCase() === "x");
						return;
					}
					if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
					if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
					event.preventDefault();
					const modifiers = [
						event.ctrlKey ? "Control" : "",
						event.metaKey ? "Meta" : "",
						event.altKey ? "Alt" : "",
						event.shiftKey ? "Shift" : "",
					].filter(Boolean);
					input({ action: "press", key: [...modifiers, event.key === " " ? "Space" : event.key].join("+") });
				}}
			/>
		</fieldset>
	);
}
