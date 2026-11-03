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
	id?: string;
	pageKey: string;
	pageIndex: number;
	children: ReactNode;
	className?: string;
	axis?: SpringAxis;
	animateHeight?: boolean;
	transition?: "fade" | "slide";
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
	transition,
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
	transition: "fade" | "slide";
}) {
	const node = useRef<HTMLDivElement>(null);
	const positionSpring = useRef(new SpringValue());
	const hasMoved = useRef(false);
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
			if (active && position === 0) {
				element.style.transform = "none";
				element.style.opacity = "1";
				return;
			}
			const offset = axis === "vertical" ? `0, ${position}px, 0` : `${position}px, 0, 0`;
			element.style.transform = transition === "slide" ? `translate3d(${offset})` : "none";
			const progress = Math.min(1, Math.abs(position) / travelDistance);
			element.style.opacity = active
				? String(1 - progress * (transition === "fade" ? 1 - motionTokens.transition.pageFade.initialOpacity : 1))
				: "0";
		},
		[active, axis, transition, travelDistance],
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
		if (active && !animateOnMount && !hasMoved.current) {
			positionSpring.current.set(0);
			paintPosition(0);
			return;
		}
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		hasMoved.current = true;
		const finish = () => {
			delete element.dataset.pageMoving;
			if (!active) onExitComplete(id);
		};
		const animate = () => {
			if (active) element.dataset.pageMoving = "true";
			const preset = motionTokens.transition[transition === "fade" ? "pageFade" : "pageSlide"].preset;
			positionSpring.current.animate(
				targetPosition,
				preset,
				paintPosition,
				finish,
				media.matches ||
					document.documentElement.dataset.navigationInput === "keyboard" ||
					Boolean(element.parentElement?.closest('.spring-page-layer[data-page-moving="true"]')),
				transition === "fade" ? 0.01 : 0.5,
				transition === "fade" ? 0.1 : 2,
			);
		};
		animate();
		media.addEventListener("change", animate);
		return () => {
			positionSpring.current.stop();
			media.removeEventListener("change", animate);
		};
	}, [active, animateOnMount, direction, id, onExitComplete, paintPosition, transition, travelDistance]);
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
				opacity: active
					? 1 -
						Math.min(1, Math.abs(position) / travelDistance) *
							(transition === "fade" ? 1 - motionTokens.transition.pageFade.initialOpacity : 1)
					: 0,
				transform:
					transition === "fade" || (active && position === 0)
						? "none"
						: axis === "vertical"
							? `translate3d(0, ${position}px, 0)`
							: `translate3d(${position}px, 0, 0)`,
				pointerEvents: active ? undefined : "none",
			}}
		>
			{children}
		</div>
	);
}

/** Keeps navigation immediately readable and retargets interrupted transitions. */
export function SpringPages({
	id,
	pageKey,
	pageIndex,
	children,
	className,
	axis = "horizontal",
	animateHeight = false,
	transition = "fade",
}: SpringPagesProps) {
	const root = useRef<HTMLDivElement>(null);
	const heightSpring = useRef(new SpringValue());
	const heightInitialized = useRef(false);
	const activePageId = useRef(0);
	const activeHeight = useRef(0);
	const rendered = useRef({ pageKey, pageIndex, children });
	const { minimumDistance, interPageGap } = motionTokens.transition.pageSlide;
	const distance = transition === "fade" ? 1 : minimumDistance + interPageGap;
	const [state, setState] = useState<PageState>({
		pageKey,
		pageIndex,
		currentId: 0,
		nextId: 1,
		direction: 1,
		travelDistance: distance,
		exits: [],
	});
	if (state.pageKey !== pageKey) {
		const previous = rendered.current;
		const travelDistance = distance;
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
			const reducedMotion =
				window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
				document.documentElement.dataset.navigationInput === "keyboard";
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
		<div ref={root} id={id} tabIndex={id ? -1 : undefined} className={rootClassName}>
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
						transition={transition}
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
