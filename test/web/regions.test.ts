// Pure-function tests for the two-area layout module.
// Contract: docs/design/assistant-agent-and-bot-separation.md §2/§6.
// No jsdom: layout/interaction stays manual (FR-9).
import { describe, expect, it } from "vitest";
import type { BotInfo } from "../../shared/protocol";
import {
	defaultView,
	partitionBots,
	REGIONS,
	resolveSelection,
	resolveView,
	visibleRooms,
} from "../../web/src/regions";
import type { ClientRoom } from "../../web/src/state";
import { robBots, workspaceBot } from "../../web/src/state";

function bot(name: string, kind: BotInfo["kind"]): BotInfo {
	return { name, kind, role: "", model: "", backend: "native" };
}

const ASSISTANT = bot("assistant", "workspace");
const ASSISTANT2 = bot("assistant2", "workspace");
const DEV = bot("dev", "rob");
const REV = bot("rev", "rob");
const ROSTER: BotInfo[] = [ASSISTANT, DEV, REV];

function room(name: string): ClientRoom {
	return {
		name,
		members: ["dev", "rev"],
		coordinator: null,
		transcript: [],
		run: { phase: "idle" },
		lastOutcome: null,
		deliverable: null,
	};
}

describe("REGIONS / defaultView / resolveView (AC-1)", () => {
	it("exposes two areas, assistant first with its own default", () => {
		expect(REGIONS.map((r) => r.id)).toEqual(["assistant", "bots"]);
		expect(defaultView("assistant")).toBe("chat");
		expect(defaultView("bots")).toBe("plaza");
	});

	it("keeps a view the region allows and folds one it does not", () => {
		expect(resolveView("bots", "agents")).toBe("agents");
		expect(resolveView("bots", "chat")).toBe("chat");
		// assistant only holds chat; plaza/agents fall back to chat.
		expect(resolveView("assistant", "plaza")).toBe("chat");
		expect(resolveView("assistant", "agents")).toBe("chat");
	});

	it("lists only views the App can actually render", () => {
		for (const region of REGIONS) {
			for (const view of region.views) {
				expect(resolveView(region.id, view)).toBe(view);
			}
		}
	});

	it("folds every non-chat view out of the assistant area", () => {
		expect(resolveView("assistant", "chat")).toBe("chat");
		expect(resolveView("assistant", "plaza")).toBe("chat");
		expect(resolveView("assistant", "subagents")).toBe("chat");
		expect(resolveView("assistant", "agents")).toBe("chat");
	});
});

describe("partitionBots (AC-2: single source)", () => {
	it("splits the assistant out and keeps robs in server order", () => {
		expect(partitionBots(ROSTER).assistant).toBe(ASSISTANT);
		expect(partitionBots(ROSTER).bots.map((b) => b.name)).toEqual([
			"dev",
			"rev",
		]);
	});

	it("agrees with the state helpers it reuses (same source of truth)", () => {
		const part = partitionBots(ROSTER);
		expect(part.assistant).toBe(workspaceBot(ROSTER));
		expect(part.bots).toEqual(robBots(ROSTER));
	});

	it("yields a null assistant when there is no workspace bot", () => {
		const part = partitionBots([DEV, REV]);
		expect(part.assistant).toBeNull();
		expect(part.bots.map((b) => b.name)).toEqual(["dev", "rev"]);
	});

	it("yields no bots when only the assistant exists", () => {
		const part = partitionBots([ASSISTANT]);
		expect(part.assistant).toBe(ASSISTANT);
		expect(part.bots).toEqual([]);
	});

	it("handles an empty roster without throwing", () => {
		expect(partitionBots([])).toEqual({ assistant: null, bots: [] });
	});

	it("matches the state helpers it reuses across all three rosters (AC-2)", () => {
		const rosters: BotInfo[][] = [[], [ASSISTANT], ROSTER];
		for (const roster of rosters) {
			const part = partitionBots(roster);
			expect(part.assistant).toBe(workspaceBot(roster) ?? null);
			expect(part.bots).toEqual(robBots(roster));
		}
	});

	it("keeps only the first workspace bot when several appear", () => {
		const part = partitionBots([ASSISTANT, ASSISTANT2, DEV, REV]);
		expect(part.assistant).toBe(ASSISTANT);
		expect(part.bots.map((b) => b.name)).toEqual(["dev", "rev"]);
		expect(part.bots).not.toContain(ASSISTANT2);
	});

	it("preserves the server order of robs even when the roster is shuffled", () => {
		const part = partitionBots([REV, ASSISTANT, DEV]);
		expect(part.bots.map((b) => b.name)).toEqual(["rev", "dev"]);
	});
});

describe("resolveSelection (AC-2/AC-3)", () => {
	const rooms = { rnd: room("rnd") };

	it("assistant forces the assistant and never a room (AC-3)", () => {
		const selection = resolveSelection({
			region: "assistant",
			selectedId: "rnd",
			bots: ROSTER,
			rooms,
		});
		expect(selection.bot).toBe(ASSISTANT);
		expect(selection.room).toBeNull();
	});

	it("bots resolves a selected room to the room, not a bot", () => {
		const selection = resolveSelection({
			region: "bots",
			selectedId: "rnd",
			bots: ROSTER,
			rooms,
		});
		expect(selection.room?.name).toBe("rnd");
		expect(selection.bot).toBeNull();
	});

	it("bots resolves a selected rob", () => {
		const selection = resolveSelection({
			region: "bots",
			selectedId: "dev",
			bots: ROSTER,
			rooms,
		});
		expect(selection.bot?.name).toBe("dev");
		expect(selection.room).toBeNull();
	});

	it("bots falls back to the first rob for an unknown id", () => {
		const selection = resolveSelection({
			region: "bots",
			selectedId: "ghost",
			bots: ROSTER,
			rooms,
		});
		expect(selection.bot?.name).toBe("dev");
		expect(selection.room).toBeNull();
	});

	it("bots with no selection falls back to the first rob", () => {
		const selection = resolveSelection({
			region: "bots",
			selectedId: null,
			bots: ROSTER,
			rooms,
		});
		expect(selection.bot?.name).toBe("dev");
	});

	it("bots with no robs yields nothing", () => {
		const selection = resolveSelection({
			region: "bots",
			selectedId: null,
			bots: [ASSISTANT],
			rooms: {},
		});
		expect(selection.bot).toBeNull();
		expect(selection.room).toBeNull();
	});

	it("never leaks the assistant into the bots area for a stale assistant id", () => {
		// App's selectedId defaults to workspace.name; switching assistant -> bots
		// reuses it, so it must resolve to the first rob, never the assistant.
		const selection = resolveSelection({
			region: "bots",
			selectedId: ASSISTANT.name,
			bots: ROSTER,
			rooms: {},
		});
		expect(selection.bot?.kind).not.toBe("workspace");
		expect(selection.bot).toBe(DEV);
		expect(selection.bot).not.toBe(ASSISTANT);
		expect(selection.room).toBeNull();
	});

	it("assistant with no workspace in the roster yields nothing", () => {
		const selection = resolveSelection({
			region: "assistant",
			selectedId: null,
			bots: [DEV, REV],
			rooms: {},
		});
		expect(selection.bot).toBeNull();
		expect(selection.room).toBeNull();
	});

	it("bots with no robs and an unknown id yields nothing", () => {
		const selection = resolveSelection({
			region: "bots",
			selectedId: "ghost",
			bots: [ASSISTANT],
			rooms: {},
		});
		expect(selection.bot).toBeNull();
		expect(selection.room).toBeNull();
	});

	it("prefers a selected room over a rob that shares its name", () => {
		const clash = { ...rooms, dev: room("dev") };
		const selection = resolveSelection({
			region: "bots",
			selectedId: "dev",
			bots: ROSTER,
			rooms: clash,
		});
		expect(selection.room?.name).toBe("dev");
		expect(selection.bot).toBeNull();
	});
});

describe("visibleRooms (AC-3)", () => {
	const rooms = [room("rnd"), room("ops")];

	it("shows no rooms in the assistant area", () => {
		expect(visibleRooms("assistant", rooms)).toEqual([]);
		expect(visibleRooms("assistant", [])).toEqual([]);
	});

	it("shows every room, in order, in the bots area", () => {
		expect(visibleRooms("bots", rooms).map((r) => r.name)).toEqual([
			"rnd",
			"ops",
		]);
	});

	it("has nothing to show when the bots area has no rooms", () => {
		expect(visibleRooms("bots", [])).toEqual([]);
	});
});
