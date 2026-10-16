import { describe, expect, it } from "vitest";
import { officeKindOf, previewOffice } from "../../src/serve/office.js";
import { ZipArchive, ZipReadError } from "../../src/serve/unzip.js";
import { buildZip } from "../helpers/zip.js";

const XLSX = buildZip([
	{
		name: "xl/workbook.xml",
		data: '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
	},
	{
		name: "xl/_rels/workbook.xml.rels",
		data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
	},
	{
		name: "xl/sharedStrings.xml",
		data: "<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>",
	},
	{
		name: "xl/worksheets/sheet1.xml",
		data: [
			"<worksheet><sheetData>",
			'<row r="1"><c r="A1" t="s"><v>0</v></c></row>',
			'<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row>',
			"</sheetData></worksheet>",
		].join(""),
	},
]);

const DOCX = buildZip([
	{
		name: "word/document.xml",
		data: [
			"<w:document><w:body>",
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>',
			"<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>&lt;world&gt;</w:t></w:r></w:p>",
			'<w:p><w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr><w:r><w:t>first</w:t></w:r></w:p>',
			"</w:body></w:document>",
		].join(""),
	},
]);

const PPTX = buildZip([
	{
		name: "ppt/slides/slide1.xml",
		data: [
			"<p:sld><p:cSld><p:spTree><p:sp><p:txBody>",
			"<a:p><a:r><a:t>Intro</a:t></a:r></a:p>",
			"<a:p><a:r><a:t>Point A</a:t></a:r></a:p>",
			"</p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
		].join(""),
	},
]);

describe("officeKindOf", () => {
	it("maps the OOXML extensions and ignores everything else", () => {
		expect(officeKindOf("report.xlsx")).toBe("xlsx");
		expect(officeKindOf("REPORT.XLSM")).toBe("xlsx");
		expect(officeKindOf("letter.docx")).toBe("docx");
		expect(officeKindOf("deck.pptx")).toBe("pptx");
		expect(officeKindOf("notes.docx.bak")).toBeNull();
		expect(officeKindOf("README.md")).toBeNull();
		expect(officeKindOf("noextension")).toBeNull();
	});
});

describe("previewOffice xlsx", () => {
	it("reads shared strings, numbers, and sparse cells as a padded grid", () => {
		const preview = previewOffice("xlsx", XLSX);
		expect(preview).toEqual({
			kind: "sheet",
			sheets: [
				{
					name: "Data",
					rows: [
						["Name", ""],
						["Alice", "42"],
					],
				},
			],
			truncated: false,
		});
	});

	it("caps the rows and reports the truncation", () => {
		const rows = Array.from(
			{ length: 400 },
			(_, index) =>
				`<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`,
		).join("");
		const preview = previewOffice(
			"xlsx",
			buildZip([
				{
					name: "xl/worksheets/sheet1.xml",
					data: `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
				},
			]),
		);
		expect(preview.kind).toBe("sheet");
		if (preview.kind !== "sheet") return;
		expect(preview.sheets[0].rows).toHaveLength(300);
		expect(preview.truncated).toBe(true);
	});
});

describe("previewOffice docx", () => {
	it("maps heading, paragraph, and list styles to plain decoded blocks", () => {
		expect(previewOffice("docx", DOCX)).toEqual({
			kind: "doc",
			blocks: [
				{ style: "h1", text: "Title" },
				{ style: "p", text: "Hello <world>" },
				{ style: "li", text: "first" },
			],
			truncated: false,
		});
	});

	it("returns markup-looking text as text, never as HTML", () => {
		const doc = buildZip([
			{
				name: "word/document.xml",
				data: "<w:document><w:body><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>",
			},
		]);
		const preview = previewOffice("docx", doc);
		expect(preview.kind).toBe("doc");
		if (preview.kind !== "doc") return;
		expect(preview.blocks[0].text).toBe("<script>alert(1)</script>");
	});
});

describe("previewOffice pptx", () => {
	it("takes the first text run as the title and the rest as lines", () => {
		expect(previewOffice("pptx", PPTX)).toEqual({
			kind: "slides",
			slides: [{ title: "Intro", lines: ["Point A"] }],
			truncated: false,
		});
	});
});

describe("ZipArchive", () => {
	it("refuses an entry that declares more bytes than the cap", () => {
		const bomb = buildZip([
			{ name: "xl/big.xml", data: "x", uncompressed: 5_000_000 },
		]);
		const archive = ZipArchive.open(bomb);
		expect(() => archive.read("xl/big.xml", 1024)).toThrow(ZipReadError);
	});

	it("reads a stored member and treats a missing name as absent", () => {
		const archive = ZipArchive.open(
			buildZip([
				{ name: "stored.txt", data: "stored bytes", store: true },
				{ name: "deflated.txt", data: "deflated bytes" },
			]),
		);
		expect(archive.read("stored.txt", 1024)?.toString("utf8")).toBe(
			"stored bytes",
		);
		expect(archive.read("deflated.txt", 1024)?.toString("utf8")).toBe(
			"deflated bytes",
		);
		expect(archive.read("nope.xml", 1024)).toBeUndefined();
	});

	it("throws on a buffer that is not a zip", () => {
		expect(() => ZipArchive.open(Buffer.from("not a zip"))).toThrow(
			ZipReadError,
		);
	});
});
