export type SpringPresetName = "snappy" | "smooth" | "gentle" | "bouncy";

export interface SpringPreset {
	stiffness: number;
	damping: number;
	mass: number;
}

export const springPresets: Record<SpringPresetName, SpringPreset> = {
	// Near-critical damping keeps control interactions quick without visible bounce.
	snappy: { stiffness: 640, damping: 48, mass: 0.9 },
	smooth: { stiffness: 400, damping: 40, mass: 1 },
	gentle: { stiffness: 280, damping: 34, mass: 1.15 },
	// Reserved for deliberate, low-amplitude spring returns.
	bouncy: { stiffness: 420, damping: 28, mass: 1 },
};

/** A scalar spring that can be retargeted without discarding its current velocity. */
export class SpringValue {
	position = 0;
	velocity = 0;
	private frame = 0;

	set(position: number, velocity = 0): void {
		cancelAnimationFrame(this.frame);
		this.position = position;
		this.velocity = velocity;
	}

	stop(): void {
		cancelAnimationFrame(this.frame);
	}

	animate(
		target: number,
		preset: SpringPresetName,
		onUpdate: (position: number) => void,
		onRest: () => void,
		reducedMotion = false,
		restDistance = 0.001,
		restVelocity = 0.01,
	): void {
		this.stop();
		if (reducedMotion) {
			this.position = target;
			this.velocity = 0;
			onUpdate(target);
			onRest();
			return;
		}
		const settings = springPresets[preset];
		let previousTime = 0;
		const step = (time: number) => {
			if (previousTime === 0) previousTime = time;
			let remaining = Math.min((time - previousTime) / 1000, 0.032);
			previousTime = time;
			while (remaining > 0) {
				const delta = Math.min(remaining, 1 / 240);
				const acceleration =
					(settings.stiffness * (target - this.position) - settings.damping * this.velocity) / settings.mass;
				this.velocity += acceleration * delta;
				this.position += this.velocity * delta;
				remaining -= delta;
			}
			onUpdate(this.position);
			if (Math.abs(target - this.position) < restDistance && Math.abs(this.velocity) < restVelocity) {
				this.position = target;
				this.velocity = 0;
				onUpdate(target);
				onRest();
			} else this.frame = requestAnimationFrame(step);
		};
		this.frame = requestAnimationFrame(step);
	}
}

export const motionTokens = {
	duration: {
		instant: 100,
		fast: 160,
		normal: 240,
		slow: 340,
	},
	easing: {
		enter: "cubic-bezier(0.2, 0.8, 0.2, 1)",
		exit: "cubic-bezier(0.4, 0, 1, 1)",
		standard: "cubic-bezier(0.2, 0.8, 0.2, 1)",
		// CSS fallback for transitions that cannot be driven by the spring runner.
		spring: "cubic-bezier(0.22, 1, 0.36, 1)",
	},
	transition: {
		fade: { duration: 140, easing: "standard" },
		scaleFade: { duration: 240, easing: "spring", scale: 0.985 },
		slide: { duration: 300, easing: "spring", distance: 12 },
		pageSlide: { minimumDistance: 32, interPageGap: 32, preset: "smooth" },
		layout: { duration: 340, easing: "spring" },
		sharedElement: { duration: 360, easing: "spring" },
		springReturn: { duration: 320, preset: "smooth" },
	},
} as const;
