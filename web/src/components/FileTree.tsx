import {
	type ChangeEvent,
	type DragEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { UploadOptions, UploadResult } from "../api";
import type {
	FileEntry,
	FileListResponse,
	FsDirEntry,
	FsDirsResponse,
} from "../protocol";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	ChevronRightIcon,
	FileIcon,
	FolderIcon,
	PackageIcon,
	RefreshIcon,
	SymlinkIcon,
} from "./icons";
import WorkspacePicker from "./WorkspacePicker";

interface Props {
	// The client call, forwarded from the hub; the panel owns the cache and
	// the expanded set.
	listFiles: (
		path: string,
		options?: { showHidden?: boolean; showIgnored?: boolean },
	) => Promise<FileListResponse>;
	// A same-origin download URL, so the row anchor lets the browser stream
	// the file itself.
	fileDownloadUrl: (path: string) => string;
	// A same-origin zip URL for one directory, so a directory row's 打包下载
	// anchor downloads the tree itself.
	fileArchiveUrl: (path: string) => string;
	// Uploads one file into a directory and reports its own progress; the panel
	// owns the per-file list and the overwrite retry.
	upload: (
		path: string,
		file: File,
		options?: UploadOptions,
	) => Promise<UploadResult>;
	// Structure writes, forwarded from the hub; each rejects with the server's
	// reason so the panel can show it on the row.
	mkdir: (path: string) => Promise<void>;
	renameEntry: (from: string, to: string) => Promise<void>;
	moveEntry: (from: string, to: string) => Promise<void>;
	deleteEntry: (path: string, recursive?: boolean) => Promise<void>;
	// The same bounded directory browse the panel's root chip and 移动到… both
	// use, so each offers only directories the server already allows.
	listDirs: (path?: string) => Promise<FsDirsResponse>;
	// The active workspace root (absolute), so a browse path maps back to the
	// workspace-relative path this panel and the structure routes use.
	workspaceRoot: string;
	// Wide screens show the panel inline; a sidebar button folds it away.
	open: boolean;
}

// One row of the upload list: the file still held so an `exists` refusal can be
// retried with overwrite, the directory it targets, and its own progress and
// status.
interface UploadItem {
	id: number;
	file: File;
	dir: string;
	name: string;
	status: "uploading" | "done" | "exists" | "error";
	percent: number;
	reason?: string;
}

// The one inline text editor the panel opens: a rename replaces the row's name
// and a new folder adds a row under the chosen directory. Enter saves and
// Escape cancels, the same keys SessionRow uses.
type EditState =
	| { kind: "rename"; entry: FileEntry; draft: string }
	| { kind: "mkdir"; dir: string; draft: string };

// A delete the user has armed but not confirmed. `count` is the number of
// entries under a directory, null until the walk finishes (or when it failed);
// a file needs no count.
interface PendingDelete {
	entry: FileEntry;
	count: number | null;
	capped: boolean;
}

// The workspace file tree. The root loads on mount and every directory is
// fetched the first time it is expanded, then cached; the flags re-read from
// scratch so every visible directory matches them, and 刷新 drops the cache
// entirely. Each directory row (and the empty body) is also a drop target that
// streams files into that directory. A per-row menu adds the structure writes:
// a new folder, an inline rename, a move picker, and an armed delete. The
// header's chip re-roots the panel at another directory of the same workspace.
export default function FileTree({
	listFiles,
	fileDownloadUrl,
	fileArchiveUrl,
	upload,
	mkdir,
	renameEntry,
	moveEntry,
	deleteEntry,
	listDirs,
	workspaceRoot,
	open,
}: Props) {
	// The directory the panel lists at its top level; workspace-relative, so ""
	// is the workspace root and the paths the routes take stay unchanged.
	const [root, setRoot] = useState("");
	const [cache, setCache] = useState<Record<string, FileListResponse>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [showHidden, setShowHidden] = useState(false);
	const [showIgnored, setShowIgnored] = useState(false);
	const [uploads, setUploads] = useState<UploadItem[]>([]);
	// The directory a drag is currently over (the panel root is ""), so only
	// that row highlights.
	const [dragDir, setDragDir] = useState<string | null>(null);
	// The row whose menu is open, the inline editor, and the move/delete state.
	const [menuPath, setMenuPath] = useState<string | null>(null);
	const [edit, setEdit] = useState<EditState | null>(null);
	const [moving, setMoving] = useState<FileEntry | null>(null);
	const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
		null,
	);
	// A structure write in flight, so its row's controls stay disabled.
	const [opBusy, setOpBusy] = useState(false);
	// The last write refusal, keyed by the row it belongs to, so the server's
	// reason renders under the entry that failed.
	const [opError, setOpError] = useState<{
		path: string;
		message: string;
	} | null>(null);

	// The picker is opened by a row's button; this holds the directory that
	// button named until the change fires.
	const pendingDir = useRef("");
	const fileInputRef = useRef<HTMLInputElement>(null);
	const nextUploadId = useRef(0);

	// Fetches one directory under the current flags and caches the answer. The
	// flags ride as closure values so a re-read always matches the checkboxes.
	const load = useCallback(
		async (path: string) => {
			setLoading((prev) => new Set(prev).add(path));
			try {
				const listing = await listFiles(path, { showHidden, showIgnored });
				setCache((prev) => ({ ...prev, [path]: listing }));
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading((prev) => {
					const next = new Set(prev);
					next.delete(path);
					return next;
				});
			}
		},
		[listFiles, showHidden, showIgnored],
	);

	// The root loads on mount. A flag change drops the cache and collapses the
	// tree so a directory fetched under the old flags is never shown stale; a
	// new panel root re-reads from scratch the same way.
	useEffect(() => {
		setCache({});
		setExpanded(new Set());
		setError(null);
		void load(root);
	}, [load, root]);

	// A menu closes when the user clicks anywhere outside it, not only when the
	// trigger is pressed again.
	useEffect(() => {
		if (menuPath === null) return;
		const onDown = (event: MouseEvent) => {
			const target = event.target as HTMLElement | null;
			if (
				target !== null &&
				target.closest(".file-menu, .file-more") !== null
			) {
				return;
			}
			setMenuPath(null);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [menuPath]);

	const toggleDir = (path: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
		// Fetch lazily on the first expand; collapse keeps the cached children.
		if (cache[path] === undefined && !loading.has(path)) void load(path);
	};

	const refresh = () => {
		setCache({});
		setExpanded(new Set());
		setError(null);
		setEdit(null);
		setOpError(null);
		void load(root);
	};

	// The workspace root without a trailing slash, so a relative path and an
	// absolute one map both ways without doubling the separator.
	const workspaceBase = workspaceRoot.replace(/\/+$/, "");

	// The root chip hands back an absolute path; the panel lists by
	// workspace-relative ones, so a path outside the workspace cannot become
	// the panel's root and the picker offers it as browse-only.
	const relFromWorkspace = (absPath: string): string | null => {
		if (absPath === workspaceBase) return "";
		if (!absPath.startsWith(`${workspaceBase}/`)) return null;
		return absPath.slice(workspaceBase.length + 1);
	};

	const updateUpload = (id: number, patch: Partial<UploadItem>) => {
		setUploads((prev) =>
			prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
		);
	};

	// Re-reads the target directory and expands it, so the freshly written file
	// is visible after an upload lands.
	const reveal = (dir: string) => {
		if (dir !== "") setExpanded((prev) => new Set(prev).add(dir));
		void load(dir);
	};

	// Re-reads one directory and keeps it open, so a structure change shows up
	// where the user is looking.
	const reload = (dir: string) => {
		if (dir !== "") setExpanded((prev) => new Set(prev).add(dir));
		void load(dir);
	};

	// Drops one path and everything under it from the caches after a rename,
	// move, or delete, so a stale subtree cannot reappear under the old key. A
	// panel root inside the dropped subtree no longer exists, so the panel
	// falls back to the workspace root.
	const forgetSubtree = (path: string) => {
		setCache((prev) => {
			const next: Record<string, FileListResponse> = {};
			for (const [key, value] of Object.entries(prev)) {
				if (key === path || key.startsWith(`${path}/`)) continue;
				next[key] = value;
			}
			return next;
		});
		setExpanded((prev) => {
			const next = new Set(prev);
			next.delete(path);
			for (const key of prev) {
				if (key.startsWith(`${path}/`)) next.delete(key);
			}
			return next;
		});
		if (root === path || root.startsWith(`${path}/`)) setRoot("");
	};

	const updateDraft = (draft: string) => {
		setEdit((prev) => (prev === null ? prev : { ...prev, draft }));
	};

	const beginRename = (entry: FileEntry) => {
		setMenuPath(null);
		setOpError(null);
		setEdit({ kind: "rename", entry, draft: entry.name });
	};

	const beginMkdir = (dir: string) => {
		setMenuPath(null);
		setOpError(null);
		setEdit({ kind: "mkdir", dir, draft: "" });
		// The new folder's input lives inside this directory, so open it.
		if (dir !== "") setExpanded((prev) => new Set(prev).add(dir));
	};

	const beginMove = (entry: FileEntry) => {
		setMenuPath(null);
		setOpError(null);
		setMoving(entry);
	};

	// Arming a delete never writes: the first press opens the confirm, and a
	// directory's contents are counted first so the warning can name them.
	const beginDelete = (entry: FileEntry) => {
		setMenuPath(null);
		setOpError(null);
		setPendingDelete({ entry, count: null, capped: false });
		if (entry.kind !== "dir") return;
		void countEntries(entry.path, listFiles)
			.then(({ count, capped }) => {
				setPendingDelete((prev) =>
					prev !== null && prev.entry.path === entry.path
						? { entry, count, capped }
						: prev,
				);
			})
			.catch(() => {
				// The warning cannot name a count, but the confirm still offers the
				// delete; deleteWarning falls back to the all-contents wording.
			});
	};

	const commitRename = async () => {
		const current = edit;
		if (current === null || current.kind !== "rename") return;
		const entry = current.entry;
		const name = current.draft.trim();
		setEdit(null);
		// A blank name is refused by the server and an unchanged one is not a
		// write at all, so neither reaches the network.
		if (name === "" || name === entry.name) return;
		const parent = parentOf(entry.path);
		setOpError(null);
		setOpBusy(true);
		try {
			await renameEntry(entry.path, joinRel(parent, name));
			forgetSubtree(entry.path);
			reload(parent);
		} catch (err) {
			setOpError({ path: entry.path, message: messageOf(err) });
		} finally {
			setOpBusy(false);
		}
	};

	const commitMkdir = async () => {
		const current = edit;
		if (current === null || current.kind !== "mkdir") return;
		const name = current.draft.trim();
		setEdit(null);
		if (name === "") return;
		const parent = current.dir;
		setOpError(null);
		setOpBusy(true);
		try {
			await mkdir(joinRel(parent, name));
			reload(parent);
		} catch (err) {
			// Keyed to the containing directory, whose row is visible, because the
			// rejected new name has no row of its own.
			setOpError({ path: parent, message: messageOf(err) });
		} finally {
			setOpBusy(false);
		}
	};

	// The move picker hands back a destination directory; the entry keeps its
	// name, so the destination path is that directory plus the basename.
	const commitMove = async (entry: FileEntry, destDir: string) => {
		const fromDir = parentOf(entry.path);
		await moveEntry(entry.path, joinRel(destDir, entry.name));
		forgetSubtree(entry.path);
		reload(fromDir);
		if (destDir !== fromDir) reload(destDir);
	};

	const runDelete = async (entry: FileEntry) => {
		setOpError(null);
		setOpBusy(true);
		try {
			await deleteEntry(entry.path, entry.kind === "dir");
			setPendingDelete(null);
			forgetSubtree(entry.path);
			reload(parentOf(entry.path));
		} catch (err) {
			setPendingDelete(null);
			setOpError({ path: entry.path, message: messageOf(err) });
		} finally {
			setOpBusy(false);
		}
	};

	// Uploads the selected files one at a time, so each row carries the progress
	// of its own request.
	const runUpload = async (item: UploadItem, overwrite: boolean) => {
		updateUpload(item.id, {
			status: "uploading",
			percent: 0,
			reason: undefined,
		});
		try {
			const result = await upload(item.dir, item.file, {
				overwrite,
				onProgress: ({ loaded, total }) => {
					updateUpload(item.id, { percent: total > 0 ? loaded / total : 0 });
				},
			});
			if (result.written.length > 0) {
				updateUpload(item.id, { status: "done", percent: 1 });
				reveal(item.dir);
				return;
			}
			const failure = result.failed[0];
			if (failure?.reason === "exists") {
				updateUpload(item.id, { status: "exists", reason: failure.reason });
			} else {
				updateUpload(item.id, {
					status: "error",
					reason: failure?.reason ?? "上传失败",
				});
			}
		} catch (err) {
			updateUpload(item.id, {
				status: "error",
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const startUpload = (dir: string, files: File[], overwrite: boolean) => {
		if (files.length === 0) return;
		const items: UploadItem[] = files.map((file) => ({
			id: nextUploadId.current++,
			file,
			dir,
			name: file.name,
			status: "uploading",
			percent: 0,
		}));
		setUploads((prev) => [...prev, ...items]);
		void (async () => {
			for (const item of items) {
				await runUpload(item, overwrite);
			}
		})();
	};

	const pickFiles = (dir: string) => {
		pendingDir.current = dir;
		fileInputRef.current?.click();
	};

	const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		// Reset so picking the same file again still fires a change.
		event.target.value = "";
		startUpload(pendingDir.current, files, false);
	};

	const handleDrop = (event: DragEvent, dir: string) => {
		event.preventDefault();
		event.stopPropagation();
		setDragDir(null);
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length > 0) startUpload(dir, files, false);
	};

	const handleDragOver = (event: DragEvent, dir: string) => {
		// Only a file drag is a target; a text selection keeps its normal cursor.
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "copy";
		setDragDir(dir);
	};

	// Moving onto a child fires a leave for the parent first; only a leave of
	// the target itself clears the highlight.
	const handleDragLeave = (event: DragEvent) => {
		if (event.currentTarget === event.target) setDragDir(null);
	};

	const renderUpload = (item: UploadItem): ReactNode => {
		const percent = Math.round(item.percent * 100);
		return (
			<li key={item.id} className={`file-upload-item ${item.status}`}>
				<div className="file-upload-line">
					<span
						className="file-upload-name"
						title={item.dir === "" ? item.name : `${item.dir}/${item.name}`}
					>
						{item.name}
					</span>
					<span className="file-upload-status">
						{item.status === "uploading"
							? `${percent}%`
							: item.status === "done"
								? "完成"
								: item.status === "exists"
									? "已存在"
									: "失败"}
					</span>
				</div>
				{item.status === "uploading" && (
					<div
						className="file-upload-bar"
						role="progressbar"
						aria-valuenow={percent}
						aria-valuemin={0}
						aria-valuemax={100}
					>
						<div
							className="file-upload-bar-fill"
							style={{ width: `${percent}%` }}
						/>
					</div>
				)}
				{item.status === "exists" && (
					<div className="file-upload-actions">
						<span className="file-upload-hint">同名文件已存在</span>
						<button
							type="button"
							className="btn small"
							onClick={() => void runUpload(item, true)}
						>
							覆盖
						</button>
					</div>
				)}
				{item.status === "error" && (
					<div className="file-upload-actions">
						<span className="file-upload-error">
							{item.reason ?? "上传失败"}
						</span>
						<button
							type="button"
							className="btn small"
							onClick={() => void runUpload(item, false)}
						>
							重试
						</button>
					</div>
				)}
			</li>
		);
	};

	const renderEntry = (entry: FileEntry): ReactNode => {
		const isDir = entry.kind === "dir";
		const isOpen = isDir && expanded.has(entry.path);
		const child = isOpen ? cache[entry.path] : undefined;
		const childLoading =
			isOpen && loading.has(entry.path) && child === undefined;
		const editing = edit?.kind === "rename" && edit.entry.path === entry.path;
		const deleting = pendingDelete?.entry.path === entry.path;
		const rowError = opError?.path === entry.path ? opError.message : null;
		const menuOpen = menuPath === entry.path;
		return (
			<li key={entry.path}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: a directory row is a file drop target */}
				<div
					className={`file-row ${isDir && dragDir === entry.path ? "drop-target" : ""}`}
					onDragOver={
						isDir ? (event) => handleDragOver(event, entry.path) : undefined
					}
					onDragLeave={isDir ? handleDragLeave : undefined}
					onDrop={isDir ? (event) => handleDrop(event, entry.path) : undefined}
				>
					{isDir ? (
						<button
							type="button"
							className={`file-arrow ${isOpen ? "open" : ""}`}
							title={isOpen ? "收起" : "展开"}
							aria-label={isOpen ? "收起" : "展开"}
							aria-expanded={isOpen}
							onClick={() => toggleDir(entry.path)}
						>
							<ChevronRightIcon />
						</button>
					) : (
						<span className="file-arrow" aria-hidden="true" />
					)}
					<span className={`file-kind-icon ${entry.kind}`} aria-hidden="true">
						{kindIcon(entry.kind)}
					</span>
					{editing ? (
						<input
							className="file-rename"
							// The input exists only after a click, so focusing it is the
							// point: the user should not have to aim a second time.
							// biome-ignore lint/a11y/noAutofocus: focusing the rename input the user just opened is intentional
							autoFocus
							value={edit.draft}
							disabled={opBusy}
							aria-label="重命名"
							onChange={(event) => updateDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void commitRename();
								} else if (event.key === "Escape") {
									event.preventDefault();
									setEdit(null);
								}
							}}
						/>
					) : (
						<span className="file-name" title={entryTitle(entry)}>
							{entry.name}
						</span>
					)}
					{isDir ? (
						<>
							<button
								type="button"
								className="file-upload"
								title={`上传到 ${entry.name}`}
								aria-label={`上传到 ${entry.name}`}
								onClick={() => pickFiles(entry.path)}
							>
								<ArrowUpIcon size={13} />
							</button>
							<a
								className="file-download"
								href={fileArchiveUrl(entry.path)}
								download={`${entry.name}.zip`}
								title={`打包下载 ${entry.name}`}
								aria-label={`打包下载 ${entry.name}`}
							>
								<PackageIcon size={13} />
							</a>
						</>
					) : (
						<a
							className="file-download"
							href={fileDownloadUrl(entry.path)}
							download={entry.name}
							title={`下载 ${entry.name}`}
							aria-label={`下载 ${entry.name}`}
						>
							<ArrowDownIcon size={13} />
						</a>
					)}
					<button
						type="button"
						className="file-more"
						title="更多操作"
						aria-label={`${entry.name} 的操作`}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						disabled={opBusy}
						onClick={() => setMenuPath(menuOpen ? null : entry.path)}
					>
						⋯
					</button>
				</div>
				{menuOpen && (
					<div className="file-menu" role="menu">
						{isDir && (
							<button
								type="button"
								role="menuitem"
								onClick={() => beginMkdir(entry.path)}
							>
								新建文件夹
							</button>
						)}
						<button
							type="button"
							role="menuitem"
							onClick={() => beginRename(entry)}
						>
							重命名
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => beginMove(entry)}
						>
							移动到…
						</button>
						<button
							type="button"
							role="menuitem"
							className="danger"
							onClick={() => beginDelete(entry)}
						>
							删除
						</button>
					</div>
				)}
				{deleting && pendingDelete !== null && (
					<div className="file-confirm" role="alert">
						<span className="file-confirm-text">
							{deleteWarning(pendingDelete)}
						</span>
						<button
							type="button"
							className="btn small deny"
							disabled={opBusy}
							onClick={() => void runDelete(entry)}
						>
							删除
						</button>
						<button
							type="button"
							className="btn small"
							disabled={opBusy}
							onClick={() => setPendingDelete(null)}
						>
							取消
						</button>
					</div>
				)}
				{rowError !== null && (
					<p className="file-row-error" role="alert">
						{rowError}
					</p>
				)}
				{isDir && isOpen && (
					<ul className="file-tree-children">
						{edit?.kind === "mkdir" && edit.dir === entry.path && (
							<li className="file-new-row">
								<input
									className="file-rename"
									// biome-ignore lint/a11y/noAutofocus: focusing the new-folder input the user just opened is intentional
									autoFocus
									value={edit.draft}
									disabled={opBusy}
									placeholder="文件夹名称"
									aria-label="新建文件夹名称"
									onChange={(event) => updateDraft(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											void commitMkdir();
										} else if (event.key === "Escape") {
											event.preventDefault();
											setEdit(null);
										}
									}}
								/>
							</li>
						)}
						{childLoading ? (
							<li className="file-empty">加载中…</li>
						) : child === undefined ? null : child.entries.length === 0 ? (
							<li className="file-empty">空目录</li>
						) : (
							child.entries.map((childEntry) => renderEntry(childEntry))
						)}
					</ul>
				)}
			</li>
		);
	};

	const listing = cache[root];

	return (
		<aside className={`file-panel ${open ? "" : "closed"}`} aria-label="文件树">
			<div className="file-panel-header">
				<h2 className="file-panel-title">文件</h2>
				<button
					type="button"
					className="icon-btn"
					title="上传文件"
					aria-label="上传文件"
					onClick={() => pickFiles(root)}
				>
					<ArrowUpIcon />
				</button>
				<button
					type="button"
					className="icon-btn"
					title="刷新"
					aria-label="刷新"
					onClick={refresh}
				>
					<RefreshIcon />
				</button>
			</div>
			<div className="file-panel-root">
				<WorkspacePicker
					root={root === "" ? workspaceBase : `${workspaceBase}/${root}`}
					listDirs={listDirs}
					canOpen={(path) => relFromWorkspace(path) !== null}
					onOpen={(path) => {
						const rel = relFromWorkspace(path);
						if (rel !== null) setRoot(rel);
					}}
				/>
			</div>
			<input
				ref={fileInputRef}
				type="file"
				multiple
				className="file-input"
				onChange={handleFileInput}
			/>
			<div className="file-panel-filters">
				<label className="file-toggle">
					<input
						type="checkbox"
						checked={showHidden}
						onChange={(event) => setShowHidden(event.target.checked)}
					/>
					显示隐藏文件
				</label>
				<label className="file-toggle">
					<input
						type="checkbox"
						checked={showIgnored}
						onChange={(event) => setShowIgnored(event.target.checked)}
					/>
					显示被忽略的文件
				</label>
			</div>
			{uploads.length > 0 && (
				<div className="file-uploads">
					<div className="file-uploads-head">
						<span>上传</span>
						<button
							type="button"
							className="file-uploads-clear"
							title="清除上传列表"
							onClick={() => setUploads([])}
						>
							清除
						</button>
					</div>
					<ul className="file-upload-list">
						{uploads.map((item) => renderUpload(item))}
					</ul>
				</div>
			)}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the empty body drops files at the panel root */}
			<div
				className={`file-panel-body ${dragDir === root ? "drop-target" : ""}`}
				onDragOver={(event) => handleDragOver(event, root)}
				onDragLeave={handleDragLeave}
				onDrop={(event) => handleDrop(event, root)}
			>
				{error !== null ? (
					<div className="file-panel-error" role="alert">
						<span className="file-panel-error-text">{error}</span>
						<button type="button" className="btn small" onClick={refresh}>
							重试
						</button>
					</div>
				) : listing === undefined ? (
					<p className="file-panel-loading">加载中…</p>
				) : listing.entries.length === 0 ? (
					<p className="file-empty">空目录</p>
				) : (
					<ul className="file-tree">
						{listing.entries.map((entry) => renderEntry(entry))}
					</ul>
				)}
			</div>
			{moving !== null && (
				<MoveDialog
					entry={moving}
					workspaceRoot={workspaceRoot}
					listDirs={listDirs}
					onCommit={(destDir) => commitMove(moving, destDir)}
					onClose={() => setMoving(null)}
				/>
			)}
		</aside>
	);
}

// A small directory picker for 移动到… . It reuses the bounded browse route, so
// it can only walk directories the server already allows, and it stops at the
// active workspace root because a move must stay inside the workspace. The
// chosen directory plus the entry's own name becomes the destination.
interface MoveDialogProps {
	entry: FileEntry;
	workspaceRoot: string;
	listDirs: (path?: string) => Promise<FsDirsResponse>;
	onCommit: (destDir: string) => Promise<void>;
	onClose: () => void;
}

function MoveDialog({
	entry,
	workspaceRoot,
	listDirs,
	onCommit,
	onClose,
}: MoveDialogProps) {
	const [cwd, setCwd] = useState(workspaceRoot);
	const [dirs, setDirs] = useState<FsDirEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const modalRef = useRef<HTMLDivElement>(null);

	const load = useCallback(
		async (target: string) => {
			setLoading(true);
			setError(null);
			try {
				const listing = await listDirs(target);
				setCwd(listing.path);
				setDirs(listing.dirs);
			} catch (err) {
				// A refused path is the server's reason, shown so the user can
				// correct it rather than being dropped back silently.
				setError(messageOf(err));
			} finally {
				setLoading(false);
			}
		},
		[listDirs],
	);

	// Open at the workspace root and grab focus so Escape works immediately.
	useEffect(() => {
		void load(workspaceRoot);
		modalRef.current?.focus();
	}, [workspaceRoot, load]);

	const currentRel = relFromRoot(workspaceRoot, cwd);
	const atRoot = currentRel === "";

	const commit = async () => {
		const rel = relFromRoot(workspaceRoot, cwd);
		if (rel === null) return;
		setBusy(true);
		setError(null);
		try {
			await onCommit(rel);
			onClose();
		} catch (err) {
			// The server's reason (an existing destination, a move into the
			// entry's own subtree) stays in the dialog for the user to correct.
			setError(messageOf(err));
			setBusy(false);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		}
	};

	const destination =
		currentRel === null ? entry.name : joinRel(currentRel, entry.name);

	return (
		<div className="modal-backdrop">
			<div
				className="modal workspace-browser move-dialog"
				role="dialog"
				aria-modal="true"
				aria-label="移动到"
				ref={modalRef}
				tabIndex={-1}
				onKeyDown={onKeyDown}
			>
				<div className="modal-header">
					<div className="modal-heading">
						<span className="modal-title">移动「{entry.name}」</span>
						<span className="modal-subtitle" title={destination}>
							/{destination}
						</span>
					</div>
				</div>

				<div className="modal-body">
					<div className="browser-toolbar">
						<button
							type="button"
							className="btn small"
							disabled={atRoot || loading}
							title={atRoot ? "已到工作区顶层" : "上一级"}
							onClick={() => void load(parentAbs(cwd))}
						>
							上一级
						</button>
						<button
							type="button"
							className="btn primary small"
							disabled={busy || loading || currentRel === null}
							onClick={() => void commit()}
						>
							{busy ? "移动中…" : "移动到此处"}
						</button>
					</div>

					<div className="browser-list" role="listbox" aria-label="子目录">
						{loading ? (
							<p className="browser-empty">加载中…</p>
						) : dirs.length === 0 ? (
							<p className="browser-empty">此目录没有子目录</p>
						) : (
							dirs.map((dir) => (
								<button
									key={dir.path}
									type="button"
									role="option"
									aria-selected={false}
									className="browser-row"
									title={dir.path}
									onClick={() => void load(dir.path)}
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

function kindIcon(kind: FileEntry["kind"]): ReactNode {
	if (kind === "dir") return <FolderIcon />;
	if (kind === "symlink") return <SymlinkIcon />;
	return <FileIcon />;
}

// A row's tooltip carries what the compact line cannot: the byte size and the
// modification time, formatted for the locale.
function entryTitle(entry: FileEntry): string {
	const size = entry.kind === "dir" ? "—" : formatSize(entry.size);
	return `${entry.name}\n大小：${size}\n修改时间：${new Date(entry.mtime).toLocaleString("zh-CN")}`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

// Counts every entry under a directory — recursively, hidden and ignored
// included — so a delete confirm can name how much a recursive delete removes.
// The walk is bounded, so a huge tree cannot hold the confirm open with
// hundreds of requests; a capped result is reported as an approximation.
async function countEntries(
	path: string,
	listFiles: Props["listFiles"],
	limit = 500,
): Promise<{ count: number; capped: boolean }> {
	const listing = await listFiles(path, {
		showHidden: true,
		showIgnored: true,
	});
	let count = 0;
	for (const entry of [...listing.entries, ...listing.ignored]) {
		count += 1;
		if (count >= limit) return { count, capped: true };
		if (entry.kind === "dir") {
			const nested = await countEntries(entry.path, listFiles, limit - count);
			count += nested.count;
			if (nested.capped || count >= limit) {
				return { count, capped: true };
			}
		}
	}
	return { count, capped: false };
}

// The delete confirm wording: a file names itself, a directory warns that its
// contents cannot be restored, and — once counted — how many entries that is.
function deleteWarning(pending: PendingDelete): string {
	const { entry, count, capped } = pending;
	if (entry.kind !== "dir") {
		return `确认删除「${entry.name}」？此操作无法恢复。`;
	}
	if (count === null) {
		return `确认删除目录「${entry.name}」及其全部内容？此操作无法恢复。`;
	}
	const amount = capped ? `${count}+` : `${count}`;
	return `确认删除目录「${entry.name}」及其中的 ${amount} 个条目？此操作无法恢复。`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// The containing directory of a workspace-relative path; "" is the root.
function parentOf(rel: string): string {
	const slash = rel.lastIndexOf("/");
	return slash === -1 ? "" : rel.slice(0, slash);
}

function joinRel(base: string, name: string): string {
	return base === "" ? name : `${base}/${name}`;
}

// Maps an absolute browse path back to a workspace-relative path. A path
// outside the root has no relative form (null), which the picker treats as
// unselectable. Both sides are posix; the browser has no node:path.
function relFromRoot(root: string, target: string): string | null {
	const base = root.replace(/\/+$/, "");
	if (target === base) return "";
	if (!target.startsWith(`${base}/`)) return null;
	return target.slice(base.length + 1);
}

// The containing directory of an absolute posix path; "/" is its own parent at
// the filesystem root.
function parentAbs(target: string): string {
	const slash = target.lastIndexOf("/");
	return slash <= 0 ? "/" : target.slice(0, slash);
}
