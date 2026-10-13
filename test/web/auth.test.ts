import { describe, expect, it } from "vitest";
import { authHeaders, eventsUrl, readToken } from "../../web/src/auth";

// These helpers are what let the browser prove it may talk to a non-loopback
// server; the values are asserted literally so a helper that returned
// undefined could never satisfy them.
describe("readToken", () => {
	it("reads the token query parameter", () => {
		expect(readToken("?token=abc")).toBe("abc");
	});

	it("finds the token alongside other parameters", () => {
		expect(readToken("?x=1&token=abc")).toBe("abc");
	});

	it("is null when there is no query string", () => {
		expect(readToken("")).toBeNull();
	});

	it("is null when the token is present but empty", () => {
		expect(readToken("?token=")).toBeNull();
	});
});

describe("eventsUrl", () => {
	it("appends the token so the EventSource can authenticate", () => {
		expect(eventsUrl("abc")).toBe("/api/events?token=abc");
	});

	it("stays bare when there is no token", () => {
		expect(eventsUrl(null)).toBe("/api/events");
	});
});

describe("authHeaders", () => {
	it("builds a bearer header from the token", () => {
		expect(authHeaders("abc")).toEqual({ Authorization: "Bearer abc" });
	});

	it("adds nothing when there is no token", () => {
		expect(authHeaders(null)).toEqual({});
	});
});
