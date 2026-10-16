import type { SubagentView } from "../protocol";
import { subagentLine } from "../subagent";

interface Props {
	entries: SubagentView[];
}

// Read-only, exactly like the TUI's SubagentView: no input handler, no Team
// reference, and no action to take. An event with no line is filtered out.
export default function SubagentFeed({ entries }: Props) {
	const lines = entries
		.map((entry) => ({
			key: `${entry.parent}-${entry.id}-${entry.at}-${JSON.stringify(entry.event)}`,
			parent: entry.parent,
			text: subagentLine(entry.event),
		}))
		.filter((line) => line.text !== "");

	return (
		<main className="subagents">
			<header className="page-header">
				<div>
					<h1>子 Agent</h1>
					<p className="page-sub">
						{lines.length} 条活动，每个 Bot 的子 Agent 都归在它的名字下
					</p>
				</div>
			</header>

			{lines.length === 0 ? (
				<div className="empty-page compact">
					<p className="empty-title">还没有子 Agent 活动</p>
					<p className="empty-desc">
						Bot 委派任务给子 Agent 时，它的活动会显示在这里。
					</p>
				</div>
			) : (
				<ul className="subagent-list">
					{lines.map((line) => (
						<li key={line.key} className="subagent-row">
							{`[${line.parent}] ${line.text}`}
						</li>
					))}
				</ul>
			)}
		</main>
	);
}
