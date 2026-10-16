// QA boundary pin for the backend mention tokenizer.
//
// Scope: docs/prd/room-mention-and-roster.md FR-1.4 / AC-12. The front-end @
// picker must not diverge from how the backend actually tokenizes `@name`, so
// these cases pin the *real* `parseRoomMentions` behaviour (no new semantics).
// AC-12 is worded as these exact truths: `-` is part of the name charset
// `[a-z][a-z0-9-]*` (not a terminator), while `,`/`@`/space/uppercase/CJK end a
// token. This is the *backend* truth; the web picker's own pure-function cases
// live separately under test/web/**.
import { describe, expect, it } from "vitest";
import { parseRoomMentions } from "../../src/rob/room-text.js";
import type { RobName } from "../../src/rob/types.js";

// A member set that includes a hyphenated name on purpose: it proves `-` is a
// legal name character, not a terminator.
const members: readonly RobName[] = ["dev", "dev-", "de", "all", "worker"];

describe("parseRoomMentions: token boundary vs the front-end picker (AC-12)", () => {
	it("does not treat a trailing hyphen as a terminator (token is `dev-`)", () => {
		// `dev-` is a real member here, so it IS addressed — never truncated to `dev`.
		expect(parseRoomMentions("@dev- please", members)).toEqual({
			body: "please",
			addressed: ["dev-"],
		});
		// With no hyphenated member present, the same token matches nobody and
		// stays in the body — again, not `dev`.
		expect(parseRoomMentions("@dev- please", ["dev"])).toEqual({
			body: "@dev- please",
			addressed: [],
		});
	});

	it("terminates a token on punctuation and on a second @", () => {
		expect(parseRoomMentions("@dev, go", members)).toEqual({
			body: ", go",
			addressed: ["dev"],
		});
		// A bare trailing `@` ends the token and is left in the body.
		expect(parseRoomMentions("@dev@", members)).toEqual({
			body: "@",
			addressed: ["dev"],
		});
		expect(parseRoomMentions("@dev@x", members)).toEqual({
			body: "@x",
			addressed: ["dev"],
		});
	});

	it("terminates a token on whitespace", () => {
		expect(parseRoomMentions("@dev ", members)).toEqual({
			body: "",
			addressed: ["dev"],
		});
		expect(parseRoomMentions("@dev hi", members)).toEqual({
			body: "hi",
			addressed: ["dev"],
		});
	});

	it("is case-sensitive: an uppercase tail is left over, not folded", () => {
		expect(parseRoomMentions("@deV", members)).toEqual({
			body: "V",
			addressed: ["de"],
		});
	});

	it("does not address a fully uppercase hand-typed token (AC-13 known behaviour)", () => {
		// The UI may *offer* a match for `@DEV` (case-insensitive query), but a
		// user who types `@DEV` and sends without picking from the menu gets no
		// mention: the backend regex only matches `[a-z]`.
		expect(parseRoomMentions("@DEV", members)).toEqual({
			body: "@DEV",
			addressed: [],
		});
		expect(parseRoomMentions("@DEV hi", members)).toEqual({
			body: "@DEV hi",
			addressed: [],
		});
	});
});
