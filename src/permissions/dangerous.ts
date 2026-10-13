const DANGEROUS_PATTERNS: RegExp[] = [
	/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
	/\brm\s+-[a-z]*r[a-z]*\s+(?:\/|~|\*)(?:\s|$)/i,
	/\bsudo\b/,
	/\bmkfs(?:\.\w+)?\b/,
	/\bdd\b[^;&|]*\bof=\/dev\//,
	/>>?\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk|disk)/,
	/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/,
	/\bchmod\s+-[a-z]*R[a-z]*\s+777\b/i,
	/\bgit\s+push\b[^;&|]*(?:--force\b|\s-f\b)/,
	/\bgit\s+reset\b[^;&|]*--hard\b/,
	/\bshutdown\b/,
	/\breboot\b/,
	/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
];

export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}
