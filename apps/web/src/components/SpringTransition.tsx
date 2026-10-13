import type { TransitionProps } from "@mui/material/transitions";
import type { CSSProperties, ReactElement, Ref } from "react";
import {
	Children,
	cloneElement,
	forwardRef,
	isValidElement,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { type SpringPresetName, SpringValue } from "../theme/motion.ts";

interface SpringTransitionProps extends TransitionProps {
	preset?: SpringPresetName;
	direction?: "left" | "right" | "up" | "down";
	distance?: number;
}

interface StyledTransitionChild {
	style?: CSSProperties;
	ref?: Ref<HTMLElement>;
	inert?: boolean;
}

/** A retargetable spring transition for MUI slots. It keeps the current velocity when reversed. */
export const SpringTransition = forwardRef<HTMLElement, SpringTransitionProps>(function SpringTransition(
	{
		children,
		in: isIn = false,
		mountOnEnter = false,
		unmountOnExit = false,
		preset = "smooth",
		direction,
		distance = 10,
		onEnter,
		onEntering,
		onEntered,
		onExit,
		onExiting,
		onExited,
	},
	forwardedRef,
) {
	const [mounted, setMounted] = useState(isIn || !mountOnEnter);
	const nodeRef = useRef<HTMLElement | null>(null);
	const spring = useRef(new SpringValue());
	const lastTarget = useRef<number | undefined>(undefined);
	const lifecycle = useRef({ onEnter, onEntering, onEntered, onExit, onExiting, onExited });
	lifecycle.current = { onEnter, onEntering, onEntered, onExit, onExiting, onExited };

	const child = Children.only(children);
	if (!isValidElement(child)) throw new Error("SpringTransition requires one element child");
	const styledChild = child as ReactElement<StyledTransitionChild>;
	const childRef = styledChild.props.ref;
	const setNode = useCallback(
		(node: HTMLElement | null) => {
			nodeRef.current = node;
			if (typeof childRef === "function") childRef(node);
			else if (childRef) childRef.current = node;
			if (typeof forwardedRef === "function") forwardedRef(node);
			else if (forwardedRef) forwardedRef.current = node;
		},
		[childRef, forwardedRef],
	);

	useLayoutEffect(() => {
		if (isIn && !mounted) {
			setMounted(true);
			return;
		}
		const node = nodeRef.current;
		if (!node) return;

		const target = isIn ? 1 : 0;
		const previousTarget = lastTarget.current;
		if (lastTarget.current !== target) {
			const handlers = lifecycle.current;
			if (isIn) {
				handlers.onEnter?.(node, false);
				handlers.onEntering?.(node, false);
			} else if (lastTarget.current !== undefined) {
				handlers.onExit?.(node);
				handlers.onExiting?.(node);
			}
			lastTarget.current = target;
		}
		const notifyRest = previousTarget !== undefined || isIn;

		let motionQuery: MediaQueryList | undefined;
		const paint = (value: number) => {
			const offset = (direction ? distance : 0) * (1 - value);
			const translation =
				direction === "left"
					? `translate(${-offset}px)`
					: direction === "right"
						? `translate(${offset}px)`
						: direction === "up"
							? `translate(0, ${-offset}px)`
							: direction === "down"
								? `translate(0, ${offset}px)`
								: "";
			node.style.opacity = String(value);
			node.style.transform = `${translation} scale(${0.985 + value * 0.015})`.trim();
			node.style.pointerEvents = isIn ? "" : "none";
		};
		const finish = () => {
			if (!notifyRest) return;
			if (target === 1) lifecycle.current.onEntered?.(node, false);
			else {
				lifecycle.current.onExited?.(node);
				if (unmountOnExit) setMounted(false);
			}
		};
		const reduceMotion = () => spring.current.animate(target, preset, paint, finish, motionQuery?.matches ?? false);
		motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
		reduceMotion();
		motionQuery.addEventListener("change", reduceMotion);

		return () => {
			spring.current.stop();
			motionQuery?.removeEventListener("change", reduceMotion);
		};
	}, [direction, distance, isIn, mounted, preset, unmountOnExit]);

	if (!mounted) return null;
	const currentPosition = spring.current.position;
	const offset = (direction ? distance : 0) * (1 - currentPosition);
	const translation =
		direction === "left"
			? `translate(${-offset}px)`
			: direction === "right"
				? `translate(${offset}px)`
				: direction === "up"
					? `translate(0, ${-offset}px)`
					: direction === "down"
						? `translate(0, ${offset}px)`
						: "";
	const currentTransform = `${translation} scale(${0.985 + currentPosition * 0.015})`.trim();
	return cloneElement(styledChild, {
		ref: setNode,
		inert: !isIn,
		style: {
			...styledChild.props.style,
			opacity: currentPosition,
			transform: currentTransform,
			transformOrigin: styledChild.props.style?.transformOrigin,
		},
	});
});
