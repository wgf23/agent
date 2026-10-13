import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { Suggestion } from "../suggestions.js";

export interface SuggestionMenuProps {
	items: Suggestion[];
	index: number;
}

export function SuggestionMenu({
	items,
	index,
}: SuggestionMenuProps): ReactElement {
	return (
		<Box flexDirection="column" paddingX={1}>
			{items.map((suggestion, position) => {
				const selected = position === index;
				return (
					<Text
						key={suggestion.value}
						color={selected ? "cyan" : undefined}
						bold={selected}
						dimColor={!selected}
					>
						{selected ? "❯ " : "  "}
						{suggestion.label}
						{suggestion.hint !== undefined ? `  ${suggestion.hint}` : ""}
					</Text>
				);
			})}
		</Box>
	);
}
