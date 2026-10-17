import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const SCRIPT = path.join(REPO_ROOT, "scripts", "room-members.mjs");
const LIMITS = path.join(REPO_ROOT, "src", "rob", "room-limits.ts");
const ROOM = path.join(REPO_ROOT, "src", "rob", "room.ts");

/** Runs the real script from a throwaway workspace, so the repo's own
 *  my-agent.json (local runtime state) and the real room ledgers are never
 *  touched. The script resolves my-agent.json and src/rob/*.ts from
 *  process.cwd(), and the ledger root from MY_AGENT_ROOMS_DIR. */
async function run(workspace: string, roomsDir: string, ...args: string[]) {
	try {
		const { stdout } = await execFileAsync(
			process.execPath,
			["scripts/room-members.mjs", "rnd", ...args],
			{
				cwd: workspace,
				env: { ...process.env, MY_AGENT_ROOMS_DIR: roomsDir },
			},
		);
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as {
			code?: number;
			stdout?: string;
			stderr?: string;
		};
		return {
			code: failure.code ?? -1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
}

interface RoomSeed {
	name?: string;
	members: string[];
	coordinator?: string | null;
	transcript?: { id: number; kind: string; text: string }[];
}

describe("scripts/room-members.mjs", () => {
	let workspace: string;
	let roomsDir: string;
	let ledger: string;

	/** Builds the workspace copy the script reads: config, the two source files
	 *  it parses, and the script itself (copied byte-for-byte from the repo). */
	async function setupWorkspace(room: RoomSeed, robs: string[]) {
		const config = {
			robs: robs.map((name) => ({ name })),
			rooms: [
				{
					name: "rnd",
					members: room.members,
					...(room.coordinator === undefined
						? {}
						: { coordinator: room.coordinator }),
				},
			],
		};
		await writeFile(
			path.join(workspace, "my-agent.json"),
			`${JSON.stringify(config, null, 2)}\n`,
		);
	}

	async function seedLedger(room: RoomSeed) {
		const state = {
			version: 1,
			name: "rnd",
			workspaceRoot: workspace,
			members: room.members,
			coordinator: room.coordinator ?? null,
			transcript: room.transcript ?? [{ id: 1, kind: "user", text: "hi" }],
			runOpen: false,
			queue: [],
			createdAt: 1,
			updatedAt: 1,
		};
		await writeFile(ledger, `${JSON.stringify(state, null, 2)}\n`);
	}

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(tmpdir(), "room-members-ws-"));
		roomsDir = await mkdtemp(path.join(tmpdir(), "room-members-rooms-"));
		await mkdir(path.join(workspace, "scripts"), { recursive: true });
		await mkdir(path.join(workspace, "src", "rob"), { recursive: true });
		await writeFileScript(workspace);
		await writeFile(
			path.join(workspace, "src", "rob", "room-limits.ts"),
			await readFile(LIMITS, "utf8"),
		);
		await writeFile(
			path.join(workspace, "src", "rob", "room.ts"),
			await readFile(ROOM, "utf8"),
		);
		const slug = workspace.replace(/[^a-zA-Z0-9]/g, "-");
		await mkdir(path.join(roomsDir, slug), { recursive: true });
		ledger = path.join(roomsDir, slug, "rnd.json");
	});

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true });
		await rm(roomsDir, { recursive: true, force: true });
	});

	it("writes the config's members and keeps the pre-change ledger as .bak", async () => {
		await setupWorkspace({ members: ["pm", "architect"], coordinator: "pm" }, [
			"pm",
			"architect",
			"dev",
		]);
		await seedLedger({ members: ["pm"], coordinator: "pm" });
		const before = await readFile(ledger, "utf8");

		const result = await run(workspace, roomsDir);

		expect(result.code).toBe(0);
		const after = JSON.parse(await readFile(ledger, "utf8"));
		expect(after.members).toEqual(["pm", "architect"]);
		expect(after.coordinator).toBe("pm");
		// The transcript is not the script's business; it must survive verbatim.
		expect(after.transcript).toHaveLength(1);
		expect(JSON.parse(await readFile(`${ledger}.bak`, "utf8"))).toEqual(
			JSON.parse(before),
		);
	});

	it("refuses a member that is not in robs and leaves the ledger alone", async () => {
		await setupWorkspace({ members: ["pm", "ghost"], coordinator: "pm" }, [
			"pm",
			"architect",
		]);
		await seedLedger({ members: ["pm"], coordinator: "pm" });
		const before = await readFile(ledger, "utf8");

		const result = await run(workspace, roomsDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("not in robs");
		expect(await readFile(ledger, "utf8")).toBe(before);
		await expect(readFile(`${ledger}.bak`, "utf8")).rejects.toThrow();
	});

	it("fails closed when the reserved-name list is reformatted across lines", async () => {
		// The script parses src/rob/room.ts with a regex. A layout change that is
		// semantically identical must not silently turn the reserved-name check
		// into a no-op: it has to refuse to run. This pins that coupling.
		const original = await readFile(ROOM, "utf8");
		const anchor =
			'export const RESERVED_ROOM_SPEAKERS = ["user", "system"] as const;';
		expect(original).toContain(anchor);
		await writeFile(
			path.join(workspace, "src", "rob", "room.ts"),
			original.replace(
				anchor,
				[
					"export const RESERVED_ROOM_SPEAKERS = [",
					'\t/* the human */ "user",',
					'\t/* the daemon */ "system",',
					"] as const;",
				].join("\n"),
			),
		);
		await setupWorkspace({ members: ["pm", "user"], coordinator: "pm" }, [
			"pm",
			"user",
		]);
		await seedLedger({ members: ["pm"], coordinator: "pm" });
		const before = await readFile(ledger, "utf8");

		const result = await run(workspace, roomsDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Cannot parse RESERVED_ROOM_SPEAKERS");
		expect(await readFile(ledger, "utf8")).toBe(before);
		await expect(readFile(`${ledger}.bak`, "utf8")).rejects.toThrow();
	});

	it("does not overwrite the .bak of an earlier run", async () => {
		await setupWorkspace({ members: ["pm", "architect"], coordinator: "pm" }, [
			"pm",
			"architect",
		]);
		// The first run is the migration that matters: its .bak is the only copy
		// of the ledger as it was before the member table changed.
		await seedLedger({ members: ["pm"], coordinator: "pm" });
		expect((await run(workspace, roomsDir)).code).toBe(0);
		const firstBackup = await readFile(`${ledger}.bak`, "utf8");

		const before2 = await readFile(ledger, "utf8");
		expect((await run(workspace, roomsDir)).code).toBe(0);

		// The second run must still write (updatedAt moves), and its backup must
		// land beside the first one instead of replacing it.
		expect(await readFile(ledger, "utf8")).not.toBe(before2);
		const siblings = await readdir(path.dirname(ledger));
		expect(siblings.some((file) => /^rnd\.json\.bak\.\d+$/.test(file))).toBe(
			true,
		);
		expect(await readFile(`${ledger}.bak`, "utf8")).toBe(firstBackup);
		expect(JSON.parse(firstBackup).members).toEqual(["pm"]);
	});

	it("refuses to clear a coordinator the ledger already has", async () => {
		// A config that omits `coordinator` means "not stated", not "remove it".
		// Writing null here silently disables the room's wrap-up step.
		await setupWorkspace({ members: ["pm", "architect"] }, ["pm", "architect"]);
		await seedLedger({ members: ["pm"], coordinator: "pm" });
		const before = await readFile(ledger, "utf8");

		const result = await run(workspace, roomsDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("coordinator");
		expect(await readFile(ledger, "utf8")).toBe(before);
		await expect(readFile(`${ledger}.bak`, "utf8")).rejects.toThrow();
	});

	it("clears the coordinator when asked to explicitly", async () => {
		await setupWorkspace({ members: ["pm", "architect"] }, ["pm", "architect"]);
		await seedLedger({ members: ["pm"], coordinator: "pm" });

		const result = await run(workspace, roomsDir, "--allow-clear-coordinator");

		expect(result.code).toBe(0);
		expect(JSON.parse(await readFile(ledger, "utf8")).coordinator).toBeNull();
	});

	it("writes nothing at all in a dry run", async () => {
		await setupWorkspace({ members: ["pm", "architect"], coordinator: "pm" }, [
			"pm",
			"architect",
		]);
		await seedLedger({ members: ["pm"], coordinator: "pm" });
		const before = await readFile(ledger, "utf8");

		const result = await run(workspace, roomsDir, "--dry-run");

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("dry run");
		expect(await readFile(ledger, "utf8")).toBe(before);
		await expect(readFile(`${ledger}.bak`, "utf8")).rejects.toThrow();
		await expect(readFile(`${ledger}.tmp`, "utf8")).rejects.toThrow();
	});
});

async function writeFileScript(workspace: string): Promise<void> {
	await writeFile(
		path.join(workspace, "scripts", "room-members.mjs"),
		await readFile(SCRIPT, "utf8"),
	);
}
