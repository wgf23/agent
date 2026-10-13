import type { RobName } from "../rob/types.js";

export interface Clock {
	now(): number;
}

export interface Timer {
	schedule(
		spec: { bot: RobName; everyMs: number; text: string },
		deliver: (wake: Wake) => void,
	): () => void;
}

export interface Wake {
	kind: "interval";
	bot: RobName;
	text: string;
	at: number;
}

export interface ManualClock extends Clock {
	advance(ms: number): void;
}

export interface ManualTimer {
	timer: Timer;
	fire(bot: RobName): void;
	pending(): readonly { bot: RobName; everyMs: number; text: string }[];
}

export const systemClock: Clock = {
	now: () => Date.now(),
};

// Rearms itself each tick so the interval is wall-clock, not one-shot, and
// unrefs every handle so a lone pending timer never holds the process open.
export const systemTimer: Timer = {
	schedule(spec, deliver) {
		let handle: NodeJS.Timeout | undefined;
		let cancelled = false;
		const arm = (): void => {
			if (cancelled) return;
			handle = setTimeout(() => {
				if (cancelled) return;
				deliver({
					kind: "interval",
					bot: spec.bot,
					text: spec.text,
					at: Date.now(),
				});
				arm();
			}, spec.everyMs);
			handle.unref();
		};
		arm();
		return () => {
			cancelled = true;
			if (handle !== undefined) clearTimeout(handle);
		};
	},
};

export function manualClock(start: number): ManualClock {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
	};
}

// A test timer that only fires when told: schedule records the spec, fire invokes
// the matching deliver with a synthetic wake, and cancel (returned by schedule)
// removes the entry.
export function manualTimer(): ManualTimer {
	interface Entry {
		spec: { bot: RobName; everyMs: number; text: string };
		deliver: (wake: Wake) => void;
		at: number;
	}
	const entries = new Map<RobName, Entry>();
	return {
		timer: {
			schedule(spec, deliver) {
				entries.set(spec.bot, { spec, deliver, at: 0 });
				return () => {
					entries.delete(spec.bot);
				};
			},
		},
		fire(bot) {
			const entry = entries.get(bot);
			if (entry === undefined) return;
			entry.at += entry.spec.everyMs;
			entry.deliver({
				kind: "interval",
				bot,
				text: entry.spec.text,
				at: entry.at,
			});
		},
		pending() {
			return [...entries.values()].map((entry) => ({ ...entry.spec }));
		},
	};
}

export function wakeText(wake: Wake): string {
	return `[wake:interval] ${wake.text}`;
}
