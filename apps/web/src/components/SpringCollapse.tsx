import { useMediaQuery } from "@mui/material";
import type { TransitionProps } from "@mui/material/transitions";
import { forwardRef, useCallback, useLayoutEffect, useRef, useState } from "react";
import { type SpringPresetName, SpringValue } from "../theme/motion.ts";

interface SpringCollapseProps extends TransitionProps {
	preset?: SpringPresetName;
	fillAvailable?: boolean;
	id?: string;
	className?: string;
	contentClassName?: string;
}

function measureExpandedHeight(root: HTMLDivElement, content: HTMLDivElement, fillAvailable: boolean): number {
	const contentHeight = content.offsetHeight;
	const parent = root.parentElement;
	if (!fillAvailable || !parent) return contentHeight;
	const parentStyle = window.getComputedStyle(parent);
	const padding = Number.parseFloat(parentStyle.paddingTop) + Number.parseFloat(parentStyle.paddingBottom);
	const gap = Number.parseFloat(parentStyle.rowGap) || 0;
	const siblingHeight = Array.from(parent.children)
		.filter((child) => child !== root)
		.reduce((height, child) => height + child.getBoundingClientRect().height, 0);
	const totalGaps = Math.max(0, parent.children.length - 1) * gap;
	return Math.max(contentHeight, parent.clientHeight - padding - siblingHeight - totalGaps);
}

/** Height transition for disclosures and accordions. Retargets from the current height and velocity. */
export const SpringCollapse = forwardRef<HTMLDivElement, SpringCollapseProps>(function SpringCollapse(
	{
		children,
		in: isIn = false,
		mountOnEnter = false,
		unmountOnExit = false,
		preset = "smooth",
		fillAvailable = false,
		onEnter,
		onEntering,
		onEntered,
		onExit,
		onExiting,
		onExited,
		id,
		className,
		contentClassName,
	},
	forwardedRef,
) {
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const [mounted, setMounted] = useState(isIn || !mountOnEnter);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const contentObserver = useRef<ResizeObserver | null>(null);
	const targetHeight = useRef(0);
	const height = useRef(new SpringValue());
	const opacity = useRef(new SpringValue());
	const initialized = useRef(false);
	const lastTarget = useRef<boolean | undefined>(undefined);
	const lifecycle = useRef({ onEnter, onEntering, onEntered, onExit, onExiting, onExited });
	const presetRef = useRef(preset);
	const fillAvailableRef = useRef(fillAvailable);
	const reducedMotionRef = useRef(reducedMotion);
	const openRef = useRef(isIn);
	lifecycle.current = { onEnter, onEntering, onEntered, onExit, onExiting, onExited };
	presetRef.current = preset;
	fillAvailableRef.current = fillAvailable;
	reducedMotionRef.current = reducedMotion;
	openRef.current = isIn;

	const setRoot = useCallback(
		(node: HTMLDivElement | null) => {
			rootRef.current = node;
			if (typeof forwardedRef === "function") forwardedRef(node);
			else if (forwardedRef) forwardedRef.current = node;
		},
		[forwardedRef],
	);
	const setContent = useCallback((node: HTMLDivElement | null) => {
		contentRef.current = node;
		contentObserver.current?.disconnect();
		contentObserver.current = null;
		if (!node || typeof ResizeObserver === "undefined") return;
		const root = rootRef.current;
		let previousHeight = root ? measureExpandedHeight(root, node, fillAvailableRef.current) : node.offsetHeight;
		const observer = new ResizeObserver(() => {
			const activeRoot = rootRef.current;
			if (!openRef.current || !activeRoot) return;
			const nextHeight = measureExpandedHeight(activeRoot, node, fillAvailableRef.current);
			if (nextHeight === targetHeight.current || nextHeight === previousHeight) return;
			previousHeight = nextHeight;
			targetHeight.current = nextHeight;
			height.current.animate(
				nextHeight,
				presetRef.current,
				(position) => {
					if (rootRef.current) rootRef.current.style.height = `${position}px`;
				},
				() => {},
				reducedMotionRef.current,
				0.5,
				2,
			);
		});
		contentObserver.current = observer;
		observer.observe(node);
		if (fillAvailableRef.current && root?.parentElement) {
			observer.observe(root.parentElement);
			for (const sibling of Array.from(root.parentElement.children)) observer.observe(sibling);
		}
	}, []);

	useLayoutEffect(() => {
		if (isIn && !mounted) {
			setMounted(true);
			return;
		}
		const root = rootRef.current;
		const content = contentRef.current;
		if (!root || !content) return;
		if (!initialized.current) {
			const initialHeight = isIn ? measureExpandedHeight(root, content, fillAvailable) : 0;
			height.current.set(initialHeight);
			targetHeight.current = initialHeight;
			opacity.current.set(isIn ? 1 : 0);
			root.style.height = `${initialHeight}px`;
			root.style.opacity = String(isIn ? 1 : 0);
			root.inert = !isIn;
			initialized.current = true;
			lastTarget.current = isIn;
			return;
		}
		if (!mounted) return;

		const targetChanged = lastTarget.current !== isIn;
		if (!targetChanged && !reducedMotion) return;
		const handlers = lifecycle.current;
		if (targetChanged) {
			if (isIn) {
				handlers.onEnter?.(root, false);
				handlers.onEntering?.(root, false);
			} else {
				handlers.onExit?.(root);
				handlers.onExiting?.(root);
			}
		}
		lastTarget.current = isIn;
		root.inert = !isIn;
		const nextHeight = isIn ? measureExpandedHeight(root, content, fillAvailable) : 0;
		targetHeight.current = nextHeight;
		const finish = () => {
			if (isIn) handlers.onEntered?.(root, false);
			else {
				handlers.onExited?.(root);
				if (unmountOnExit) setMounted(false);
			}
		};
		height.current.animate(
			nextHeight,
			preset,
			(position) => {
				root.style.height = `${position}px`;
			},
			finish,
			reducedMotion,
			0.5,
			2,
		);
		opacity.current.animate(
			isIn ? 1 : 0,
			preset,
			(position) => {
				root.style.opacity = String(position);
			},
			() => {},
			reducedMotion,
			0.01,
			0.02,
		);
		return () => {
			height.current.stop();
			opacity.current.stop();
		};
	}, [fillAvailable, isIn, mounted, preset, reducedMotion, unmountOnExit]);

	useLayoutEffect(() => () => contentObserver.current?.disconnect(), []);

	if (!mounted) return null;
	return (
		<div
			ref={setRoot}
			id={id}
			className={className}
			aria-hidden={!isIn}
			inert={!isIn}
			style={{
				height: initialized.current ? `${height.current.position}px` : isIn ? "auto" : 0,
				opacity: initialized.current ? opacity.current.position : isIn ? 1 : 0,
				overflow: "hidden",
			}}
		>
			<div
				ref={setContent}
				className={contentClassName}
				style={contentClassName ? undefined : { display: "flow-root" }}
			>
				{children}
			</div>
		</div>
	);
});
