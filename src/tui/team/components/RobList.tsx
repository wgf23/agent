import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { TeamRobState } from "../state.js";

export interface RobListProps {
	robs: TeamRobState[];
	selected: number;
}

export function RobList({ robs, selected }: RobListProps): ReactElement {
	return (
		<Box flexDirection="column" marginRight={2}>
			{robs.map((rob, index) => {
				const active = index === selected;
				return (
					<Text
						key={rob.name}
						color={active ? "cyan" : undefined}
						bold={active}
					>
						{`${active ? "> " : "  "}${rob.name}  ${rob.robStatus}  ${rob.messages.length}`}
					</Text>
				);
			})}
		</Box>
	);
}
