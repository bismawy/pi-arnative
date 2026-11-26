/**
 * Active session duration tracking and duration formatting.
 *
 * `ActiveClock` stores its snapshot in `RuntimeState` so `/reload` keeps accumulated
 * active time without resetting a running session.
 */
import { getRuntime } from "./runtime.ts";

export const IDLE_PAUSE_MS = 30_000;

/**
 * Tracks active session duration, freezing after inactivity periods.
 * State is stored on RuntimeState to survive module reloads.
 */
export class ActiveClock {
	active: number;
	runStarted: number;
	lastSeen: number;
	readonly pauseMs: number;

	constructor(startedAt: number, pauseMs: number = IDLE_PAUSE_MS) {
		const saved = getRuntime().activeClock;
		this.pauseMs = pauseMs;
		this.active = typeof saved?.active === "number" ? saved.active : 0;
		this.runStarted = typeof saved?.runStarted === "number" ? saved.runStarted : startedAt;
		this.lastSeen = typeof saved?.lastSeen === "number" ? saved.lastSeen : startedAt;
	}

	/** Committed runs plus the live one, the live part clamped at `lastSeen + pauseMs`. */
	total(now: number = Date.now()): number {
		return this.active + Math.max(0, Math.min(now, this.lastSeen + this.pauseMs) - this.runStarted);
	}

	/** Activity: commits a run left longer than `pauseMs`, else just moves `lastSeen`. */
	tick(now: number = Date.now()): void {
		if (now - this.lastSeen > this.pauseMs) {
			this.active = this.total(now);
			this.runStarted = now;
		}
		this.lastSeen = now;
		getRuntime().activeClock = {
			active: this.active,
			runStarted: this.runStarted,
			lastSeen: this.lastSeen,
		};
	}

	idle(now: number = Date.now()): boolean {
		return now - this.lastSeen > this.pauseMs;
	}
}

/** Sums active duration from recorded session entries up to pause threshold. */
export function seedActiveMs(entries: readonly unknown[], pauseMs: number = IDLE_PAUSE_MS, now: number = Date.now()): number {
	const times: number[] = [];
	for (const entry of entries) {
		const ts = (entry as { timestamp?: string } | null)?.timestamp;
		const parsed = ts ? Date.parse(ts) : NaN;
		if (Number.isFinite(parsed) && parsed <= now) times.push(parsed);
	}
	times.sort((a, b) => a - b);
	let ms = 0;
	for (let i = 1; i < times.length; i++) {
		const gap = times[i]! - times[i - 1]!;
		if (gap > 0 && gap <= pauseMs) ms += gap;
	}
	return ms;
}

export function resolveSessionStartMs(reason: string, headerTimestamp: string | undefined, now: number): number {
	if (reason === "reload") return now;
	const parsed = headerTimestamp ? Date.parse(headerTimestamp) : NaN;
	return Number.isFinite(parsed) && parsed > 0 && parsed <= now ? parsed : now;
}

export function formatDuration(ms: number): string {
	// Sub-second renders as "-" to avoid a "0s" flash on fresh session.
	if (!ms || ms < 1000) return "-";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/** Pointer motion and terminal focus reports are not user activity. */
export function isPointerOrFocusInput(data: string): boolean {
	return data.startsWith("\x1b[<") || data.startsWith("\x1b[M") || data === "\x1b[I" || data === "\x1b[O";
}
