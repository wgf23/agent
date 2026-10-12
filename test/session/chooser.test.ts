import { describe, expect, it } from "vitest";
import { chooseSession } from "../../src/session/chooser.js";

const sessions = [{ id: "ses_one" }, { id: "ses_two" }];

describe("chooseSession", () => {
	it("errors when both flags are given", () => {
		expect(
			chooseSession({ continueFlag: true, sessionId: "ses_one" }, sessions),
		).toEqual({
			mode: "error",
			error: "Use either --continue or --session <id>, not both.",
		});
	});

	it("picks the latest when only continue is given", () => {
		expect(chooseSession({ continueFlag: true }, sessions)).toEqual({
			mode: "latest",
		});
	});

	it("starts new when continue finds no sessions", () => {
		expect(chooseSession({ continueFlag: true }, [])).toEqual({ mode: "new" });
	});

	it("picks a known id", () => {
		expect(
			chooseSession({ continueFlag: false, sessionId: "ses_two" }, sessions),
		).toEqual({ mode: "id", id: "ses_two" });
	});

	it("errors on an unknown id", () => {
		expect(
			chooseSession(
				{ continueFlag: false, sessionId: "ses_missing" },
				sessions,
			),
		).toEqual({ mode: "error", error: "Unknown session: ses_missing" });
	});

	it("starts new when neither flag is given", () => {
		expect(chooseSession({ continueFlag: false }, sessions)).toEqual({
			mode: "new",
		});
	});
});
