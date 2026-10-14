import { describe, expect, it } from "vitest";
import { renderCollaboration, renderRoster } from "../../src/rob/prompt.js";

describe("renderRoster", () => {
	it("lists each other rob by name and role and excludes the caller", () => {
		const roster = [
			{ name: "planner", role: "coordinate" },
			{ name: "worker", role: "carry out file tasks" },
			{ name: "reviewer", role: "check the work" },
		];

		const text = renderRoster(roster, "planner");

		expect(text).toContain("- worker — carry out file tasks");
		expect(text).toContain("- reviewer — check the work");
		expect(text).not.toContain("planner");
	});

	it("states that a solo rob is alone", () => {
		const text = renderRoster(
			[{ name: "planner", role: "coordinate" }],
			"planner",
		);

		expect(text).toContain("You are currently the only rob on the team.");
		expect(text).not.toContain("planner");
	});
});

describe("renderCollaboration", () => {
	it("includes every teammate's name and role and excludes the caller", () => {
		const roster = [
			{ name: "planner", role: "coordinate" },
			{ name: "worker", role: "carry out file tasks" },
			{ name: "reviewer", role: "check the work" },
		];

		const text = renderCollaboration(roster, "planner");

		expect(text).toContain("worker");
		expect(text).toContain("carry out file tasks");
		expect(text).toContain("reviewer");
		expect(text).toContain("check the work");
		expect(text).not.toContain("planner");
	});

	it("describes the send_message, incoming DM, and read_messages semantics", () => {
		const roster = [
			{ name: "planner", role: "coordinate" },
			{ name: "worker", role: "carry out file tasks" },
		];

		const text = renderCollaboration(roster, "planner");

		expect(text).toContain("send_message");
		expect(text).toContain("read_messages");
		expect(text).toContain("[from rob:<name>]");
	});

	it("states that a solo rob is alone", () => {
		const text = renderCollaboration(
			[{ name: "planner", role: "coordinate" }],
			"planner",
		);

		expect(text).toContain("You are currently the only rob on the team.");
		expect(text).not.toContain("planner");
	});
});
