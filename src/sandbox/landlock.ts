import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The Landlock ruleset must be applied from the child process itself: the
// syscalls restrict the calling process, so a Python helper installs the
// ruleset and then execs the command. The source is embedded rather than
// shipped as an asset so tsup bundles it into dist/index.js.
const LANDLOCK_HELPER_SOURCE = `#!/usr/bin/env python3
import ctypes
import os
import sys

libc = ctypes.CDLL("libc.so.6", use_errno=True)

SYS_CREATE_RULESET = 444
SYS_ADD_RULE = 445
SYS_RESTRICT_SELF = 446

LANDLOCK_RULE_PATH_BENEATH = 1
LANDLOCK_RULE_NET_PORT = 2

FS_EXECUTE = 0x1
FS_WRITE_FILE = 0x2
FS_READ_FILE = 0x4
FS_READ_DIR = 0x8
FS_REMOVE_DIR = 0x10
FS_REMOVE_FILE = 0x20
FS_MAKE_CHAR = 0x40
FS_MAKE_DIR = 0x80
FS_MAKE_REG = 0x100
FS_MAKE_SOCK = 0x200
FS_MAKE_FIFO = 0x400
FS_MAKE_BLOCK = 0x800
FS_MAKE_SYM = 0x1000
FS_REFER = 0x2000
FS_TRUNCATE = 0x4000
FS_IOCTL_DEV = 0x8000

ALL_FS = (
    FS_EXECUTE
    | FS_WRITE_FILE
    | FS_READ_FILE
    | FS_READ_DIR
    | FS_REMOVE_DIR
    | FS_REMOVE_FILE
    | FS_MAKE_CHAR
    | FS_MAKE_DIR
    | FS_MAKE_REG
    | FS_MAKE_SOCK
    | FS_MAKE_FIFO
    | FS_MAKE_BLOCK
    | FS_MAKE_SYM
    | FS_REFER
    | FS_TRUNCATE
    | FS_IOCTL_DEV
)

READ_EXEC = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
WRITE = (
    FS_WRITE_FILE
    | FS_REMOVE_DIR
    | FS_REMOVE_FILE
    | FS_MAKE_CHAR
    | FS_MAKE_DIR
    | FS_MAKE_REG
    | FS_MAKE_SOCK
    | FS_MAKE_FIFO
    | FS_MAKE_BLOCK
    | FS_MAKE_SYM
    | FS_REFER
    | FS_TRUNCATE
)


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def die(msg):
    print("landlock-helper:", msg, file=sys.stderr)
    sys.exit(126)


abi = libc.syscall(SYS_CREATE_RULESET, None, 0, 1)

# A probe reports the ABI without installing a ruleset, so detection is a cheap
# subprocess that leaves the caller unconfined.
if len(sys.argv) >= 2 and sys.argv[1] == "--probe":
    if abi < 1:
        print("0")
        sys.exit(1)
    print(abi)
    sys.exit(0)

if abi < 1:
    die("landlock unavailable (abi %d)" % abi)

# TCP is denied by default. LL_NETWORK=1 leaves handled_access_net at zero so the
# ruleset does not cover network at all.
handled_net = 0
if abi >= 4 and os.environ.get("LL_NETWORK") != "1":
    handled_net = 0x1 | 0x2  # BIND_TCP | CONNECT_TCP

attr = RulesetAttr(ALL_FS, handled_net)
ruleset_fd = libc.syscall(SYS_CREATE_RULESET, ctypes.byref(attr), ctypes.sizeof(attr), 0)
if ruleset_fd < 0:
    die("create_ruleset errno %d" % ctypes.get_errno())


def allow(path, access):
    fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    pb = PathBeneathAttr(access, fd)
    res = libc.syscall(SYS_ADD_RULE, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(pb), 0)
    os.close(fd)
    if res < 0:
        die("add_rule %s errno %d" % (path, ctypes.get_errno()))


allow("/", READ_EXEC)
for root in os.environ.get("LL_WRITABLE", "").split(":"):
    if root.strip():
        allow(root.strip(), WRITE)

if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
    die("prctl failed")

if libc.syscall(SYS_RESTRICT_SELF, ruleset_fd, 0) != 0:
    die("restrict_self errno %d" % ctypes.get_errno())

os.close(ruleset_fd)
os.execvp(sys.argv[1], sys.argv[1:])
`;

export interface SandboxExec {
	argv: string[];
	env: Record<string, string>;
}

export interface LandlockArgvInput {
	command: string;
	python: string;
	writableRoots: string[];
	network: boolean;
}

export function helperDirectory(): string {
	// Landlock is Linux-only and process.getuid is absent on Windows, so the
	// directory name falls back to uid 0 where the probe never runs.
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return path.join(os.tmpdir(), `my-agent-sandbox-${uid}`);
}

export function helperFilePath(): string {
	return path.join(helperDirectory(), "landlock_helper.py");
}

let ensured: Promise<string> | null = null;

export function ensureHelperFile(): Promise<string> {
	// The file is immutable, so one write per process is enough; concurrent
	// callers share the same promise.
	if (ensured === null) ensured = writeHelper();
	return ensured;
}

async function writeHelper(): Promise<string> {
	const dir = helperDirectory();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const file = helperFilePath();
	writeFileSync(file, LANDLOCK_HELPER_SOURCE, { mode: 0o600 });
	chmodSync(file, 0o600);
	return file;
}

export function landlockArgv(input: LandlockArgvInput): SandboxExec {
	const env: Record<string, string> = {
		LL_WRITABLE: input.writableRoots.join(":"),
	};
	if (input.network) env.LL_NETWORK = "1";
	return {
		argv: [input.python, helperFilePath(), "/bin/sh", "-c", input.command],
		env,
	};
}
