import { type RefObject, useLayoutEffect, useRef } from "react";
import { type SpringPresetName, SpringValue } from "../theme/motion.ts";

/** Keeps surviving list rows visually in place while the layout moves underneath them. */
export function useSpringLayout<T extends HTMLElement>(
	container: RefObject<T | null>,
	itemsKey: string,
	preset: SpringPresetName = "gentle",
): void {
	const previousTops = useRef(new Map<HTMLElement, number>());
	const states = useRef(new Map<HTMLElement, SpringValue>());
	const previousKey = useRef<string | undefined>(undefined);
	useLayoutEffect(
		() => () => {
			for (const spring of states.current.values()) spring.stop();
			states.current.clear();
		},
		[],
	);
	useLayoutEffect(() => {
		if (previousKey.current === itemsKey) return;
		previousKey.current = itemsKey;
		const root = container.current;
		if (!root) return;
		const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
		const reduceMotion = motionQuery.matches;
		const stopLayoutMotion = () => {
			if (!motionQuery.matches) return;
			for (const [row, spring] of states.current) {
				spring.stop();
				row.style.translate = "none";
			}
			states.current.clear();
		};
		motionQuery.addEventListener("change", stopLayoutMotion);
		const nextTops = new Map<HTMLElement, number>();
		for (const row of Array.from(root.children)) {
			if (!(row instanceof HTMLElement)) continue;
			const spring = states.current.get(row);
			const rectangle = row.getBoundingClientRect();
			const layoutTop = rectangle.top - (spring?.position ?? 0);
			const previousTop = previousTops.current.get(row);
			nextTops.set(row, layoutTop);
			if (reduceMotion) {
				row.style.translate = "none";
				if (spring) {
					spring.stop();
					states.current.delete(row);
				}
				continue;
			}
			if (previousTop === undefined) continue;

			const activeSpring = spring ?? new SpringValue();
			activeSpring.set(previousTop - layoutTop + activeSpring.position, activeSpring.velocity);
			states.current.set(row, activeSpring);
			activeSpring.animate(
				0,
				preset,
				(position) => {
					row.style.translate = position === 0 ? "none" : `0 ${position}px`;
				},
				() => states.current.delete(row),
				reduceMotion,
				0.01,
				0.1,
			);
		}
		for (const [row, state] of states.current) {
			if (!root.contains(row)) {
				state.stop();
				states.current.delete(row);
			}
		}
		previousTops.current = nextTops;
		return () => motionQuery.removeEventListener("change", stopLayoutMotion);
	}, [container, itemsKey, preset]);
}
