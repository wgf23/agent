const BASH_COMMAND_MAX_CHARS = 80;
const UNKNOWN_JSON_MAX_CHARS = 60;

export function summarizeArgs(name: string, args: unknown): string {
	switch (name) {
		case "read_file":
		case "write_file":
		case "edit_file":
			return argString(args, "path") ?? "";
		case "bash": {
			const command = argString(args, "command") ?? "";
			return command.slice(0, BASH_COMMAND_MAX_CHARS);
		}
		case "glob":
			return argString(args, "pattern") ?? "";
		case "grep": {
			const pattern = argString(args, "pattern") ?? "";
			const path = argString(args, "path");
			return path === undefined || path === ""
				? pattern
				: `${pattern} in ${path}`;
		}
		case "web_fetch":
			return argString(args, "url") ?? "";
		default:
			return JSON.stringify(args ?? {}).slice(0, UNKNOWN_JSON_MAX_CHARS);
	}
}

export function argString(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
