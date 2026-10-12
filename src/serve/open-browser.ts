import { spawn } from "node:child_process";

// Best-effort: a missing opener must never crash the server. The URL is printed
// to the terminal either way.
export function openBrowser(url: string): void {
	const platform = process.platform;
	const [command, args] =
		platform === "darwin"
			? ["open", [url]]
			: platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];

	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// Ignore: xdg-open may not exist on a headless host.
	}
}
