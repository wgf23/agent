import { type KeyboardEvent, useState } from "react";
import type { BotStatus } from "../protocol";

interface Props {
	model: string;
	status: BotStatus;
	onSend: (text: string) => void;
	onInterrupt: () => void;
}

export default function Composer({
	model,
	status,
	onSend,
	onInterrupt,
}: Props) {
	const [value, setValue] = useState("");
	const working = status === "working";
	const waiting = status === "waiting_approval";
	const interject = working || waiting;

	const submit = () => {
		const text = value.trim();
		if (text === "") return;
		onSend(text);
		setValue("");
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="composer">
			<textarea
				className="composer-input"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={handleKeyDown}
				rows={3}
				placeholder={
					interject
						? "机器人工作中，输入将作为插话在下一步注入…"
						: "输入消息，Enter 发送，Shift+Enter 换行"
				}
			/>
			<div className="composer-footer">
				<span className="model-chip">{model || "—"}</span>
				<div className="composer-actions">
					{working && (
						<button type="button" className="btn stop" onClick={onInterrupt}>
							停止
						</button>
					)}
					<button
						type="button"
						className="btn send"
						onClick={submit}
						disabled={value.trim() === ""}
					>
						{interject ? "插话" : "发送"}
					</button>
				</div>
			</div>
		</div>
	);
}
