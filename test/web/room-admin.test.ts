import { describe, expect, it } from "vitest";
import {
	ADMIN_TOKEN_STORAGE_KEY,
	canSaveSettings,
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
