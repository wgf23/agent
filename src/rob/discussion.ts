import path from "node:path";
import { writeTextAtomic } from "../session/atomic.js";
import type { DmEntry, RobStatus } from "./types.js";

// The discussion loop polls often enough to feel immediate but rarely enough
// not to spin; callers can override it for tests.
const DEFAULT_POLL_MS = 50;
// A slug lands in a file name beside a 16-character timestamp and ".md", so a
// long task must not be allowed to grow the name without bound.
const DEFAULT_SLUG_MAX_LEN = 60;
// The wrap-up gets half of whatever wall time is left when the loop ends.
const WRAP_UP_BUDGET_FRACTION = 0.5;

export interface DiscussionStatus {
	name: string;
	status: RobStatus;
	pending: number;
}

// Everything the loop needs from the live team, so a unit test can drive it
// with a fake instead of a model.
export interface DiscussionPort {
	statuses(): readonly DiscussionStatus[];
	dmCount(): number;
	dispatch(name: string, text: string): void;
	notice(name: string, text: string): void;
	lastMessage(name: string): string | null;
	now(): number;
	sleep(ms: number): Promise<void>;
}

export interface DiscussionOptions {
	coordinator?: string;
	maxRounds: number;
	waitMs: number;
	task: string;
	wrapUp: (task: string) => string;
	pollMs?: number;
	wrapUpMs?: number;
}

export type DiscussionReason = "converged" | "max-rounds" | "timeout";

export interface DiscussionResult {
	rounds: number;
	converged: boolean;
	reason: DiscussionReason;
	deliverable: string | null;
}

// Drives a bounded discussion: wait for the team to go quiet, let one more
// round run when new DMs appeared, and force the coordinator to compile a
// deliverable even when the loop ran out of time or rounds.
export async function runDiscussion(
	port: DiscussionPort,
	options: DiscussionOptions,
): Promise<DiscussionResult> {
	const { coordinator, maxRounds, waitMs, task, wrapUp } = options;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const deadline = port.now() + waitMs;

	let rounds = 0;
	let converged = false;
	let reason: DiscussionReason = "max-rounds";

	for (;;) {
		if (rounds >= maxRounds) {
			reason = "max-rounds";
			break;
		}
		rounds += 1;
		const before = port.dmCount();
		if (!(await waitForQuiescence(port, deadline, pollMs))) {
			reason = "timeout";
			break;
		}
		// A round that produced no DM is the signal that the discussion has
		// settled; any new DM means the team is still talking, so loop.
		if (port.dmCount() === before) {
			converged = true;
			reason = "converged";
			break;
		}
	}

	let deliverable: string | null = null;
	if (coordinator !== undefined) {
		deliverable = await wrapUpDeliverable(
			port,
			coordinator,
			task,
			wrapUp,
			deadline,
			pollMs,
			options.wrapUpMs,
		);
	}

	return { rounds, converged, reason, deliverable };
}

async function waitForQuiescence(
	port: DiscussionPort,
	deadline: number,
	pollMs: number,
): Promise<boolean> {
	for (;;) {
		if (isQuiescent(port.statuses())) return true;
		if (port.now() >= deadline) return false;
		await port.sleep(pollMs);
	}
}

function isQuiescent(statuses: readonly DiscussionStatus[]): boolean {
	return statuses.every(
		(entry) => entry.status === "idle" && entry.pending === 0,
	);
}

async function wrapUpDeliverable(
	port: DiscussionPort,
	coordinator: string,
	task: string,
	wrapUp: (task: string) => string,
	deadline: number,
	pollMs: number,
	wrapUpMs: number | undefined,
): Promise<string | null> {
	port.notice(coordinator, "compiling the final deliverable");
	port.dispatch(coordinator, wrapUp(task));
	const remaining = Math.max(0, deadline - port.now());
	const budget = wrapUpMs ?? Math.floor(remaining * WRAP_UP_BUDGET_FRACTION);
	await waitForCoordinator(port, coordinator, port.now() + budget, pollMs);
	return port.lastMessage(coordinator);
}

async function waitForCoordinator(
	port: DiscussionPort,
	name: string,
	deadline: number,
	pollMs: number,
): Promise<void> {
	// The dispatch lands asynchronously, so a coordinator that reads idle on
	// the first probe may simply not have picked the message up yet. Sleep once
	// before trusting an idle reading.
	await port.sleep(pollMs);
	for (;;) {
		const status = port.statuses().find((entry) => entry.name === name);
		if (
			status === undefined ||
			(status.status !== "working" && status.status !== "waiting_approval")
		) {
			return;
		}
		if (port.now() >= deadline) return;
		await port.sleep(pollMs);
	}
}

export function deliverableSlug(
	task: string,
	maxLen = DEFAULT_SLUG_MAX_LEN,
): string {
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen)
		// Slicing can re-expose a trailing dash the trim above removed.
		.replace(/-+$/g, "");
	return slug === "" ? "task" : slug;
}

export function deliverableFileName(at: number, task: string): string {
	return `${formatUtcStamp(at)}-${deliverableSlug(task)}.md`;
}

export function deliverablePath(dir: string, at: number, task: string): string {
	return path.join(dir, deliverableFileName(at, task));
}

export interface DeliverableInput {
	task: string;
	coordinator: string;
	participants: readonly string[];
	dms: readonly DmEntry[];
	body: string;
	at: number;
}

export function renderDeliverable(input: DeliverableInput): string {
	const { task, coordinator, participants, dms, body, at } = input;
	const lines = [
		`# ${task}`,
		"",
		`- Coordinator: ${coordinator}`,
		`- Generated: ${new Date(at).toISOString()}`,
		`- Participants: ${participants.length > 0 ? participants.join(", ") : "(none)"}`,
		"",
		"## Discussion",
		"",
	];
	if (dms.length === 0) {
		lines.push("(no DMs)");
	} else {
		for (const dm of dms) lines.push(`${dm.from} -> ${dm.to}: ${dm.text}`);
	}
	lines.push("", "## Deliverable", "", body, "");
	return lines.join("\n");
}

// The deliverable is a file like any other, so it goes through the same
// temp-sibling rename as JSON writes.
export function writeDeliverable(
	filePath: string,
	content: string,
): Promise<void> {
	return writeTextAtomic(filePath, content);
}

function formatUtcStamp(at: number): string {
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return [
		date.getUTCFullYear(),
		pad(date.getUTCMonth() + 1),
		pad(date.getUTCDate()),
		"T",
		pad(date.getUTCHours()),
		pad(date.getUTCMinutes()),
		pad(date.getUTCSeconds()),
	].join("");
}
