import { useEffect, useRef, useState } from "react";
import { formatCountdown, isUrgent, remainingSeconds } from "../countdown";
import type { ApprovalChoice, ApprovalRequestInfo } from "../protocol";

interface Props {
	request: ApprovalRequestInfo;
	queued: number;
	onRespond: (id: string, decision: ApprovalChoice) => void;
}

export default function PermissionModal({ request, queued, onRespond }: Props) {
	const allowOnceRef = useRef<HTMLButtonElement>(null);
	// The tick owns its own state so a deadline change (a queued request that
	// has just been promoted) restarts the countdown rather than inheriting the
	// previous one's remaining time.
	const [tick, setTick] = useState(() => Date.now());

	useEffect(() => {
		if (request.expiresAt === null) return;
		setTick(Date.now());
		const handle = setInterval(() => setTick(Date.now()), 1000);
		return () => clearInterval(handle);
	}, [request.expiresAt]);

	useEffect(() => {
		allowOnceRef.current?.focus();
	}, []);

	// Escape means "deny", the safe default; it never approves.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onRespond(request.id, "deny");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [request.id, onRespond]);

	return (
		<div className="modal-backdrop">
			<div className="modal approval" role="alertdialog" aria-modal="true">
				<div className="modal-header">
					<div className="modal-heading">
						<span className="modal-title">需要确认</span>
						<span className="modal-subtitle">
							{request.bot} 请求使用 <code>{request.toolName}</code>
						</span>
					</div>
					<div className="modal-header-badges">
						{request.dangerous && (
							<span className="badge dangerous">危险操作</span>
						)}
						{queued > 1 && (
							<span className="badge">另有 {queued - 1} 项待处理</span>
						)}
						{request.expiresAt !== null && (
							<span
								className={`badge countdown ${
									isUrgent(request.expiresAt, tick) ? "urgent" : ""
								}`}
								title="服务器会在超时后自动拒绝这次请求"
								role="timer"
								aria-live="off"
							>
								{formatCountdown(remainingSeconds(request.expiresAt, tick))}
								<span className="countdown-label">后自动拒绝</span>
							</span>
						)}
					</div>
				</div>

				<div className="modal-body">
					<div className="modal-block">
						<span className="modal-label">参数</span>
						<pre className="modal-code">
							<code>{request.subject}</code>
						</pre>
					</div>
					{request.rule !== null && (
						<div className="modal-block">
							<span className="modal-label">匹配规则</span>
							<code className="modal-rule">{request.rule}</code>
						</div>
					)}
				</div>

				<div className="modal-actions">
					<button
						type="button"
						className="btn deny"
						onClick={() => onRespond(request.id, "deny")}
					>
						拒绝
					</button>
					<button
						type="button"
						className="btn"
						disabled={request.dangerous}
						title={
							request.dangerous
								? "危险命令不可永久放行"
								: "之后同规则的调用不再询问"
						}
						onClick={() => onRespond(request.id, "allow_always")}
					>
						始终允许
					</button>
					<button
						type="button"
						ref={allowOnceRef}
						className="btn primary"
						onClick={() => onRespond(request.id, "allow_once")}
					>
						允许一次
					</button>
				</div>
				<p className="modal-keyhint">
					{request.expiresAt === null
						? "按 Esc 拒绝"
						: "按 Esc 拒绝 · 超时未答复将自动拒绝"}
				</p>
			</div>
		</div>
	);
}
