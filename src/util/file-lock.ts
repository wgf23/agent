import path from "node:path";

const locks = new Map<string, Promise<void>>();

// Serializes work on one resolved path while letting different paths run in
// parallel. A caller chains behind the previous holder's tail and releases in a
// finally, so a rejected or aborted call never leaves the path locked.
export async function withFileLock<T>(
	absolutePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const key = path.resolve(absolutePath);
	const previous = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => held);
	locks.set(key, tail);

	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (locks.get(key) === tail) locks.delete(key);
	}
}
