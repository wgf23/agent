import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../util/errors.js";
import { globalConfigPath } from "./resolve.js";

export interface GlobalProviderSettings {
	preset: string;
	model: string;
	baseURL?: string;
	apiKeyEnv?: string;
}

export type GlobalWriteResult = { ok: true } | { ok: false; error: string };

export async function writeGlobalProviderSettings(
	homeDir: string,
	settings: GlobalProviderSettings,
): Promise<GlobalWriteResult> {
	const filePath = globalConfigPath(homeDir);

	let raw: Record<string, unknown> = {};
	try {
		const text = await readFile(filePath, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			return {
				ok: false,
				error: `Invalid JSON in ${filePath}: ${errorMessage(error)}`,
			};
		}
		if (!isRecord(parsed)) {
			return {
				ok: false,
				error: `Invalid ${filePath}: expected a JSON object.`,
			};
		}
		raw = parsed;
	} catch (error) {
		if (!isEnoent(error)) {
			return {
				ok: false,
				error: `Failed to read ${filePath}: ${errorMessage(error)}`,
			};
		}
	}

	const existingProvider = isRecord(raw.provider) ? raw.provider : {};
	const provider: Record<string, unknown> = {
		...existingProvider,
		preset: settings.preset,
		model: settings.model,
	};
	if (settings.baseURL !== undefined) provider.baseURL = settings.baseURL;
	else delete provider.baseURL;
	if (settings.apiKeyEnv !== undefined) provider.apiKeyEnv = settings.apiKeyEnv;
	else delete provider.apiKeyEnv;

	// A key belongs only in credentials.json, so never carry one through here.
	delete provider.apiKey;
	const root: Record<string, unknown> = { ...raw };
	delete root.apiKey;
	const next = { ...root, provider };

	const dir = path.dirname(filePath);
	const tempPath = path.join(
		dir,
		`${path.basename(filePath)}.${randomUUID()}.tmp`,
	);
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await rename(tempPath, filePath);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		return {
			ok: false,
			error: `Failed to write ${filePath}: ${errorMessage(error)}`,
		};
	}

	return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
