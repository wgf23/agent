import { type ChildProcess, spawn } from "node:child_process";

// Kills a child and, on posix, every process in its group. `detached` spawns put
// the child in its own group so a timeout or cancel can take descendants with
// it. Windows has no process group here; taskkill walks the child tree.
export function killProcessGroup(child: ChildProcess): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
		});
		killer.on("error", () => child.kill());
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}
