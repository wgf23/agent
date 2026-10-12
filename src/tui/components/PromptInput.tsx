import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { useReducer, useRef } from "react";
import type { TuiStatus } from "../state.js";
import { isMenuOpen, type MenuState, type Suggestion } from "../suggestions.js";

const MAX_VISIBLE_LINES = 8;
const PLACEHOLDER = "Ask anything. /help for commands";

export interface PromptInputProps {
	value: string;
	disabled: boolean;
	active: boolean;
	status: TuiStatus;
	menu: MenuState;
	suggestionsFor: (text: string) => Suggestion[];
	onChange: (text: string) => void;
	onSubmit: (text: string) => void;
	onHistoryPrev: () => void;
	onHistoryNext: () => void;
	onMenuMove: (delta: 1 | -1) => void;
	onMenuClose: () => void;
	onCancel: () => void;
	onExit: () => void;
	onToggleTools: () => void;
	onToggleReasoning: () => void;
}

export function PromptInput({
	value,
	disabled,
	active,
	status,
	menu,
	suggestionsFor,
	onChange,
	onSubmit,
	onHistoryPrev,
	onHistoryNext,
	onMenuMove,
	onMenuClose,
	onCancel,
	onExit,
	onToggleTools,
	onToggleReasoning,
}: PromptInputProps): ReactElement {
	// A keystroke and the Enter that follows can arrive before React commits the
	// previous dispatch, so the latest text and cursor live in refs, not props.
	const latest = useRef(value);
	const cursorText = useRef(value);
	const cursor = useRef(value.length);
	const [, forceRender] = useReducer((count: number) => count + 1, 0);

	latest.current = value;
	if (cursorText.current !== value) {
		cursorText.current = value;
		cursor.current = value.length;
	}

	const apply = (next: string, nextCursor: number): void => {
		latest.current = next;
		cursorText.current = next;
		cursor.current = clamp(nextCursor, 0, next.length);
		onChange(next);
		forceRender();
	};

	const moveCursor = (next: number): void => {
		cursor.current = clamp(next, 0, latest.current.length);
		forceRender();
	};

	useInput(
		(input, key) => {
			// The dialog can mount before this handler's effect cleanup runs, so
			// check `active` here as well as through `isActive`.
			if (!active) return;
			if (key.ctrl && input === "c") {
				onExit();
				return;
			}
			if (key.ctrl && input === "o") {
				onToggleTools();
				return;
			}
			if (key.ctrl && input === "t") {
				onToggleReasoning();
				return;
			}
			const matches = suggestionsFor(latest.current);
			const menuOpen = isMenuOpen(menu, matches);
			if (key.escape) {
				if (menuOpen) onMenuClose();
				else onCancel();
				return;
			}
			if (input === "\n") {
				const text = latest.current;
				const position = cursor.current;
				apply(
					`${text.slice(0, position)}\n${text.slice(position)}`,
					position + 1,
				);
				return;
			}
			if (key.return) {
				if (menuOpen) {
					acceptSuggestion(matches, menu.index, apply);
					return;
				}
				if (!disabled && latest.current.trim() !== "") onSubmit(latest.current);
				return;
			}
			if (key.tab) {
				if (menuOpen) acceptSuggestion(matches, menu.index, apply);
				return;
			}
			if (key.upArrow || key.downArrow) {
				if (menuOpen) {
					onMenuMove(key.upArrow ? -1 : 1);
					return;
				}
				const text = latest.current;
				if (!text.includes("\n")) {
					if (key.upArrow) onHistoryPrev();
					else onHistoryNext();
					return;
				}
				moveCursor(moveLine(text, cursor.current, key.upArrow ? -1 : 1));
				return;
			}
			if (key.backspace || key.delete) {
				const text = latest.current;
				const position = cursor.current;
				if (key.delete) {
					if (position >= text.length) return;
					apply(text.slice(0, position) + text.slice(position + 1), position);
					return;
				}
				if (position === 0) return;
				apply(text.slice(0, position - 1) + text.slice(position), position - 1);
				return;
			}
			if (key.ctrl || key.meta || input === "") return;
			const text = latest.current;
			const position = cursor.current;
			apply(
				text.slice(0, position) + input + text.slice(position),
				position + input.length,
			);
		},
		{ isActive: active },
	);

	const text = latest.current;
	const lines = text.split("\n");
	const cursorLine = lineIndex(text, cursor.current);
	let start = 0;
	if (lines.length > MAX_VISIBLE_LINES) {
		start = clamp(
			cursorLine - MAX_VISIBLE_LINES + 1,
			0,
			lines.length - MAX_VISIBLE_LINES,
		);
	}
	const visible = lines.slice(start, start + MAX_VISIBLE_LINES);
	const matches = suggestionsFor(text);
	const menuOpen = isMenuOpen(menu, matches);
	const selected = clamp(menu.index, 0, matches.length - 1);
	const isEmpty = text === "";

	return (
		<Box flexDirection="column" width="100%">
			{menuOpen ? (
				<Box flexDirection="column" paddingX={1}>
					{matches.map((suggestion, index) => (
						<Text
							key={suggestion.value}
							color={index === selected ? "cyan" : undefined}
							bold={index === selected}
							dimColor={index !== selected}
						>
							{index === selected ? "❯ " : "  "}
							{suggestion.label}
							{suggestion.hint !== undefined ? `  ${suggestion.hint}` : ""}
						</Text>
					))}
				</Box>
			) : null}
			<Box
				borderStyle="round"
				borderColor={borderColor(status)}
				borderDimColor={status === "idle" || status === "error"}
				paddingX={1}
				width="100%"
				flexDirection="column"
			>
				{visible.map((line, index) => {
					const absolute = start + index;
					const indicator = absolute === 0 ? (disabled ? "… " : "> ") : "  ";
					return (
						<Text key={absolute}>
							<Text color="cyan">{indicator}</Text>
							{isEmpty && absolute === 0 ? (
								<Text dimColor>{PLACEHOLDER}</Text>
							) : (
								<Text>{line}</Text>
							)}
						</Text>
					);
				})}
			</Box>
		</Box>
	);
}

function acceptSuggestion(
	matches: Suggestion[],
	index: number,
	apply: (text: string, cursor: number) => void,
): void {
	const choice = matches[clamp(index, 0, matches.length - 1)];
	if (choice === undefined) return;
	apply(`${choice.value} `, choice.value.length + 1);
}

function borderColor(status: TuiStatus): string {
	if (status === "awaiting_permission") return "yellow";
	if (status === "streaming") return "cyan";
	return "gray";
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function lineIndex(text: string, offset: number): number {
	return text.slice(0, clamp(offset, 0, text.length)).split("\n").length - 1;
}

function lineBounds(
	text: string,
	offset: number,
): { start: number; end: number } {
	const start = text.lastIndexOf("\n", offset - 1) + 1;
	const nextNewline = text.indexOf("\n", start);
	const end = nextNewline === -1 ? text.length : nextNewline;
	return { start, end };
}

function moveLine(text: string, offset: number, direction: -1 | 1): number {
	const current = lineBounds(text, offset);
	const column = offset - current.start;
	if (direction === -1) {
		if (current.start === 0) return offset;
		const previous = lineBounds(text, current.start - 1);
		return previous.start + Math.min(column, previous.end - previous.start);
	}
	if (current.end === text.length) return offset;
	const next = lineBounds(text, current.end + 1);
	return next.start + Math.min(column, next.end - next.start);
}
