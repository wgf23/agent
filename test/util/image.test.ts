import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_IMAGES_PER_MESSAGE, readImages } from "../../src/util/image.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "image-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("readImages", () => {
	it("rejects more than the per-message image cap", async () => {
		const paths = Array.from(
			{ length: MAX_IMAGES_PER_MESSAGE + 1 },
			(_, index) => path.join(dir, `img${index}.png`),
		);
		for (const filePath of paths) {
			await writeFile(filePath, "x", "utf8");
		}

		const result = await readImages(paths);

		expect(result).toEqual({
			ok: false,
			error: `Too many images: ${MAX_IMAGES_PER_MESSAGE + 1} (limit ${MAX_IMAGES_PER_MESSAGE})`,
		});
	});

	it("rejects when the total base64 exceeds the per-message cap", async () => {
		const paths: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			const filePath = path.join(dir, `big${index}.png`);
			await writeFile(filePath, Buffer.alloc(7 * 1024 * 1024, 65), "utf8");
			paths.push(filePath);
		}

		const result = await readImages(paths);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("20 MiB");
	});

	it("reads a batch within the caps", async () => {
		const first = path.join(dir, "a.png");
		const second = path.join(dir, "b.jpg");
		await writeFile(first, "hello", "utf8");
		await writeFile(second, "world", "utf8");

		const result = await readImages([first, second]);

		expect(result).toEqual({
			ok: true,
			images: [
				{ type: "image", mediaType: "image/png", data: "aGVsbG8=" },
				{ type: "image", mediaType: "image/jpeg", data: "d29ybGQ=" },
			],
		});
	});
});
