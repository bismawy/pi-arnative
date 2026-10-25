/**
 * Auto-compact — keep long sessions light without the manual /compact.
 *
 * Why: pi renders the whole transcript on every frame, so the drag a user feels tracks
 * the ABSOLUTE size of the session, not how full the window is. A 1M-window model gets
 * heavy around 200k tokens (a fifth of its window), while a 128k model can run to
 * nearly 100% and let pi's own threshold compaction handle it safely.
 *
 * Two shapes of control, both off until picked in `/arnative` → Auto-compact:
 * - **Smart** maps the context window through a tier table (≥768k→20%, ≥384k→40%,
 *   ≥192k→80%, smaller→defer to pi core). Every tier lands the trigger near the same
 *   ~200k-token transcript ceiling, and small windows never fire at all — pi's own
 *   `compaction.reserveTokens` compaction stays their safety net.
 * - **A manual token budget** (100k–400k) fires at the same absolute size whatever the
 *   window, for users who want one number.
 *
 * The trigger is `agent_before_settle` (idle, nothing queued) and fires pi's compaction
 * through `ctx.compact()` — the same machinery and summary as /compact, never mid-run.
 * Pi's own `compaction.reserveTokens` threshold, including per-model overrides, is
 * unaffected; whichever fires first wins.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, isMain } from "../lib/check.ts";
import { loadChoice, resetPresetCache, saveChoice } from "../lib/preset-store.ts";

/** Stored exactly as the picker shows them; `Off` disables the trigger entirely. */
export const AUTO_COMPACT_CHOICES = ["Off", "Smart", "100k", "150k", "200k", "300k", "400k"] as const;
export type AutoCompactChoice = (typeof AUTO_COMPACT_CHOICES)[number];
export const DEFAULT_AUTO_COMPACT: AutoCompactChoice = "Off";
const AUTO_COMPACT_KEY = "autoCompact";

/** Smart's tier table, first match wins. `null` defers the window to pi's own
 *  compaction — the "100%" tier, where the current behavior is already safe. */
const SMART_TIERS: ReadonlyArray<{ minWindow: number; percent: number | null }> = [
	{ minWindow: 786432, percent: 20 }, // ≥768k: a 1M window triggers at ~200k tokens
	{ minWindow: 393216, percent: 40 }, // 384k–768k: a 512k window triggers at ~205k
	{ minWindow: 196608, percent: 80 }, // 192k–384k: a 256k window triggers at ~205k
	{ minWindow: 0, percent: null }, // below 192k (128k models): pi core stays in charge
];

/** The Smart percent for a context window, or null when the window defers to pi core. */
export function smartPercent(contextWindow: number): number | null {
	const tier = SMART_TIERS.find((t) => contextWindow >= t.minWindow);
	return tier?.percent ?? null;
}

// Active choice on globalThis so the `/arnative` picker (a second module instance, see
// animations.ts) and this module's event handlers agree without sharing memo caches.
const AUTO_COMPACT_CONFIG_KEY = Symbol.for("pi-arnative.autoCompact");

export function activeAutoCompact(): AutoCompactChoice {
	const stored =
		(globalThis as Record<symbol, unknown>)[AUTO_COMPACT_CONFIG_KEY] ??
		loadChoice(AUTO_COMPACT_KEY, AUTO_COMPACT_CHOICES);
	return AUTO_COMPACT_CHOICES.includes(stored as AutoCompactChoice) ? (stored as AutoCompactChoice) : DEFAULT_AUTO_COMPACT;
}

/** The trigger threshold in context tokens for the given window, or null when the
 *  choice is off or Smart defers this window to pi's own compaction. */
export function activeAutoCompactThreshold(contextWindow: number): number | null {
	const choice = activeAutoCompact();
	if (choice === "Off") return null;
	if (choice === "Smart") {
		const percent = smartPercent(contextWindow);
		return percent === null ? null : Math.round((contextWindow * percent) / 100);
	}
	return Number.parseInt(choice, 10) * 1000;
}

/** Pick a choice and persist it (the `/arnative` → Auto-compact rows call this). */
export function setAutoCompact(choice: AutoCompactChoice): void {
	(globalThis as Record<symbol, unknown>)[AUTO_COMPACT_CONFIG_KEY] = choice;
	saveChoice(AUTO_COMPACT_KEY, choice);
}

/** Session-scoped trigger state. Module-local: only this module's registrar mutates it. */
export interface AutoCompactState {
	/** A compaction this module triggered has not finished yet. */
	inFlight: boolean;
	/** Context tokens at the last trigger; null once usage really dropped under the threshold. */
	lastAttemptTokens: number | null;
	/** The last triggered compaction finished, so its effect on usage is visible. */
	attemptSettled: boolean;
	/** Do not trigger while usage stays below this (failure backoff, anti-flap). */
	blockedUntilTokens: number;
}

export function freshAutoCompactState(): AutoCompactState {
	return { inFlight: false, lastAttemptTokens: null, attemptSettled: false, blockedUntilTokens: 0 };
}

/** How much usage must outgrow a previous attempt before it counts as real growth
 *  (5% of the threshold, at least 5k tokens). */
export function growthMargin(thresholdTokens: number): number {
	return Math.max(5000, Math.round(thresholdTokens * 0.05));
}

/** Pure decision for the settle handler: fire pi's compaction now, or wait. */
export function autoCompactDecision(
	state: AutoCompactState,
	tokens: number | null,
	thresholdTokens: number,
): "compact" | "wait" {
	if (tokens === null || tokens < thresholdTokens) return "wait";
	if (state.inFlight) return "wait";
	if (tokens < state.blockedUntilTokens) return "wait";
	// A finished compaction that still left usage at or above the threshold freed too
	// little: wait for real growth instead of re-summarizing every settle.
	if (state.attemptSettled && state.lastAttemptTokens !== null && tokens < state.lastAttemptTokens + growthMargin(thresholdTokens)) {
		return "wait";
	}
	return "compact";
}

/** Usage dropped back under the threshold (the handler's below-threshold branch).
 *  A shallow dip — still within the growth margin of the last attempt — keeps the
 *  attempt memory, so usage oscillating right at the threshold cannot re-summarize
 *  every turn. A real drop forgets the attempt and re-arms the trigger fully. */
export function rearmAfterDip(state: AutoCompactState, tokens: number, thresholdTokens: number): void {
	if (state.lastAttemptTokens === null || tokens < state.lastAttemptTokens - growthMargin(thresholdTokens)) {
		state.lastAttemptTokens = null;
		state.attemptSettled = false;
		state.blockedUntilTokens = 0;
	}
}

export default function registerAutoCompact(pi: ExtensionAPI): void {
	const state = freshAutoCompactState();

	pi.on("session_start", async () => {
		// Fresh session (or /reload): backoff and attempt state belonged to the previous branch.
		Object.assign(state, freshAutoCompactState());
	});

	pi.on("agent_before_settle", async (_event, ctx) => {
		const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		const window = usage?.contextWindow;
		if (typeof window !== "number" || window <= 0) return;
		const threshold = activeAutoCompactThreshold(window);
		if (threshold === null) return;
		const tokens = usage.tokens ?? null;
		if (tokens === null) return;
		if (tokens < threshold) {
			rearmAfterDip(state, tokens, threshold);
			return;
		}
		if (autoCompactDecision(state, tokens, threshold) !== "compact") return;
		if (typeof ctx.compact !== "function") return; // older host without the API
		state.inFlight = true;
		state.attemptSettled = false;
		state.lastAttemptTokens = tokens;
		state.blockedUntilTokens = tokens + 1; // anti-flap: re-fire only past this attempt
		ctx.compact();
	});

	pi.on("session_compact", async () => {
		// Also fires for pi's own compactions; harmless — the flags only matter after a trigger.
		state.inFlight = false;
		state.attemptSettled = true;
	});

	pi.on("session_compact_failed", async () => {
		if (!state.inFlight) return;
		// A failed (or user-aborted) compaction must not retry-loop at the same usage:
		// wait until usage outgrows the attempt by the growth margin.
		state.inFlight = false;
		state.attemptSettled = true;
		state.blockedUntilTokens = (state.lastAttemptTokens ?? 0) + growthMargin(state.lastAttemptTokens ?? 200000);
	});
}

// Self-check: `node extensions/autocompact.ts`
if (isMain(import.meta.url)) {
	// The real agent dir must not decide pass/fail, and the test must not touch it.
	const fixture = mkdtempSync(join(tmpdir(), "arnative-autocompact-"));
	process.env.PI_CODING_AGENT_DIR = fixture;
	delete (globalThis as Record<symbol, unknown>)[AUTO_COMPACT_CONFIG_KEY];

	// Choice parsing and persistence.
	assert(activeAutoCompact() === "Off", "the default is off");
	assert(activeAutoCompactThreshold(1_048_576) === null, "off reads as no threshold");
	setAutoCompact("200k");
	assert(activeAutoCompactThreshold(131072) === 200000, "a manual budget ignores the window");
	assert(loadChoice(AUTO_COMPACT_KEY, AUTO_COMPACT_CHOICES) === "200k", "the choice survives a restart (read from disk)");

	// Smart's tier table: the field examples land where they were asked to.
	assert(smartPercent(131072) === null, "128k defers to pi core (the 100% tier)");
	assert(smartPercent(196607) === null, "just under the 192k tier edge still defers");
	assert(smartPercent(196608) === 80, "the 192k tier edge takes 80%");
	assert(smartPercent(262144) === 80, "256k takes 80%");
	assert(smartPercent(524288) === 40, "512k takes 40%");
	assert(smartPercent(1048576) === 20, "1M takes 20%");
	setAutoCompact("Smart");
	assert(activeAutoCompactThreshold(1048576) === 209715, "Smart on 1M triggers at ~200k tokens");
	assert(activeAutoCompactThreshold(262144) === 209715, "Smart on 256k triggers at ~205k tokens");
	assert(activeAutoCompactThreshold(131072) === null, "Smart on 128k defers to pi core");
	setAutoCompact("Off");
	assert(activeAutoCompactThreshold(1048576) === null, "switching back to off disables the trigger");

	// Decision table.
	const s = freshAutoCompactState();
	assert(autoCompactDecision(s, null, 200000) === "wait", "no usage estimate: wait");
	assert(autoCompactDecision(s, 199999, 200000) === "wait", "below the threshold: wait");
	assert(autoCompactDecision(s, 200000, 200000) === "compact", "at the threshold with fresh state: compact");
	s.inFlight = true;
	assert(autoCompactDecision(s, 250000, 200000) === "wait", "a compaction is still running: wait");
	s.inFlight = false;
	s.blockedUntilTokens = 260000;
	assert(autoCompactDecision(s, 250000, 200000) === "wait", "below the failure backoff: wait");
	s.blockedUntilTokens = 0;
	s.attemptSettled = true;
	s.lastAttemptTokens = 240000;
	assert(autoCompactDecision(s, 245000, 200000) === "wait", "a settled attempt that freed too little waits for the growth margin");
	assert(autoCompactDecision(s, 250500, 200000) === "compact", "usage outgrew the settled attempt: compact again");

	// Rearm after a dip: shallow keeps the attempt memory, deep forgets it.
	const r = freshAutoCompactState();
	r.lastAttemptTokens = 200000;
	r.attemptSettled = true;
	r.blockedUntilTokens = 200001;
	rearmAfterDip(r, 195000, 200000);
	assert(r.lastAttemptTokens === 200000, "a shallow dip keeps the attempt memory");
	rearmAfterDip(r, 189000, 200000);
	assert(r.lastAttemptTokens === null && r.attemptSettled === false && r.blockedUntilTokens === 0, "a real drop forgets the attempt and re-arms");

	// Registered handlers against a fake pi, driven like a Smart session on a 1M model.
	setAutoCompact("Smart");
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	registerAutoCompact({ on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => void (handlers[name] = fn) } as never);
	const compactCalls: number[] = [];
	const ctxOf = (tokens: number | null, contextWindow = 1_048_576) => ({
		getContextUsage: () => ({ tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 }),
		compact: () => compactCalls.push(tokens ?? -1),
	});

	await handlers.session_start!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(210000));
	assert(compactCalls.length === 1 && compactCalls[0] === 210000, "usage at/above the threshold triggers pi's compaction");
	await handlers.agent_before_settle!({}, ctxOf(215000));
	assert(compactCalls.length === 1, "the anti-flap guard blocks an immediate re-trigger");
	await handlers.session_compact!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(215000));
	assert(compactCalls.length === 1, "a settled attempt that still sits above the threshold waits for growth");
	await handlers.agent_before_settle!({}, ctxOf(222000));
	assert(compactCalls.length === 2 && compactCalls[1] === 222000, "usage outgrowing the attempt compacts again");
	await handlers.session_compact!({}, undefined); // the compaction that made usage drop
	await handlers.agent_before_settle!({}, ctxOf(60000));
	assert(compactCalls.length === 2, "below the threshold nothing fires");
	await handlers.agent_before_settle!({}, ctxOf(210500));
	assert(compactCalls.length === 3 && compactCalls[2] === 210500, "the next crossing starts a fresh cycle");

	// Oscillation at the threshold: one compaction per growth margin, not every turn.
	await handlers.session_compact!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(208000)); // shallow dip under the threshold
	await handlers.agent_before_settle!({}, ctxOf(211000));
	assert(compactCalls.length === 3, "an oscillation at the threshold does not re-summarize every turn");
	await handlers.agent_before_settle!({}, ctxOf(222000));
	assert(compactCalls.length === 4 && compactCalls[3] === 222000, "real growth past the attempt compacts again");

	// A failed compaction backs off; session_start clears the backoff for a fresh session.
	await handlers.session_compact_failed!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(225000));
	assert(compactCalls.length === 4, "after a failure the backoff holds below attempt + margin");
	await handlers.agent_before_settle!({}, ctxOf(234000));
	assert(compactCalls.length === 5, "and gives way once usage outgrows the failed attempt");
	await handlers.session_compact_failed!({}, undefined);
	await handlers.session_start!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(210500));
	assert(compactCalls.length === 6, "a fresh session clears the backoff");

	// The 128k case from the field: Smart defers the whole window to pi's own
	// compaction — no percent, however close to full, ever fires ours.
	await handlers.session_start!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(130000, 131072));
	assert(compactCalls.length === 6, "a 128k window under Smart never triggers: pi core stays in charge");

	// Older hosts: missing ctx APIs must degrade to a no-op, not throw.
	await handlers.agent_before_settle!({}, { getContextUsage: () => undefined });
	assert(compactCalls.length === 6, "no usage estimate: no trigger");
	// Reset inFlight first, so the missing compact() — not a pending compaction — is what stops it.
	await handlers.session_start!({}, undefined);
	await handlers.agent_before_settle!({}, { getContextUsage: () => ({ tokens: 400000, contextWindow: 1_048_576, percent: 40 }) });
	assert(compactCalls.length === 6, "no ctx.compact on the host: no trigger");

	// Restore: the next module load starts from the real agent dir and the stored default.
	rmSync(fixture, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete (globalThis as Record<symbol, unknown>)[AUTO_COMPACT_CONFIG_KEY];
	resetPresetCache();
	console.log("autocompact.ts self-check OK");
}
