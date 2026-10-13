import type { BotStatus } from "./protocol";

export const STATUS_LABEL: Record<BotStatus, string> = {
	idle: "空闲",
	working: "工作中",
	waiting_approval: "等待审批",
	stopped: "已停止",
};
