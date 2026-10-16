import { deflateRawSync } from "node:zlib";

interface Entry {
	name: string;
	data: string;
	// A stored member (method 0) instead of the deflated default.
	store?: boolean;
}

// Builds a minimal zip in memory so an office fixture is reproducible without
// checking a binary in. The crc is left zero because the reader under test
// never validates it. `uncompressed` can overstate the real length, which is
// how a zip-bomb declaration is simulated.
export function buildZip(
	entries: Array<Entry & { uncompressed?: number }>,
): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const raw = Buffer.from(entry.data, "utf8");
		const method = entry.store === true ? 0 : 8;
		const stored = method === 0 ? raw : deflateRawSync(raw);
		const uncompressed = entry.uncompressed ?? raw.length;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(stored.length, 18);
		local.writeUInt32LE(uncompressed, 22);
		local.writeUInt16LE(name.length, 26);
		localParts.push(local, name, stored);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(stored.length, 20);
		central.writeUInt32LE(uncompressed, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centralParts.push(central, name);

		offset += local.length + name.length + stored.length;
	}

	const centralDir = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDir.length, 12);
	end.writeUInt32LE(offset, 16);

	return Buffer.concat([...localParts, centralDir, end]);
}
