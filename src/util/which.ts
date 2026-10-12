import { accessSync, constants } from "node:fs";
import path from "node:path";

// True when `command` resolves to an executable file. A name containing a path
// separator is checked directly; otherwise each PATH entry is tried. Used to
// reject a cli-backed rob whose command is not installed.
export function commandExists(
	command: string,
	pathEnv: string | undefined = process.env.PATH,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (command === "") return false;
	const extensions = platform === "win32" ? windowsExtensions(command) : [""];

	if (command.includes("/") || command.includes("\\")) {
		return extensions.some((ext) => isExecutable(command + ext));
	}

	const dirs = (pathEnv ?? "").split(platform === "win32" ? ";" : ":");
	for (const dir of dirs) {
		if (dir === "") continue;
		for (const ext of extensions) {
			if (isExecutable(path.join(dir, command + ext))) return true;
		}
	}
	return false;
}

function windowsExtensions(command: string): string[] {
	if (path.extname(command) !== "") return [""];
	const pathext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	return ["", ...pathext.split(";").filter((ext) => ext !== "")];
}

function isExecutable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
