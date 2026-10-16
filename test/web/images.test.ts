import { describe, expect, it } from "vitest";
import {
	acceptAttribute,
	fitsMessage,
	MAX_IMAGE_BYTES,
	MAX_IMAGES_PER_MESSAGE,
	readImageFile,
	toBase64,
	toImagePart,
	validateImageFile,
} from "../../web/src/images";

// The composer's file input is a browser object; the validation and the
// encoder behind it are plain functions, so they are pinned here.
function fakeFile(name: string, size: number, type = "image/png"): File {
	const bytes = new Uint8Array(size);
	return {
		name,
		size,
		type,
		arrayBuffer: () => Promise.resolve(bytes.buffer),
	} as unknown as File;
}

describe("validateImageFile", () => {
	it("accepts every extension the CLI accepts", () => {
		for (const name of ["shot.png", "shot.JPG", "shot.jpeg", "shot.webp"]) {
			expect(validateImageFile(fakeFile(name, 1024))).toBeNull();
		}
	});

	it("rejects an unsupported extension naming the file", () => {
		const rejected = validateImageFile(fakeFile("notes.txt", 10, "text/plain"));
		expect(rejected?.ok).toBe(false);
		expect(rejected?.ok === false && rejected.error).toContain("notes.txt");
		expect(rejected?.ok === false && rejected.error).toContain(
			"png、jpg、jpeg、webp",
		);
	});

	it("rejects a file over 8 MiB and accepts one at the cap", () => {
		expect(
			validateImageFile(fakeFile("big.png", MAX_IMAGE_BYTES + 1)),
		).toMatchObject({ ok: false });
		expect(validateImageFile(fakeFile("ok.png", MAX_IMAGE_BYTES))).toBeNull();
	});

	it("refuses a file with no extension", () => {
		expect(validateImageFile(fakeFile("clipboard", 10))).toMatchObject({
			ok: false,
		});
	});
});

describe("readImageFile", () => {
	it("encodes the bytes as base64 beside a media type, with no data-URL prefix", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const result = await readImageFile(
			{
				name: "shot.png",
				size: bytes.length,
				type: "",
				arrayBuffer: () => Promise.resolve(bytes.buffer),
			} as unknown as File,
			"img-1",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.image.mediaType).toBe("image/png");
		expect(result.image.data).toBe(toBase64(bytes.buffer));
		expect(result.image.data).toBe("iVBORw==");
		expect(toImagePart(result.image)).toEqual({
			type: "image",
			mediaType: "image/png",
			data: "iVBORw==",
		});
	});

	it("never reads a file it has already refused", async () => {
		let read = false;
		const result = await readImageFile(
			{
				name: "big.png",
				size: MAX_IMAGE_BYTES + 1,
				type: "image/png",
				arrayBuffer: () => {
					read = true;
					return Promise.resolve(new ArrayBuffer(0));
				},
			} as unknown as File,
			"img-1",
		);
		expect(result.ok).toBe(false);
		expect(read).toBe(false);
	});
});

describe("toBase64", () => {
	it("encodes a payload larger than one chunk", () => {
		const bytes = new Uint8Array(0x8000 * 2 + 7).fill(65);
		const encoded = toBase64(bytes.buffer);
		expect(encoded).toBe(btoa("A".repeat(bytes.length)));
	});
});

describe("message limits", () => {
	it("caps the images in one message", () => {
		expect(fitsMessage(MAX_IMAGES_PER_MESSAGE)).toBeNull();
		expect(
			fitsMessage(MAX_IMAGES_PER_MESSAGE + 1)?.ok === false &&
				fitsMessage(MAX_IMAGES_PER_MESSAGE + 1)?.error,
		).toContain(`${MAX_IMAGES_PER_MESSAGE}`);
	});

	it("offers only the media types the route accepts", () => {
		expect(acceptAttribute()).toBe("image/png,image/jpeg,image/webp");
	});
});
