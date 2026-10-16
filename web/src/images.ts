import type { ImagePart } from "./protocol";

// Mirrors src/util/image.ts so the composer refuses a file the server would
// reject, without a round trip. The counts and caps are the CLI's.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 8;

// The extensions the CLI accepts, keyed by extension. jpg/jpeg and png/webp
// share a media type, so the picker offers the type the provider receives.
const MEDIA_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};

const ACCEPT = "image/png,image/jpeg,image/webp";

export type PickedImage = {
	id: string;
	name: string;
	mediaType: string;
	data: string;
};

export type Rejection = { ok: false; error: string };

export type PickResult = { ok: true; image: PickedImage } | Rejection;

// The Chinese message the composer shows next to the chips; the same wording
// for every rejection so the user learns one rule, not five.
function formatBytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// Validates the file before it is read, so an over-cap or unsupported
// attachment never costs a multi-megabyte read.
export function validateImageFile(file: File): Rejection | null {
	const extension = extensionOf(file.name);
	const mediaType = MEDIA_TYPES[extension];
	if (mediaType === undefined) {
		return {
			ok: false,
			error: `不支持的图片格式：${file.name}（仅支持 png、jpg、jpeg、webp）`,
		};
	}
	if (file.size > MAX_IMAGE_BYTES) {
		return {
			ok: false,
			error: `图片超过 ${formatBytes(MAX_IMAGE_BYTES)} 上限：${file.name}`,
		};
	}
	return null;
}

export function acceptAttribute(): string {
	return ACCEPT;
}

// Reads the file and encodes it the way the provider consumes it: a base64
// payload plus its media type, no data-URL prefix. The extension decides the
// type rather than file.type, because a browser-reported type is empty or
// wrong often enough to matter.
export async function readImageFile(
	file: File,
	id: string,
): Promise<PickResult> {
	const rejected = validateImageFile(file);
	if (rejected !== null) return rejected;
	const mediaType = MEDIA_TYPES[extensionOf(file.name)];
	const buffer = await file.arrayBuffer();
	return {
		ok: true,
		image: { id, name: file.name, mediaType, data: toBase64(buffer) },
	};
}

export function toImagePart(image: PickedImage): ImagePart {
	return { type: "image", mediaType: image.mediaType, data: image.data };
}

export function fitsMessage(count: number): Rejection | null {
	if (count > MAX_IMAGES_PER_MESSAGE) {
		return {
			ok: false,
			error: `一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`,
		};
	}
	return null;
}

// Base64 without blowing the argument limit on a large image: btoa takes a
// string, and String.fromCharCode over a whole buffer is a stack overflow.
export function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const CHUNK = 0x8000;
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}
	return btoa(binary);
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot === -1) return "";
	return name.slice(dot).toLowerCase();
}
