import { Button } from "@mui/material";
import { type RefObject, useEffect, useRef, useState } from "react";
import { ArrowUp } from "./WorkbenchIcons.tsx";

export function ScrollToTop({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
	const scroller = useRef<HTMLElement | null>(null);
	const [visible, setVisible] = useState(false);
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		const element = containerRef.current?.querySelector<HTMLElement>(".resources-page");
		scroller.current = element ?? null;
		const update = () => setVisible(Boolean(element && element.scrollTop > 160));
		update();
		element?.addEventListener("scroll", update, { passive: true });
		return () => element?.removeEventListener("scroll", update);
	}, [containerRef]);
	if (!visible && !focused) return null;
	return (
		<Button
			className="scroll-to-top"
			variant="outlined"
			startIcon={<ArrowUp size={16} />}
			onFocus={() => setFocused(true)}
			onBlur={() => setFocused(false)}
			onClick={() =>
				scroller.current?.scrollTo({
					top: 0,
					behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
				})
			}
		>
			返回顶部
		</Button>
	);
}
