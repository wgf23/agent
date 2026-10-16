// The room @-mention picker's arithmetic, kept out of the component so a node
// test can pin it without a DOM. Two token rules live here and must not be
// mixed (docs/design/room-mention-and-roster.md §2): Q is the wide, case
// insensitive query the user is typing (drives the dropdown and the replacement
// span), B is the strict lowercase rule src/rob/room-text.ts uses at send time
// (drives the "already mentioned" exclusion). The only difference is case;
// "-" is a name character in both, while "," "@" and spaces terminate both.

import type { BotState } from "./protocol";
import { STATUS_LABEL } from "./status";

/**
 * B: the backend's mention token, identical to src/rob/room-text.ts:32. Exported
 * as source, not as a /g regex: a shared stateful instance is a footgun, since
 * `matchAll` copies its `lastIndex` and an outside `.test()`/`.exec()` would
 * silently shift the scan.
 */
export const MENTION_RE_SOURCE = "@([a-z][a-z0-9-]*)";
const QUERY_TAIL_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

export interface MentionQuery {
	anchor: number;
	length: number;
	query: string;
}

/**
 * The "@ token" the caret sits at, per the wide Q rule. Returns null when the
 * character after "@" cannot start a name (e.g. "@1", "@ "), so the menu closes
 * instead of falling back to "everything". Only the text left of the caret is
 * examined; insertMention handles whatever trails it.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
	const anchor = text.lastIndexOf("@", caret - 1);
	if (anchor < 0) return null;
	const segment = text.slice(anchor + 1, caret);
	if (segment !== "" && !QUERY_TAIL_RE.test(segment)) return null;
	return { anchor, length: caret - anchor, query: segment.toLowerCase() };
}

/**
 * Every name the strict B rule finds in the text, in order and deduplicated.
 * skipIndex drops the match that starts at that offset, so the token still being
 * typed never excludes its own member from the list. A fresh regex is built per
 * call: `matchAll` copies the receiver's `lastIndex`, so reusing a shared /g
 * instance would let an unrelated `.test()`/`.exec()` silently skip the first
 * mention.
 */
export function mentionedNames(text: string, skipIndex?: number): string[] {
	const seen = new Set<string>();
	for (const match of text.matchAll(new RegExp(MENTION_RE_SOURCE, "g"))) {
		if (match.index === skipIndex) continue;
		seen.add(match[1]);
	}
	return [...seen];
}

export interface MentionCandidate {
	name: string;
	label: string;
	broadcast: boolean;
}

export interface MentionState {
	anchor: number;
	length: number;
	query: string;
	candidates: MentionCandidate[];
}

/**
 * Query plus candidates in one step. Members keep their order and drop out once
 * they are already mentioned (B rule); the broadcast item is appended last and
 * only when no real member is literally called "all" (in which case "all" is an
 * ordinary member whose exact name wins).
 */
export function mentionState(input: {
	text: string;
	caret: number;
	members: readonly string[];
}): MentionState | null {
	const query = mentionQuery(input.text, input.caret);
	if (query === null) return null;
	const mentioned = new Set(mentionedNames(input.text, query.anchor));
	const candidates: MentionCandidate[] = [];
	for (const name of input.members) {
		if (mentioned.has(name)) continue;
		if (!name.toLowerCase().startsWith(query.query)) continue;
		candidates.push({ name, label: `@${name}`, broadcast: false });
	}
	const hasAll = input.members.some((name) => name === "all");
	if (!hasAll && !mentioned.has("all") && "all".startsWith(query.query)) {
		candidates.push({ name: "all", label: "@all 所有人", broadcast: true });
	}
	return {
		anchor: query.anchor,
		length: query.length,
		query: query.query,
		candidates,
	};
}

export interface InsertResult {
	text: string;
	caret: number;
}

/** Extends a caret position rightwards over the rest of a name token. */
function tokenEnd(text: string, from: number): number {
	let end = from;
	while (end < text.length && /[A-Za-z0-9-]/.test(text[end] ?? "")) end += 1;
	return end;
}

/**
 * Replaces the caret's @ token with `@name ` and reports where the caret lands.
 * The replacement runs to the end of the token, not just to the caret, so
 * choosing with the caret mid-token (`@de|v`) leaves no tail behind. The
 * trailing space is part of the contract: it terminates the token so the next
 * "@" starts a fresh one.
 */
export function insertMention(
	text: string,
	caret: number,
	name: string,
): InsertResult {
	const query = mentionQuery(text, caret);
	if (query === null) return { text, caret };
	const end = tokenEnd(text, caret);
	const next = `${text.slice(0, query.anchor)}@${name} ${text.slice(end)}`;
	return { text: next, caret: query.anchor + name.length + 2 };
}

export interface RosterRow {
	name: string;
	label: string;
	isCoordinator: boolean;
	statusLabel: string;
}

/** Every member, in order, with coordinator mark and status; missing = idle. */
export function rosterRows(
	members: readonly string[],
	coordinator: string | null,
	botStates: Record<string, BotState>,
): RosterRow[] {
	return members.map((name) => ({
		name,
		label: `@${name}`,
		isCoordinator: name === coordinator,
		statusLabel: STATUS_LABEL[botStates[name]?.status ?? "idle"],
	}));
}

export type MentionAction = "submit" | "select" | "close" | "none";

/**
 * What a keypress means while the menu may be open. An IME composition wins over
 * everything: Enter there is confirming a candidate, not sending.
 */
export function mentionKeydown(input: {
	key: string;
	shiftKey: boolean;
	isComposing: boolean;
	open: boolean;
}): MentionAction {
	if (input.isComposing) return "none";
	if (input.open) {
		if (input.key === "Enter" || input.key === "Tab") return "select";
		if (input.key === "Escape") return "close";
		return "none";
	}
	if (input.key === "Enter" && !input.shiftKey) return "submit";
	return "none";
}

/** Wraps the highlight around a list of `count` items. */
export function moveIndex(index: number, count: number, delta: 1 | -1): number {
	if (count <= 0) return 0;
	return (index + delta + count) % count;
}

/**
 * Keeps the highlight inside the live list, so a candidate set that shrank off
 * an onChange path (say a members event) can never leave Enter pointing at a
 * missing row.
 */
export function clampIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	return Math.min(Math.max(index, 0), count - 1);
}
