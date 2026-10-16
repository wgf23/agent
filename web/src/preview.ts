// Pure classification and decoding for the file preview. The component reads
// the bytes and renders; these functions decide which tier a name belongs to,
// cap the delimited rows and columns, and turn raw bytes into text, so the
// behavior is testable without a DOM.

// A text, code, markdown, JSON, or CSV preview loads the whole file into the
// page, so it is bounded; a larger file is left to the download link.
export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
export const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;

// A table is capped in both dimensions so a wide or long sheet cannot build an
// unbounded DOM.
export const MAX_TABLE_ROWS = 500;
export const MAX_TABLE_COLS = 40;

export type PreviewKind =
	| "image"
	| "markdown"
	| "json"
	| "csv"
	| "code"
	| "office"
	| "text"
	| "unsupported";

const IMAGE_EXT = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"avif",
	"ico",
]);

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);

const JSON_EXT = new Set(["json", "jsonc", "json5"]);

const CSV_EXT = new Set(["csv", "tsv"]);

const OFFICE_EXT = new Set(["docx", "xlsx", "xlsm", "pptx"]);

// A known-binary name never gets fetched; it goes straight to the download
// fallback. Unknown names are sniffed after the fetch, which catches the rest.
const BINARY_EXT = new Set([
	"zip",
	"gz",
	"tgz",
	"tar",
	"bz2",
	"7z",
	"rar",
	"pdf",
	"exe",
	"dll",
	"so",
	"dylib",
	"bin",
	"o",
	"a",
	"class",
	"jar",
	"wasm",
	"mp3",
	"ogg",
	"wav",
	"flac",
	"mp4",
	"mov",
	"avi",
	"mkv",
	"webm",
	"ttf",
	"otf",
	"woff",
	"woff2",
]);

// highlight.js's common bundle covers these; an unmapped extension still shows
// as text, only without a language guess.
const CODE_LANG: Record<string, string> = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "typescript",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	swift: "swift",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	lua: "lua",
	r: "r",
	pl: "perl",
	sql: "sql",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	css: "css",
	scss: "scss",
	less: "less",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	ini: "ini",
	conf: "ini",
	diff: "diff",
	patch: "diff",
	graphql: "graphql",
	gql: "graphql",
	vb: "vbnet",
	ktm: "kotlin",
};

export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function previewKind(name: string): PreviewKind {
	const ext = extensionOf(name);
	if (IMAGE_EXT.has(ext)) return "image";
	if (MARKDOWN_EXT.has(ext)) return "markdown";
	if (JSON_EXT.has(ext)) return "json";
	if (CSV_EXT.has(ext)) return "csv";
	if (OFFICE_EXT.has(ext)) return "office";
	if (BINARY_EXT.has(ext)) return "unsupported";
	if (ext in CODE_LANG) return "code";
	return "text";
}

// The language highlight.js is asked for: JSON goes to its own grammar, code
// names map through the table, and everything else lets highlight.js guess.
export function codeLanguage(name: string): string {
	const ext = extensionOf(name);
	if (JSON_EXT.has(ext)) return "json";
	return CODE_LANG[ext] ?? "";
}

// The client-side byte cap for a tier, or null when the server enforces its own
// cap (office) or no bytes are fetched (image streams through an <img>).
export function previewByteLimit(kind: PreviewKind): number | null {
	if (kind === "image") return MAX_IMAGE_PREVIEW_BYTES;
	if (kind === "office") return null;
	if (kind === "unsupported") return null;
	return MAX_TEXT_PREVIEW_BYTES;
}

export function decodeText(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// A NUL in the leading bytes is the cheapest reliable signal that a file is not
// text; an extension the table did not know is sniffed with this after the
// fetch. Only the head is scanned, so a large text file is not walked twice.
export function isProbablyBinary(bytes: Uint8Array): boolean {
	const limit = Math.min(bytes.length, 8192);
	for (let index = 0; index < limit; index += 1) {
		if (bytes[index] === 0) return true;
	}
	return false;
}

// Pretty-prints JSON when it parses; a partial or invalid document falls back
// to the raw text rather than an error, so an in-progress edit still previews.
export function formatJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

// Splits CSV or TSV into rows, honoring quoted fields and doubled quotes.
// Rows and columns are capped and the overflow is reported, never silently
// dropped.
export function parseDelimited(
	text: string,
	delimiter: string,
	maxRows: number = MAX_TABLE_ROWS,
	maxCols: number = MAX_TABLE_COLS,
): { rows: string[][]; truncated: boolean } {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let truncated = false;

	const pushField = () => {
		if (row.length < maxCols) row.push(field);
		else truncated = true;
		field = "";
	};
	const pushRow = () => {
		if (rows.length < maxRows) rows.push(row);
		else truncated = true;
		row = [];
	};

	let index = 0;
	while (index < text.length) {
		const ch = text[index];
		if (quoted) {
			if (ch === '"' && text[index + 1] === '"') {
				field += '"';
				index += 2;
			} else if (ch === '"') {
				quoted = false;
				index += 1;
			} else {
				field += ch;
				index += 1;
			}
			continue;
		}
		if (ch === '"' && field === "") {
			quoted = true;
			index += 1;
		} else if (ch === delimiter) {
			pushField();
			index += 1;
		} else if (ch === "\r") {
			index += 1;
		} else if (ch === "\n") {
			pushField();
			pushRow();
			index += 1;
		} else {
			field += ch;
			index += 1;
		}
	}
	if (field !== "" || row.length > 0) {
		pushField();
		pushRow();
	}
	return { rows, truncated };
}
