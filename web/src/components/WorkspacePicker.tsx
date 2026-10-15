import { useState } from "react";
import type { FsDirsResponse } from "../protocol";
import WorkspaceBrowser from "./WorkspaceBrowser";

interface Props {
	// The workspace root the file panel is showing, so the trigger can name it.
	root: string;
	listDirs: (path?: string) => Promise<FsDirsResponse>;
	// Opens one directory of the workspace as the panel's root; the panel maps
	// the absolute path back to the workspace-relative one it lists by.
	onOpen: (path: string) => void;
	// True when an absolute path is inside the workspace, which is what the
	// route can list; an outside path is offered as a browse target only.
	canOpen: (path: string) => boolean;
}

// The panel's workspace control. The server's workspace root is fixed for the
// life of the run, so the picker chooses which directory inside it the panel is
// rooted at rather than switching the server's root. The directory browser and
// the manual path field both live in the modal.
export default function WorkspacePicker({
	root,
	listDirs,
	onOpen,
	canOpen,
}: Props) {
	const [open, setOpen] = useState(false);

	return (
		<div className="workspace-picker">
			<button
				type="button"
				className="workspace-trigger"
				onClick={() => setOpen(true)}
				aria-expanded={open}
				title={root}
			>
				<span className="workspace-label">{labelOf(root)}</span>
				<span className="workspace-caret" aria-hidden="true">
					▾
				</span>
			</button>

			{open && (
				<WorkspaceBrowser
					title="选择目录"
					initialPath={root}
					listDirs={listDirs}
					selectLabel="打开此目录"
					canSelect={canOpen}
					selectHint="只能打开工作区内的目录"
					onSelect={(path) => {
						onOpen(path);
						setOpen(false);
					}}
					onClose={() => setOpen(false)}
				/>
			)}
		</div>
	);
}

// The chip names the panel's root by its last segment, so a deep root stays
// readable; the title attribute carries the whole path.
function labelOf(root: string): string {
	const base = root.replace(/\/+$/, "");
	const slash = base.lastIndexOf("/");
	const name = slash === -1 ? base : base.slice(slash + 1);
	return name === "" ? base || "/" : name;
}
