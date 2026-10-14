import type { SessionSummaryInfo } from "./protocol";

// The fields a label needs, so a search hit (a SessionMatch) and a sidebar row
// (a SessionSummaryInfo) can share the one helper.
export type SessionLabelSource = Pick<
	SessionSummaryInfo,
	"title" | "firstUserText"
>;

// The one place a session's label is chosen, so the workspace chat's list and a
// bot's list cannot disagree: an owner-set title wins, then the first thing the
// user said, then a neutral placeholder. A blank string falls through rather
// than labelling a row with spaces.
export function sessionLabel(session: SessionLabelSource): string {
	const title = session.title?.trim() ?? "";
	if (title !== "") return title;
	const firstUserText = session.firstUserText.trim();
	if (firstUserText !== "") return firstUserText;
	return "新会话";
}
