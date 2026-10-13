import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { BotStatus } from "../protocol";
import { ArrowUpIcon, StopIcon } from "./icons";

interface Props {
	model: string;
	status: BotStatus;
	configured: boolean;
	onSend: (text: string) => void;
	onInterrupt: () => void;
}

const MAX_HEIGHT = 220;

export default function Composer({
	model,
	status,
	configured,
	onSend,
	onInterrupt,
}: Props) {
	const [value, setValue] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const working = status === "working";
	const waiting = status === "waiting_approval";
	const busy = working || waiting;
	const canSend = configured && value.trim() !== "";

	// Grow with the content up to a cap, then scroll inside the textarea.
	const resize = (el: HTMLTextAreaElement) => {
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
	};

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const submit = () => {
		if (!canSend) return;
		onSend(value.trim());
		setValue("");
		if (textareaRef.current !== null) {
			textareaRef.current.style.height = "auto";
		}
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		// While an IME is composing (e.g. Chinese pinyin), Enter confirms the
		// candidate and must not send the message.
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
			return;
		}
		if (event.key === "Escape" && working) {
			event.preventDefault();
			onInterrupt();
		}
	};

	let placeholder = "给 Agent 发消息…";
	if (!configured) {
		placeholder = "请先配置模型";
	} else if (working) {
		placeholder = "运行中，输入内容将作为插话在下一步注入…";
	} else if (waiting) {
		placeholder = "等待工具审批中，可以先输入插话…";
	}

	return (
		<div className="composer-wrap">
			<div className={`composer ${busy ? "busy" : ""}`}>
				<textarea
					ref={textareaRef}
					className="composer-input"
					value={value}
					onChange={(event) => {
						setValue(event.target.value);
						resize(event.target);
					}}
					onKeyDown={handleKeyDown}
					rows={1}
					placeholder={placeholder}
					aria-label="消息输入"
				/>
				<div className="composer-footer">
					<span className="composer-model" title="当前模型">
						{model || "未设置模型"}
					</span>
					<div className="composer-actions">
						{working && (
							<button
								type="button"
								className="btn stop"
								onClick={onInterrupt}
								title="停止当前回合（Esc）"
							>
								<StopIcon />
								停止
							</button>
						)}
						<button
							type="button"
							className="btn primary send"
							onClick={submit}
							disabled={!canSend}
							title={busy ? "作为插话发送" : "发送（Enter）"}
							aria-label={busy ? "插话" : "发送"}
						>
							<ArrowUpIcon />
						</button>
					</div>
				</div>
			</div>
			<p className="composer-hint">
				{busy
					? "插话会在下一步注入；停止会清空待发送的插话"
					: "Enter 发送 · Shift+Enter 换行"}
			</p>
		</div>
	);
}
