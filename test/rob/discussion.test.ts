import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DiscussionPort,
	type DiscussionStatus,
	deliverableFileName,
	deliverablePath,
	deliverableSlug,
	renderDeliverable,
	runDiscussion,
	writeDeliverable,
} from "../../src/rob/discussion.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

// A scripted port: `dmCount` opens a round (which makes the fake "busy" until
// the round's sleep resolves) and `growth[i]` is how many DMs that round
// produces, so tests can script convergence, churn, or a stall.
class FakePort implements DiscussionPort {
	nowMs = 0;
	readonly notices: Array<{ name: string; text: string }> = [];
	readonly dispatched: Array<{ name: string; text: string }> = [];
	readonly messages = new Map<string, string>();
	private readonly names: string[];
	private readonly growth: number[];
	private readonly quiescent: boolean;
	private sleepIndex = 0;
	private dmTotal = 0;
	private active = true;

	constructor(
		options: {
			growth?: number[];
			quiescent?: boolean;
			names?: string[];
		} = {},
	) {
		this.names = options.names ?? ["planner", "worker"];
		this.growth = options.growth ?? [];
		this.quiescent = options.quiescent ?? true;
	}

	statuses(): readonly DiscussionStatus[] {
		return this.names.map((name) => ({
			name,
			status: this.quiescent && !this.active ? "idle" : "working",
			pending: 0,
		}));
	}

	dmCount(): number {
		// A fresh reading marks a new round, so the fake gets busy again.
		this.active = true;
		return this.dmTotal;
	}

	dispatch(name: string, text: string): void {
		this.dispatched.push({ name, text });
		this.messages.set(name, text);
	}

	notice(name: string, text: string): void {
		this.notices.push({ name, text });
	}

	lastMessage(name: string): string | null {
		return this.messages.get(name) ?? null;
	}

	now(): number {
		return this.nowMs;
	}

	async sleep(ms: number): Promise<void> {
		this.nowMs += ms;
		this.active = false;
		this.dmTotal += this.growth[this.sleepIndex] ?? 0;
		this.sleepIndex += 1;
	}
}

describe("runDiscussion", () => {
	it("converges on the first quiet round and reports the exact round count", async () => {
		const port = new FakePort({ growth: [1, 1, 0] });

		const result = await runDiscussion(port, {
			coordinator: "planner",
			maxRounds: 10,
			waitMs: 5_000,
			task: "write the report",
			wrapUp: (task) => `final: ${task}`,
		});

		expect(result).toMatchObject({
			rounds: 3,
			converged: true,
			reason: "converged",
		});
		expect(result.deliverable).toBe("final: write the report");
	});

	it("times out, yet still forces exactly one wrap-up and returns its message", async () => {
		const port = new FakePort({ growth: [1, 1], quiescent: false });

		const result = await runDiscussion(port, {
			coordinator: "planner",
			maxRounds: 10,
			waitMs: 300,
			task: "the task",
			wrapUp: (task) => `wrap: ${task}`,
			pollMs: 100,
		});

		expect(result.converged).toBe(false);
		expect(result.reason).toBe("timeout");
		expect(result.deliverable).toBe("wrap: the task");
		expect(port.dispatched).toEqual([
			{ name: "planner", text: "wrap: the task" },
		]);
		expect(port.notices).toContainEqual({
			name: "planner",
			text: "compiling the final deliverable",
		});
	});

	it("stops at maxRounds with a deliverable", async () => {
		const port = new FakePort({ growth: [1, 1, 1, 1, 1] });

		const result = await runDiscussion(port, {
			coordinator: "planner",
			maxRounds: 3,
			waitMs: 5_000,
			task: "t",
			wrapUp: () => "final",
		});

		expect(result.rounds).toBe(3);
		expect(result.reason).toBe("max-rounds");
		expect(result.converged).toBe(false);
		expect(result.deliverable).toBe("final");
	});

	it("skips the wrap-up entirely when no coordinator is set", async () => {
		const port = new FakePort({ growth: [0] });

		const result = await runDiscussion(port, {
			maxRounds: 3,
			waitMs: 5_000,
			task: "t",
			wrapUp: () => "unused",
		});

		expect(result.deliverable).toBeNull();
		expect(port.dispatched).toEqual([]);
		expect(port.notices).toEqual([]);
	});
});

describe("deliverableSlug", () => {
	it("lowercases and hyphenates runs of punctuation", () => {
		expect(deliverableSlug("Fix: The BUG!!")).toBe("fix-the-bug");
	});

	it("falls back to task for empty or all-punctuation input", () => {
		expect(deliverableSlug("")).toBe("task");
		expect(deliverableSlug("!!! --- ...")).toBe("task");
	});

	it("caps the slug at maxLen without a trailing dash", () => {
		expect(deliverableSlug("a".repeat(100), 10)).toBe("a".repeat(10));
		expect(deliverableSlug("hello world", 7)).toBe("hello-w");
	});
});

describe("deliverableFileName", () => {
	it("formats the UTC stamp and slug", () => {
		expect(deliverableFileName(0, "Hello World")).toBe(
			"19700101T000000-hello-world.md",
		);
	});

	it("matches the timestamp pattern for an arbitrary clock", () => {
		expect(deliverableFileName(Date.now(), "Anything!")).toMatch(
			/^\d{8}T\d{6}-.+\.md$/,
		);
	});

	it("joins the directory with the file name", () => {
		expect(deliverablePath("/tmp/deliverables", 0, "Hello World")).toBe(
			path.join("/tmp/deliverables", "19700101T000000-hello-world.md"),
		);
	});
});

describe("renderDeliverable", () => {
	it("renders the task, coordinator, participants, DMs, and body", () => {
		const doc = renderDeliverable({
			task: "Fix the bug",
			coordinator: "planner",
			participants: ["planner", "worker"],
			dms: [
				{ from: "planner", to: "worker", text: "please fix it", at: 1 },
				{ from: "worker", to: "planner", text: "fixed", at: 2 },
			],
			body: "The bug is fixed.",
			at: 0,
		});

		expect(doc).toContain("# Fix the bug");
		expect(doc).toContain("Coordinator: planner");
		expect(doc).toContain("Participants: planner, worker");
		expect(doc).toContain("## Discussion");
		expect(doc).toContain("planner -> worker: please fix it");
		expect(doc).toContain("worker -> planner: fixed");
		expect(doc).toContain("## Deliverable");
		expect(doc).toContain("The bug is fixed.");
	});
});

describe("writeDeliverable", () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await makeWorkspace("my-agent-deliverable-");
	});

	afterEach(async () => {
		await removeWorkspace(workspace);
	});

	it("round-trips text through an atomic write", async () => {
		const filePath = path.join(workspace, "nested", "out.md");

		await writeDeliverable(filePath, "# hello\n");

		expect(await readFile(filePath, "utf8")).toBe("# hello\n");
	});

	it("surfaces a failing write instead of swallowing it", async () => {
		const blocker = path.join(workspace, "blocker");
		await writeFile(blocker, "not a directory", "utf8");

		await expect(
			writeDeliverable(path.join(blocker, "out.md"), "content"),
		).rejects.toThrow();
	});
});
