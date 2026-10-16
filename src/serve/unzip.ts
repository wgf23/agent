import { inflateRawSync } from "node:zlib";

// A minimal, read-only ZIP reader for the OOXML office containers (docx, xlsx,
// pptx), which are zip archives of XML. It uses node:zlib only, so no parser
// dependency is added. The source buffer is read in full by the caller, which
// caps its size first; every inflate is bounded by `maxOutputLength`, so a zip
// bomb cannot expand past the caller's byte cap.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const EOCD_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

// A container that is not a non-zip64 archive of storable or deflated members.
export class ZipReadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipReadError";
	}
}

// One member as the central directory records it. The local header repeats the
// name and extra-field lengths needed to find the data, so only the offset and
// sizes are kept here.
interface Member {
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localOffset: number;
}

export class ZipArchive {
	private constructor(
		private readonly buffer: Buffer,
		private readonly members: Map<string, Member>,
	) {}

	// Parses the central directory. A zip64 archive (an entry or count at its
	// 32-bit sentinel) is refused rather than misread, and a directory member is
	// dropped because it has no bytes to read.
	static open(buffer: Buffer): ZipArchive {
		const eocd = findEndRecord(buffer);
		const count = buffer.readUInt16LE(eocd + 10);
		const centralOffset = buffer.readUInt32LE(eocd + 16);
		if (count === UINT16_MAX || centralOffset === UINT32_MAX) {
			throw new ZipReadError("zip64 archives are not supported");
		}

		const members = new Map<string, Member>();
		let pos = centralOffset;
		for (let index = 0; index < count; index += 1) {
			if (
				pos + 46 > buffer.length ||
				buffer.readUInt32LE(pos) !== CENTRAL_SIGNATURE
			) {
				throw new ZipReadError("malformed zip central directory");
			}
			const method = buffer.readUInt16LE(pos + 10);
			const compressedSize = buffer.readUInt32LE(pos + 20);
			const uncompressedSize = buffer.readUInt32LE(pos + 24);
			const nameLength = buffer.readUInt16LE(pos + 28);
			const extraLength = buffer.readUInt16LE(pos + 30);
			const commentLength = buffer.readUInt16LE(pos + 32);
			const localOffset = buffer.readUInt32LE(pos + 42);
			const name = buffer.toString("utf8", pos + 46, pos + 46 + nameLength);
			if (
				compressedSize === UINT32_MAX ||
				uncompressedSize === UINT32_MAX ||
				localOffset === UINT32_MAX
			) {
				throw new ZipReadError("zip64 entries are not supported");
			}
			if (!name.endsWith("/")) {
				members.set(name, {
					method,
					compressedSize,
					uncompressedSize,
					localOffset,
				});
			}
			pos += 46 + nameLength + extraLength + commentLength;
		}
		return new ZipArchive(buffer, members);
	}

	names(): string[] {
		return [...this.members.keys()];
	}

	// Reads one member into memory, bounded by `maxBytes`. A missing name is
	// undefined so a caller can treat an optional part as absent; a member that
	// declares or inflates past the cap throws, so a bomb is refused, not read.
	read(name: string, maxBytes: number): Buffer | undefined {
		const member = this.members.get(name);
		if (member === undefined) return undefined;
		if (member.uncompressedSize > maxBytes) {
			throw new ZipReadError(`entry is too large: ${name}`);
		}
		const local = member.localOffset;
		if (
			local + 30 > this.buffer.length ||
			this.buffer.readUInt32LE(local) !== LOCAL_SIGNATURE
		) {
			throw new ZipReadError(`malformed zip entry: ${name}`);
		}
		const nameLength = this.buffer.readUInt16LE(local + 26);
		const extraLength = this.buffer.readUInt16LE(local + 28);
		const start = local + 30 + nameLength + extraLength;
		const end = start + member.compressedSize;
		if (end > this.buffer.length) {
			throw new ZipReadError(`truncated zip entry: ${name}`);
		}
		const data = this.buffer.subarray(start, end);
		if (member.method === METHOD_STORE) return Buffer.from(data);
		if (member.method === METHOD_DEFLATE) {
			try {
				return inflateRawSync(data, { maxOutputLength: maxBytes });
			} catch (error) {
				throw new ZipReadError(`cannot inflate ${name}: ${errorText(error)}`);
			}
		}
		throw new ZipReadError(`unsupported compression method in ${name}`);
	}
}

// The end record sits after the central directory, so it is found by scanning
// back across the optional comment (at most 64 KiB).
function findEndRecord(buffer: Buffer): number {
	const earliest = Math.max(
		0,
		buffer.length - EOCD_LENGTH - MAX_COMMENT_LENGTH,
	);
	for (let pos = buffer.length - EOCD_LENGTH; pos >= earliest; pos -= 1) {
		if (buffer.readUInt32LE(pos) === EOCD_SIGNATURE) return pos;
	}
	throw new ZipReadError("not a zip archive");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
