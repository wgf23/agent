import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeWorkspace(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export async function removeWorkspace(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
