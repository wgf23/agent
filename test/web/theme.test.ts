import { describe, expect, it } from "vitest";
import { readTheme } from "../../web/src/theme";

function storage(value: string | null) {
	return { getItem: () => value };
}

describe("readTheme", () => {
	it("defaults to dark when nothing is stored", () => {
		expect(readTheme(storage(null))).toBe("dark");
	});

	it("returns light only for a stored light choice", () => {
		expect(readTheme(storage("light"))).toBe("light");
		expect(readTheme(storage("dark"))).toBe("dark");
		expect(readTheme(storage("sepia"))).toBe("dark");
	});
});
