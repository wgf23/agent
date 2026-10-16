// Pure-function tests for the mobile drawer state machine (AC-1).
// Contract: docs/design/webui-mobile-adaptation.md §7.1.
// No jsdom: layout/interaction stays manual (FR-8).
import { describe, expect, it } from "vitest";
import {
	type DrawerAction,
	drawerReducer,
	MOBILE_MAX_PX,
} from "../../web/src/layout";

describe("drawerReducer", () => {
	it("toggle flips the drawer either way", () => {
		expect(drawerReducer(false, "toggle")).toBe(true);
		expect(drawerReducer(true, "toggle")).toBe(false);
	});

	it("open always opens, however it was", () => {
		expect(drawerReducer(false, "open")).toBe(true);
		expect(drawerReducer(true, "open")).toBe(true);
	});

	it("close always closes, however it was", () => {
		expect(drawerReducer(false, "close")).toBe(false);
		expect(drawerReducer(true, "close")).toBe(false);
	});

	it("navigate closes, so picking a target returns to the main area", () => {
		expect(drawerReducer(true, "navigate")).toBe(false);
		expect(drawerReducer(false, "navigate")).toBe(false);
	});

	it("covers every action without an unknown branch", () => {
		const actions: DrawerAction[] = ["toggle", "open", "close", "navigate"];
		for (const action of actions) {
			expect(typeof drawerReducer(false, action)).toBe("boolean");
			expect(typeof drawerReducer(true, action)).toBe("boolean");
		}
	});
});

describe("MOBILE_MAX_PX", () => {
	it("matches the max-width: 640px queries it documents", () => {
		expect(MOBILE_MAX_PX).toBe(640);
	});
});
