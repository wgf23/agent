// Pure layout constants and the mobile drawer state machine.
// No React, no DOM: App binds these to state and CSS owns the breakpoint.
// Contract: docs/design/webui-mobile-adaptation.md §7.1.

/** The mobile breakpoint, kept in step with the `max-width: 640px` queries. */
export const MOBILE_MAX_PX = 640;

/** What a drawer gesture means: a hamburger tap, a backdrop/Esc close, or a
 *  navigation choice that should return the reader to the main area. */
export type DrawerAction = "toggle" | "open" | "close" | "navigate";

/** The drawer's open/closed state machine: toggling flips, open shows, and both
 *  close and navigate hide it (picking a target returns to the main area). */
export function drawerReducer(open: boolean, action: DrawerAction): boolean {
	switch (action) {
		case "toggle":
			return !open;
		case "open":
			return true;
		case "close":
		case "navigate":
			return false;
	}
}
