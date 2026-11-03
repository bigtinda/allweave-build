import { LinearProgress } from "@mui/material";

/** A low-intrusion wait indicator for content regions that do not have data yet. */
export function LoadingState({ label, className }: { label: string; className?: string }) {
	return (
		<output className={`loading-state${className ? ` ${className}` : ""}`} aria-live="polite" aria-busy="true">
			<LinearProgress className="loading-state-bar" aria-label={label} />
			<span className="loading-state-label">{label}</span>
		</output>
	);
}
