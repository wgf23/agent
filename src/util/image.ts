import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ImagePart } from "../providers/types.js";
import { errorMessage } from "./errors.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
