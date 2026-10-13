import { useState } from "react";
import type { SwitchWorkspaceResult } from "../api";
import type { WorkspaceOption } from "../protocol";

interface Props {
	workspaces: WorkspaceOption[];
	activeRoot: string;
	onSwitch: (root: string) => Promise<SwitchWorkspaceResult>;
}

// The switch is server-driven: picking a root here only names it; the server
// reopens the scope and emits a fresh hello, so this menu never merges state.
export default function WorkspacePicker({
	workspaces,
	activeRoot,
	onSwitch,
}: Props) {
	const [open, setOpen] = useState(false);
	const [path, setPath] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const active =
		workspaces.find((workspace) => workspace.active) ??
		workspaces.find((workspace) => workspace.root === activeRoot);
	const label =
		active?.label ?? (activeRoot !== "" ? activeRoot : "选择工作区");
	const canSubmit = path.trim() !== "" && !busy;

	const switchTo = async (root: string) => {
		const target = root.trim();
		if (target === "" || target === activeRoot) {
			setOpen(false);
			return;
		}
		setBusy(true);
		setError(null);
		const result = await onSwitch(target);
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setPath("");
		setOpen(false);
	};

	return (
		<div className="workspace-picker">
			<button
				type="button"
				className="workspace-trigger"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				title={activeRoot}
			>
				<span className="workspace-label">{label}</span>
				<span className="workspace-caret" aria-hidden="true">
					▾
				</span>
			</button>

			{open && (
				<div className="workspace-menu">
					{workspaces.map((workspace) => (
						<button
							key={workspace.root}
							type="button"
							className={`workspace-item ${workspace.active ? "active" : ""}`}
							onClick={() => {
								void switchTo(workspace.root);
							}}
							title={workspace.root}
						>
							<span className="workspace-item-label">{workspace.label}</span>
							{workspace.active && (
								<span className="workspace-item-mark" aria-hidden="true">
									✓
								</span>
							)}
						</button>
					))}

					<form
						className="workspace-form"
						onSubmit={(event) => {
							event.preventDefault();
							if (canSubmit) void switchTo(path);
						}}
					>
						<input
							className="field-input workspace-input"
							value={path}
							onChange={(event) => setPath(event.target.value)}
							placeholder="输入工作区路径…"
							aria-label="工作区路径"
						/>
						<button type="submit" className="btn small" disabled={!canSubmit}>
							{busy ? "切换中…" : "切换"}
						</button>
					</form>

					{error !== null && (
						<p className="workspace-error" role="alert">
							{error}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
