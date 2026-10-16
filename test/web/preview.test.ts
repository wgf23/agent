import { describe, expect, it } from "vitest";
import {
	codeLanguage,
	decodeText,
	formatJson,
	isProbablyBinary,
	MAX_TABLE_COLS,
	MAX_TABLE_ROWS,
	parseDelimited,
	previewByteLimit,
	previewKind,
} from "../../web/src/preview";

describe("previewKind", () => {
	it("classifies each tier by extension", () => {
		expect(previewKind("logo.svg")).toBe("image");
		expect(previewKind("photo.WEBP")).toBe("image");
		expect(previewKind("README.md")).toBe("markdown");
		expect(previewKind("data.json")).toBe("json");
		expect(previewKind("table.csv")).toBe("csv");
		expect(previewKind("sheet.tsv")).toBe("csv");
		expect(previewKind("report.xlsx")).toBe("office");
		expect(previewKind("app.tsx")).toBe("code");
		expect(previewKind("notes.log")).toBe("text");
		expect(previewKind("archive.zip")).toBe("unsupported");
		expect(previewKind("Makefile")).toBe("text");
	});
});

describe("codeLanguage", () => {
	it("maps extensions to highlight.js grammars", () => {
		expect(codeLanguage("main.py")).toBe("python");
		expect(codeLanguage("App.tsx")).toBe("typescript");
		expect(codeLanguage("data.json")).toBe("json");
		expect(codeLanguage("style.scss")).toBe("scss");
		expect(codeLanguage("unknown.zzz")).toBe("");
	});
});

describe("previewByteLimit", () => {
	it("gives text-like tiers the text cap and office no client cap", () => {
		expect(previewByteLimit("code")).toBe(1024 * 1024);
		expect(previewByteLimit("csv")).toBe(1024 * 1024);
		expect(previewByteLimit("image")).toBe(20 * 1024 * 1024);
		expect(previewByteLimit("office")).toBeNull();
		expect(previewByteLimit("unsupported")).toBeNull();
	});
});

describe("isProbablyBinary", () => {
	it("flags a NUL byte and passes plain text", () => {
		expect(isProbablyBinary(new TextEncoder().encode("hello"))).toBe(false);
		expect(isProbablyBinary(new Uint8Array([104, 0, 105]))).toBe(true);
	});
});

describe("decodeText", () => {
	it("decodes UTF-8 without throwing on invalid bytes", () => {
		expect(decodeText(new TextEncoder().encode("héllo"))).toBe("héllo");
		expect(decodeText(new Uint8Array([0xff]))).toBe("\uFFFD");
	});
});

describe("formatJson", () => {
	it("pretty-prints valid JSON and passes invalid text through", () => {
		expect(formatJson('{"a":[1,2]}')).toBe(
			'{\n  "a": [\n    1,\n    2\n  ]\n}',
		);
		expect(formatJson("{oops")).toBe("{oops");
	});
});

describe("parseDelimited", () => {
	it("parses quotes, escaped quotes, and embedded newlines", () => {
		const { rows, truncated } = parseDelimited(
			'a,b\n"x, y","she said ""hi"""\n"line\nbreak",z',
			",",
		);
		expect(rows).toEqual([
			["a", "b"],
			["x, y", 'she said "hi"'],
			["line\nbreak", "z"],
		]);
		expect(truncated).toBe(false);
	});

	it("parses tab-separated input and ignores a trailing newline", () => {
		expect(parseDelimited("a\tb\nc\td\n", "\t").rows).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});

	it("caps rows and columns and reports the overflow", () => {
		const wide = Array.from({ length: MAX_TABLE_COLS + 5 }, () => "x").join(
			",",
		);
		const long = Array.from({ length: MAX_TABLE_ROWS + 5 }, () => wide).join(
			"\n",
		);
		const { rows, truncated } = parseDelimited(long, ",");
		expect(rows).toHaveLength(MAX_TABLE_ROWS);
		expect(rows[0]).toHaveLength(MAX_TABLE_COLS);
		expect(truncated).toBe(true);
	});
});
