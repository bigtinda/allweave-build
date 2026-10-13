import type { ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { motionTokens, SpringValue } from "../theme/motion.ts";

type SpringAxis = "horizontal" | "vertical";

interface ExitingPage {
	id: number;
	pageKey: string;
	children: ReactNode;
	direction: -1 | 1;
}

interface PageState {
	pageKey: string;
	pageIndex: number;
	currentId: number;
	nextId: number;
	direction: -1 | 1;
	travelDistance: number;
	exits: ExitingPage[];
}

interface SpringPagesProps {
	pageKey: string;
	pageIndex: number;
	children: ReactNode;
	className?: string;
	axis?: SpringAxis;
	animateHeight?: boolean;
}

function SpringPage({
	id,
	active,
	direction,
	axis,
	animateOnMount,
	onExitComplete,
	onSizeChange,
	children,
	travelDistance,
}: {
	id: number;
	active: boolean;
	direction: -1 | 1;
	axis: SpringAxis;
	animateOnMount: boolean;
	onExitComplete: (id: number) => void;
	onSizeChange?: (id: number, height: number) => void;
	children: ReactNode;
	travelDistance: number;
}) {
	const node = useRef<HTMLDivElement>(null);
	const positionSpring = useRef(new SpringValue());
	const initialized = useRef(false);
	if (!initialized.current) {
		initialized.current = true;
		positionSpring.current.set(active && animateOnMount ? direction * travelDistance : 0);
	}
	const position = positionSpring.current.position;
	const paintPosition = useCallback(
		(position: number) => {
			const element = node.current;
			if (!element) return;
			const offset = axis === "vertical" ? `0, ${position}px, 0` : `${position}px, 0, 0`;
			element.style.transform = `translate3d(${offset})`;
		},
		[axis],
	);
	const measure = useCallback(() => {
		const element = node.current;
		if (active && element) onSizeChange?.(id, element.getBoundingClientRect().height);
	}, [active, id, onSizeChange]);
	useLayoutEffect(() => {
		if (!active || !onSizeChange) return;
		measure();
		const element = node.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [active, measure, onSizeChange]);
	useLayoutEffect(() => {
		const element = node.current;
		if (!element) return;
		const targetPosition = active ? 0 : -direction * travelDistance;
		if (active && !animateOnMount) {
			positionSpring.current.set(0);
			paintPosition(0);
			return;
		}
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		const finish = () => {
			delete element.dataset.pageMoving;
			if (!active) onExitComplete(id);
		};
		const animate = () => {
			if (active) element.dataset.pageMoving = "true";
			const preset = motionTokens.transition.pageSlide.preset;
			positionSpring.current.animate(targetPosition, preset, paintPosition, finish, media.matches);
		};
		animate();
		media.addEventListener("change", animate);
		return () => {
			positionSpring.current.stop();
			media.removeEventListener("change", animate);
		};
	}, [active, animateOnMount, direction, id, onExitComplete, paintPosition, travelDistance]);
	useLayoutEffect(
		() => () => {
			positionSpring.current.stop();
		},
		[],
	);
	return (
		<div
			ref={node}
			className="spring-page-layer"
			data-page-moving={active && animateOnMount ? "true" : undefined}
			aria-hidden={!active}
			inert={!active}
			style={{
				transform: axis === "vertical" ? `translate3d(0, ${position}px, 0)` : `translate3d(${position}px, 0, 0)`,
				pointerEvents: active ? undefined : "none",
			}}
		>
			{children}
		</div>
	);
}

/** Overlaps adjacent pages and retargets their directional springs during quick changes. */
export function SpringPages({
	pageKey,
	pageIndex,
	children,
	className,
	axis = "horizontal",
	animateHeight = false,
}: SpringPagesProps) {
	const root = useRef<HTMLDivElement>(null);
	const heightSpring = useRef(new SpringValue());
	const heightInitialized = useRef(false);
	const activePageId = useRef(0);
	const activeHeight = useRef(0);
	const rendered = useRef({ pageKey, pageIndex, children });
	const { minimumDistance, interPageGap } = motionTokens.transition.pageSlide;
	const [state, setState] = useState<PageState>({
		pageKey,
		pageIndex,
		currentId: 0,
		nextId: 1,
		direction: 1,
		travelDistance: minimumDistance + interPageGap,
		exits: [],
	});
	if (state.pageKey !== pageKey) {
		const previous = rendered.current;
		const distance = axis === "vertical" ? root.current?.clientHeight : root.current?.clientWidth;
		const travelDistance = Math.max(distance ?? 0, minimumDistance) + interPageGap;
		setState((current) => {
			if (current.pageKey === pageKey) return current;
			const direction = pageIndex === current.pageIndex ? current.direction : pageIndex > current.pageIndex ? 1 : -1;
			const returningPage = current.exits.find((page) => page.pageKey === pageKey);
			return {
				pageKey,
				pageIndex,
				currentId: returningPage?.id ?? current.nextId,
				nextId: returningPage ? current.nextId : current.nextId + 1,
				direction,
				travelDistance,
				exits: [
					...current.exits.filter((page) => page.pageKey !== pageKey).map((page) => ({ ...page, direction })),
					{
						id: current.currentId,
						pageKey: current.pageKey,
						children: previous.children,
						direction,
					},
				],
			};
		});
	} else if (state.pageIndex !== pageIndex) {
		setState((current) => {
			if (current.pageKey !== pageKey || current.pageIndex === pageIndex) return current;
			return { ...current, pageIndex, direction: pageIndex > current.pageIndex ? 1 : -1 };
		});
	}
	activePageId.current = state.currentId;
	useLayoutEffect(() => {
		rendered.current = { pageKey, pageIndex, children };
	}, [children, pageIndex, pageKey]);
	useLayoutEffect(() => () => heightSpring.current.stop(), []);
	const paintHeight = useCallback((height: number) => {
		if (root.current) root.current.style.height = `${height}px`;
	}, []);
	const updatePageHeight = useCallback(
		(id: number, height: number) => {
			if (!animateHeight || id !== activePageId.current || !root.current || !Number.isFinite(height)) return;
			activeHeight.current = height;
			if (!heightInitialized.current) {
				heightInitialized.current = true;
				heightSpring.current.set(height);
				paintHeight(height);
				return;
			}
			if (Math.abs(height - heightSpring.current.position) < 0.5) return;
			const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			heightSpring.current.animate(height, "gentle", paintHeight, () => {}, reducedMotion, 0.5, 0.1);
		},
		[animateHeight, paintHeight],
	);
	useLayoutEffect(() => {
		if (!animateHeight) return;
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		const settleHeight = () => {
			if (!media.matches || activeHeight.current <= 0) return;
			heightSpring.current.set(activeHeight.current);
			paintHeight(activeHeight.current);
		};
		media.addEventListener("change", settleHeight);
		return () => media.removeEventListener("change", settleHeight);
	}, [animateHeight, paintHeight]);
	const removeExit = useCallback((id: number) => {
		setState((current) => ({ ...current, exits: current.exits.filter((page) => page.id !== id) }));
	}, []);
	const rootClassName = ["spring-page-switch", animateHeight ? "spring-page-switch-sized" : "", className ?? ""]
		.filter(Boolean)
		.join(" ");
	return (
		<div ref={root} className={rootClassName}>
			{[
				...state.exits,
				{
					id: state.currentId,
					pageKey: state.pageKey,
					children,
					direction: state.direction,
				},
			].map((page) => {
				const active = page.id === state.currentId;
				return (
					<SpringPage
						key={page.id}
						id={page.id}
						active={active}
						direction={page.direction}
						axis={axis}
						animateOnMount={!active || page.id > 0}
						travelDistance={state.travelDistance}
						onExitComplete={removeExit}
						onSizeChange={animateHeight && active ? updatePageHeight : undefined}
					>
						{page.children}
					</SpringPage>
				);
			})}
		</div>
	);
}
