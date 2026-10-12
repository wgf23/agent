import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { DmEntry } from "../../../rob/types.js";

export interface DmViewProps {
	dms: DmEntry[];
}

// Read-only: the view owns no input handler and no Team reference.
export function DmView({ dms }: DmViewProps): ReactElement {
	return (
		<Box flexDirection="column">
			<Text bold>Direct messages (read-only)</Text>
			{dms.length === 0 ? (
				<Text dimColor>(no DMs)</Text>
			) : (
				dms.map((dm) => (
					<Text key={`${dm.from}-${dm.to}-${dm.at}-${dm.text}`}>
						{`${dm.from} → ${dm.to}: ${dm.text}`}
					</Text>
				))
			)}
			<Text dimColor>escape to close</Text>
		</Box>
	);
}
