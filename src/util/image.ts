import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ImagePart } from "../providers/types.js";
import { errorMessage } from "./errors.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 8;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

export function mediaTypeForExtension(extension: string): string | undefined {
	return MEDIA_TYPES[extension.toLowerCase()];
}

// The same set readImage derives from a file extension, for a payload that
// arrives already encoded (a browser upload has no path to inspect).
export const ALLOWED_IMAGE_MEDIA_TYPES: readonly string[] = [
	...new Set(Object.values(MEDIA_TYPES)),
];

export function isAllowedMediaType(mediaType: string): boolean {
	return ALLOWED_IMAGE_MEDIA_TYPES.includes(mediaType);
}

// The bytes a base64 payload decodes to. A size cap has to work on a payload
// that never touched the disk, and the padding must come off so the cap reads
// as the file size the CLI enforces.
export function base64ByteLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export type ReadImageResult =
	| { ok: true; image: ImagePart }
	| { ok: false; error: string };

export async function readImage(filePath: string): Promise<ReadImageResult> {
	const extension = path.extname(filePath).toLowerCase();
	const mediaType = MEDIA_TYPES[extension];
	if (mediaType === undefined) {
		return {
			ok: false,
			error: `Unsupported image extension "${extension === "" ? "(none)" : extension}": ${filePath}`,
		};
	}

	try {
		const size = (await stat(filePath)).size;
		if (size > MAX_IMAGE_BYTES) {
			return {
				ok: false,
				error: `Image file exceeds the 8 MiB limit: ${filePath}`,
			};
		}
	} catch (error) {
		if (isEnoent(error)) {
			return { ok: false, error: `Image file not found: ${filePath}` };
		}
		return {
			ok: false,
			error: `Failed to read ${filePath}: ${errorMessage(error)}`,
		};
	}

	let data: Buffer;
	try {
		data = await readFile(filePath);
	} catch (error) {
		return {
			ok: false,
			error: `Failed to read ${filePath}: ${errorMessage(error)}`,
		};
	}

	return {
		ok: true,
		image: { type: "image", mediaType, data: data.toString("base64") },
	};
}

export type ReadImagesResult =
	| { ok: true; images: ImagePart[] }
	| { ok: false; error: string };

// Reads and caps a message's attachments. The count cap bounds how many images
// the session re-sends on every later turn, and the byte cap bounds the base64
// that gets persisted and replayed.
export async function readImages(
	filePaths: string[],
): Promise<ReadImagesResult> {
	if (filePaths.length > MAX_IMAGES_PER_MESSAGE) {
		return {
			ok: false,
			error: `Too many images: ${filePaths.length} (limit ${MAX_IMAGES_PER_MESSAGE})`,
		};
	}
	const images: ImagePart[] = [];
	let totalBytes = 0;
	for (const filePath of filePaths) {
		const result = await readImage(filePath);
		if (!result.ok) return result;
		totalBytes += result.image.data.length;
		if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
			return {
				ok: false,
				error: "Images exceed the 20 MiB per-message limit",
			};
		}
		images.push(result.image);
	}
	return { ok: true, images };
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
