import { useMediaQuery } from "@mui/material";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { SpringValue } from "../theme/motion.ts";

export function SpringSize({
	open,
	children,
	width,
	className,
	collapsedWidth,
	collapsedContent,
}: {
	open: boolean;
	children: ReactNode;
	width: number;
	className: string;
	collapsedWidth: number;
	collapsedContent: ReactNode;
}) {
	const node = useRef<HTMLDivElement>(null);
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const initialTarget = open ? width : collapsedWidth;
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
		spring.current.animate(
			open ? width : collapsedWidth,
			"snappy",
			(position) => {
				element.style.width = `${position}px`;
			},
			() => {},
			reducedMotion,
			0.5,
			2,
		);
		return () => spring.current.stop();
	}, [collapsedWidth, open, reducedMotion, width]);
	return (
		<div ref={node} className={`${className} ${open ? "is-expanded" : "is-compact"}`}>
			<div className="sidebar-expanded" inert={!open} aria-hidden={!open}>
				{children}
			</div>
			<div className="sidebar-compact" inert={open} aria-hidden={open}>
				{collapsedContent}
			</div>
		</div>
	);
}
