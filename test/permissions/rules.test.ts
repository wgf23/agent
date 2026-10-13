import { describe, expect, it } from "vitest";
import {
	defaultRules,
	matchesPattern,
	type PermissionRules,
	resolveAction,
} from "../../src/permissions/rules.js";

describe("matchesPattern", () => {
	it("matches a wildcard prefix against the whole command", () => {
		expect(matchesPattern("git *", "git status -s")).toBe(true);
	});

	it("does not match a command whose word only shares a prefix", () => {
		expect(matchesPattern("git *", "gitk")).toBe(false);
	});

	it("treats every non-wildcard character literally", () => {
		expect(matchesPattern("a.b", "axb")).toBe(false);
		expect(matchesPattern("a.b", "a.b")).toBe(true);
	});

	it("lets a bare star span spaces and slashes", () => {
		expect(matchesPattern("*", "src/a b/c.ts")).toBe(true);
	});

	it("anchors both ends", () => {
		expect(matchesPattern("git *", "git status extra")).toBe(true);
		expect(matchesPattern("git *", "x git status")).toBe(false);
	});
});

describe("resolveAction", () => {
	it("returns the default action for each built-in tool", () => {
		const rules = defaultRules();

		expect(resolveAction(rules, "read_file", "a.txt")).toBe("allow");
		expect(resolveAction(rules, "glob", "**/*.ts")).toBe("allow");
		expect(resolveAction(rules, "grep", "foo")).toBe("allow");
		expect(resolveAction(rules, "write_file", "a.txt")).toBe("ask");
		expect(resolveAction(rules, "edit_file", "a.txt")).toBe("ask");
		expect(resolveAction(rules, "bash", "ls")).toBe("ask");
		expect(resolveAction(rules, "mystery_tool", "x")).toBe("ask");
	});

	it("uses the first matching entry in a rule list", () => {
		const rules: PermissionRules = {
			bash: [
				{ pattern: "git *", action: "allow" },
				{ pattern: "*", action: "deny" },
			],
		};

		expect(resolveAction(rules, "bash", "git status")).toBe("allow");
		expect(resolveAction(rules, "bash", "rm -rf /")).toBe("deny");
	});

	it("lets a deny rule override an allow default", () => {
		const rules: PermissionRules = {
			...defaultRules(),
			read_file: [{ pattern: "secrets/*", action: "deny" }],
		};

		expect(resolveAction(rules, "read_file", "secrets/key.txt")).toBe("deny");
		expect(resolveAction(rules, "read_file", "public.txt")).toBe("allow");
	});
});
