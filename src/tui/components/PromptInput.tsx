import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { useRef } from "react";

export interface PromptInputProps {
	value: string;
	disabled: boolean;
	onChange: (text: string) => void;
	onSubmit: (text: string) => void;
	onHistoryPrev: () => void;
	onHistoryNext: () => void;
	onCancel: () => void;
	onExit: () => void;
}

export function PromptInput({
	value,
	disabled,
	onChange,
	onSubmit,
	onHistoryPrev,
	onHistoryNext,
	onCancel,
	onExit,
}: PromptInputProps): ReactElement {
	// A keystroke and the Enter that follows can arrive before React commits the
	// previous dispatch, so the latest text is tracked in a ref rather than props.
	const latest = useRef(value);
	latest.current = value;

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			onExit();
			return;
		}
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.return) {
			const text = latest.current;
			if (!disabled && text.trim() !== "") onSubmit(text);
			return;
		}
		if (key.upArrow) {
			onHistoryPrev();
			return;
		}
		if (key.downArrow) {
			onHistoryNext();
			return;
		}
		if (key.backspace || key.delete) {
			const next = latest.current.slice(0, -1);
			latest.current = next;
			onChange(next);
			return;
		}
		if (key.ctrl || key.meta || key.tab || input === "") return;
		const next = latest.current + input;
		latest.current = next;
		onChange(next);
	});

	return (
		<Box>
			<Text color="cyan">{disabled ? "… " : "> "}</Text>
			<Text>{value}</Text>
		</Box>
	);
}
