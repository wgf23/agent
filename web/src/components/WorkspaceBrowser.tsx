import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { SwitchWorkspaceResult } from "../api";
import type { FsDirEntry, FsDirsResponse, WorkspaceOption } from "../protocol";

interface Props {
	workspaces: WorkspaceOption[];
	activeRoot: string;
	listDirs: (path?: string) => Promise<FsDirsResponse>;
	onSwitch: (root: string) => Promise<SwitchWorkspaceResult>;
	onClose: () => void;
}

// Splits an absolute path into clickable breadcrumbs. The last segment is the
// current directory (drawn as text, not a button); the root is always first.
function breadcrumb(cwd: string | null): Array<{ name: string; path: string }> {
	if (cwd === null || cwd === "") return [];
	if (!cwd.startsWith("/")) return [{ name: cwd, path: cwd }];
	const parts = cwd.split("/").filter((part) => part !== "");
	const crumbs = parts.map((part, index) => ({
		name: part,
		path: `/${parts.slice(0, index + 1).join("/")}`,
	}));
	return [{ name: "/", path: "/" }, ...crumbs];
}

// A filesystem-style workspace picker. Every read is bounded by the server to
// the home directory and the active workspace root, so this modal only walks
// allowed directories; a 400 from the server (an out-of-root or unreadable
// path) is shown inline instead of hidden. Selecting the current directory
// reuses the existing server-driven switch, and the recent list stays one
// click away. Keyboard: arrows move, Enter enters, Escape closes.
export default function WorkspaceBrowser({
	workspaces,
	activeRoot,
	listDirs,
	onSwitch,
	onClose,
}: Props) {
	const [cwd, setCwd] = useState<string | null>(null);
	// null is itself meaning, not "unset": the server sends null at a browse
	// root whose parent is outside every root, which disables 上一级.
	const [parent, setParent] = useState<string | null>(null);
	const [dirs, setDirs] = useState<FsDirEntry[]>([]);
	const [selected, setSelected] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [manual, setManual] = useState("");
	const modalRef = useRef<HTMLDivElement>(null);

	const load = useCallback(
		async (target?: string) => {
			setLoading(true);
			setError(null);
			try {
				const listing = await listDirs(target);
				setCwd(listing.path);
				setParent(listing.parent);
				setDirs(listing.dirs);
				setSelected(0);
			} catch (err) {
				// A refused path (outside the roots, unreadable) is the server's
				// reason, shown so the user can correct the input.
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		},
		[listDirs],
	);

	// Open at the active workspace when it has a root, otherwise at home (the
	// route's default), so the modal starts somewhere the user recognises. The
	// modal grabs focus so the arrow keys work before anything is clicked.
	useEffect(() => {
		void load(activeRoot !== "" ? activeRoot : undefined);
		modalRef.current?.focus();
	}, [activeRoot, load]);

	const switchTo = async (root: string) => {
		const target = root.trim();
		if (target === "") return;
		// Re-picking the root already live would reopen the same scope; just
		// close, matching the old dropdown's behavior.
		if (target === activeRoot) {
			onClose();
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
		onClose();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		// The manual field and the buttons handle their own Enter/click; only
		// the modal body drives the list so typing is never hijacked.
		const target = event.target as HTMLElement;
		if (target.tagName === "INPUT" || target.tagName === "BUTTON") return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			if (dirs.length > 0) {
				setSelected((index) => Math.min(index + 1, dirs.length - 1));
			}
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			if (dirs.length > 0) setSelected((index) => Math.max(index - 1, 0));
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const dir = dirs[selected];
			if (dir !== undefined) void load(dir.path);
		}
	};

	const crumbs = breadcrumb(cwd);
	const canSelect = cwd !== null && !busy;

	return (
		<div className="modal-backdrop">
			<div
				className="modal workspace-browser"
				role="dialog"
				aria-modal="true"
				ref={modalRef}
				tabIndex={-1}
				onKeyDown={onKeyDown}
			>
				<div className="modal-header">
					<div className="modal-heading">
						<span className="modal-title">选择工作区</span>
						<span className="modal-subtitle" title={cwd ?? undefined}>
							{cwd ?? "…"}
						</span>
					</div>
				</div>

				<div className="modal-body">
					<nav className="browser-breadcrumb" aria-label="路径">
						{crumbs.map((crumb, index) =>
							index === crumbs.length - 1 ? (
								<span
									key={crumb.path}
									className="browser-crumb current"
									title={crumb.path}
								>
									{crumb.name}
								</span>
							) : (
								<button
									key={crumb.path}
									type="button"
									className="browser-crumb"
									title={crumb.path}
									onClick={() => void load(crumb.path)}
								>
									{crumb.name}
								</button>
							),
						)}
					</nav>

					<div className="browser-toolbar">
						<button
							type="button"
							className="btn small"
							disabled={parent === null || loading}
							title={parent ?? "已到可浏览的顶层目录"}
							onClick={() => {
								if (parent !== null) void load(parent);
							}}
						>
							上一级
						</button>
						<button
							type="button"
							className="btn primary small"
							disabled={!canSelect}
							onClick={() => {
								if (cwd !== null) void switchTo(cwd);
							}}
						>
							{busy ? "切换中…" : "选择当前目录"}
						</button>
					</div>

					<div className="browser-list" role="listbox" aria-label="子目录">
						{loading ? (
							<p className="browser-empty">加载中…</p>
						) : dirs.length === 0 ? (
							<p className="browser-empty">此目录没有子目录</p>
						) : (
							dirs.map((dir, index) => (
								<button
									key={dir.path}
									type="button"
									role="option"
									aria-selected={index === selected}
									className={`browser-row ${
										index === selected ? "selected" : ""
									}`}
									title={dir.path}
									onClick={() => void load(dir.path)}
									onMouseEnter={() => setSelected(index)}
								>
									<span className="browser-folder" aria-hidden="true">
										📁
									</span>
									<span className="browser-row-name">{dir.name}</span>
								</button>
							))
						)}
					</div>

					{error !== null && (
						<div className="dialog-error" role="alert">
							{error}
						</div>
					)}

					<div className="browser-section">
						<span className="browser-section-label">最近的工作区</span>
						{workspaces.length === 0 ? (
							<p className="browser-empty">还没有访问记录</p>
						) : (
							workspaces.map((workspace) => (
								<button
									key={workspace.root}
									type="button"
									className={`browser-row ${workspace.active ? "active" : ""}`}
									title={workspace.root}
									disabled={busy}
									onClick={() => void switchTo(workspace.root)}
								>
									<span className="browser-row-name">{workspace.label}</span>
									{workspace.active && (
										<span className="browser-row-mark" aria-hidden="true">
											✓
										</span>
									)}
								</button>
							))
						)}
					</div>

					<form
						className="browser-form"
						onSubmit={(event) => {
							event.preventDefault();
							const target = manual.trim();
							if (target !== "") void load(target);
						}}
					>
						<input
							className="field-input browser-input"
							value={manual}
							onChange={(event) => setManual(event.target.value)}
							placeholder="输入绝对路径后回车…"
							aria-label="绝对路径"
						/>
						<button
							type="submit"
							className="btn small"
							disabled={manual.trim() === ""}
						>
							前往
						</button>
					</form>
				</div>

				<div className="modal-actions">
					<button type="button" className="btn" onClick={onClose}>
						取消
					</button>
				</div>
			</div>
		</div>
	);
}
