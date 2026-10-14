// The approval deadline's arithmetic, kept out of the component so a node
// test can pin it without a DOM: the modal only renders what these return.

// Whole seconds left, rounded up, so a deadline that has just passed reads 0
// instead of a negative count.
export function remainingSeconds(expiresAt: number, now: number): number {
	return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

// Minutes and zero-padded seconds: "4:07", "0:09".
export function formatCountdown(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}

// The warning color kicks in this long before the deadline, which is the last
// moment a user can still answer without racing the server's timer.
export const WARN_BEFORE_MS = 30_000;

export function isUrgent(expiresAt: number, now: number): boolean {
	return expiresAt - now <= WARN_BEFORE_MS;
}
