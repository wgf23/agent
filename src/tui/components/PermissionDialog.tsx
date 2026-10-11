import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import type { ApprovalChoice } from "../../permissions/authorizer.js";
import type { PendingPermission } from "../approval.js";

export interface PermissionDialogProps {
	request: PendingPermission;
	onChoice: (choice: ApprovalChoice) => void;
}

export function PermissionDialog({
	request,
	onChoice,
}: PermissionDialogProps): ReactElement {
	useInput((input, key) => {
		if (key.escape) {
			onChoice("deny");
			return;
		}
		const choice = input.toLowerCase();
		if (choice === "n") {
			onChoice("deny");
			return;
		}
		if (choice === "y") {
			onChoice("allow_once");
			return;
		}
		if (choice === "a" && !request.dangerous) {
			onChoice("allow_always");
		}
	});

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="yellow"
			paddingX={1}
		>
			<Text bold>Permission required</Text>
			<Text>
				<Text bold>{request.toolName}</Text>
				{` ${request.subject}`}
			</Text>
			{request.dangerous ? (
				<Text color="red">Warning: this command looks dangerous.</Text>
			) : null}
			{request.dangerous ? (
				<Text dimColor>always is not available for dangerous commands</Text>
			) : (
				<Text dimColor>{`always allows ${request.rule}`}</Text>
			)}
			<Text>
				<Text color="green">y</Text>
				{" allow once   "}
				<Text color={request.dangerous ? "gray" : "green"}>a</Text>
				{" allow always   "}
				<Text color="red">n</Text>
				{" deny"}
			</Text>
		</Box>
	);
}
