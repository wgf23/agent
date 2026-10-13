import { z } from "zod";
import type { LspDiagnostic } from "./client.js";

export const severitySchema = z.enum(["error", "warning", "info", "hint"]);
export type Severity = z.infer<typeof severitySchema>;

export const diagnosticsSchema = z
	.object({
		path: z.string().describe("File path relative to the workspace root."),
		severity: severitySchema
			.optional()
			.describe("Only return diagnostics of this severity."),
	})
	.strict();

const SEVERITY_NUMBER: Record<Severity, number> = {
	error: 1,
	warning: 2,
	info: 3,
	hint: 4,
};

// The LSP spec defaults a missing severity to Error (1).
export function severityLabel(
	severity: number | undefined,
): "error" | "warning" | "info" | "hint" {
	switch (severity) {
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "error";
	}
}

export function filterDiagnostics(
	diagnostics: LspDiagnostic[],
	severity: Severity | undefined,
): LspDiagnostic[] {
	if (severity === undefined) return diagnostics;
	const target = SEVERITY_NUMBER[severity];
	return diagnostics.filter(
		(diagnostic) => (diagnostic.severity ?? 1) === target,
	);
}

export function formatDiagnostics(
	filePath: string,
	diagnostics: LspDiagnostic[],
): string {
	if (diagnostics.length === 0) return "no diagnostics";
	return diagnostics
		.map(
			(diagnostic) =>
				`${filePath}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${severityLabel(diagnostic.severity)} ${diagnostic.message}`,
		)
		.join("\n");
}
