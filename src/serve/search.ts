import type { SearchHit, SessionMatch } from "../../shared/protocol.js";
import type { Turn } from "../bot/schema.js";
import type { Message } from "../providers/types.js";
import type { StoredSession } from "../session/store.js";

// v1 is a linear scan with no index and no cache. These bounds keep a broad
// query from returning an unbounded payload; the same per-section cap applies
// to the chat and to every bot.
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

// The bot half: every turn for the workspace grouped by session in turn order,
// capped to MAX_SESSION_MATCHES. A turn from another workspace is filtered out,
// the same rule replay uses, so a search never surfaces another workspace's
// conversation.
export function turnMatches(
	turns: readonly Turn[],
	workspaceRoot: string,
	titles: Readonly<Record<string, string>>,
	query: string,
): SessionMatch[] {
	const bySession = new Map<string, SessionMatch>();
	for (const turn of [...turns].sort((a, b) => a.seq - b.seq)) {
		if (turn.workspaceRoot !== workspaceRoot) continue;
		const hits = messageHits(turn.messages, turn.at, query);
		if (hits.length === 0) continue;
		const existing = bySession.get(turn.sessionId);
		if (existing === undefined) {
			bySession.set(turn.sessionId, {
				sessionId: turn.sessionId,
				title: titles[turn.sessionId] ?? null,
				firstUserText: firstUserMessageText(turn.messages),
				hits,
			});
			continue;
		}
		existing.hits.push(...hits);
		if (existing.firstUserText === "") {
			existing.firstUserText = firstUserMessageText(turn.messages);
		}
	}
	return [...bySession.values()].slice(0, MAX_SESSION_MATCHES).map((match) => ({
		...match,
		hits: match.hits.slice(0, MAX_HITS_PER_SESSION),
	}));
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
