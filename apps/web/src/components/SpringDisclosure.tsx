import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { SpringCollapse } from "./SpringCollapse.tsx";

export function SpringDisclosure({
	label,
	children,
	className,
	defaultOpen = false,
}: {
	label: ReactNode;
	children: ReactNode;
	className: string;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const id = useId();
	const triggerId = `${id}-trigger`;
	const panelId = `${id}-panel`;
	return (
		<section className={`${className}${open ? " is-open" : ""}`}>
			<button
				id={triggerId}
				className="spring-disclosure-trigger"
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((current) => !current)}
			>
				{label}
				<ChevronDown className="spring-disclosure-chevron" size={16} aria-hidden="true" />
			</button>
			<SpringCollapse id={panelId} className="spring-disclosure-panel" in={open} preset="smooth">
				<section aria-labelledby={triggerId}>{children}</section>
			</SpringCollapse>
		</section>
	);
}
