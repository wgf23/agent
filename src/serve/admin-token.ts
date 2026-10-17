import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The admin token guards every destructive room route. It is resolved once at
 *  startup and never echoed: no response body, log line, error text or URL
 *  carries it. An unconfigured server refuses those routes rather than opening
 *  them to the LAN (fail-closed). */
export interface AdminTokenContext {
	readonly token: string | null;
	readonly source: "env" | "file" | "none";
}

export const ADMIN_TOKEN_ENV = "MY_AGENT_ADMIN_TOKEN";

/** Relative to the workspace root; `.my-agent/` is already git-ignored. */
export const ADMIN_TOKEN_FILE = path.join(".my-agent", "admin-token");

const EXPECTED_MODE = 0o600;

/** Env wins over the file, and a blank value counts as unset. A readable file
 *  whose mode is wider than 0600 is still used, but the caller gets one notice:
 *  the permission warning must not turn a configured deployment into a
 *  permanently 403 one. */
export function resolveAdminToken(input: {
	env: Record<string, string | undefined>;
	workspaceRoot: string;
	onNotice?: (line: string) => void;
}): AdminTokenContext {
	const fromEnv = input.env[ADMIN_TOKEN_ENV]?.trim();
	if (fromEnv !== undefined && fromEnv !== "") {
		return { token: fromEnv, source: "env" };
	}
	const file = path.join(input.workspaceRoot, ADMIN_TOKEN_FILE);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { token: null, source: "none" };
	}
	const token = raw.trim();
	if (token === "") return { token: null, source: "none" };
	try {
		const mode = statSync(file).mode & 0o777;
		if (mode !== EXPECTED_MODE) {
			input.onNotice?.(`admin token file is ${mode.toString(8)}, expected 600`);
		}
	} catch {
		// The read already succeeded; a stat failure is not worth refusing.
	}
	return { token, source: "file" };
}

/** The only token comparison in the repo. Length is compared first so
 *  `timingSafeEqual` is never handed buffers of different sizes (it throws),
 *  and the comparison itself runs in constant time. */
export function adminTokenMatches(
	context: AdminTokenContext,
	presented: string | undefined,
): boolean {
	if (context.token === null || presented === undefined) return false;
	const expected = Buffer.from(context.token, "utf8");
	const actual = Buffer.from(presented, "utf8");
	if (expected.length !== actual.length) return false;
	return timingSafeEqual(expected, actual);
}
