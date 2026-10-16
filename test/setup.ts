import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// discoverSkills() reads this override, so no test reaches the real home
// directory. Individual tests may reassign it to a fixture root.
process.env.MY_AGENT_SKILLS_DIR = mkdtempSync(
	path.join(tmpdir(), "my-agent-test-skills-"),
);

// Team opens each room's ledger in its constructor, so no test may reach the
// real data root. Tests that inspect ledger files reassign this to their own
// temporary root.
process.env.MY_AGENT_ROOMS_DIR = mkdtempSync(
	path.join(tmpdir(), "my-agent-test-rooms-"),
);

// The bot ledger writes to the data root by default, so a test that builds a
// Team without injecting a store must still land in a temp directory.
process.env.MY_AGENT_BOTS_DIR = mkdtempSync(
	path.join(tmpdir(), "my-agent-test-bots-"),
);
