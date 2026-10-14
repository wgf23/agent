import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { FileEntry, FileListResponse } from "../protocol";
import {
	ArrowDownIcon,
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
	// Wide screens show the panel inline; a sidebar button folds it away.
	open: boolean;
}

// The read-only workspace file tree. The root loads on mount and every
// directory is fetched the first time it is expanded, then cached; the flags
// re-read from scratch so every visible directory matches them, and 刷新 drops
// the cache entirely.
export default function FileTree({ listFiles, fileDownloadUrl, open }: Props) {
	const [cache, setCache] = useState<Record<string, FileListResponse>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [showHidden, setShowHidden] = useState(false);
	const [showIgnored, setShowIgnored] = useState(false);

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

	const renderEntry = (entry: FileEntry): ReactNode => {
		const isDir = entry.kind === "dir";
		const isOpen = isDir && expanded.has(entry.path);
		const child = isOpen ? cache[entry.path] : undefined;
		const childLoading =
			isOpen && loading.has(entry.path) && child === undefined;
		return (
			<li key={entry.path}>
				<div className="file-row">
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
					{!isDir && (
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
					title="刷新"
					aria-label="刷新"
					onClick={refresh}
				>
					<RefreshIcon />
				</button>
			</div>
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
			<div className="file-panel-body">
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
