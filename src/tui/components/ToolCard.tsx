import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { addedLines, lineDiff } from "../diff.js";
import { capUiOutput } from "../output.js";
import type { ToolStatus, TuiToolCall } from "../state.js";
import { argString } from "../summarize.js";
import { Diff } from "./Diff.js";
import { SPINNER_FRAMES } from "./StatusBar.js";

const OUTPUT_PREVIEW_LINES = 3;

const STATUS_MARK: Record<Exclude<ToolStatus, "running">, string> = {
	ok: "✓",
	error: "✗",
	blocked: "⊘",
};

const STATUS_COLOR: Record<ToolStatus, string | undefined> = {
	running: "yellow",
	ok: "green",
	error: "red",
	blocked: "red",
};

export interface ToolCardProps {
	card: TuiToolCall;
	expanded: boolean;
}

export function ToolCard({ card, expanded }: ToolCardProps): ReactElement {
	const frame = useSpinner(card.status === "running");
	const marker =
		card.status === "running"
			? SPINNER_FRAMES[frame]
			: STATUS_MARK[card.status];

	return (
		<Box flexDirection="column">
			<Text>
				<Text color={STATUS_COLOR[card.status]}>{marker} </Text>
				<Text bold>{card.name}</Text>
				<Text dimColor>{` ${card.summary}`}</Text>
			</Text>
			<ToolBody card={card} expanded={expanded} />
		</Box>
	);
}

function ToolBody({ card, expanded }: ToolCardProps): ReactElement | null {
	if (card.status === "ok") {
		const diff = fileDiff(card);
		if (diff !== undefined) {
			return (
				<Box flexDirection="column">
					{diff.lines.length > 0 ? <Diff lines={diff.lines} /> : null}
					{diff.omitted > 0 ? (
						<Text dimColor>{`... ${diff.omitted} more lines`}</Text>
					) : null}
				</Box>
			);
		}
	}
	if (card.output === "") return null;
	const lines = capUiOutput(card.output).split("\n");
	const shown = expanded ? lines : lines.slice(0, OUTPUT_PREVIEW_LINES);
	const hidden = lines.length - shown.length;
	const color =
		card.status === "blocked" || card.status === "error" ? "red" : undefined;
	return (
		<Box flexDirection="column">
			<Text color={color}>{shown.join("\n")}</Text>
			{hidden > 0 ? (
				<Text dimColor>{`... ${hidden} more lines (ctrl+o to expand)`}</Text>
			) : null}
		</Box>
	);
}

interface FileDiff {
	lines: ReturnType<typeof lineDiff>;
	omitted: number;
}

function fileDiff(card: TuiToolCall): FileDiff | undefined {
	if (card.name === "edit_file") {
		const oldString = argString(card.args, "old_string");
		const newString = argString(card.args, "new_string");
		if (oldString === undefined || newString === undefined) return undefined;
		return { lines: lineDiff(oldString, newString), omitted: 0 };
	}
	if (card.name === "write_file") {
		const content = argString(card.args, "content");
		if (content === undefined) return undefined;
		const added = addedLines(content);
		return {
			lines: added.lines.map((text) => ({ kind: "add" as const, text })),
			omitted: added.omitted,
		};
	}
	return undefined;
}

function useSpinner(active: boolean): number {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(
			() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length),
			80,
		);
		return () => clearInterval(timer);
	}, [active]);
	return frame;
}
