import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { RoomEntry } from "../../../rob/room.js";
import type { TeamRoomState } from "../state.js";

export interface RoomTranscriptProps {
	room: TeamRoomState;
}

// Read-only: the room is the only writer of its transcript; this renders the
// entries the reducer applied, and keeps command output in notes below.
export function RoomTranscript({ room }: RoomTranscriptProps): ReactElement {
	return (
		<Box flexDirection="column">
			<Text bold>{`room ${room.name} · ${room.members.join(", ")}`}</Text>
			<Text dimColor>{runLine(room)}</Text>
			{room.transcript.length === 0 ? (
				<Text dimColor>(no messages yet)</Text>
			) : null}
			{room.transcript.map((entry) => (
				<Text key={entry.id}>{`${speakerOf(entry)}: ${entry.text}`}</Text>
			))}
			{room.notes.map((note) => (
				<Text key={`note-${note.id}`} dimColor>
					{`· ${note.text}`}
				</Text>
			))}
			<Text dimColor>@name scopes the round to that member</Text>
		</Box>
	);
}

function speakerOf(entry: RoomEntry): string {
	switch (entry.kind) {
		case "user":
			return "user";
		case "member":
			return entry.from;
		case "system":
			return "system";
	}
}

function runLine(room: TeamRoomState): string {
	const run = room.run;
	if (run.phase === "running") {
		const current = run.current === null ? "" : ` · ${run.current} is replying`;
		return `round ${run.round}/${run.rounds} · ${run.remaining} messages left${current}`;
	}
	if (room.lastOutcome === null) return "idle";
	return `idle · ${room.lastOutcome}`;
}
