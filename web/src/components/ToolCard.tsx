import type { ToolCallView, ToolStatus } from "../protocol";

interface Props {
	tool: ToolCallView;
}

const STATUS_LABEL: Record<ToolStatus, string> = {
	running: "运行中",
	ok: "成功",
	error: "失败",
	blocked: "已阻止",
};

export default function ToolCard({ tool }: Props) {
	return (
		<div className={`tool-card ${tool.status}`}>
			<details>
				<summary className="tool-summary">
					<span className={`tool-status ${tool.status}`} />
					<span className="tool-name">{tool.name}</span>
					<span className="tool-summary-text">{tool.summary}</span>
					<span className="tool-state">{STATUS_LABEL[tool.status]}</span>
				</summary>
				{tool.output !== "" && (
					<pre className="tool-output">
						<code>{tool.output}</code>
					</pre>
				)}
			</details>
		</div>
	);
}
