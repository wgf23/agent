import os from "node:os";
import path from "node:path";

export const SKILLS_DIR_ENV = "MY_AGENT_SKILLS_DIR";

// The one place that reads the skills-prefix override. Tests point
// MY_AGENT_SKILLS_DIR at a temp directory so they never read or write the real
// home directory.
export function skillsRoot(
	env: Record<string, string | undefined> = process.env,
	homeDir: string = os.homedir(),
): string {
	const override = env[SKILLS_DIR_ENV];
	if (override !== undefined && override.trim() !== "") {
		return path.resolve(override);
	}
	return path.join(homeDir, ".config", "my-agent", "skills");
}
