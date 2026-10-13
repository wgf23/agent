export interface SandboxExec {
	argv: string[];
	env: Record<string, string>;
}

export interface BwrapArgvInput {
	command: string;
	workspaceRoot: string;
	writableRoots: string[];
	network: boolean;
}

export function bwrapArgv(input: BwrapArgvInput): SandboxExec {
	// Read-only root plus a fresh /dev and /proc covers every system dir the
	// command needs to read or exec. Writable roots are bound back over it.
	const argv = [
		"bwrap",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
	];

	const seen = new Set<string>();
	for (const root of [input.workspaceRoot, ...input.writableRoots]) {
		if (root === "/" || seen.has(root)) continue;
		seen.add(root);
		argv.push("--bind", root, root);
	}

	argv.push("--die-with-parent");
	if (!input.network) argv.push("--unshare-net");
	argv.push("--chdir", input.workspaceRoot, "/bin/sh", "-c", input.command);

	return { argv, env: {} };
}
