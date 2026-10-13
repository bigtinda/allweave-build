export function BuildMark({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 240 120" fill="none" aria-hidden="true">
			<path
				d="M108 45C80 14 59 13 43 19C6 33 6 87 43 101C77 114 99 77 132 45C160 14 181 13 197 19C234 33 234 87 197 101C163 114 141 77 108 45"
				stroke="currentColor"
				strokeWidth="8"
			/>
			<path
				d="M60 42L42 60L60 78M180 42L198 60L180 78"
				stroke="currentColor"
				strokeWidth="7"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
