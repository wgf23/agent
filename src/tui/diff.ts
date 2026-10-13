import { diffLines } from "diff";

export type DiffLineKind = "add" | "remove" | "context";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
}

export const WRITE_DIFF_MAX_LINES = 20;

export interface AddedLines {
	lines: string[];
	omitted: number;
}

// Line-level changes match the red/green prefixed rendering the card uses; a word
// diff would not read as added and removed lines.
export function lineDiff(oldText: string, newText: string): DiffLine[] {
	const lines: DiffLine[] = [];
	for (const change of diffLines(oldText, newText)) {
		if (change.value === "") continue;
		const kind: DiffLineKind = change.added
			? "add"
			: change.removed
				? "remove"
				: "context";
		const body = change.value.endsWith("\n")
			? change.value.slice(0, -1)
			: change.value;
		for (const text of body.split("\n")) {
			lines.push({ kind, text });
		}
	}
	return lines;
}

export function addedLines(content: string): AddedLines {
	const all = content.split("\n");
	const lines = all.slice(0, WRITE_DIFF_MAX_LINES);
	return { lines, omitted: all.length - lines.length };
}
