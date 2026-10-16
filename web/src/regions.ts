// Pure region/partition logic for the two-area layout (assistant vs bots).
// No React, no DOM: the view layer imports these and only binds state.
// Contract: docs/design/assistant-agent-and-bot-separation.md §2.
import type { BotInfo } from "./protocol.js";
import type { ClientRoom } from "./state.js";
import { robBots, workspaceBot } from "./state.js";

/** The two top-level areas. Client-only UI state; never crosses the wire. */
export type Region = "assistant" | "bots";

/** The existing navigation views, kept identical to Sidebar's old `View`. */
export type View = "chat" | "plaza" | "subagents" | "agents";

export interface RegionSpec {
	id: Region;
	label: string;
	defaultView: View;
	views: readonly View[];
}

/** The tabs' single source of truth: order = render order, assistant first. */
export const REGIONS: readonly RegionSpec[] = [
	{ id: "assistant", label: "助手", defaultView: "chat", views: ["chat"] },
	{
		id: "bots",
		label: "Bot",
		defaultView: "plaza",
		views: ["chat", "plaza", "subagents", "agents"],
	},
];

function spec(region: Region): RegionSpec {
	// REGIONS covers every Region, so the lookup always succeeds.
	return REGIONS.find((entry) => entry.id === region) ?? REGIONS[0];
}

/** The view a region opens on. */
export function defaultView(region: Region): View {
	return spec(region).defaultView;
}

/** Folds a view into a region: kept when allowed, else the region's default. */
export function resolveView(region: Region, view: View): View {
	const allowed = spec(region).views;
	return allowed.includes(view) ? view : spec(region).defaultView;
}

export interface Partition {
	/** kind === "workspace": the single global assistant (Q4). */
	assistant: BotInfo | null;
	/** kind === "rob", in server order. */
	bots: BotInfo[];
}

/** Splits the one roster into the two areas, so both derive from state.bots. */
export function partitionBots(bots: readonly BotInfo[]): Partition {
	return {
		assistant: workspaceBot(bots) ?? null,
		bots: robBots(bots),
	};
}

export interface Selection {
	bot: BotInfo | null;
	room: ClientRoom | null;
}

/** Resolves what a region renders now:
 *   - assistant: the assistant, never a room (ignores selectedId/rooms).
 *   - bots: a room when selectedId names one; otherwise the selected bot, the
 *     first bot, or null. */
export function resolveSelection(input: {
	region: Region;
	selectedId: string | null;
	bots: readonly BotInfo[];
	rooms: Record<string, ClientRoom>;
}): Selection {
	const { region, selectedId, bots, rooms } = input;
	const { assistant, bots: robs } = partitionBots(bots);
	if (region === "assistant") {
		return { bot: assistant, room: null };
	}
	const room = selectedId !== null ? (rooms[selectedId] ?? null) : null;
	if (room !== null) return { bot: null, room };
	const bot =
		(selectedId !== null
			? robs.find((entry) => entry.name === selectedId)
			: undefined) ??
		robs[0] ??
		null;
	return { bot, room: null };
}

/** Rooms visible in a region: none in assistant, all (order kept) in bots. */
export function visibleRooms(
	region: Region,
	rooms: readonly ClientRoom[],
): ClientRoom[] {
	return region === "assistant" ? [] : [...rooms];
}
