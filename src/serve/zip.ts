import { createReadStream, type Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { crc32, createDeflateRaw } from "node:zlib";

// A streaming ZIP writer built on node:zlib only. One entry per regular file
// and one zero-length entry per subdirectory, written depth-first, with the
// crc32 and both sizes streamed through a data descriptor so a large file never
// lands in memory. The central directory and the end record are written after
// the walk. Names are posix and relative to the archived directory, so
// unzipping yields that directory's contents.

// The 32-bit fields of a non-zip64 archive; a value at or above 4 GiB cannot be
// represented. Zip64 is out of scope, so that is a named error rather than a
// silently truncated archive.
const MAX_ZIP32 = 0xffffffff;

const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

// Bit 3 says the crc and sizes ride in a data descriptor after the data; bit 11
// says the name is UTF-8, so a non-ASCII path round-trips.
const FLAGS = 0x0008 | 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// The DOS directory attribute bit unzip reads in the external attributes.
const DIRECTORY_ATTR = 0x10;

// A path the archive cannot carry: an entry or the whole archive reached 4 GiB,
// which the 32-bit fields cannot express without zip64.
export class ZipTooLargeError extends Error {
	constructor(entry: string) {
		super(`zip64 is not supported: ${entry} is at least 4 GiB`);
		this.name = "ZipTooLargeError";
	}
}

// One recorded entry for the central directory: the name bytes, the DOS
// timestamp, and the crc/sizes/offset computed while the entry streamed.
interface CentralEntry {
	name: Buffer;
	time: number;
	date: number;
	method: number;
	crc: number;
	compressed: number;
	uncompressed: number;
	localOffset: number;
	directory: boolean;
}

// Streams the contents of `absDir` (already resolved inside `workspaceRoot`) as
// a zip. A symlink is followed only when its real target stays inside the
// workspace root; a link out of the root, a broken link, and a non-file,
// non-directory target are skipped rather than archived.
export function createZipStream(
	workspaceRoot: string,
	absDir: string,
): Readable {
	return Readable.from(zipEntries(workspaceRoot, absDir), {
		objectMode: false,
	});
}

async function* zipEntries(
	workspaceRoot: string,
	absDir: string,
): AsyncGenerator<Buffer> {
	const root = await realpath(workspaceRoot);
	const dir = path.resolve(absDir);
	const central: CentralEntry[] = [];
	// The canonical path of every directory already emitted keeps a symlink
	// cycle from recursing forever.
	const visited = new Set<string>([await realpath(dir)]);
	let offset = 0;

	// Emits one directory entry: a zero-length stored entry whose name ends in
	// "/", followed by its data descriptor, exactly as a file entry would.
	async function* emitDirectory(
		rel: string,
		mtime: Date,
	): AsyncGenerator<Buffer> {
		const name = Buffer.from(`${rel}/`, "utf8");
		const { time, date } = dosDateTime(mtime);
		const localOffset = offset;
		const header = localHeader(name, METHOD_STORE, time, date);
		offset += header.length;
		yield header;
		const descriptor = dataDescriptor(0, 0, 0);
		offset += descriptor.length;
		yield descriptor;
		central.push({
			name,
			time,
			date,
			method: METHOD_STORE,
			crc: 0,
			compressed: 0,
			uncompressed: 0,
			localOffset,
			directory: true,
		});
	}

	// Emits one regular file entry: the local header, the deflated bytes, then
	// the data descriptor carrying the crc and sizes computed here. The crc is
	// a running seed over the uncompressed chunks, so the source is read once.
	async function* emitFile(
		rel: string,
		absFile: string,
		info: Stats,
	): AsyncGenerator<Buffer> {
		const name = Buffer.from(rel, "utf8");
		const { time, date } = dosDateTime(info.mtime);
		const localOffset = offset;
		const header = localHeader(name, METHOD_DEFLATE, time, date);
		offset += header.length;
		yield header;

		let crc = 0;
		let uncompressed = 0;
		let compressed = 0;
		for await (const chunk of deflateFile(absFile, (raw) => {
			crc = crc32(raw, crc);
			uncompressed += raw.length;
		})) {
			compressed += chunk.length;
			assertZip32(compressed, rel);
			assertZip32(uncompressed, rel);
			offset += chunk.length;
			assertZip32(offset, rel);
			yield chunk;
		}

		const descriptor = dataDescriptor(crc, compressed, uncompressed);
		offset += descriptor.length;
		yield descriptor;
		central.push({
			name,
			time,
			date,
			method: METHOD_DEFLATE,
			crc,
			compressed,
			uncompressed,
			localOffset,
			directory: false,
		});
	}

	async function* walk(current: string, rel: string): AsyncGenerator<Buffer> {
		const dirents = await readdir(current, { withFileTypes: true });
		// Sorted so an archive is deterministic run to run.
		dirents.sort((a, b) => a.name.localeCompare(b.name));
		for (const dirent of dirents) {
			const full = path.join(current, dirent.name);
			const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;

			if (dirent.isSymbolicLink()) {
				// A link is followed only inside the workspace root; the real
				// target decides both the boundary and the kind, and a broken
				// link (realpath throws) is skipped.
				let target: string;
				try {
					target = await realpath(full);
				} catch {
					continue;
				}
				if (!isInside(root, target)) continue;
				let info: Stats;
				try {
					info = await stat(target);
				} catch {
					continue;
				}
				if (info.isDirectory()) {
					if (visited.has(target)) continue;
					visited.add(target);
					yield* emitDirectory(childRel, info.mtime);
					yield* walk(target, childRel);
				} else if (info.isFile()) {
					yield* emitFile(childRel, target, info);
				}
				continue;
			}

			if (dirent.isDirectory()) {
				const target = await realpath(full);
				if (!isInside(root, target) || visited.has(target)) continue;
				visited.add(target);
				const info = await stat(full);
				yield* emitDirectory(childRel, info.mtime);
				yield* walk(full, childRel);
				continue;
			}

			if (dirent.isFile()) {
				// lstat is enough here: a symlink was handled above, so this is
				// a regular file and stat cannot disagree.
				yield* emitFile(childRel, full, await lstat(full));
			}
			// A fifo, socket, or device has no bytes to archive and is skipped.
		}
	}

	yield* walk(dir, "");

	const centralOffset = offset;
	let centralSize = 0;
	for (const entry of central) {
		const record = centralHeader(entry);
		offset += record.length;
		centralSize += record.length;
		yield record;
	}
	assertZip32(centralOffset, "central directory offset");
	assertZip32(centralSize, "central directory size");
	yield endRecord(central.length, centralSize, centralOffset);
}

// Reads one file through createDeflateRaw and yields the compressed bytes. The
// source chunks pass a counting transform first so `onSource` sees the
// uncompressed bytes (for the running crc32 and the uncompressed size) while
// only the deflated output is yielded. pipe() does not forward a source error
// to the compressor, so the read failure is propagated explicitly; the finally
// destroys every stage when the consumer stops early.
async function* deflateFile(
	absFile: string,
	onSource: (chunk: Buffer) => void,
): AsyncGenerator<Buffer> {
	const source = createReadStream(absFile);
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			onSource(chunk);
			callback(null, chunk);
		},
	});
	const deflate = createDeflateRaw();
	source.on("error", (error) => deflate.destroy(error));
	source.pipe(counter).pipe(deflate);
	try {
		for await (const chunk of deflate) {
			yield chunk as Buffer;
		}
	} finally {
		source.destroy();
		counter.destroy();
		deflate.destroy();
	}
}

// The fixed local file header plus the UTF-8 name. The crc and both sizes are
// zero here because the data descriptor after the data carries the real ones.
function localHeader(
	name: Buffer,
	method: number,
	time: number,
	date: number,
): Buffer {
	const fixed = Buffer.alloc(30);
	fixed.writeUInt32LE(LOCAL_SIGNATURE, 0);
	fixed.writeUInt16LE(20, 4); // version needed to extract
	fixed.writeUInt16LE(FLAGS, 6);
	fixed.writeUInt16LE(method, 8);
	fixed.writeUInt16LE(time, 10);
	fixed.writeUInt16LE(date, 12);
	fixed.writeUInt32LE(0, 14); // crc-32
	fixed.writeUInt32LE(0, 18); // compressed size
	fixed.writeUInt32LE(0, 22); // uncompressed size
	fixed.writeUInt16LE(name.length, 26);
	fixed.writeUInt16LE(0, 28); // no extra field
	return Buffer.concat([fixed, name]);
}

// The 16-byte data descriptor: signature plus crc-32, compressed size, and
// uncompressed size, each 32-bit little-endian.
function dataDescriptor(
	crc: number,
	compressed: number,
	uncompressed: number,
): Buffer {
	const buffer = Buffer.alloc(16);
	buffer.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
	buffer.writeUInt32LE(crc >>> 0, 4);
	buffer.writeUInt32LE(compressed, 8);
	buffer.writeUInt32LE(uncompressed, 12);
	return buffer;
}

// One central directory record plus the name. The offset points at the entry's
// local header; a directory carries the 0x10 external-attribute bit so unzip
// creates it as a directory even without the trailing slash.
function centralHeader(entry: CentralEntry): Buffer {
	const fixed = Buffer.alloc(46);
	fixed.writeUInt32LE(CENTRAL_SIGNATURE, 0);
	fixed.writeUInt16LE(20, 4); // version made by
	fixed.writeUInt16LE(20, 6); // version needed to extract
	fixed.writeUInt16LE(FLAGS, 8);
	fixed.writeUInt16LE(entry.method, 10);
	fixed.writeUInt16LE(entry.time, 12);
	fixed.writeUInt16LE(entry.date, 14);
	fixed.writeUInt32LE(entry.crc >>> 0, 16);
	fixed.writeUInt32LE(entry.compressed, 20);
	fixed.writeUInt32LE(entry.uncompressed, 24);
	fixed.writeUInt16LE(entry.name.length, 28);
	fixed.writeUInt16LE(0, 30); // extra field length
	fixed.writeUInt16LE(0, 32); // file comment length
	fixed.writeUInt16LE(0, 34); // disk number start
	fixed.writeUInt16LE(0, 36); // internal file attributes
	fixed.writeUInt32LE(entry.directory ? DIRECTORY_ATTR : 0, 38);
	fixed.writeUInt32LE(entry.localOffset, 42);
	return Buffer.concat([fixed, entry.name]);
}

// The end-of-central-directory record: one disk, the record count, and the
// central directory's size and offset.
function endRecord(
	count: number,
	centralSize: number,
	centralOffset: number,
): Buffer {
	const buffer = Buffer.alloc(22);
	buffer.writeUInt32LE(END_SIGNATURE, 0);
	buffer.writeUInt16LE(0, 4); // number of this disk
	buffer.writeUInt16LE(0, 6); // disk with the central directory
	buffer.writeUInt16LE(count, 8); // records on this disk
	buffer.writeUInt16LE(count, 10); // total records
	buffer.writeUInt32LE(centralSize, 12);
	buffer.writeUInt32LE(centralOffset, 16);
	buffer.writeUInt16LE(0, 20); // comment length
	return buffer;
}

// Converts an mtime to the DOS time/date pair the headers carry. The year is
// clamped to the DOS range, so an mtime outside 1980..2107 cannot roll the
// bit fields into nonsense.
function dosDateTime(mtime: Date): { time: number; date: number } {
	const year = Math.min(2107, Math.max(1980, mtime.getFullYear()));
	const date =
		((year - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate();
	const time =
		(mtime.getHours() << 11) |
		(mtime.getMinutes() << 5) |
		Math.floor(mtime.getSeconds() / 2);
	return { time, date };
}

function assertZip32(value: number, entry: string): void {
	if (value > MAX_ZIP32) throw new ZipTooLargeError(entry);
}

// The same lexical containment resolveInWorkspace uses: a normalized relative
// path that neither climbs out nor is absolute means `target` is inside `root`.
function isInside(root: string, target: string): boolean {
	if (target === root) return true;
	const rel = path.relative(root, target);
	return (
		rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
	);
}
