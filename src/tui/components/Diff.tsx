import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { DiffLine, DiffLineKind } from "../diff.js";

const PREFIX: Record<DiffLineKind, string> = {
	add: "+",
	remove: "-",
	context: " ",
};

const COLOR: Record<DiffLineKind, string | undefined> = {
	add: "green",
	remove: "red",
	context: undefined,
};

export function Diff({ lines }: { lines: DiffLine[] }): ReactElement {
	return <Box flexDirection="column">{toNodes(lines)}</Box>;
}

function toNodes(lines: DiffLine[]): ReactElement[] {
	const nodes: ReactElement[] = [];
	const occurrences = new Map<string, number>();
	for (const line of lines) {
		const base = `${line.kind}:${line.text}`;
		const seen = occurrences.get(base) ?? 0;
		occurrences.set(base, seen + 1);
		nodes.push(
			<Text
				key={`${base}#${seen}`}
				color={COLOR[line.kind]}
				dimColor={line.kind === "context"}
			>
				{PREFIX[line.kind]}
				{line.text}
			</Text>,
		);
	}
	return nodes;
}
