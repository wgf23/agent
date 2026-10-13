import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

// One line that truncates rather than wrapping, so both status bars stay a
// single row in a narrow terminal.
export function StatusRow({ children }: { children: ReactNode }): ReactElement {
	return (
		<Box width="100%">
			<Text wrap="truncate">{children}</Text>
		</Box>
	);
}
