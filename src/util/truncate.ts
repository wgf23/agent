export interface TruncateOptions {
	maxLines?: number;
	maxBytes?: number;
}

export interface TruncateResult {
	text: string;
	truncated: boolean;
}

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

export function truncateOutput(
	text: string,
	options: TruncateOptions = {},
): TruncateResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const lines = text.split("\n");
	let kept = text;
	let linesCut = 0;
	if (lines.length > maxLines) {
		linesCut = lines.length - maxLines;
		kept = lines.slice(0, maxLines).join("\n");
	}

	let bytesCut = 0;
	const keptBytes = Buffer.byteLength(kept, "utf8");
	if (keptBytes > maxBytes) {
		// Slicing the buffer can split a multi-byte character, so drop the
		// replacement character the decoder emits at the boundary.
		kept = Buffer.from(kept, "utf8")
			.subarray(0, maxBytes)
			.toString("utf8")
			.replace(/\uFFFD$/, "");
		bytesCut = keptBytes - Buffer.byteLength(kept, "utf8");
	}

	if (linesCut === 0 && bytesCut === 0) {
		return { text: kept, truncated: false };
	}

	const parts: string[] = [];
	if (linesCut > 0) parts.push(`${linesCut} lines`);
	if (bytesCut > 0) parts.push(`${bytesCut} bytes`);
	return {
		text: `${kept}\n[truncated: ${parts.join(" and ")} cut]`,
		truncated: true,
	};
}
