import { useState } from "react";
import type { AgentJobView, AgentStatusView, InstallPhase } from "../protocol";
import { isLivePhase } from "../state";

interface Props {
	agents: AgentStatusView[];
	jobs: Record<string, AgentJobView>;
	onInstall: (id: string) => Promise<void> | void;
	onCancel: (id: string) => void;
}

const PHASE_LABEL: Record<InstallPhase, string> = {
	queued: "排队中",
	installing: "安装中…",
	verifying: "校验中…",
	installed: "已安装",
	unverified: "未验证",
	failed: "失败",
	cancelled: "已取消",
};

export default function AgentsPanel({
	agents,
	jobs,
	onInstall,
	onCancel,
}: Props) {
	const [error, setError] = useState<string | null>(null);

	const install = (id: string) => {
		setError(null);
		Promise.resolve(onInstall(id)).catch((err) => {
			setError(err instanceof Error ? err.message : String(err));
		});
	};

	return (
		<main className="agents">
			<header className="page-header">
				<div>
					<h1>Agents</h1>
					<p className="page-sub">
						管理外部编码 CLI：检测是否安装、安装缺失的，或取消进行中的安装
					</p>
				</div>
			</header>

			{error !== null && (
				<div className="dialog-error" role="alert">
					{error}
				</div>
			)}

			<ul className="agent-list">
				{agents.map((agent) => {
					const job = jobs[agent.id] ?? null;
					const live = job !== null && isLivePhase(job.phase);
					return (
						<li className="agent-row" key={agent.id}>
							<div className="agent-main">
								<span className="agent-name">
									{agent.label}
									<span className="agent-command">{agent.command}</span>
								</span>
								<span className="agent-meta">{agent.npmPackage}</span>
								<span className="agent-meta">
									{agent.installed
										? `已安装${agent.version !== null ? ` ${agent.version}` : ""}${
												agent.onPath ? "" : "（不在 PATH 上）"
											}`
										: "未安装"}
								</span>
								{!agent.robBackend && (
									<span className="agent-note">
										不能作为 Rob 后端：{agent.robBlockedReason}
									</span>
								)}
							</div>

							<div className="agent-actions">
								{live ? (
									<>
										<span className="agent-phase">
											{PHASE_LABEL[job.phase]}
										</span>
										<button
											type="button"
											className="btn small deny"
											onClick={() => onCancel(agent.id)}
										>
											取消
										</button>
									</>
								) : agent.installed ? (
									<span className="agent-status">已就绪</span>
								) : (
									<button
										type="button"
										className="btn small primary"
										onClick={() => install(agent.id)}
									>
										安装
									</button>
								)}
							</div>

							{job !== null && job.error !== null && (
								<p className="agent-error">{job.error}</p>
							)}
						</li>
					);
				})}
			</ul>
		</main>
	);
}
