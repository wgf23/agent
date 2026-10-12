import type { ApprovalChoice, ApprovalRequestInfo } from "../protocol";

interface Props {
	request: ApprovalRequestInfo;
	onRespond: (id: string, decision: ApprovalChoice) => void;
}

export default function PermissionModal({ request, onRespond }: Props) {
	return (
		<div className="modal-backdrop">
			<div className="modal" role="dialog" aria-modal="true">
				<div className="modal-header">
					<span className="modal-title">工具需要审批</span>
					{request.dangerous && <span className="badge dangerous">危险</span>}
				</div>

				<div className="modal-body">
					<div className="modal-row">
						<span className="modal-label">Bot</span>
						<span className="modal-value">{request.bot}</span>
					</div>
					<div className="modal-row">
						<span className="modal-label">工具</span>
						<code className="modal-value">{request.toolName}</code>
					</div>
					<div className="modal-row subject">
						<span className="modal-label">参数</span>
						<code className="modal-value">{request.subject}</code>
					</div>
					{request.rule !== null && (
						<div className="modal-row">
							<span className="modal-label">规则</span>
							<code className="modal-value">{request.rule}</code>
						</div>
					)}
				</div>

				<div className="modal-actions">
					<button
						type="button"
						className="btn allow-once"
						onClick={() => onRespond(request.id, "allow_once")}
					>
						允许一次
					</button>
					<button
						type="button"
						className="btn allow-always"
						disabled={request.dangerous}
						title={
							request.dangerous ? "危险命令不可永久放行" : "后续同规则不再询问"
						}
						onClick={() => onRespond(request.id, "allow_always")}
					>
						始终允许
					</button>
					<button
						type="button"
						className="btn deny"
						onClick={() => onRespond(request.id, "deny")}
					>
						拒绝
					</button>
				</div>
			</div>
		</div>
	);
}
