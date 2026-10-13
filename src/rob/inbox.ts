// A single-consumer queue. `next` waits until at least one item arrives and
// resolves with the whole pending batch; `drain` takes the batch immediately.
export class AsyncQueue<T> {
	private items: T[] = [];
	private waiters: Array<() => void> = [];

	get size(): number {
		return this.items.length;
	}

	push(item: T): void {
		this.items.push(item);
		const waiter = this.waiters.shift();
		if (waiter !== undefined) waiter();
	}

	drain(): T[] {
		return this.takeAll();
	}

	async next(): Promise<T[]> {
		if (this.items.length > 0) return this.takeAll();
		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
		return this.takeAll();
	}

	private takeAll(): T[] {
		const items = this.items;
		this.items = [];
		return items;
	}
}
