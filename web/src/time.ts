export function formatTime(at: number): string {
	return new Date(at).toLocaleTimeString("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
	});
}
