import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { errorMessage } from "../util/errors.js";
import { GLOBAL_CONFIG_DIR } from "./resolve.js";

export const CREDENTIALS_NAME = "credentials.json";

const credentialsSchema = z.looseObject({
	keys: z.record(z.string(), z.string()).optional(),
});

export type CredentialsReadResult =
	| { ok: true; keys: Record<string, string> }
	| { ok: false; error: string };

export type CredentialWriteResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

export function credentialsPath(homeDir: string): string {
	return path.join(homeDir, GLOBAL_CONFIG_DIR, CREDENTIALS_NAME);
}

export function readCredentials(homeDir: string): CredentialsReadResult {
	const filePath = credentialsPath(homeDir);

	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { ok: true, keys: {} };
		return {
			ok: false,
			error: `Failed to read ${filePath}: ${errorMessage(error)}`,
		};
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			error: `Invalid JSON in ${filePath}: ${errorMessage(error)}`,
		};
	}

	const parsed = credentialsSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			error: `Invalid credentials in ${filePath}: ${z.prettifyError(parsed.error)}`,
		};
	}
	return { ok: true, keys: parsed.data.keys ?? {} };
}

export async function writeCredential(
	homeDir: string,
	envName: string,
	key: string,
): Promise<CredentialWriteResult> {
	const trimmed = key.trim();
	if (trimmed === "") {
		return { ok: false, error: "API key must not be empty." };
	}

	const filePath = credentialsPath(homeDir);
	const current = readCredentials(homeDir);
	if (!current.ok) return current;

	const next = { keys: { ...current.keys, [envName]: trimmed } };
	const dir = path.dirname(filePath);
	const tempPath = path.join(dir, `${CREDENTIALS_NAME}.${randomUUID()}.tmp`);

	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700);
		await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(tempPath, filePath);
		await chmod(filePath, 0o600);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		return {
			ok: false,
			error: `Failed to write ${filePath}: ${errorMessage(error)}`,
		};
	}

	return { ok: true, path: filePath };
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
