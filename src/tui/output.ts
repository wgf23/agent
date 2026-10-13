// Kept in step with the agent's UI cap so a card never shows more output than
// the tool result the model was shown.
export const UI_OUTPUT_MAX_CHARS = 4000;

export function capUiOutput(text: string): string {
	return text.length > UI_OUTPUT_MAX_CHARS
		? `${text.slice(0, UI_OUTPUT_MAX_CHARS)}[truncated]`
		: text;
}
