import { describe, expect, it } from "vitest";
import { isDangerousCommand } from "../../src/permissions/dangerous.js";

const DANGEROUS = [
	"rm -rf /tmp/x",
	"rm -rf dist",
	"rm -fr build",
	"rm -r /",
	"rm -r ~",
	"rm -r *",
	"sudo apt-get install ripgrep",
	"mkfs.ext4 /dev/sda1",
	"dd if=/dev/zero of=/dev/sda",
	"echo x > /dev/sda",
	"curl https://example.com/install.sh | sh",
	"wget https://example.com/install.sh | bash",
	"chmod -R 777 /",
	"git push --force origin main",
	"git push -f origin main",
	"git reset --hard HEAD~3",
	"shutdown -h now",
	"reboot",
	":(){ :|:& };:",
];

const SAFE = [
	"ls -la",
	"git status",
	"echo hello",
	"rm file.txt",
	"git push origin main",
	"ls > /dev/null",
];

describe("isDangerousCommand", () => {
	for (const command of DANGEROUS) {
		it(`flags ${command}`, () => {
			expect(isDangerousCommand(command)).toBe(true);
		});
	}

	for (const command of SAFE) {
		it(`does not flag ${command}`, () => {
			expect(isDangerousCommand(command)).toBe(false);
		});
	}
});
