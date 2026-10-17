import { createHash } from "node:crypto";
import {
	type Dirent,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyAuthorize } from "../../src/agent/authorize.js";
import {
	projectFilePath,
	readProjectConfig,
} from "../../src/config/project-file.js";
import type { RoomConfig } from "../../src/rob/room.js";
import { roomsRoot } from "../../src/rob/room-store.js";
import { Team } from "../../src/rob/team.js";
import { projectSlug } from "../../src/session/store.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { makeWorkspace, removeWorkspace } from "../tools/helpers.js";

const MEMBERS = ["alpha", "beta"] as const;

let workspace: string;

beforeEach(async () => {
	workspace = await makeWorkspace("my-agent-room-restart-");
});

afterEach(async () => {
	await removeWorkspace(workspace);
});

/** The same input a real boot gets: the room list on disk, not a literal. */
async function configuredRooms(): Promise<readonly RoomConfig[]> {
	const config = await readProjectConfig(workspace);
	if (!config.ok) throw new Error(config.error);
	return config.config.rooms ?? [];
}

function writeConfig(rooms: Array<{ name: string; members: string[] }>): void {
	writeFileSync(
		projectFilePath(workspace),
		`${JSON.stringify({
			robs: [
				{ name: "alpha", role: "a" },
				{ name: "beta", role: "b" },
			],
			rooms,
		})}\n`,
		"utf8",
	);
}

async function boot(): Promise<Team> {
	return new Team({
		robs: [
			{ name: "alpha", role: "a" },
			{ name: "beta", role: "b" },
		],
		defaultModel: "deepseek-flash",
		providerFactory: () => createMockProvider([]),
		workspaceRoot: workspace,
		authorizerFactory: () => readOnlyAuthorize,
		rooms: await configuredRooms(),
	});
}

async function restart(team: Team): Promise<Team> {
	await team.stop();
	return boot();
}

function ledgerPath(name: string): string {
	return path.join(roomsRoot(), projectSlug(workspace), `${name}.json`);
}

/** Every file under `root`, keyed by its relative path, valued by the sha256
 *  of its bytes. Names and contents both count: a delete that leaves the same
 *  number of files with different bytes is a failure, not a pass. */
function treeFingerprint(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				out[path.relative(root, full)] = createHash("sha256")
					.update(readFileSync(full))
					.digest("hex");
			}
		}
	};
	walk(root);
	return out;
}

describe("a deleted room across a restart", () => {
	it("AC-6-T1: does not come back after a restart", async () => {
		writeConfig([{ name: "standup", members: [...MEMBERS] }]);
		let team = await boot();
		expect(team.rooms().map((room) => room.name)).toContain("standup");

		expect((await team.removeRoom("standup")).status).toBe("removed");

		team = await restart(team);
		try {
			expect(team.rooms().map((room) => room.name)).not.toContain("standup");
		} finally {
			await team.stop();
		}
	});

	// The reverse control: with the config entry kept and only the ledger
	// removed, the room must come back. Without this, T1 would still pass if
	// the restart read nothing at all.
	it("AC-6-T3: keeps a room whose config entry survived and ledger did not", async () => {
		writeConfig([{ name: "ghosted", members: [...MEMBERS] }]);
		let team = await boot();
		expect(team.rooms().map((room) => room.name)).toContain("ghosted");
		await team.stop();
		rmSync(ledgerPath("ghosted"), { force: true });

		team = await boot();
		try {
			expect(team.rooms().map((room) => room.name)).toContain("ghosted");
		} finally {
			await team.stop();
		}
	});
});

describe("a delete does not reach outside the rooms directory", () => {
	it("AC-9: leaves bots/** and docs/deliverables/** byte-identical", async () => {
		writeConfig([{ name: "standup", members: [...MEMBERS] }]);
		mkdirSync(path.join(workspace, "bots", "alpha"), { recursive: true });
		writeFileSync(
			path.join(workspace, "bots", "alpha", "state.json"),
			'{"sessions":["keep-me"]}\n',
			"utf8",
		);
		mkdirSync(path.join(workspace, "docs", "deliverables"), {
			recursive: true,
		});
		writeFileSync(
			path.join(workspace, "docs", "deliverables", "probe.md"),
			"# keep\n",
			"utf8",
		);

		const botsBefore = treeFingerprint(path.join(workspace, "bots"));
		const docsBefore = treeFingerprint(path.join(workspace, "docs"));
		// Guard against a fingerprint that sees nothing and therefore matches.
		expect(Object.keys(botsBefore)).toEqual([path.join("alpha", "state.json")]);
		expect(Object.keys(docsBefore)).toEqual([
			path.join("deliverables", "probe.md"),
		]);

		const team = await boot();
		expect((await team.removeRoom("standup")).status).toBe("removed");
		await team.stop();

		expect(treeFingerprint(path.join(workspace, "bots"))).toEqual(botsBefore);
		expect(treeFingerprint(path.join(workspace, "docs"))).toEqual(docsBefore);
		// Only the room's own ledger moved: the workspace keeps its config file.
		const config = JSON.parse(readFileSync(projectFilePath(workspace), "utf8"));
		expect(config.rooms).toEqual([]);
	});
});
