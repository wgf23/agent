// Auth helpers shared by the SSE connection and the fetch call sites. They are
// pure string functions so a node import (and the test suite) never needs a DOM.

export function readToken(search: string): string | null {
	const token = new URLSearchParams(search).get("token");
	return token === null || token === "" ? null : token;
}

export function eventsUrl(token: string | null): string {
	return token === null
		? "/api/events"
		: `/api/events?token=${encodeURIComponent(token)}`;
}

export function authHeaders(token: string | null): Record<string, string> {
	return token === null ? {} : { Authorization: `Bearer ${token}` };
}
