import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// discoverSkills() reads this override, so no test reaches the real home
// directory. Individual tests may reassign it to a fixture root.
process.env.MY_AGENT_SKILLS_DIR = mkdtempSync(
	path.join(tmpdir(), "my-agent-test-skills-"),
);
