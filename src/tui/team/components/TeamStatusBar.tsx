import { Text } from "ink";
import type { ReactElement } from "react";
import { SPINNER_FRAMES, useSpinner } from "../../components/StatusBar.js";
import { StatusRow } from "../../components/StatusRow.js";
import { type TeamState, teamTokens } from "../state.js";

export interface TeamStatusBarProps {
	state: TeamState;
}

export function TeamStatusBar({ state }: TeamStatusBarProps): ReactElement {
	const tokens = teamTokens(state);
	// A rob reports `working` while its run streams, so the row spins for the
	// same reason the single-agent row does.
	const working = state.robs.some((rob) => rob.robStatus === "working");
	const frame = useSpinner(working);
	return (
		<StatusRow>
			<Text color="cyan">{state.model}</Text>
			<Text>{`  robs ${state.robs.length}`}</Text>
			<Text>{`  waiting ${state.approvals.length}`}</Text>
			<Text>{`  tokens ${tokens.input + tokens.output}`}</Text>
			{working ? (
				<Text color="yellow">{`  ${SPINNER_FRAMES[frame]}`}</Text>
			) : null}
		</StatusRow>
	);
}
