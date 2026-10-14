import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { isLocalRequest } from "../../src/serve/server.js";

// The local-only guard reads the caller, not the bind host: a loopback peer is
// the machine, and any other peer must hold the server token. These are the two
// branches the HTTP tests cannot both reach, because a test client is always on
// loopback.
function request(
	remoteAddress: string | null,
	options: { authorization?: string; queryToken?: string } = {},
): FastifyRequest {
	return {
		socket: { remoteAddress },
		headers:
			options.authorization === undefined
				? {}
				: { authorization: options.authorization },
		query:
			options.queryToken === undefined ? {} : { token: options.queryToken },
	} as unknown as FastifyRequest;
}

describe("isLocalRequest", () => {
	it("accepts every loopback form the kernel reports", () => {
		expect(isLocalRequest(request("127.0.0.1"), undefined)).toBe(true);
		expect(isLocalRequest(request("127.0.0.53"), undefined)).toBe(true);
		expect(isLocalRequest(request("::1"), undefined)).toBe(true);
		expect(isLocalRequest(request("::ffff:127.0.0.1"), undefined)).toBe(true);
	});

	it("refuses a non-loopback peer with no token", () => {
		expect(isLocalRequest(request("10.0.0.5"), undefined)).toBe(false);
		expect(isLocalRequest(request("::ffff:10.0.0.5"), undefined)).toBe(false);
		expect(isLocalRequest(request(null), undefined)).toBe(false);
	});

	it("accepts a non-loopback peer that presents the server token", () => {
		const token = "s3cret-token";
		expect(
			isLocalRequest(request("10.0.0.5", { queryToken: token }), token),
		).toBe(true);
		expect(
			isLocalRequest(
				request("10.0.0.5", { authorization: `Bearer ${token}` }),
				token,
			),
		).toBe(true);
	});

	it("refuses a non-loopback peer with a wrong or absent token", () => {
		expect(
			isLocalRequest(request("10.0.0.5", { queryToken: "nope" }), "s3cret"),
		).toBe(false);
		expect(isLocalRequest(request("10.0.0.5"), "s3cret")).toBe(false);
	});

	it("does not let a loopback peer skip anything (loopback is already local)", () => {
		expect(isLocalRequest(request("127.0.0.1"), "s3cret")).toBe(true);
	});
});
