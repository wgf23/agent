import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { TeamRobState, TeamRoomState } from "../state.js";

export interface TeamListProps {
	robs: TeamRobState[];
	rooms: TeamRoomState[];
	selected: number;
}

// Rooms follow the robs in the same list; `selected` indexes that order.
export function TeamList({
	robs,
	rooms,
	selected,
}: TeamListProps): ReactElement {
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
			{rooms.map((room, index) => {
				const active = robs.length + index === selected;
				return (
					<Text
						key={room.name}
						color={active ? "cyan" : undefined}
						bold={active}
					>
						{`${active ? "> " : "  "}${room.name}  room  ${roomLabel(room)}`}
					</Text>
				);
			})}
		</Box>
	);
}

function roomLabel(room: TeamRoomState): string {
	if (room.run.phase === "running") {
		return `running ${room.run.round}/${room.run.rounds}`;
	}
	return `${room.members.length} members`;
}
