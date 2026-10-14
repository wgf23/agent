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
		<main className="panel">
			<header className="panel-header">
				<div>
					<h2 className="panel-title">子 Agent</h2>
					<p className="panel-sub">{lines.length} 条活动</p>
				</div>
			</header>

			{lines.length === 0 ? (
				<p className="panel-empty">这个 Bot 还没有子 Agent 活动。</p>
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
