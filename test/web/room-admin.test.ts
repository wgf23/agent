import { describe, expect, it } from "vitest";
import {
	ROOM_MAX_MEMBERS as SRC_MAX_MEMBERS,
	ROOM_MIN_MEMBERS as SRC_MIN_MEMBERS,
} from "../../src/rob/room-limits.js";
import {
	ADMIN_TOKEN_STORAGE_KEY,
	canCreateRoom,
	canDeleteRoom,
	canSaveSettings,
	ROOM_MAX_MEMBERS,
	ROOM_MIN_MEMBERS,
	readAdminToken,
	reconcileCoordinator,
	saveAdminToken,
	settingsChanged,
	settingsPatch,
	toggleMember,
} from "../../web/src/room-admin";

// A sessionStorage stand-in: the helpers take the slice they need, so no jsdom
// (this repo has none) and no globals.
function storage(initial: Record<string, string> = {}) {
	const items = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => {
			items.set(key, value);
		},
		removeItem: (key: string) => {
			items.delete(key);
		},
		has: (key: string) => items.has(key),
	};
}

const current = { members: ["alpha", "beta"], coordinator: "alpha" };

describe("toggleMember", () => {
	it("appends a name that is not a member", () => {
		expect(toggleMember(["alpha", "beta"], "gamma")).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
	});

	it("removes a name and keeps the order of the rest", () => {
		expect(toggleMember(["alpha", "beta", "gamma"], "beta")).toEqual([
			"alpha",
			"gamma",
		]);
	});
});

describe("reconcileCoordinator", () => {
	it("clears a coordinator the list no longer holds", () => {
		expect(reconcileCoordinator(["beta"], "alpha")).toBeNull();
	});

	it("keeps one that is still there, and null stays null", () => {
		expect(reconcileCoordinator(["alpha", "beta"], "beta")).toBe("beta");
		expect(reconcileCoordinator(["alpha"], null)).toBeNull();
	});
});

describe("settingsChanged / settingsPatch", () => {
	it("reports no change when the draft mirrors the room", () => {
		expect(settingsChanged(current, current)).toBe(false);
		expect(settingsPatch(current, current)).toEqual({});
	});

	it("sends only the half that changed", () => {
		expect(
			settingsPatch({ members: current.members, coordinator: "beta" }, current),
		).toEqual({ coordinator: "beta" });
		expect(
			settingsPatch(
				{ members: ["beta", "alpha"], coordinator: current.coordinator },
				current,
			),
		).toEqual({ members: ["beta", "alpha"] });
	});

	it("treats a different order as a change", () => {
		// Membership order is turn order, so it is part of the value, not a set.
		expect(
			settingsChanged(
				{ members: ["beta", "alpha"], coordinator: "alpha" },
				current,
			),
		).toBe(true);
	});
});

describe("canSaveSettings", () => {
	const base = {
		current,
		busy: false,
		submitting: false,
		minMembers: 2,
		maxMembers: 20,
	};

	it("refuses an unchanged draft and a live room", () => {
		expect(canSaveSettings({ ...base, draft: current })).toBe(false);
		expect(
			canSaveSettings({
				...base,
				busy: true,
				draft: { members: ["beta", "alpha"], coordinator: "alpha" },
			}),
		).toBe(false);
	});

	it("refuses a list outside the server's bounds", () => {
		expect(
			canSaveSettings({
				...base,
				draft: { members: ["alpha"], coordinator: "alpha" },
			}),
		).toBe(false);
	});

	it("allows a real change on an idle room", () => {
		expect(
			canSaveSettings({
				...base,
				draft: { members: ["beta", "alpha"], coordinator: "alpha" },
			}),
		).toBe(true);
	});
});

describe("admin token storage", () => {
	it("reads nothing as empty and trims what is stored", () => {
		expect(readAdminToken(storage())).toBe("");
		expect(
			readAdminToken(storage({ [ADMIN_TOKEN_STORAGE_KEY]: "  abc  " })),
		).toBe("abc");
	});

	it("writes a trimmed token and forgets a blank one", () => {
		const store = storage();
		saveAdminToken(" abc ", store);
		expect(store.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBe("abc");
		saveAdminToken("   ", store);
		expect(store.has(ADMIN_TOKEN_STORAGE_KEY)).toBe(false);
	});
});

describe("canDeleteRoom", () => {
	const base = {
		typed: "ship-it",
		name: "ship-it",
		submitting: false,
		token: "abc",
	};

	it("allows a delete only when the name is typed exactly and a token exists", () => {
		expect(canDeleteRoom(base)).toBe(true);
	});

	it("refuses a mismatched or partial name, including trailing spaces", () => {
		for (const typed of ["", "ship", "ship-it ", "Ship-It", " ship-it"]) {
			expect(canDeleteRoom({ ...base, typed }), typed).toBe(false);
		}
	});

	it("refuses while the drawer is already deleting", () => {
		expect(canDeleteRoom({ ...base, submitting: true })).toBe(false);
	});

	it("refuses a blank token: the server would only answer 403", () => {
		expect(canDeleteRoom({ ...base, token: "" })).toBe(false);
		expect(canDeleteRoom({ ...base, token: "   " })).toBe(false);
	});

	it("refuses an empty room name rather than matching an empty draft", () => {
		expect(canDeleteRoom({ ...base, name: "", typed: "" })).toBe(false);
	});
});

describe("canCreateRoom", () => {
	// Both bounds come from the same module the dialog passes in, so a drift
	// here is a real bug and not a test-fixture mismatch.
	const base = {
		nameValid: true,
		memberCount: ROOM_MIN_MEMBERS,
		submitting: false,
		minMembers: ROOM_MIN_MEMBERS,
		maxMembers: ROOM_MAX_MEMBERS,
	};

	it("allows the inclusive bounds and everything between them", () => {
		for (const memberCount of [ROOM_MIN_MEMBERS, ROOM_MAX_MEMBERS]) {
			expect(canCreateRoom({ ...base, memberCount }), `${memberCount}`).toBe(
				true,
			);
		}
	});

	// The upper bound is what the server refuses and what no click can reach
	// with fewer than 21 robs, so this is the only guard it has.
	it("refuses one member below the minimum and one above the maximum", () => {
		expect(canCreateRoom({ ...base, memberCount: ROOM_MIN_MEMBERS - 1 })).toBe(
			false,
		);
		expect(canCreateRoom({ ...base, memberCount: ROOM_MAX_MEMBERS + 1 })).toBe(
			false,
		);
	});

	it("refuses an invalid name even with a valid member count", () => {
		expect(canCreateRoom({ ...base, nameValid: false })).toBe(false);
	});

	it("refuses while the create request is in flight", () => {
		expect(canCreateRoom({ ...base, submitting: true })).toBe(false);
	});
});

// web/ cannot import src/ at runtime (separate tsconfig and bundler), so the
// limits are duplicated on both sides. This pins the duplication: drifting
// either copy is otherwise silent, since each side only tests itself.
describe("room limits match the server's", () => {
	it("keeps the duplicated bounds equal to src/rob/room-limits.ts", () => {
		expect(ROOM_MIN_MEMBERS).toBe(SRC_MIN_MEMBERS);
		expect(ROOM_MAX_MEMBERS).toBe(SRC_MAX_MEMBERS);
	});
});
