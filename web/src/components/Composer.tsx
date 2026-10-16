import {
	type ChangeEvent,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	acceptAttribute,
	fitsMessage,
	type PickedImage,
	readImageFile,
	toImagePart,
} from "../images";
import type { AllowAllMode, BotStatus, ImagePart } from "../protocol";
import { ArrowUpIcon, ImageIcon, StopIcon, XIcon } from "./icons";

interface Props {
	model: string;
	status: BotStatus;
	configured: boolean;
	// The runtime allow-all scope, shown as the dropdown under the composer.
	allowAllMode: AllowAllMode;
	onAllowAllChange: (mode: AllowAllMode) => void;
	// Images ride along with the text; the composer's chips are what becomes a
	// PickedImage list, and the send clears them.
	onSend: (text: string, images: ImagePart[]) => void;
	onInterrupt: () => void;
}

const MAX_HEIGHT = 220;

export default function Composer({
	model,
	status,
	configured,
	allowAllMode,
	onAllowAllChange,
	onSend,
	onInterrupt,
}: Props) {
	const [value, setValue] = useState("");
	const [images, setImages] = useState<PickedImage[]>([]);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const nextId = useRef(0);
	const working = status === "working";
	const waiting = status === "waiting_approval";
	const busy = working || waiting;
	// An image alone is a message worth sending, so the send gate is not only
	// about text.
	const canSend = configured && (value.trim() !== "" || images.length > 0);

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
		onSend(value.trim(), images.map(toImagePart));
		setValue("");
		setImages([]);
		setError(null);
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

	// Reads every chosen file. A rejected one leaves a message above the input
	// and adds nothing, so the send never carries an attachment the server
	// would refuse.
	const pickFiles = async (event: ChangeEvent<HTMLInputElement>) => {
		const files = [...(event.target.files ?? [])];
		// Reset immediately so picking the same file twice still fires onChange.
		event.target.value = "";
		if (files.length === 0) return;
		setError(null);
		const accepted: PickedImage[] = [];
		for (const file of files) {
			if (fitsMessage(accepted.length + images.length + 1) !== null) break;
			nextId.current += 1;
			const result = await readImageFile(file, `img-${nextId.current}`);
			if (!result.ok) {
				setError(result.error);
				break;
			}
			accepted.push(result.image);
		}
		if (accepted.length === 0) return;
		const overflow = fitsMessage(images.length + accepted.length);
		if (overflow !== null) {
			setError(overflow.error);
			return;
		}
		setImages((current) => [...current, ...accepted]);
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
				{images.length > 0 && (
					<ul className="composer-chips" aria-label="已选择的图片">
						{images.map((image) => (
							<li key={image.id} className="composer-chip">
								<ImageIcon />
								<span className="composer-chip-name" title={image.name}>
									{image.name}
								</span>
								<button
									type="button"
									className="composer-chip-remove"
									title="移除这张图片"
									aria-label={`移除 ${image.name}`}
									onClick={() => {
										setImages((current) =>
											current.filter((entry) => entry.id !== image.id),
										);
									}}
								>
									<XIcon />
								</button>
							</li>
						))}
					</ul>
				)}
				{error !== null && (
					<p className="composer-error" role="alert">
						{error}
					</p>
				)}
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
						<input
							ref={fileRef}
							type="file"
							accept={acceptAttribute()}
							multiple
							className="composer-file"
							aria-hidden="true"
							tabIndex={-1}
							onChange={(event) => {
								void pickFiles(event);
							}}
						/>
						<button
							type="button"
							className="btn small"
							title="添加图片（png、jpg、jpeg、webp，单张不超过 8 MiB）"
							aria-label="添加图片"
							onClick={() => fileRef.current?.click()}
						>
							<ImageIcon />
							图片
						</button>
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
			<div className="composer-tools">
				<label className="allow-all-control">
					<span className="allow-all-label">自动放行工具</span>
					<select
						className="allow-all-select"
						value={allowAllMode}
						onChange={(event) =>
							onAllowAllChange(event.target.value as AllowAllMode)
						}
					>
						<option value="off">关闭</option>
						<option value="session">本次会话放行</option>
						<option value="all">所有会话放行</option>
					</select>
				</label>
				<span className="composer-hint">
					{busy
						? "插话会在下一步注入；停止会清空待发送的插话"
						: "Enter 发送 · Shift+Enter 换行 · 图片随消息一起发送"}
				</span>
			</div>
		</div>
	);
}
