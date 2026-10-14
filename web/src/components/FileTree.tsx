import {
	type ChangeEvent,
	type DragEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { UploadOptions, UploadResult } from "../api";
import type { FileEntry, FileListResponse } from "../protocol";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	ChevronRightIcon,
	FileIcon,
	FolderIcon,
	RefreshIcon,
	SymlinkIcon,
} from "./icons";

interface Props {
	// The token-aware client call, forwarded from the hub; the panel owns the
	// cache and the expanded set.
	listFiles: (
		path: string,
		options?: { showHidden?: boolean; showIgnored?: boolean },
	) => Promise<FileListResponse>;
	// A same-origin download URL, token included when the bind needs one, so
	// the row anchor lets the browser stream the file itself.
	fileDownloadUrl: (path: string) => string;
	// Uploads one file into a directory and reports its own progress; the panel
	// owns the per-file list and the overwrite retry.
	upload: (
		path: string,
		file: File,
		options?: UploadOptions,
	) => Promise<UploadResult>;
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

// The read-only workspace file tree. The root loads on mount and every
// directory is fetched the first time it is expanded, then cached; the flags
// re-read from scratch so every visible directory matches them, and 刷新 drops
// the cache entirely. Each directory row (and the empty body) is also a drop
// target that streams files into that directory.
export default function FileTree({
	listFiles,
	fileDownloadUrl,
	upload,
	open,
}: Props) {
	const [cache, setCache] = useState<Record<string, FileListResponse>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [showHidden, setShowHidden] = useState(false);
	const [showIgnored, setShowIgnored] = useState(false);
	const [uploads, setUploads] = useState<UploadItem[]>([]);
	// The directory a drag is currently over ("" is the root), so only that row
	// highlights.
	const [dragDir, setDragDir] = useState<string | null>(null);

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
	// tree so a directory fetched under the old flags is never shown stale.
	useEffect(() => {
		setCache({});
		setExpanded(new Set());
		setError(null);
		void load("");
	}, [load]);

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
		void load("");
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
					<span className="file-name" title={entryTitle(entry)}>
						{entry.name}
					</span>
					{isDir ? (
						<button
							type="button"
							className="file-upload"
							title={`上传到 ${entry.name}`}
							aria-label={`上传到 ${entry.name}`}
							onClick={() => pickFiles(entry.path)}
						>
							<ArrowUpIcon size={13} />
						</button>
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
				</div>
				{isDir && isOpen && (
					<ul className="file-tree-children">
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

	const root = cache[""];

	return (
		<aside className={`file-panel ${open ? "" : "closed"}`} aria-label="文件树">
			<div className="file-panel-header">
				<h2 className="file-panel-title">文件</h2>
				<button
					type="button"
					className="icon-btn"
					title="上传文件"
					aria-label="上传文件"
					onClick={() => pickFiles("")}
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
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the empty body drops files at the workspace root */}
			<div
				className={`file-panel-body ${dragDir === "" ? "drop-target" : ""}`}
				onDragOver={(event) => handleDragOver(event, "")}
				onDragLeave={handleDragLeave}
				onDrop={(event) => handleDrop(event, "")}
			>
				{error !== null ? (
					<div className="file-panel-error" role="alert">
						<span className="file-panel-error-text">{error}</span>
						<button type="button" className="btn small" onClick={refresh}>
							重试
						</button>
					</div>
				) : root === undefined ? (
					<p className="file-panel-loading">加载中…</p>
				) : root.entries.length === 0 ? (
					<p className="file-empty">空目录</p>
				) : (
					<ul className="file-tree">
						{root.entries.map((entry) => renderEntry(entry))}
					</ul>
				)}
			</div>
		</aside>
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
