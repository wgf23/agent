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
});

describe("visibleRooms (AC-3)", () => {
	const rooms = [room("rnd"), room("ops")];

	it("shows no rooms in the assistant area", () => {
		expect(visibleRooms("assistant", rooms)).toEqual([]);
	});

	it("shows every room, in order, in the bots area", () => {
		expect(visibleRooms("bots", rooms).map((r) => r.name)).toEqual([
			"rnd",
			"ops",
		]);
	});
});
