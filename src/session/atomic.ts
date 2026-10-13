import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Writes `payload` as pretty JSON to `filePath` atomically. A crash never
// leaves a half-written file because the bytes land in a sibling temp file
// that is renamed into place. The temp file is removed if the write fails and
// the original error is rethrown for the caller to report.
export async function writeJsonAtomic(
	filePath: string,
	payload: unknown,
): Promise<void> {
	const dir = path.dirname(filePath);
	const tempPath = `${filePath}.${randomUUID()}.tmp`;

	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700);
		await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(tempPath, filePath);
		await chmod(filePath, 0o600);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}
