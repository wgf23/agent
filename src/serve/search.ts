import type {
	RoomMatches,
	SearchHit,
	SessionMatch,
} from "../../shared/protocol.js";
import type { Message } from "../providers/types.js";
import type { RoomEntry, RoomView } from "../rob/room.js";
import type { StoredSession } from "../session/store.js";

// v1 is a linear scan with no index and no cache. These bounds keep a broad
// query from returning an unbounded payload; the same per-section cap applies
// to the chat and to every room.
export const MAX_SESSION_MATCHES = 20;
export const MAX_HITS_PER_SESSION = 50;
export const SNIPPET_RADIUS = 80;

export interface MatchRange {
	start: number;
	end: number;
}

// Every non-overlapping occurrence of the literal, case-insensitive query, or
// null when the text does not carry it. An empty query never matches, so a
// blank search is the route's 400, never a request for everything.
export function matchText(text: string, query: string): MatchRange[] | null {
	if (query === "") return null;
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase();
	const ranges: MatchRange[] = [];
	let from = 0;
	while (from <= haystack.length - needle.length) {
		const start = haystack.indexOf(needle, from);
		if (start === -1) break;
		const end = start + needle.length;
		ranges.push({ start, end });
		from = end;
	}
	return ranges.length === 0 ? null : ranges;
}

// The bounded window around the first match, with the match intact. The window
// is at most query.length + 2 * radius characters; a query with no match yields
// the empty string, since there is no run to keep intact.
export function snippet(text: string, query: string, radius: number): string {
	const first = matchText(text, query)?.[0];
	if (first === undefined) return "";
	const start = Math.max(0, first.start - radius);
	const end = Math.min(text.length, first.end + radius);
	return text.slice(start, end);
}

// The chat half: one workspace session, or null when nothing in it matches.
export function sessionMatch(
	session: StoredSession,
	query: string,
): SessionMatch | null {
	const hits = messageHits(session.messages, session.updatedAt, query);
	if (hits.length === 0) return null;
	return {
		sessionId: session.id,
		title: session.title ?? null,
		firstUserText: firstUserMessageText(session.messages),
		hits: hits.slice(0, MAX_HITS_PER_SESSION),
	};
}

// The room half: every room's transcript, one session-shaped result per room
// since a room owns exactly one conversation. Rooms with no match are omitted,
// and the cap keeps the rooms with the newest matching entry first, the same
// recency direction the chat half uses.
export function roomMatches(
	rooms: readonly RoomView[],
	query: string,
): RoomMatches[] {
	const results: Array<{
		room: string;
		match: SessionMatch;
		newestAt: number;
	}> = [];
	for (const room of rooms) {
		const hits = entryHits(room.transcript, query);
		if (hits.length === 0) continue;
		results.push({
			room: room.name,
			match: {
				// A room's name is its address on the wire and its owner-set
				// label, so both the id and the title carry it.
				sessionId: room.name,
				title: room.name,
				firstUserText: firstUserEntryText(room.transcript),
				hits: hits.slice(0, MAX_HITS_PER_SESSION),
			},
			newestAt: hits.at(-1)?.at ?? 0,
		});
	}
	return results
		.sort((a, b) => b.newestAt - a.newestAt)
		.slice(0, MAX_SESSION_MATCHES)
		.map(({ room, match }) => ({ room, matches: [match] }));
}

// One hit per message whose searchable text carries the query, in message
// order. Assistant text lives in content blocks; every other role carries a
// plain string.
function messageHits(
	messages: readonly Message[],
	at: number,
	query: string,
): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const message of messages) {
		const text = messageText(message);
		if (matchText(text, query) === null) continue;
		hits.push({
			role: message.role,
			text: snippet(text, query, SNIPPET_RADIUS),
			at,
		});
		if (hits.length >= MAX_HITS_PER_SESSION) break;
	}
	return hits;
}

// One hit per transcript entry whose text carries the query, in id order (the
// room's own order). A member speaking is the room's assistant voice, so it
// maps to the one role the session shape has for that.
function entryHits(entries: readonly RoomEntry[], query: string): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const entry of entries) {
		if (matchText(entry.text, query) === null) continue;
		hits.push({
			role: entry.kind === "member" ? "assistant" : entry.kind,
			text: snippet(entry.text, query, SNIPPET_RADIUS),
			at: entry.at,
		});
	}
	return hits;
}

function messageText(message: Message): string {
	if (message.role !== "assistant") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function firstUserMessageText(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role === "user") return message.content;
	}
	return "";
}

function firstUserEntryText(entries: readonly RoomEntry[]): string {
	for (const entry of entries) {
		if (entry.kind === "user") return entry.text;
	}
	return "";
}
