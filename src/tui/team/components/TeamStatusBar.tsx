import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { type TeamState, teamTokens } from "../state.js";

export interface TeamStatusBarProps {
	state: TeamState;
}

export function TeamStatusBar({ state }: TeamStatusBarProps): ReactElement {
	const tokens = teamTokens(state);
	return (
		<Box width="100%">
			<Text wrap="truncate">
				<Text color="cyan">{state.model}</Text>
				<Text>{`  robs ${state.robs.length}`}</Text>
				<Text>{`  waiting ${state.approvals.length}`}</Text>
				<Text>{`  tokens ${tokens.input + tokens.output}`}</Text>
			</Text>
		</Box>
	);
}
