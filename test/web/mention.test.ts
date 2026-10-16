// QA acceptance tests for the room @-picker + roster pure module.
//
// Contract: docs/design/room-mention-and-roster.md §3 (frozen signatures).
// Covers AC-1/2/3/4/6/7/8/10/12/13. Pure functions only — no jsdom (FR-5.3).
// AC-5/AC-11 stay in test/rob/room-text.test.ts (backend truth, not rewritten).
import { describe, expect, it } from "vitest";
import {
	insertMention,
	MENTION_RE,
	mentionedNames,
	mentionKeydown,
	mentionQuery,
	mentionState,
	moveIndex,
	rosterRows,
} from "../../web/src/mention.js";
import type { BotState } from "../../web/src/protocol.js";

const MEMBERS = ["dev", "worker"] as const;

function botState(status: BotState["status"]): BotState {
	return {
		bot: "x",
		status,
		messageCount: 0,
		pending: 0,
		lastMessage: null,
		usage: { input: 0, output: 0 },
	};
}

describe("mentionQuery (Q rule: caret query + replace span)", () => {
	it("parses a bare @ with an empty query", () => {
		expect(mentionQuery("@", 1)).toEqual({ anchor: 0, length: 1, query: "" });
	});

	it("normalizes case and covers @DEV in full (AC-13)", () => {
		expect(mentionQuery("@DEV", 4)).toEqual({
			anchor: 0,
			length: 4,
			query: "dev",
		});
		expect(mentionQuery("@Dev", 4)).toEqual({
			anchor: 0,
			length: 4,
			query: "dev",
		});
	});

	it("reads the token left of the caret at an arbitrary position", () => {
		expect(mentionQuery("hi @d", 5)).toEqual({
			anchor: 3,
			length: 2,
			query: "d",
		});
	});

	it("terminates on `,`, a second `@`, or a space, but not on `-` (AC-12)", () => {
		expect(mentionQuery("@dev,", 4)).toEqual({
			anchor: 0,
			length: 4,
			query: "dev",
		});
		expect(mentionQuery("@dev@", 4)).toEqual({
			anchor: 0,
			length: 4,
			query: "dev",
		});
		expect(mentionQuery("@dev ", 4)).toEqual({
			anchor: 0,
			length: 4,
			query: "dev",
		});
		expect(mentionQuery("@dev-", 5)).toEqual({
			anchor: 0,
			length: 5,
			query: "dev-",
		});
	});

	it("returns null when the first char is outside the charset (no fallback to all)", () => {
		expect(mentionQuery("@1", 2)).toBeNull();
		expect(mentionQuery("@ ", 2)).toBeNull();
		expect(mentionQuery("@×", 2)).toBeNull();
		expect(mentionQuery("no at here", 10)).toBeNull();
	});
});

describe("mentionedNames (B rule: already-@ set, FR-2.7)", () => {
	it("collects the literal names mentioned in the text", () => {
		expect(mentionedNames("@dev @worker")).toEqual(["dev", "worker"]);
	});

	it("follows the strict backend token: `-` is kept, uppercase stops (AC-12)", () => {
		expect(mentionedNames("@dev-")).toEqual(["dev-"]);
		expect(mentionedNames("@deV")).toEqual(["de"]);
		expect(mentionedNames("@DEV")).toEqual([]);
	});

	it("can skip the in-progress token so it cannot exclude itself", () => {
		expect(mentionedNames("@dev @d", 5)).toEqual(["dev"]);
		expect(mentionedNames("@dev", 0)).toEqual([]);
	});

	it("resists a polluted shared /g lastIndex (regression)", () => {
		// `String.prototype.matchAll` copies the regex's `lastIndex` as its start
		// offset. If a *shared* module-level /g regex is left non-zero by an
		// earlier `.test()`/`.exec()`, `mentionedNames` silently skips matches
		// before that offset. Pollute it on purpose, then require a full scan.
		try {
			MENTION_RE.lastIndex = 5;
			expect(mentionedNames("@dev @worker")).toEqual(["dev", "worker"]);
		} finally {
			MENTION_RE.lastIndex = 0;
		}
	});
});

describe("mentionState (candidates = members ∪ {all}, §2)", () => {
	it("AC-1: bare @ lists members in order then the broadcast item", () => {
		const state = mentionState({ text: "@", caret: 1, members: MEMBERS });
		expect(state).not.toBeNull();
		expect(state?.candidates.map((c) => c.name)).toEqual([
			"dev",
			"worker",
			"all",
		]);
		expect(state?.candidates.map((c) => c.broadcast)).toEqual([
			false,
			false,
			true,
		]);
		expect(state?.anchor).toBe(0);
		expect(state?.length).toBe(1);
		expect(state?.query).toBe("");
	});

	it("AC-2: filters by prefix, case-insensitively; no match -> empty", () => {
		expect(
			mentionState({ text: "@d", caret: 2, members: MEMBERS })?.candidates.map(
				(c) => c.name,
			),
		).toEqual(["dev"]);
		expect(
			mentionState({ text: "@D", caret: 2, members: MEMBERS })?.candidates.map(
				(c) => c.name,
			),
		).toEqual(["dev"]);
		expect(
			mentionState({ text: "@zz", caret: 3, members: MEMBERS })?.candidates,
		).toEqual([]);
	});

	it("AC-13: @DEV matches dev via the wide query", () => {
		const state = mentionState({ text: "@DEV", caret: 4, members: MEMBERS });
		expect(state?.query).toBe("dev");
		expect(state?.candidates.map((c) => c.name)).toContain("dev");
	});

	it("AC-7/W-T8: an already-@ name drops from candidates; @all only hides all", () => {
		const afterDev = mentionState({
			text: "@dev @",
			caret: 6,
			members: MEMBERS,
		});
		expect(afterDev?.candidates.map((c) => c.name)).toEqual(["worker", "all"]);

		const afterAll = mentionState({
			text: "@all @",
			caret: 6,
			members: MEMBERS,
		});
		expect(afterAll?.candidates.map((c) => c.name)).toEqual(["dev", "worker"]);
	});

	it("treats a real member named `all` as a normal member, not broadcast", () => {
		const state = mentionState({
			text: "@",
			caret: 1,
			members: ["all", "dev"],
		});
		expect(state?.candidates.map((c) => c.name)).toEqual(["all", "dev"]);
		expect(state?.candidates.every((c) => c.broadcast === false)).toBe(true);
	});

	it("returns null when there is no active query", () => {
		expect(mentionState({ text: "@1", caret: 2, members: MEMBERS })).toBeNull();
	});
});

describe("insertMention (Q rule / FR-2.4 / AC-3)", () => {
	it("AC-13: replaces @DEV in full and reflows the caret with no leftover", () => {
		expect(insertMention("@DEV", 4, "dev")).toEqual({
			text: "@dev ",
			caret: 5,
		});
	});

	it("AC-3: replacement extends to the Q-token end when the caret is inside it", () => {
		// The whole `@dev` token is replaced, not just the part left of the caret.
		// The remainder `ev` must NOT survive as `@dev ev`.
		expect(insertMention("@dev", 2, "dev")).toEqual({
			text: "@dev ",
			caret: 5,
		});
		// caret between `de` and `v`; the trailing `v` must not survive either.
		expect(insertMention("@dev", 3, "dev")).toEqual({
			text: "@dev ",
			caret: 5,
		});
		// a wider query tail that is not itself the member name.
		expect(insertMention("@devX", 4, "dev")).toEqual({
			text: "@dev ",
			caret: 5,
		});
	});

	it("inserts at the caret without breaking the surrounding text", () => {
		expect(insertMention("a @d b", 4, "dev")).toEqual({
			text: "a @dev  b",
			caret: 7,
		});
	});

	it("leaves the text unchanged when there is no active query", () => {
		expect(insertMention("no mention", 10, "dev")).toEqual({
			text: "no mention",
			caret: 10,
		});
	});
});

describe("rosterRows (FR-3 / AC-8 / AC-10)", () => {
	it("AC-8: lists all members with coordinator flag and status label", () => {
		const rows = rosterRows(["dev", "worker"], "dev", {
			dev: botState("working"),
			worker: botState("idle"),
		});
		expect(rows).toEqual([
			{
				name: "dev",
				label: "@dev",
				isCoordinator: true,
				statusLabel: "工作中",
			},
			{
				name: "worker",
				label: "@worker",
				isCoordinator: false,
				statusLabel: "空闲",
			},
		]);
	});

	it("AC-8: missing botStates fall back to idle", () => {
		const rows = rosterRows(["dev"], null, {});
		expect(rows[0]?.statusLabel).toBe("空闲");
		expect(rows[0]?.isCoordinator).toBe(false);
	});

	it("maps every BotStatus through STATUS_LABEL", () => {
		const rows = rosterRows(["a", "b", "c", "d"], null, {
			a: botState("waiting_approval"),
			b: botState("stopped"),
			c: botState("working"),
			d: botState("idle"),
		});
		expect(rows.map((r) => r.statusLabel)).toEqual([
			"等待审批",
			"已停止",
			"工作中",
			"空闲",
		]);
	});

	it("AC-10: an empty room yields no rows (not an error)", () => {
		expect(rosterRows([], null, {})).toEqual([]);
	});
});

describe("AC-9: candidates and roster stay same-source", () => {
	// Both consumers take `members` as input; when the room's member list moves,
	// both move together. The state layer feeds the exact same ClientRoom.members
	// (web/src/state.ts:550-554 "members" branch is the single writer; the
	// existing test/web/state.test.ts case pins that write).
	it("reflects the same members change in picker and roster", () => {
		const before = ["dev", "worker"];
		const after = ["dev", "worker", "reviewer"];

		const pick = (m: readonly string[]) =>
			mentionState({ text: "@", caret: 1, members: m })?.candidates.map(
				(c) => c.name,
			);
		const roster = (m: readonly string[]) =>
			rosterRows(m, null, {}).map((r) => r.name);

		expect(pick(before)).toEqual(["dev", "worker", "all"]);
		expect(pick(after)).toEqual(["dev", "worker", "reviewer", "all"]);
		expect(roster(before)).toEqual(["dev", "worker"]);
		expect(roster(after)).toEqual(["dev", "worker", "reviewer"]);
	});

	it("keeps the roster full even when the picker hides already-@ names", () => {
		const members = ["dev", "worker"];
		// Picker drops `dev` because it is already mentioned...
		expect(
			mentionState({ text: "@dev @", caret: 6, members })?.candidates.map(
				(c) => c.name,
			),
		).toEqual(["worker", "all"]);
		// ...the roster still lists everyone.
		expect(rosterRows(members, null, {}).map((r) => r.name)).toEqual([
			"dev",
			"worker",
		]);
	});
});

describe("mentionKeydown / moveIndex (AC-4 / AC-6)", () => {
	it("AC-4: Enter/Tab select while open, Esc closes without submitting", () => {
		expect(
			mentionKeydown({
				key: "Enter",
				shiftKey: false,
				isComposing: false,
				open: true,
			}),
		).toBe("select");
		expect(
			mentionKeydown({
				key: "Tab",
				shiftKey: false,
				isComposing: false,
				open: true,
			}),
		).toBe("select");
		expect(
			mentionKeydown({
				key: "Escape",
				shiftKey: false,
				isComposing: false,
				open: true,
			}),
		).toBe("close");
	});

	it("AC-4: Enter submits only when the menu is closed and unshifted", () => {
		expect(
			mentionKeydown({
				key: "Enter",
				shiftKey: false,
				isComposing: false,
				open: false,
			}),
		).toBe("submit");
		expect(
			mentionKeydown({
				key: "Enter",
				shiftKey: true,
				isComposing: false,
				open: false,
			}),
		).toBe("none");
	});

	it("AC-6: an IME composition suppresses every action", () => {
		expect(
			mentionKeydown({
				key: "Enter",
				shiftKey: false,
				isComposing: true,
				open: true,
			}),
		).toBe("none");
		expect(
			mentionKeydown({
				key: "Enter",
				shiftKey: false,
				isComposing: true,
				open: false,
			}),
		).toBe("none");
	});

	it("cycles the highlight index and is safe on an empty list", () => {
		expect(moveIndex(0, 3, 1)).toBe(1);
		expect(moveIndex(2, 3, 1)).toBe(0);
		expect(moveIndex(0, 3, -1)).toBe(2);
		expect(moveIndex(0, 0, 1)).toBe(0);
	});
});
