import type {
	DocBlock,
	DocPreview,
	OfficePreview,
	SheetPreview,
	SlidePreview,
} from "../../shared/protocol.js";
import { ZipArchive, ZipReadError } from "./unzip.js";

// Extracts a text-and-grid preview from a docx, xlsx, or pptx container. The
// container is a zip of XML; each part is read whole, capped, and reduced to
// decoded text. No XML is parsed as markup and no HTML is produced, so a
// document cannot inject script through the preview.

export type OfficeKind = "xlsx" | "docx" | "pptx";

// One uncompressed part is capped well below the route's whole-file cap, so a
// single part cannot expand without bound even inside a small archive.
const MAX_PART_BYTES = 32 * 1024 * 1024;

// Visible caps. Every one reports through `truncated` rather than silently
// dropping rows, so the UI can say the view is partial.
const MAX_SHEETS = 20;
const MAX_ROWS = 300;
const MAX_COLS = 60;
const MAX_DOC_BLOCKS = 5000;
const MAX_SLIDES = 200;

export function officeKindOf(name: string): OfficeKind | null {
	const dot = name.lastIndexOf(".");
	if (dot === -1) return null;
	const ext = name.slice(dot + 1).toLowerCase();
	if (ext === "xlsx" || ext === "xlsm") return "xlsx";
	if (ext === "docx") return "docx";
	if (ext === "pptx") return "pptx";
	return null;
}

export function previewOffice(kind: OfficeKind, buffer: Buffer): OfficePreview {
	const archive = ZipArchive.open(buffer);
	if (kind === "xlsx") return extractXlsx(archive);
	if (kind === "docx") return extractDocx(archive);
	return extractPptx(archive);
}

// ---------- xlsx ----------

interface SheetRef {
	name: string;
	target: string;
}

function extractXlsx(archive: ZipArchive): SheetPreview {
	const shared = parseSharedStrings(
		archive.read("xl/sharedStrings.xml", MAX_PART_BYTES)?.toString("utf8"),
	);
	const refs = readSheetList(archive);
	const sheets: SheetPreview["sheets"] = [];
	let truncated = refs.length > MAX_SHEETS;
	for (const ref of refs.slice(0, MAX_SHEETS)) {
		const xml = archive.read(ref.target, MAX_PART_BYTES);
		if (xml === undefined) continue;
		const parsed = parseSheet(xml.toString("utf8"), shared);
		sheets.push({ name: ref.name, rows: parsed.rows });
		if (parsed.truncated) truncated = true;
	}
	return { kind: "sheet", sheets, truncated };
}

// The sheet order and names live in workbook.xml; the relationship id maps to
// the worksheet part through workbook.xml.rels. A workbook that omits either
// falls back to the worksheet parts in numeric order.
function readSheetList(archive: ZipArchive): SheetRef[] {
	const targets = new Map<string, string>();
	const rels = archive.read("xl/_rels/workbook.xml.rels", MAX_PART_BYTES);
	if (rels !== undefined) {
		for (const match of rels
			.toString("utf8")
			.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
			const id = attribute(match[1], "Id");
			const target = attribute(match[1], "Target");
			if (id !== undefined && target !== undefined) {
				targets.set(id, normalizePart("xl", target));
			}
		}
	}

	const sheets: SheetRef[] = [];
	const workbook = archive.read("xl/workbook.xml", MAX_PART_BYTES);
	if (workbook !== undefined) {
		for (const match of workbook
			.toString("utf8")
			.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
			const name = attribute(match[1], "name") ?? "Sheet";
			const rid = attribute(match[1], "r:id");
			const target = rid === undefined ? undefined : targets.get(rid);
			if (target !== undefined) sheets.push({ name, target });
		}
	}
	if (sheets.length > 0) return sheets;

	return archive
		.names()
		.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
		.sort((a, b) => worksheetNumber(a) - worksheetNumber(b))
		.map((target) => ({ name: baseName(target), target }));
}

function parseSheet(
	xml: string,
	shared: string[],
): { rows: string[][]; truncated: boolean } {
	const rows: string[][] = [];
	let truncated = false;
	for (const match of xml.matchAll(
		/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g,
	)) {
		if (rows.length >= MAX_ROWS) {
			truncated = true;
			break;
		}
		rows.push(parseRow(match[2] ?? "", shared));
	}

	let width = 0;
	for (const row of rows) width = Math.max(width, row.length);
	if (width > MAX_COLS) {
		width = MAX_COLS;
		truncated = true;
	}
	for (const row of rows) {
		while (row.length < width) row.push("");
		if (row.length > width) row.length = width;
	}
	return { rows, truncated };
}

// A cell carries its column in `r` (e.g. "C7"), which places it even when empty
// cells are omitted; a cell without a reference falls at the next slot.
function parseRow(xml: string, shared: string[]): string[] {
	const cells: string[] = [];
	for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
		if (cells.length >= MAX_COLS) break;
		const attrs = match[1];
		const inner = match[2] ?? "";
		const ref = attribute(attrs, "r");
		const index = ref === undefined ? cells.length : columnIndex(ref);
		if (index >= MAX_COLS) continue;
		while (cells.length < index) cells.push("");
		cells[index] = cellText(inner, attribute(attrs, "t") ?? "n", shared);
	}
	return cells;
}

function cellText(inner: string, type: string, shared: string[]): string {
	if (type === "inlineStr") return collectText(inner);
	const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
	const raw = value === null ? "" : decodeXml(value[1]);
	if (type === "s") {
		const index = Number.parseInt(raw, 10);
		return Number.isInteger(index) && index >= 0 && index < shared.length
			? shared[index]
			: "";
	}
	if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
	return raw;
}

function parseSharedStrings(xml: string | undefined): string[] {
	if (xml === undefined) return [];
	const strings: string[] = [];
	for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
		strings.push(collectText(match[1]));
	}
	return strings;
}

// Concatenates every text run of a shared-string or inline-string fragment.
function collectText(xml: string): string {
	let out = "";
	for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
		out += decodeXml(match[1]);
	}
	return out;
}

// ---------- docx ----------

function extractDocx(archive: ZipArchive): DocPreview {
	const xml = archive.read("word/document.xml", MAX_PART_BYTES);
	if (xml === undefined) throw new ZipReadError("missing word/document.xml");
	const blocks: DocBlock[] = [];
	let truncated = false;
	for (const match of xml
		.toString("utf8")
		.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
		if (blocks.length >= MAX_DOC_BLOCKS) {
			truncated = true;
			break;
		}
		const { style, text } = parseParagraph(match[1]);
		if (text === "") continue;
		blocks.push({ style, text });
	}
	return { kind: "doc", blocks, truncated };
}

function parseParagraph(xml: string): {
	style: DocBlock["style"];
	text: string;
} {
	const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(xml);
	return {
		style: blockStyle(styleMatch === null ? "" : styleMatch[1]),
		text: paragraphText(xml),
	};
}

function blockStyle(name: string): DocBlock["style"] {
	const heading = /^(?:Heading|标题)\s*([1-6])$/.exec(name);
	if (heading !== null) return `h${heading[1]}` as DocBlock["style"];
	if (name === "Title") return "h1";
	if (name === "ListParagraph") return "li";
	return "p";
}

// Joins a paragraph's text runs, turning a tab and a break into the characters
// the plain-text view shows. A nested run (inside a hyperlink) is still a run.
function paragraphText(xml: string): string {
	let out = "";
	for (const match of xml.matchAll(
		/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g,
	)) {
		if (match[1] !== undefined) out += decodeXml(match[1]);
		else if (match[0].startsWith("<w:tab")) out += "\t";
		else out += "\n";
	}
	return out;
}

// ---------- pptx ----------

function extractPptx(archive: ZipArchive): SlidePreview {
	const names = archive
		.names()
		.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
		.sort((a, b) => slideNumber(a) - slideNumber(b));
	const slides: SlidePreview["slides"] = [];
	for (const name of names.slice(0, MAX_SLIDES)) {
		const xml = archive.read(name, MAX_PART_BYTES)?.toString("utf8") ?? "";
		const [title = "", ...lines] = collectAllText(xml);
		slides.push({ title, lines });
	}
	return { kind: "slides", slides, truncated: names.length > MAX_SLIDES };
}

function collectAllText(xml: string): string[] {
	const texts: string[] = [];
	for (const match of xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)) {
		const text = decodeXml(match[1]);
		if (text !== "") texts.push(text);
	}
	return texts;
}

// ---------- XML helpers ----------

// One attribute value from a tag's attribute string. The name is matched as a
// whole token, so `id` never matches `r:id`.
function attribute(attrs: string, name: string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`).exec(attrs);
	return match === null ? undefined : decodeXml(match[1]);
}

// Decodes the five predefined XML entities and numeric character references.
// No DTD or external entity is ever resolved, so there is no XXE path.
function decodeXml(text: string): string {
	return text.replace(
		/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
		(match, body: string) => {
			if (body.startsWith("#x") || body.startsWith("#X")) {
				return codePoint(Number.parseInt(body.slice(2), 16), match);
			}
			if (body.startsWith("#")) {
				return codePoint(Number.parseInt(body.slice(1), 10), match);
			}
			switch (body) {
				case "amp":
					return "&";
				case "lt":
					return "<";
				case "gt":
					return ">";
				case "quot":
					return '"';
				case "apos":
					return "'";
				default:
					return match;
			}
		},
	);
}

function codePoint(value: number, fallback: string): string {
	return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
		? String.fromCodePoint(value)
		: fallback;
}

// A relationship target is relative to the part that declares it; a leading
// slash is package-absolute. Both normalize to a posix path inside the zip.
function normalizePart(base: string, target: string): string {
	const raw = target.startsWith("/") ? target.slice(1) : `${base}/${target}`;
	const parts: string[] = [];
	for (const segment of raw.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") parts.pop();
		else parts.push(segment);
	}
	return parts.join("/");
}

function columnIndex(ref: string): number {
	let index = 0;
	for (const ch of ref) {
		const code = ch.charCodeAt(0);
		if (code >= 65 && code <= 90) index = index * 26 + (code - 64);
		else if (code >= 97 && code <= 122) index = index * 26 + (code - 96);
		else break;
	}
	return Math.max(0, index - 1);
}

function worksheetNumber(name: string): number {
	return Number.parseInt(name.replace(/\D+/g, ""), 10) || 0;
}

function slideNumber(name: string): number {
	return Number.parseInt(name.replace(/\D+/g, ""), 10) || 0;
}

function baseName(name: string): string {
	return (name.split("/").pop() ?? name).replace(/\.xml$/, "");
}
