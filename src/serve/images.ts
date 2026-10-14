import type { ImagePart } from "../providers/types.js";
import {
	ALLOWED_IMAGE_MEDIA_TYPES,
	base64ByteLength,
	isAllowedMediaType,
	MAX_IMAGE_BYTES,
	MAX_IMAGES_PER_MESSAGE,
	MAX_TOTAL_IMAGE_BYTES,
} from "../util/image.js";

export type ImagesResult =
	| { ok: true; images: ImagePart[] }
	| { ok: false; error: string };

// The route's own body limit: the largest send the caps below accept (20 MiB
// of base64) plus room for the text and the JSON envelope. Fastify refuses
// anything bigger with a 413 before the handler runs, so this is the backstop
// behind the caps, not the cap itself.
export const MAX_SEND_BODY_BYTES = MAX_TOTAL_IMAGE_BYTES + 1024 * 1024;

// Validates the `images` field of a send body against the same caps the CLI
// and TUI enforce on a file path: an allowed media type, 8 MiB per image, 8
// images per message, and 20 MiB of base64 in total. Absent means no
// attachments. The error names the reason, so the route can answer 400 with it
// and a hub can report it as an error event.
export function parseImages(value: unknown): ImagesResult {
	if (value === undefined || value === null) return { ok: true, images: [] };
	if (!Array.isArray(value)) {
		return { ok: false, error: "expected images: a list of {mediaType, data}" };
	}
	if (value.length > MAX_IMAGES_PER_MESSAGE) {
		return {
			ok: false,
			error: `Too many images: ${value.length} (limit ${MAX_IMAGES_PER_MESSAGE})`,
		};
	}

	const images: ImagePart[] = [];
	let totalBytes = 0;
	for (const entry of value) {
		const part = toImagePart(entry);
		if (!part.ok) return part;
		totalBytes += part.image.data.length;
		if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
			return { ok: false, error: "Images exceed the 20 MiB per-message limit" };
		}
		images.push(part.image);
	}
	return { ok: true, images };
}

type ParsedPart = { ok: true; image: ImagePart } | { ok: false; error: string };

function toImagePart(entry: unknown): ParsedPart {
	if (typeof entry !== "object" || entry === null) {
		return { ok: false, error: "expected an image part: {mediaType, data}" };
	}
	const { mediaType, data, type } = entry as {
		mediaType?: unknown;
		data?: unknown;
		type?: unknown;
	};
	if (typeof mediaType !== "string" || typeof data !== "string") {
		return { ok: false, error: "expected an image part: {mediaType, data}" };
	}
	if (type !== undefined && type !== "image") {
		return { ok: false, error: `Unsupported image part type: ${String(type)}` };
	}
	if (!isAllowedMediaType(mediaType)) {
		return {
			ok: false,
			error: `Unsupported image type "${mediaType}": allowed types are ${ALLOWED_IMAGE_MEDIA_TYPES.join(", ")}`,
		};
	}
	const bytes = base64ByteLength(data);
	if (bytes > MAX_IMAGE_BYTES) {
		return {
			ok: false,
			error: `Image exceeds the 8 MiB limit: ${mediaType} (${bytes} bytes)`,
		};
	}
	return { ok: true, image: { type: "image", mediaType, data } };
}
