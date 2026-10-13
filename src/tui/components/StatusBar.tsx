import os from "node:os";
import { Text } from "ink";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import type {
	ReasoningEffort,
	ThinkingSetting,
} from "../../providers/types.js";
import { cacheHitRatio, type TuiStatus, type TuiUsage } from "../state.js";
import { StatusRow } from "./StatusRow.js";

export const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
];
const SPINNER_INTERVAL_MS = 80;

export interface StatusBarProps {
	model: string;
	cwd: string;
	usage: TuiUsage;
	status: TuiStatus;
	runStartedAt: number | null;
	thinking?: ThinkingSetting;
	reasoningEffort?: ReasoningEffort;
	allowAll?: boolean;
}

export function shortenCwd(cwd: string, home: string): string {
	if (home === "") return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

export function StatusBar({
	model,
	cwd,
	usage,
	status,
	runStartedAt,
	thinking,
	reasoningEffort,
	allowAll,
}: StatusBarProps): ReactElement {
	const streaming = status === "streaming";
	const awaiting = status === "awaiting_permission";
	const ratio = cacheHitRatio(usage);
	const now = useTicker(streaming);
	const frame = useSpinner(streaming);
	const elapsed =
		streaming && runStartedAt !== null
			? Math.max(0, Math.floor((now - runStartedAt) / 1000))
			: null;

	return (
		<StatusRow>
			<Text color="cyan">{model}</Text>
			{allowAll === true ? <Text color="green">{"  allow-all"}</Text> : null}
			{thinking !== undefined ? (
				<Text dimColor>{`  thinking ${thinking}`}</Text>
			) : null}
			{reasoningEffort !== undefined ? (
				<Text dimColor>{`  effort ${reasoningEffort}`}</Text>
			) : null}
			<Text dimColor>{`  ${shortenCwd(cwd, os.homedir())}`}</Text>
			<Text>{`  in ${usage.input} out ${usage.output}`}</Text>
			{ratio !== null ? (
				<Text dimColor>{`  cache ${Math.round(ratio * 100)}%`}</Text>
			) : null}
			{elapsed !== null ? <Text dimColor>{`  ${elapsed}s`}</Text> : null}
			{streaming ? (
				<Text color="yellow">{`  ${SPINNER_FRAMES[frame]}`}</Text>
			) : null}
			{awaiting ? <Text color="yellow"> waiting for approval</Text> : null}
		</StatusRow>
	);
}

function useTicker(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export function useSpinner(active: boolean): number {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(
			() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length),
			SPINNER_INTERVAL_MS,
		);
		return () => clearInterval(timer);
	}, [active]);
	return frame;
}
