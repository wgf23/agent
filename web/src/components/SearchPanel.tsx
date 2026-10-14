import { useState } from "react";
import type { SearchResponse, SessionMatch } from "../protocol";
import { sessionLabel } from "../sessions";
import type { SearchState } from "../state";

interface Props {
	search: SearchState;
	onSearch: (query: string) => void;
	onClear: () => void;
	// Opens the workspace chat's session; the sidebar also returns to the chat.
	onOpenChat: (sessionId: string) => void;
	// Selects the bot, then opens the hit so the list and transcript follow.
	onOpenBot: (bot: string, sessionId: string) => void;
}

// The sidebar's session search. One query spans the workspace chat and every
// bot; the results are read-only, so the panel only ever calls back to open a
// hit. The input is local until Enter (or the clear button) so typing does not
// fire a request per keystroke.
export default function SearchPanel({
	search,
	onSearch,
	onClear,
	onOpenChat,
	onOpenBot,
}: Props) {
	const [draft, setDraft] = useState(search.query);

	const submit = () => {
		const query = draft.trim();
		// A blank query is the server's 400 and the hub drops it too; do not
		// pretend to search for nothing.
		if (query === "") return;
		onSearch(query);
	};

	return (
		<section className="sidebar-section search-panel">
			<div className="sidebar-label">
				<span>搜索</span>
			</div>
			<form
				className="search-form"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<input
					className="field-input search-input"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="搜索会话…"
					aria-label="搜索会话"
				/>
				<button
					type="button"
					className="search-clear"
					title="清除搜索"
					aria-label="清除搜索"
					onClick={() => {
						setDraft("");
						onClear();
					}}
				>
					×
				</button>
			</form>

			{search.loading && <p className="search-status">搜索中…</p>}
			{search.error !== null && (
				<p className="search-error" role="alert">
					搜索失败：{search.error}
				</p>
			)}
			{search.results !== null && (
				<SearchResults
					results={search.results}
					onOpenChat={onOpenChat}
					onOpenBot={onOpenBot}
				/>
			)}
		</section>
	);
}

function SearchResults({
	results,
	onOpenChat,
	onOpenBot,
}: {
	results: SearchResponse;
	onOpenChat: (sessionId: string) => void;
	onOpenBot: (bot: string, sessionId: string) => void;
}) {
	if (results.chat.length === 0 && results.bots.length === 0) {
		return <p className="search-empty">没有找到匹配的会话</p>;
	}

	return (
		<div className="search-results">
			{results.chat.length > 0 && (
				<SearchGroup
					label="工作区对话"
					matches={results.chat}
					onOpen={onOpenChat}
				/>
			)}
			{results.bots.map((entry) => (
				<SearchGroup
					key={entry.bot}
					label={entry.bot}
					matches={entry.matches}
					onOpen={(sessionId) => onOpenBot(entry.bot, sessionId)}
				/>
			))}
		</div>
	);
}

function SearchGroup({
	label,
	matches,
	onOpen,
}: {
	label: string;
	matches: SessionMatch[];
	onOpen: (sessionId: string) => void;
}) {
	return (
		<div className="search-group">
			<div className="search-group-label">{label}</div>
			<ul className="search-match-list">
				{matches.map((match) => (
					<li key={match.sessionId}>
						<button
							type="button"
							className="search-match"
							title={sessionLabel(match)}
							onClick={() => onOpen(match.sessionId)}
						>
							<span className="search-match-line">
								<span className="search-match-title">
									{sessionLabel(match)}
								</span>
								<span className="search-match-count">
									{match.hits.length} 处
								</span>
							</span>
							<span className="search-match-hit">
								{match.hits[0]?.text ?? ""}
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
