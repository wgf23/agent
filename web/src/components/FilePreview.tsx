import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatSize } from "../format";
import { highlight } from "../highlight";
import {
	codeLanguage,
	decodeText,
	formatJson,
	isProbablyBinary,
	type PreviewKind,
	parseDelimited,
	previewByteLimit,
	previewKind,
} from "../preview";
import type { DocBlock, FileEntry, OfficePreview } from "../protocol";
import Markdown from "./Markdown";

interface Props {
	entry: FileEntry;
	// A same-origin byte source and the office extraction call, forwarded from
	// the hub; the preview issues no request of its own shape.
	fileDownloadUrl: (path: string) => string;
	filePreview: (path: string) => Promise<OfficePreview>;
	// The read-the-file-through-the-agent action, kept available from the
	// preview so the old rail behavior is still one click away.
	onReadWithAgent: (path: string) => void;
	onClose: () => void;
}

// The async part of a preview, modeled as one state instead of a loading
// boolean plus a data field that must stay in sync with it. The image and
// unsupported tiers render from the entry with no load, so they never enter
// this machine.
type Load =
	| { status: "loading" }
	| { status: "text"; text: string }
	| { status: "office"; preview: OfficePreview }
	| { status: "binary" }
	| { status: "blocked"; reason: string }
	| { status: "error"; message: string };

export default function FilePreview({
	entry,
	fileDownloadUrl,
	filePreview,
	onReadWithAgent,
	onClose,
}: Props) {
	const kind = previewKind(entry.name);
	const [load, setLoad] = useState<Load>({ status: "loading" });
	const modalRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		modalRef.current?.focus();
	}, []);

	// A text-like tier reads the bytes and decodes them; office asks the server
	// to extract; image and unsupported need neither. Every branch is cancelled
	// when the entry changes, so a slow read cannot replace a newer preview.
	useEffect(() => {
		if (kind === "image" || kind === "unsupported") return;
		let cancelled = false;
		setLoad({ status: "loading" });

		const limit = previewByteLimit(kind);
		if (limit !== null && entry.size > limit) {
			setLoad({
				status: "blocked",
				reason: `文件较大（${formatSize(entry.size)}），超过预览上限，请下载后查看。`,
			});
			return;
		}

		void (async () => {
			try {
				if (kind === "office") {
					const preview = await filePreview(entry.path);
					if (!cancelled) setLoad({ status: "office", preview });
					return;
				}
				const response = await fetch(fileDownloadUrl(entry.path));
				if (!response.ok) {
					throw new Error(`读取失败 (${response.status})`);
				}
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (cancelled) return;
				if (isProbablyBinary(bytes)) {
					setLoad({ status: "binary" });
					return;
				}
				setLoad({ status: "text", text: decodeText(bytes) });
			} catch (error) {
				if (!cancelled) {
					setLoad({
						status: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [kind, entry.path, entry.size, fileDownloadUrl, filePreview]);

	return (
		<div className="modal-backdrop">
			<div
				className="modal preview"
				role="dialog"
				aria-modal="true"
				aria-label={`预览 ${entry.name}`}
				ref={modalRef}
				tabIndex={-1}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					}
				}}
			>
				<div className="modal-header">
					<div className="modal-heading">
						<span className="modal-title">{entry.name}</span>
						<span className="modal-subtitle">
							{entry.path} · {formatSize(entry.size)}
						</span>
					</div>
				</div>

				<div className="modal-body preview-body">
					<PreviewBody
						entry={entry}
						kind={kind}
						load={load}
						fileDownloadUrl={fileDownloadUrl}
					/>
				</div>

				<div className="modal-actions">
					<a
						className="btn"
						href={fileDownloadUrl(entry.path)}
						download={entry.name}
					>
						下载
					</a>
					<button
						type="button"
						className="btn"
						onClick={() => {
							onReadWithAgent(entry.path);
							onClose();
						}}
					>
						让 agent 读取
					</button>
					<button type="button" className="btn primary" onClick={onClose}>
						关闭
					</button>
				</div>
			</div>
		</div>
	);
}

interface BodyProps {
	entry: FileEntry;
	kind: PreviewKind;
	load: Load;
	fileDownloadUrl: (path: string) => string;
}

function PreviewBody({ entry, kind, load, fileDownloadUrl }: BodyProps) {
	if (kind === "image") {
		return (
			<img
				className="preview-image"
				src={fileDownloadUrl(entry.path)}
				alt={entry.name}
			/>
		);
	}
	if (kind === "unsupported" || load.status === "binary") {
		return <p className="preview-note">此格式无法预览，请下载后查看。</p>;
	}
	if (load.status === "loading") {
		return <p className="preview-note">加载中…</p>;
	}
	if (load.status === "blocked") {
		return <p className="preview-note">{load.reason}</p>;
	}
	if (load.status === "error") {
		return (
			<p className="preview-note preview-error" role="alert">
				{load.message}
			</p>
		);
	}
	if (load.status === "office") {
		return <OfficeView preview={load.preview} />;
	}
	return <TextBody kind={kind} text={load.text} name={entry.name} />;
}

function TextBody({
	kind,
	text,
	name,
}: {
	kind: PreviewKind;
	text: string;
	name: string;
}) {
	if (kind === "markdown") {
		return (
			<div className="preview-markdown">
				<Markdown text={text} />
			</div>
		);
	}
	if (kind === "json") {
		return <CodeView code={formatJson(text)} lang="json" />;
	}
	if (kind === "code") {
		return <CodeView code={text} lang={codeLanguage(name)} />;
	}
	if (kind === "csv") {
		const delimiter = name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
		const { rows, truncated } = parseDelimited(text, delimiter);
		return (
			<>
				<DataTable rows={rows} />
				{truncated && <p className="preview-note">仅显示前部分行列。</p>}
			</>
		);
	}
	return <pre className="preview-text">{text}</pre>;
}

// highlight.js escapes its input and DOMPurify is a second guard, the same
// pairing the markdown renderer uses, so injected markup cannot carry script.
function CodeView({ code, lang }: { code: string; lang: string }) {
	const html = useMemo(
		() => DOMPurify.sanitize(highlight(code, lang)),
		[code, lang],
	);
	return (
		<pre className="preview-code">
			{/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is escaped, then sanitized with DOMPurify */}
			<code dangerouslySetInnerHTML={{ __html: html }} />
		</pre>
	);
}

function OfficeView({ preview }: { preview: OfficePreview }) {
	if (preview.kind === "sheet") {
		return (
			<div className="preview-sheets">
				{preview.sheets.map((sheet, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a static extracted sheet has no id, and the list never reorders
					<section key={`${sheet.name}-${index}`} className="preview-sheet">
						<h3 className="preview-sheet-title">{sheet.name}</h3>
						<DataTable rows={sheet.rows} />
					</section>
				))}
				{preview.truncated && (
					<p className="preview-note">仅显示前部分工作表与行列。</p>
				)}
			</div>
		);
	}
	if (preview.kind === "doc") {
		return (
			<>
				<div className="preview-doc">
					{preview.blocks.map((block, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a static document block has no id, and the list never reorders
						<DocBlockView key={index} block={block} />
					))}
				</div>
				{preview.truncated && (
					<p className="preview-note">仅显示前部分内容。</p>
				)}
			</>
		);
	}
	return (
		<>
			<div className="preview-slides">
				{preview.slides.map((slide, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a static extracted slide has no id, and the list never reorders
					<section key={index} className="preview-slide">
						<h3 className="preview-slide-title">
							{slide.title || `第 ${index + 1} 页`}
						</h3>
						{slide.lines.length > 0 && (
							<ul>
								{slide.lines.map((line, lineIndex) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: slide lines are an ordered projection with no id
									<li key={lineIndex}>{line}</li>
								))}
							</ul>
						)}
					</section>
				))}
			</div>
			{preview.truncated && (
				<p className="preview-note">仅显示前部分幻灯片。</p>
			)}
		</>
	);
}

function DocBlockView({ block }: { block: DocBlock }) {
	if (block.style === "li") {
		return <p className="preview-li">• {block.text}</p>;
	}
	const Tag = block.style as Exclude<DocBlock["style"], "li">;
	return <Tag>{block.text}</Tag>;
}

// A grid view for CSV rows and spreadsheet sheets, with a row-number gutter.
// Every cell is plain text, so React escapes it; there is no HTML path here.
function DataTable({ rows }: { rows: string[][] }) {
	if (rows.length === 0) {
		return <p className="preview-note">空表。</p>;
	}
	const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
	return (
		<table className="preview-table">
			<tbody>
				{rows.map((row, rowIndex) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a table row is positional by definition, and the grid never reorders
					<tr key={rowIndex}>
						<th scope="row" className="preview-rownum">
							{rowIndex + 1}
						</th>
						{Array.from({ length: width }, (_, col) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a table cell is positional by definition, and the grid never reorders
							<td key={col}>{row[col] ?? ""}</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}
