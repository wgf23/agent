import { useState } from "react";
import type { SwitchWorkspaceResult } from "../api";
import type { FsDirsResponse, WorkspaceOption } from "../protocol";
import WorkspaceBrowser from "./WorkspaceBrowser";

interface Props {
	workspaces: WorkspaceOption[];
	activeRoot: string;
	listDirs: (path?: string) => Promise<FsDirsResponse>;
	onSwitch: (root: string) => Promise<SwitchWorkspaceResult>;
}

// The switch is server-driven: the modal only names a root; the server reopens
// the scope and emits a fresh hello, so nothing here merges state. The trigger
// keeps the current workspace label; the directory browser and the recent list
// both live in the modal.
export default function WorkspacePicker({
	workspaces,
	activeRoot,
	listDirs,
	onSwitch,
}: Props) {
	const [open, setOpen] = useState(false);

	const active =
		workspaces.find((workspace) => workspace.active) ??
		workspaces.find((workspace) => workspace.root === activeRoot);
	const label =
		active?.label ?? (activeRoot !== "" ? activeRoot : "选择工作区");

	return (
		<div className="workspace-picker">
			<button
				type="button"
				className="workspace-trigger"
				onClick={() => setOpen(true)}
				aria-expanded={open}
				title={activeRoot}
			>
				<span className="workspace-label">{label}</span>
				<span className="workspace-caret" aria-hidden="true">
					▾
				</span>
			</button>

			{open && (
				<WorkspaceBrowser
					workspaces={workspaces}
					activeRoot={activeRoot}
					listDirs={listDirs}
					onSwitch={onSwitch}
					onClose={() => setOpen(false)}
				/>
			)}
		</div>
	);
}
