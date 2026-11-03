import assert from "node:assert/strict";
import { test } from "node:test";
import { SpringValue } from "../src/theme/motion.ts";

function frameClock() {
	const request = globalThis.requestAnimationFrame;
	const cancel = globalThis.cancelAnimationFrame;
	const frames = new Map<number, FrameRequestCallback>();
	let id = 0;
	let time = performance.now();
	globalThis.requestAnimationFrame = (callback) => {
		frames.set(++id, callback);
		return id;
	};
	globalThis.cancelAnimationFrame = (frame) => {
		frames.delete(frame);
	};
	return {
		tick() {
			time += 16;
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(time);
		},
		pending: () => frames.size,
		restore() {
			globalThis.requestAnimationFrame = request;
			globalThis.cancelAnimationFrame = cancel;
		},
	};
}

test("springs move on the first frame and reverse from their current position and velocity", () => {
	const clock = frameClock();
	try {
		const spring = new SpringValue();
		let obsoleteCompletion = false;
		spring.animate(
			1,
			"snappy",
			() => {},
			() => {
				obsoleteCompletion = true;
			},
			false,
			0.01,
			0.1,
		);
		clock.tick();
		assert.ok(spring.position > 0, "the first display frame must advance the spring");
		for (let i = 0; i < 3; i++) clock.tick();
		const position = spring.position;
		const velocity = spring.velocity;
		let completed = false;
		spring.animate(
			0,
			"snappy",
			() => {},
			() => {
				completed = true;
			},
			false,
			0.01,
			0.1,
		);
		assert.equal(spring.position, position);
		assert.equal(spring.velocity, velocity);
		assert.equal(clock.pending(), 1);
		for (let i = 0; i < 60 && clock.pending(); i++) clock.tick();
		assert.equal(spring.position, 0);
		assert.equal(spring.velocity, 0);
		assert.equal(completed, true);
		assert.equal(obsoleteCompletion, false);
		assert.equal(clock.pending(), 0);
	} finally {
		clock.restore();
	}
});

test("reduced motion settles an in-flight spring immediately and cancels its scheduled frame", () => {
	const clock = frameClock();
	try {
		const spring = new SpringValue();
		spring.animate(
			1,
			"smooth",
			() => {},
			() => {},
		);
		clock.tick();
		let painted = -1;
		let completed = false;
		spring.animate(
			0,
			"smooth",
			(value) => {
				painted = value;
			},
			() => {
				completed = true;
			},
			true,
		);
		assert.equal(painted, 0);
		assert.equal(spring.position, 0);
		assert.equal(spring.velocity, 0);
		assert.equal(completed, true);
		assert.equal(clock.pending(), 0);
	} finally {
		clock.restore();
	}
});
