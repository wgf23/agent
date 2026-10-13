import { accessSync, constants } from "node:fs";
import path from "node:path";

// Resolves `command` to the absolute path of an executable file. A name
// containing a path separator is checked directly; otherwise each PATH entry is
// tried. Returns undefined when nothing executable matches, so callers that only
// need a yes/no answer can compare against undefined.
export function resolveCommand(
	command: string,
	pathEnv: string | undefined = process.env.PATH,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (command === "") return undefined;
	const extensions = platform === "win32" ? windowsExtensions(command) : [""];

	if (command.includes("/") || command.includes("\\")) {
		for (const ext of extensions) {
			const candidate = command + ext;
			if (isExecutable(candidate)) return path.resolve(candidate);
		}
		return undefined;
	}

	const dirs = (pathEnv ?? "").split(platform === "win32" ? ";" : ":");
	for (const dir of dirs) {
		if (dir === "") continue;
		for (const ext of extensions) {
			const candidate = path.join(dir, command + ext);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

// True when `command` resolves to an executable file. Used to reject a
// cli-backed rob whose command is not installed.
export function commandExists(
	command: string,
	pathEnv: string | undefined = process.env.PATH,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return resolveCommand(command, pathEnv, platform) !== undefined;
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
