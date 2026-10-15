import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	deliverableSlug,
	renderRoomDeliverable,
	roomDeliverableFileName,
	roomDeliverablePath,
	writeRoomDeliverable,
} from "../../src/rob/deliverable.js";
import type { RoomDeliverableDraft, RoomEntry } from "../../src/rob/room.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const AT = Date.UTC(2026, 9, 15, 14, 30, 12);

const userLine: RoomEntry = {
	id: 1,
	at: AT,
	kind: "user",
	text: "is the parser safe on CRLF?",
};
const memberLine: RoomEntry = {
	id: 2,
	at: AT,
	kind: "member",
	from: "reviewer",
	text: "one gap: the reader splits on LF only.",
};

const draft: RoomDeliverableDraft = {
	room: "ship-it",
	coordinator: "planner",
	task: "do the work",
	outcome: "settled",
	participants: ["planner", "builder"],
	transcript: [userLine, memberLine],
	body: "The parser fix is ready.",
	at: AT,
};

const EXPECTED_MARKDOWN = [
	"# do the work",
	"",
	"- Room: ship-it",
	"- Coordinator: planner",
	"- Outcome: settled",
	"- Generated: 2026-10-15T14:30:12.000Z",
	"- Participants: planner, builder",
	"",
	"## Room",
	"",
	"user: is the parser safe on CRLF?",
	"reviewer: one gap: the reader splits on LF only.",
	"",
	"## Deliverable",
	"",
	"The parser fix is ready.",
	"",
].join("\n");

describe("deliverableSlug", () => {
	it("slugifies a task and falls back to task", () => {
		expect(deliverableSlug("Ship the Parser!")).toBe("ship-the-parser");
		expect(deliverableSlug("@all")).toBe("all");
		expect(deliverableSlug("   ")).toBe("task");
		expect(deliverableSlug("x".repeat(80))).toBe("x".repeat(60));
	});
});

describe("roomDeliverableFileName", () => {
	it("stamps UTC seconds and appends .md", () => {
		expect(roomDeliverableFileName(AT, "do the work")).toBe(
			"20261015T143012-do-the-work.md",
		);
	});

	it("builds a workspace-relative path", () => {
		expect(roomDeliverablePath(AT, "do the work")).toBe(
			path.join("docs", "deliverables", "20261015T143012-do-the-work.md"),
		);
	});
});

describe("renderRoomDeliverable", () => {
	it("lays out the header, the run's entries, and the body", () => {
		expect(renderRoomDeliverable(draft)).toBe(EXPECTED_MARKDOWN);
	});
});

describe("writeRoomDeliverable", () => {
	it("writes the markdown under docs/deliverables and reports the path", async () => {
		const workspace = await makeWorkspace("my-agent-deliverable-");
		try {
			const outcome = await writeRoomDeliverable(workspace, draft);
			expect(outcome).toEqual({
				status: "written",
				path: path.join(
					"docs",
					"deliverables",
					"20261015T143012-do-the-work.md",
				),
			});
			if (outcome.status !== "written") return;
			expect(await readFile(path.join(workspace, outcome.path), "utf8")).toBe(
				EXPECTED_MARKDOWN,
			);
		} finally {
			await removeWorkspace(workspace);
		}
	});

	it("reports a failed write instead of throwing", async () => {
		const workspace = await makeWorkspace("my-agent-deliverable-");
		try {
			// A file where the directory must go makes mkdir fail.
			await writeFile(path.join(workspace, "docs"), "not a directory", "utf8");
			const outcome = await writeRoomDeliverable(workspace, draft);
			expect(outcome.status).toBe("failed");
			if (outcome.status === "failed") {
				expect(outcome.reason).toContain("docs");
			}
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
