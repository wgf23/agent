import { describe, expect, it } from "vitest";
import { readTheme } from "../../web/src/theme";

function storage(value: string | null) {
	return { getItem: () => value };
}

describe("readTheme", () => {
	it("defaults to light when nothing is stored", () => {
		expect(readTheme(storage(null))).toBe("light");
	});

	it("returns dark only for a stored dark choice", () => {
		expect(readTheme(storage("dark"))).toBe("dark");
		expect(readTheme(storage("light"))).toBe("light");
		expect(readTheme(storage("sepia"))).toBe("light");
	});
});
