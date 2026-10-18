import { BuildMark } from "./BuildMark.tsx";

export function BuildBrandFamily({ className = "" }: { className?: string }) {
	const classes = ["allweave-build-family", className].filter(Boolean).join(" ");
	return (
		<span className={classes} role="img" aria-label="万象成序 AllWeave · 构序 Build">
			<span className="family-parent-frame">
				<img src="/brand/allweave-parent-lockup.png" width="600" height="250" alt="" />
			</span>
			<span className="family-divider" aria-hidden="true" />
			<span className="family-product">
				<BuildMark className="family-product-mark" />
				<span className="family-product-name">
					<strong>构序</strong>
					<small>BUILD</small>
				</span>
			</span>
		</span>
	);
}
