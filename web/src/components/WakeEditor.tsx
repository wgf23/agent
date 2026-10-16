import { useState } from "react";
import type { BotWake, SetWakeBody } from "../protocol";

interface Props {
	bot: string;
	wake: BotWake | null;
	onSetWake: (bot: string, body: SetWakeBody) => void | Promise<void>;
}

// The input is written in seconds (readable), but the body the server wants is
// everyMs, so the value is scaled back before validating and saving.
export default function WakeEditor({ bot, wake, onSetWake }: Props) {
	const [seconds, setSeconds] = useState(
		wake === null ? "" : String(wake.everyMs / 1000),
	);
	const [prompt, setPrompt] = useState(wake?.prompt ?? "");

	const everyMs = Math.round(Number(seconds) * 1000);
	const valid =
		seconds.trim() !== "" && Number.isFinite(everyMs) && everyMs >= 1000;

	const save = () => {
		if (!valid) return;
		void onSetWake(bot, { everyMs, prompt: prompt.trim() });
	};

	return (
		<main className="panel">
			<header className="panel-header">
				<div>
					<h2 className="panel-title">唤醒</h2>
					<p className="panel-sub">
						{wake === null
							? "当前没有唤醒计划。"
							: `当前：每 ${wake.everyMs / 1000} 秒唤醒一次`}
					</p>
				</div>
			</header>

			<div className="wake-form">
				<label className="field">
					<span className="field-label">间隔（秒）</span>
					<input
						className="field-input"
						type="number"
						min={1}
						step={1}
						value={seconds}
						onChange={(event) => setSeconds(event.target.value)}
						placeholder="例如 60"
					/>
					<span className="field-hint">最短 1 秒（1000 毫秒）</span>
				</label>

				<label className="field">
					<span className="field-label">唤醒提示词</span>
					<input
						className="field-input"
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder="这个 Bot 醒来时该做什么？"
					/>
				</label>

				{wake !== null && wake.prompt !== "" && (
					<p className="wake-current">当前提示词：{wake.prompt}</p>
				)}

				<div className="panel-actions">
					<button
						type="button"
						className="btn small"
						disabled={wake === null}
						onClick={() => {
							void onSetWake(bot, { clear: true });
						}}
					>
						清除
					</button>
					<button
						type="button"
						className="btn small primary"
						disabled={!valid}
						onClick={save}
					>
						保存
					</button>
				</div>
			</div>
		</main>
	);
}
