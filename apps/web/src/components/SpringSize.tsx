import { useMediaQuery } from "@mui/material";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { motionTokens, SpringValue } from "../theme/motion.ts";

export function SpringSize({
	open,
	children,
	width,
	className,
}: {
	open: boolean;
	children: ReactNode;
	width: number;
	className: string;
}) {
	const node = useRef<HTMLDivElement>(null);
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const initialTarget = open ? width : 0;
	const spring = useRef<SpringValue>(new SpringValue());
	const initialized = useRef(false);
	if (!initialized.current) spring.current.set(initialTarget);
	useLayoutEffect(() => {
		const element = node.current;
		if (!element) return;
		if (!initialized.current) {
			initialized.current = true;
			element.style.width = `${spring.current.position}px`;
		}
		element.setAttribute("aria-hidden", String(!open));
		element.inert = !open;
		spring.current.animate(
			open ? width : 0,
			motionTokens.transition.pageSlide.preset,
			(position) => {
				element.style.width = `${position}px`;
			},
			() => {},
			reducedMotion,
		);
		return () => spring.current.stop();
	}, [open, reducedMotion, width]);
	return (
		<div ref={node} className={className}>
			{children}
		</div>
	);
}
