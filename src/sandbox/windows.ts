import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The Job Object must be created and the child assigned from PowerShell, so a
// helper script does both and then waits for the child. The source is embedded
// rather than shipped as an asset so tsup bundles it into dist/index.js. It
// mirrors src/sandbox/windows-helper.ps1, which is the canonical copy a tester
// can run by hand on Windows.
const WINDOWS_HELPER_SOURCE = `param(
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [Parameter(Mandatory = $true)]
    [string]$Cwd
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class SandboxJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInformationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInformation,
        uint cbJobObjectInformationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    public static uint SetLimits(IntPtr hJob, uint activeProcessLimit)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.BasicLimitInformation.ActiveProcessLimit = activeProcessLimit;
        uint length = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, ref info, length))
        {
            return (uint)Marshal.GetLastWin32Error();
        }
        return 0;
    }
}
"@

function Fail {
    param([string]$Message)
    [Console]::Error.WriteLine("windows-helper: " + $Message)
    exit 126
}

$ActiveProcessLimit = 64
$TimeoutMs = 60000

$job = [SandboxJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) {
    Fail ("CreateJobObject failed, win32 error {0}" -f [Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

$err = [SandboxJob]::SetLimits($job, $ActiveProcessLimit)
if ($err -ne 0) {
    [SandboxJob]::CloseHandle($job) | Out-Null
    Fail ("SetInformationJobObject failed, win32 error {0}" -f $err)
}

$comSpec = $env:ComSpec
if ([string]::IsNullOrEmpty($comSpec)) { $comSpec = "cmd.exe" }

# cmd.exe corrupts a command that contains quotes or a trailing backslash when
# passed inline, so write the command to a temp .cmd file and run that instead.
$cmdFile = [System.IO.Path]::Combine(
    [System.IO.Path]::GetTempPath(),
    ("my-agent-" + [System.Guid]::NewGuid().ToString("N") + ".cmd"))
[System.IO.File]::WriteAllText($cmdFile, $Command + [Environment]::NewLine)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $comSpec
$psi.Arguments = '/d /s /c ""' + $cmdFile + '""'
$psi.WorkingDirectory = $Cwd
$psi.UseShellExecute = $false

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $psi
$process.Start() | Out-Null

if (-not [SandboxJob]::AssignProcessToJobObject($job, $process.Handle)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    try { $process.Kill() } catch { }
    [SandboxJob]::CloseHandle($job) | Out-Null
    Remove-Item -LiteralPath $cmdFile -ErrorAction SilentlyContinue
    Fail ("AssignProcessToJobObject failed, win32 error {0}" -f $err)
}

if (-not $process.WaitForExit($TimeoutMs)) {
    # Closing the job handle kills every process in the tree; kill the root too
    # in case it has not been assigned to the job yet.
    [SandboxJob]::CloseHandle($job) | Out-Null
    try { $process.Kill() } catch { }
    Remove-Item -LiteralPath $cmdFile -ErrorAction SilentlyContinue
    Fail ("command did not exit within $TimeoutMs ms")
}

$code = $process.ExitCode

[SandboxJob]::CloseHandle($job) | Out-Null
Remove-Item -LiteralPath $cmdFile -ErrorAction SilentlyContinue
exit $code
`;

export interface SandboxExec {
	argv: string[];
	env: Record<string, string>;
}

export interface WindowsArgvInput {
	command: string;
	pwsh: string;
	workspaceRoot: string;
}

export function windowsHelperDirectory(): string {
	// Windows is the only platform this backend runs on and it has no getuid,
	// so the directory name falls back to uid 0 like the Landlock helper.
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return path.join(os.tmpdir(), `my-agent-sandbox-${uid}`);
}

export function windowsHelperPath(): string {
	return path.join(windowsHelperDirectory(), "windows-helper.ps1");
}

let ensured: Promise<string> | null = null;

export function ensureWindowsHelperFile(): Promise<string> {
	// The file is immutable, so one write per process is enough; concurrent
	// callers share the same promise.
	if (ensured === null) ensured = writeHelper();
	return ensured;
}

async function writeHelper(): Promise<string> {
	const dir = windowsHelperDirectory();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const file = windowsHelperPath();
	writeFileSync(file, WINDOWS_HELPER_SOURCE, { mode: 0o600 });
	chmodSync(file, 0o600);
	return file;
}

export function windowsArgv(input: WindowsArgvInput): SandboxExec {
	return {
		argv: [
			input.pwsh,
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			windowsHelperPath(),
			"-Command",
			input.command,
			"-Cwd",
			input.workspaceRoot,
		],
		env: {},
	};
}
