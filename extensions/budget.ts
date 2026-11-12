/**
 * Budget guardrail — the only arnative feature that can *stop* spend, and it stops the next
 * turn, not a tool call: blocking a `tool_call` does not stop the spend (the assistant message
 * that issued the call is already billed and the model spends another paid turn reacting to the
 * error result), so the gate is `pi.on("input")` returning `{ action: "handled" }`, which stops
 * the turn before any token is bought.
 *
 * Warn-only by default: `budgetEnforce` ships `"off"`. Over a cap with enforce off the gate
 * notifies once per session and lets the turn through; with enforce on it notifies and returns
 * `handled`. The spend comes from the usage cache's day buckets (`totals.today` / `last30d`,
 * billed plus its catalog-estimated part); the footer band reads it through the 5s memo, the
 * gate forces its own scan so it never decides on a total up to 5s old. Three fail-open rules: an
 * `event.source === "extension"` input is never swallowed, an unknown spend (no day buckets)
 * never blocks, and the whole handler is wrapped in a try/catch that returns `continue` — a
 * throwing `input` handler is worse than no budget. Estimate-only spend (no provider-billed
 * total) can reach `warn` but never `over` in {@link budgetState}: a cap on an unpriced model
 * would enforce $0.
 *
 * The settings live in `config.json` (`budgetDay` / `budgetMonth` amount strings, `""` = unset,
 * `budgetEnforce` `"on"`/`"off"`) and are edited from `/arnative` → **Budget** ({@link openBudget}).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thinkingColorOf } from "../lib/ansi.ts";
import { renderScreen, screenTitle } from "../lib/box.ts";
import { assert, isMain } from "../lib/check.ts";
import { rowText, type ListPickerText, type ListRow } from "../lib/list-picker.ts";
import { matchesBack } from "../lib/shortcuts.ts";
import {
	BUDGET_DAY_KEY,
	BUDGET_ENFORCE_KEY,
	BUDGET_MONTH_KEY,
	loadChoice,
	loadNumber,
	resetPresetCache,
	saveChoice,
} from "../lib/preset-store.ts";
import { collectUsageSummary, resetUsageCache } from "../lib/usage-store.ts";
import { formatCost } from "./usage.ts";

// ---------------------------------------------------------------- settings

/** Accepted cap amounts in dollars; a cap is a positive number in this range. */
export const BUDGET_AMOUNT_RANGE = { min: 0.01, max: 1_000_000 } as const;
/** The fixed cap choices the Budget screen cycles through; `0` is "off" (stored as `""`). */
export const BUDGET_CAPS = [0, 1, 2, 5, 10, 25, 50, 100, 250, 500] as const;

// Active values on globalThis so the `/arnative` picker and this module's event handlers agree
// without sharing memo caches (the same pattern as the footer cost switch).
const BUDGET_DAY_SLOT = Symbol.for("pi-arnative.budgetDay");
const BUDGET_MONTH_SLOT = Symbol.for("pi-arnative.budgetMonth");
const BUDGET_ENFORCE_SLOT = Symbol.for("pi-arnative.budgetEnforce");

export function activeBudgetDay(): number | undefined {
	const stored = (globalThis as Record<symbol, unknown>)[BUDGET_DAY_SLOT] ?? loadNumber(BUDGET_DAY_KEY, BUDGET_AMOUNT_RANGE);
	return typeof stored === "number" && stored > 0 ? stored : undefined;
}

export function activeBudgetMonth(): number | undefined {
	const stored = (globalThis as Record<symbol, unknown>)[BUDGET_MONTH_SLOT] ?? loadNumber(BUDGET_MONTH_KEY, BUDGET_AMOUNT_RANGE);
	return typeof stored === "number" && stored > 0 ? stored : undefined;
}

/** Enforce off by default: the guardrail warns unless the user explicitly turned it on. */
export function activeBudgetEnforce(): boolean {
	const stored = (globalThis as Record<symbol, unknown>)[BUDGET_ENFORCE_SLOT] ?? loadChoice(BUDGET_ENFORCE_KEY, ["on", "off"] as const);
	return stored === "on";
}

export function setBudgetDay(n: number | undefined): void {
	(globalThis as Record<symbol, unknown>)[BUDGET_DAY_SLOT] = n !== undefined && n > 0 ? n : undefined;
	saveChoice(BUDGET_DAY_KEY, n !== undefined && n > 0 ? String(n) : "");
}

export function setBudgetMonth(n: number | undefined): void {
	(globalThis as Record<symbol, unknown>)[BUDGET_MONTH_SLOT] = n !== undefined && n > 0 ? n : undefined;
	saveChoice(BUDGET_MONTH_KEY, n !== undefined && n > 0 ? String(n) : "");
}

export function setBudgetEnforce(on: boolean): void {
	(globalThis as Record<symbol, unknown>)[BUDGET_ENFORCE_SLOT] = on ? "on" : "off";
	saveChoice(BUDGET_ENFORCE_KEY, on ? "on" : "off");
}

/** The next cap choice after `current` (unset reads as 0); past the largest choice it wraps to off. */
export function nextCap(current: number | undefined): number {
	const cur = current ?? 0;
	return BUDGET_CAPS.find((c) => c > cur) ?? 0;
}

/** Row label of a cap: the amount, or `off` when unset. */
export const capLabel = (n: number | undefined): string => (n !== undefined && n > 0 ? formatCost(n) : "off");

// ---------------------------------------------------------------- decision

export type BudgetLevel = "ok" | "warn" | "over";

export interface BudgetSpend {
	/** Billed spend in the current UTC day / the last 30 days (the cache's day buckets). */
	today: number;
	month: number;
	/** Catalog-estimated spend in the same windows: it warns, it never blocks. */
	estimatedToday?: number;
	estimatedMonth?: number;
}

export interface BudgetVerdict {
	level: BudgetLevel;
	reason?: string;
}

/** `warn` starts at this fraction of a cap. */
export const WARN_PCT = 0.8;

/**
 * Pure decision — no I/O, the unit under test. `warn` at ≥80% of any set cap, `over` at ≥100%.
 * Rule 4: only **billed** spend can cross a cap, because a cap computed from a catalog estimate
 * would enforce $0 on an unpriced model. An estimate still counts towards the warning, so a
 * provider that reports no billed total is not silently ignored. `enforce` only words the
 * reason: an `over` that will be blocked says so, one that only warns does not.
 */
export function budgetState(spend: BudgetSpend, caps: { day?: number; month?: number }, enforce: boolean): BudgetVerdict {
	let level: BudgetLevel = "ok";
	let reason: string | undefined;
	const consider = (billed: number, estimated: number, cap: number | undefined, label: string): void => {
		if (cap === undefined || !(cap > 0)) return;
		const total = billed + estimated;
		if (!(total > 0)) return;
		// `floor`, not `round`: 99.6 % of a cap must not read as "at 100 %". Multiply before
		// dividing: `(115 / 100) * 100` is 114.99999999999999, `(115 * 100) / 100` is 115.
		const pct = Math.floor((total * 100) / cap);
		if (billed >= cap) {
			if (level !== "over") {
				level = "over";
				// The block is decided on billed spend, so the reason states billed spend too.
				reason = `${label} cap ${formatCost(cap)} at ${Math.floor((billed * 100) / cap)}% (${formatCost(billed)} billed)`;
			}
		} else if (total / cap >= WARN_PCT && level === "ok") {
			level = "warn";
			// The note is only true when the estimate is what pushed the window into warn: billed
			// spend below the warning threshold on its own. Otherwise the next billed dollar blocks.
			const note = estimated > 0 && billed / cap < WARN_PCT ? " — estimate only, never blocked" : "";
			reason = `${label} cap ${formatCost(cap)} at ${pct}% (${formatCost(total)} spent)${note}`;
		}
	};
	consider(spend.today, spend.estimatedToday ?? 0, caps.day, "day");
	consider(spend.month, spend.estimatedMonth ?? 0, caps.month, "month");
	if (level === "ok") return { level };
	if (level === "over") return { level, reason: `${reason}${enforce ? " — turn blocked" : " — enforcement off"}` };
	return { level, reason };
}

/** The current spend from the memoized summary's day buckets, or null when they are absent
 *  (a cache with no buckets — the spend is then unknown, never a fabricated $0). `force`
 *  re-scans: the gate must not read a total up to 5s old, the footer render must not scan. */
export function spendNow(force = false): BudgetSpend | null {
	const s = collectUsageSummary(force);
	if (!s.totals.today || !s.totals.last30d) return null;
	return {
		today: s.totals.today.cost,
		month: s.totals.last30d.cost,
		estimatedToday: s.totals.today.estimated,
		estimatedMonth: s.totals.last30d.estimated,
	};
}

/** The budget level right now — read by the footer render, so it rides the same 5s memo: at
 *  most one scan per 5s on the render path, never one per frame. Any error reads as `ok`
 *  (never a false alarm). */
export function budgetLevelNow(): BudgetLevel {
	try {
		const caps = { day: activeBudgetDay(), month: activeBudgetMonth() };
		if (caps.day === undefined && caps.month === undefined) return "ok";
		const spend = spendNow();
		if (spend === null) return "ok";
		return budgetState(spend, caps, activeBudgetEnforce()).level;
	} catch {
		return "ok";
	}
}

// ---------------------------------------------------------------- the Budget screen

const BUDGET_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Budget"),
	description: "Warn-only caps on the UTC day and the rolling 30d — enforce on blocks the next turn.",
	legend: "[↑↓] Move  [Enter] Change  [←] Back  [Esc] Close",
};

const ENFORCE_ON_NOTE = "on — blocks the next turn over a cap";
const ENFORCE_OFF_NOTE = "off — warns only";

/** The live note of one Budget row, re-read on every render so a change shows at once. */
function budgetRowNote(label: string): string | undefined {
	if (label === "Day cap") return capLabel(activeBudgetDay());
	if (label === "30d cap") return capLabel(activeBudgetMonth());
	if (label === "Enforce") return activeBudgetEnforce() ? ENFORCE_ON_NOTE : ENFORCE_OFF_NOTE;
	return undefined;
}

/** The Budget screen's editable rows: day cap, month cap, enforce. The spend itself is the
 *  status section above the rows, not a row. */
export function budgetRows(): ListRow[] {
	return ["Day cap", "30d cap", "Enforce"].map((label) => ({ label, note: budgetRowNote(label) }));
}

/** Enter on a row changes that row's value (the screen stays open, the note re-reads). */
function changeBudgetRow(index: number): void {
	if (index === 0) setBudgetDay(nextCap(activeBudgetDay()));
	else if (index === 1) setBudgetMonth(nextCap(activeBudgetMonth()));
	else if (index === 2) setBudgetEnforce(!activeBudgetEnforce());
}

// ---------------------------------------------------------------- the Budget screen (TUI)

/** Width of the spend-vs-cap bar, in cells. */
export const BUDGET_BAR_WIDTH = 20;

export interface BudgetWindow {
	label: string;
	/** Billed spend in the window. */
	billed: number;
	/** Catalog-estimated spend in the window: it warns, it never blocks. */
	estimated: number;
	/** Billed + estimated — the number the bar and the percentage are drawn from. */
	total: number;
	/** The cap, when one is set. */
	cap?: number;
	/** Bar fill fraction 0..1 (0 without a cap or without spend). */
	frac: number;
	/** Whole percent of the cap, uncapped (120 stays 120); undefined without a cap. */
	pct?: number;
	level: BudgetLevel;
	/** True when the day buckets are absent: the spend is unknown, never a fabricated $0. */
	unknown: boolean;
}

/** The two status rows of the Budget screen, pure so the self-check pins them without a theme. */
export function budgetWindows(spend: BudgetSpend | null, caps: { day?: number; month?: number }, enforce: boolean): BudgetWindow[] {
	const win = (label: string, billed: number, estimated: number, cap: number | undefined): BudgetWindow => {
		const total = billed + estimated;
		const base = { label, billed, estimated, total, cap, frac: 0, level: "ok" as BudgetLevel, unknown: false };
		if (spend === null) return { ...base, unknown: true };
		if (cap === undefined || !(cap > 0)) return base;
		// The window's own level: only its cap and its spend decide it, through the same
		// decision function the gate uses — estimate-only spend still caps at warn.
		const level = budgetState(
			label === "Today"
				? { today: billed, month: 0, estimatedToday: estimated, estimatedMonth: 0 }
				: { today: 0, month: billed, estimatedToday: 0, estimatedMonth: estimated },
			label === "Today" ? { day: cap } : { month: cap },
			enforce,
		).level;
		return { ...base, level, frac: total > 0 ? Math.min(1, total / cap) : 0, pct: Math.floor((total * 100) / cap) };
	};
	if (spend === null) {
		return [
			{ label: "Today", billed: 0, estimated: 0, total: 0, cap: caps.day, frac: 0, level: "ok", unknown: true },
			{ label: "30d", billed: 0, estimated: 0, total: 0, cap: caps.month, frac: 0, level: "ok", unknown: true },
		];
	}
	return [
		win("Today", spend.today, spend.estimatedToday ?? 0, caps.day),
		win("30d", spend.month, spend.estimatedMonth ?? 0, caps.month),
	];
}

/** The Budget dashboard: a spend-vs-cap status section over the editable cap rows. The frame
 *  comes from `renderScreen` like every other arnative screen; the level colors reuse the
 *  theme's warning/error slots (ok stays the accent, matching the footer band painter). */
class BudgetModalComponent implements Component {
	private readonly theme: { fg(c: string, t: string): string; bold?(t: string): string };
	private readonly rows: ListRow[];
	private readonly hooks: { change(index: number): void; done(back: boolean): void; requestRender(): void };
	private readonly text: ListPickerText;
	private readonly edge: (s: string) => string;
	private selected = 0;

	constructor(
		theme: { fg(c: string, t: string): string; bold?(t: string): string },
		rows: ListRow[],
		hooks: { change(index: number): void; done(back: boolean): void; requestRender(): void },
		text: ListPickerText,
		thinkingLevel?: string,
	) {
		this.theme = theme;
		this.rows = rows;
		this.hooks = hooks;
		this.text = text;
		this.edge = thinkingColorOf(theme, thinkingLevel);
	}

	invalidate(): void {
		/* renders are computed per call */
	}
	dispose(): void {
		/* no timer to clear */
	}

	handleInput(keyData: string): void {
		// Esc/← step back to /arnative, Q closes the screen — the same contract as ListPicker.
		if (matchesKey(keyData, "escape") || matchesBack(keyData)) {
			this.hooks.done(true);
			return;
		}
		if (keyData === "Q" || matchesKey(keyData, "q")) {
			this.hooks.done(false);
			return;
		}
		if (matchesKey(keyData, "up") || matchesKey(keyData, "k")) {
			this.selected = Math.max(0, this.selected - 1);
			this.hooks.requestRender();
			return;
		}
		if (matchesKey(keyData, "down") || matchesKey(keyData, "j")) {
			this.selected = Math.min(this.rows.length - 1, this.selected + 1);
			this.hooks.requestRender();
			return;
		}
		if (matchesKey(keyData, "enter")) {
			this.hooks.change(this.selected);
			this.hooks.requestRender();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const bold = th.bold ?? ((t: string) => t);
		const dim = (s: string) => th.fg("dim", s);
		const acc = (s: string) => th.fg("accent", s);
		// Levels ride the active theme's semantic slots: OK accent, WARN warning, OVER error.
		const levelPaint = (level: BudgetLevel) =>
			level === "ok" ? acc : level === "warn" ? (s: string) => th.fg("warning", s) : (s: string) => th.fg("error", s);
		const contentW = Math.max(20, width - 4);
		const body: string[] = [];

		// Status: one line per window — `label · spend of cap  bar  pct% · LEVEL` — then the
		// estimated total. The bars share one column: the spend-of-cap text is padded to the
		// widest window, so a longer cap never shifts its neighbour's bar.
		const spend = spendNow();
		const windows = budgetWindows(spend, { day: activeBudgetDay(), month: activeBudgetMonth() }, activeBudgetEnforce());
		const capText = (w: BudgetWindow): string => (w.cap !== undefined && w.cap > 0 ? `${formatCost(w.total)} of ${formatCost(w.cap)}` : "");
		const partW = Math.max(0, ...windows.map((w) => visibleWidth(capText(w))));
		for (const w of windows) {
			const label = th.fg("text", w.label.padEnd(5));
			if (w.unknown) {
				body.push(`${label} · ${dim("unknown — no day buckets yet")}`);
				continue;
			}
			if (w.cap === undefined || !(w.cap > 0)) {
				body.push(`${label} · ${th.fg("text", formatCost(w.total))}  ${dim("no cap")}`);
				continue;
			}
			const paint = levelPaint(w.level);
			const filled = Math.round(w.frac * BUDGET_BAR_WIDTH);
			const bar = paint("█".repeat(filled)) + dim("░".repeat(BUDGET_BAR_WIDTH - filled));
			const pct = `${w.pct}%`.padEnd(4);
			body.push(`${label} · ${th.fg("text", capText(w).padEnd(partW))}  ${bar}  ${paint(pct)} · ${paint(w.level.toUpperCase())}`);
		}
		// The estimated part of both windows, once: an estimate-only provider shows $0 billed
		// per window, so the total is the only place the guess is summed.
		const estimated = (spend?.estimatedToday ?? 0) + (spend?.estimatedMonth ?? 0);
		if (estimated > 0) body.push(`${dim(`Total · ${formatCost(estimated)} est.`)}`);
		body.push("");

		// Editable rows — the same rows the headless picker offers.
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i]!;
			const isSelected = i === this.selected;
			const paint = isSelected ? (s: string) => acc(bold(s)) : (s: string) => th.fg(row.note ? "text" : "muted", s);
			const note = budgetRowNote(row.label);
			const noteText = note ? ` ${dim("·")} ${dim(note)}` : "";
			body.push(` ${isSelected ? acc("→ ") : "  "}${paint(row.label)}${noteText}`);
		}
		return renderScreen(th, width, this.text, body.map((l) => truncateToWidth(l, contentW, "")), this.edge);
	}
}

/** `/arnative` → **Budget**: a dashboard of spend vs caps over the editable cap rows. */
export async function openBudget(ctx: ExtensionCommandContext): Promise<boolean | void> {
	if (ctx.mode !== "tui") {
		// No custom components (RPC/headless): fall back to the blocking picker.
		const rows = budgetRows();
		const labels = rows.map(rowText);
		const pick = await ctx.ui.select(BUDGET_PICKER_TEXT.title, labels);
		if (pick === undefined) return;
		const index = labels.indexOf(pick);
		changeBudgetRow(index);
		ctx.ui.notify(`[arnative] Budget: ${rowText(budgetRows()[index]!)}`, "info");
		return;
	}

	const goBack = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		return new BudgetModalComponent(
			theme,
			budgetRows(),
			{
				change: (index) => {
					changeBudgetRow(index);
					tui.requestRender();
				},
				done: (back) => done(back),
				requestRender: () => tui.requestRender(),
			},
			BUDGET_PICKER_TEXT,
			ctx.thinkingLevel,
		);
	});
	return goBack === true;
}

// ---------------------------------------------------------------- the gate

/** Notified once per session while over a cap with enforce off. */
let overNotified = false;

export default function registerBudget(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		overNotified = false;
	});

	pi.on("input", async (event, ctx) => {
		try {
			// An extension-injected message must never be swallowed by the budget gate.
			if (event.source === "extension") return { action: "continue" };
			const caps = { day: activeBudgetDay(), month: activeBudgetMonth() };
			if (caps.day === undefined && caps.month === undefined) return { action: "continue" };
			const spend = spendNow(true);
			// Unknown spend (no day buckets): never block.
			if (spend === null) return { action: "continue" };
			const enforce = activeBudgetEnforce();
			const verdict = budgetState(spend, caps, enforce);
			if (verdict.level !== "over") return { action: "continue" };
			if (enforce) {
				ctx.ui.notify(verdict.reason ?? "over the budget cap", "error");
				return { action: "handled" };
			}
			if (!overNotified) {
				overNotified = true;
				ctx.ui.notify(verdict.reason ?? "over the budget cap", "warning");
			}
			return { action: "continue" };
		} catch {
			// Fail open, always: a throwing input handler is worse than no budget.
			return { action: "continue" };
		}
	});
}

// Self-check: `node extensions/budget.ts`
if (isMain(import.meta.url)) {
	// The real agent dir must not decide pass/fail, and the check must not touch it.
	const fixture = mkdtempSync(join(tmpdir(), "arnative-budget-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = fixture;
	const clearSlots = () => {
		delete (globalThis as Record<symbol, unknown>)[BUDGET_DAY_SLOT];
		delete (globalThis as Record<symbol, unknown>)[BUDGET_MONTH_SLOT];
		delete (globalThis as Record<symbol, unknown>)[BUDGET_ENFORCE_SLOT];
	};
	clearSlots();
	resetPresetCache();

	// The decision function: percentages of a $100 day cap.
	for (const [spend, level] of [[0, "ok"], [79, "ok"], [80, "warn"], [99, "warn"], [100, "over"], [120, "over"]] as const) {
		assert(budgetState({ today: spend, month: 0 }, { day: 100 }, true).level === level, `${spend}% of the cap is ${level}`);
	}
	assert(budgetState({ today: 999, month: 999 }, {}, true).level === "ok", "no caps set → ok");
	assert(budgetState({ today: 999, month: 999 }, {}, true).reason === undefined, "ok carries no reason");
	assert(budgetState({ today: 50, month: 0 }, { day: 0 }, true).level === "ok", "a zero cap is not a cap");
	assert(budgetState({ today: 85, month: 120 }, { day: 100, month: 100 }, true).level === "over", "the month cap is checked and over wins");
	assert(budgetState({ today: 85, month: 50 }, { day: 100, month: 100 }, true).level === "warn", "80% of either cap warns");
	// Rule 4: estimate-only spend never reaches over.
	assert(budgetState({ today: 0, month: 0, estimatedToday: 120 }, { day: 100 }, true).level === "warn", "estimate-only spend is capped at warn, never over");
	assert(budgetState({ today: 0, month: 0, estimatedToday: 120 }, { day: 100 }, false).level === "warn", "estimate-only spend is warn with enforce off too");
	assert(budgetState({ today: 120, month: 0, estimatedToday: 30 }, { day: 100 }, true).level === "over", "a billed crossing is over even with estimates in the mix");
	// Billed 90 of a 100 cap already warns on its own: the estimate did not push it there, so the
	// reason must not claim the over-cap is estimate-only.
	const mixed = budgetState({ today: 90, month: 0, estimatedToday: 40 }, { day: 100 }, true);
	assert(mixed.level === "warn" && !(mixed.reason ?? "").includes("never blocked"), "a mixed warn does not claim estimate-only: " + mixed.reason);
	// Pinned reason strings.
	assert(
		budgetState({ today: 6, month: 0 }, { day: 5 }, true).reason === "day cap $5.00 at 120% ($6.00 billed) — turn blocked",
		"over + enforce reason pinned: " + budgetState({ today: 6, month: 0 }, { day: 5 }, true).reason,
	);
	assert(
		budgetState({ today: 6, month: 0 }, { day: 5 }, false).reason === "day cap $5.00 at 120% ($6.00 billed) — enforcement off",
		"over + enforce off reason pinned",
	);
	assert(budgetState({ today: 4, month: 0 }, { day: 5 }, true).reason === "day cap $5.00 at 80% ($4.00 spent)", "warn reason pinned");
	assert(
		budgetState({ today: 0, month: 0, estimatedToday: 6 }, { day: 5 }, true).reason === "day cap $5.00 at 120% ($6.00 spent) — estimate only, never blocked",
		"estimate-capped reason pinned",
	);

	// The fixed cap choices and their labels.
	assert(nextCap(undefined) === 1 && nextCap(0) === 1 && nextCap(5) === 10 && nextCap(7.5) === 10 && nextCap(500) === 0, "nextCap cycles the choices, past the largest wraps to off");
	assert(capLabel(undefined) === "off" && capLabel(0) === "off" && capLabel(5) === "$5.00", "capLabel pinned");

	// Settings: absent reads as unset / off; a set value persists through the fixture config.
	assert(activeBudgetDay() === undefined && activeBudgetMonth() === undefined && activeBudgetEnforce() === false, "no caps, enforce off by default");
	setBudgetDay(5);
	setBudgetEnforce(true);
	assert(activeBudgetDay() === 5 && loadNumber(BUDGET_DAY_KEY, BUDGET_AMOUNT_RANGE) === 5, "a day cap is stored and reads back");
	assert(activeBudgetEnforce() === true && loadChoice(BUDGET_ENFORCE_KEY, ["on", "off"] as const) === "on", "enforce is stored as on/off");
	setBudgetDay(undefined);
	assert(activeBudgetDay() === undefined && loadNumber(BUDGET_DAY_KEY, BUDGET_AMOUNT_RANGE) === undefined, "clearing the cap stores the empty string (unset)");

	// The spend comes from the day buckets: one billed $6 entry today → today and 30d both $6.
	mkdirSync(join(fixture, "sessions", "p"), { recursive: true });
	const asst = (cost: number) =>
		JSON.stringify({
			message: { role: "assistant", provider: "google", model: "m", timestamp: Date.now(), usage: { input: 10, output: 5, cost: { total: cost, totalFromProvider: true } } },
		});
	writeFileSync(join(fixture, "sessions", "p", "s.jsonl"), asst(6) + "\n");
	resetUsageCache();
	const spend = spendNow();
	assert(spend !== null && spend.today === 6 && spend.month === 6 && spend.estimatedToday === 0, "spend reads the day buckets (today / 30d): " + JSON.stringify(spend));

	// The level right now, through the same memoized summary.
	assert(budgetLevelNow() === "ok", "no caps → ok");
	setBudgetDay(5);
	assert(budgetLevelNow() === "over", "$6 of a $5 day cap is over");
	setBudgetDay(7.5);
	assert(budgetLevelNow() === "warn", "$6 of $7.50 is exactly 80% → warn");
	setBudgetDay(undefined);

	// The gate, driven through a fake pi.
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	registerBudget({ on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => void (handlers[name] = fn) } as never);
	const notes: { msg: string; level: string }[] = [];
	const ctxOf = (): unknown => ({ ui: { notify: (msg: string, level: string) => void notes.push({ msg, level }) } });
	const ev = (source: string) => ({ type: "input", text: "hi", source });
	const input = async (source: string, ctx: unknown) => (await handlers.input!(ev(source), ctx)) as { action: string };

	setBudgetDay(5); // $6 spent → 120% of the day cap
	setBudgetEnforce(false);
	assert((await input("interactive", ctxOf())).action === "continue", "over + enforce off lets the turn through");
	assert(notes.length === 1 && notes[0]!.level === "warning", "over + enforce off notifies once, as a warning");
	assert(notes[0]!.msg === "day cap $5.00 at 120% ($6.00 billed) — enforcement off", "the notify carries the pinned reason: " + notes[0]!.msg);
	assert((await input("interactive", ctxOf())).action === "continue" && notes.length === 1, "the second over-input does not notify again (once per session)");
	assert((await input("extension", ctxOf())).action === "continue" && notes.length === 1, "an extension-injected input is never swallowed and never notifies");
	await handlers.session_start!({}, undefined);
	setBudgetEnforce(true);
	assert((await input("interactive", ctxOf())).action === "handled", "over + enforce on blocks the next turn");
	assert(notes.length === 2 && notes[1]!.level === "error" && notes[1]!.msg === "day cap $5.00 at 120% ($6.00 billed) — turn blocked", "over + enforce on notifies an error with the pinned reason");
	assert(
		(await input("interactive", { get ui(): unknown { throw new Error("boom"); } })).action === "continue",
		"a throwing handler path fails open: continue, never block",
	);
	assert(notes.length === 2, "the failed notify was not recorded");
	setBudgetDay(7.5); // 80% → warn: no notify, the turn goes through
	assert((await input("interactive", ctxOf())).action === "continue" && notes.length === 2, "warn does not notify and does not block");

	// Unknown spend (no day buckets) never blocks, even with enforce on and a cap set.
	const empty = mkdtempSync(join(tmpdir(), "arnative-budget-empty-"));
	process.env.PI_CODING_AGENT_DIR = empty;
	clearSlots();
	resetPresetCache();
	resetUsageCache();
	setBudgetDay(5);
	setBudgetEnforce(true);
	assert(spendNow() === null, "no day buckets → the spend is unknown");
	assert((await input("interactive", ctxOf())).action === "continue" && notes.length === 2, "unknown spend never blocks");

	// No caps set → the gate is a no-op.
	process.env.PI_CODING_AGENT_DIR = fixture;
	clearSlots();
	resetPresetCache();
	resetUsageCache();
	setBudgetEnforce(true);
	setBudgetDay(undefined);
	assert((await input("interactive", ctxOf())).action === "continue" && notes.length === 2, "no caps → continue, no notify");

	// The Budget screen rows carry the live values and the pinned copy.
	setBudgetDay(5);
	const rows = budgetRows();
	assert(rows.map((r) => r.label).join(",") === "Day cap,30d cap,Enforce", "the Budget rows: " + rows.map((r) => r.label).join(","));
	assert(rows[0]!.note === "$5.00" && rows[1]!.note === "off", "the cap rows show the stored caps");
	assert(rows[2]!.note === ENFORCE_ON_NOTE && ENFORCE_ON_NOTE === "on — blocks the next turn over a cap", "the enforce row is pinned: " + rows[2]!.note);
	assert(BUDGET_PICKER_TEXT.title === "Budget - Arnative\u2819", "the Budget screen title is pinned: " + BUDGET_PICKER_TEXT.title);
	assert(
		BUDGET_PICKER_TEXT.description === "Warn-only caps on the UTC day and the rolling 30d — enforce on blocks the next turn.",
		"the Budget screen description is pinned",
	);
	assert(BUDGET_PICKER_TEXT.legend === "[↑↓] Move  [Enter] Change  [←] Back  [Esc] Close", "the Budget legend is pinned");
	assert(rowText(rows[0]!) === "Day cap · $5.00", "the headless row text is pinned: " + rowText(rows[0]!));

	// The dashboard: the two spend-vs-cap windows, pure and pinned.
	const windows = budgetWindows(spendNow(), { day: activeBudgetDay(), month: activeBudgetMonth() }, activeBudgetEnforce());
	assert(windows.length === 2 && windows[0]!.label === "Today" && windows[1]!.label === "30d", "two status windows: " + windows.map((w) => w.label).join(","));
	assert(windows[0]!.pct === 120 && windows[0]!.level === "over" && windows[0]!.frac === 1, "today $6 of a $5 cap is 120% over, bar full: " + JSON.stringify(windows[0]));
	assert(windows[1]!.cap === undefined && windows[1]!.level === "ok" && windows[1]!.frac === 0 && windows[1]!.pct === undefined, "no month cap → no bar, no percent, ok");
	assert(budgetWindows(null, { day: 5 }, true).every((w) => w.unknown), "unknown spend (no day buckets) flags both windows");
	assert(budgetWindows({ today: 0, month: 0, estimatedToday: 6 }, { day: 5 }, true)[0]!.level === "warn", "estimate-only today spend warns, never over");

	// The modal render: status bars above the editable rows, through the shared screen frame.
	const modalTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const changed: number[] = [];
	const modal = new BudgetModalComponent(
		modalTheme as never,
		budgetRows(),
		{ change: (i) => void changed.push(i), done: () => {}, requestRender: () => {} },
		BUDGET_PICKER_TEXT as never,
	);
	const rendered = modal.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	assert(rendered.some((l) => l.includes("Budget - Arnative")), "the modal keeps the shared screen title");
	assert(rendered[0]!.includes("╭") && rendered[rendered.length - 1]!.includes("╰"), "the modal keeps the shared screen frame");
	assert(rendered.some((l) => l.includes("Today") && l.includes("█") && l.includes("120%") && l.includes("OVER")), "the Today row shows spend, bar, percent and level");
	assert(rendered.some((l) => l.includes("30d") && l.includes("no cap")), "the uncapped window says no cap");
	assert(rendered.some((l) => l.includes("Day cap") && l.includes("$5.00")), "the editable rows render with their notes");
	modal.handleInput("\x1b[B"); // down
	modal.handleInput("\r"); // enter
	assert(changed.length === 1 && changed[0] === 1, "down+enter changes the second row (30d cap), not the first");
	assert(modal.render(40).length > 0, "the modal renders on a narrow terminal");

	// Both windows capped: the bars share one column however long the spend-of-cap text is.
	setBudgetMonth(10);
	const aligned = modal.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	const todayBar = aligned.find((l) => l.includes("Today") && l.includes("█"))!;
	const monthBar = aligned.find((l) => l.includes("30d") && l.includes("█"))!;
	assert(todayBar.includes("█") && monthBar.includes("█"), "both capped windows draw a bar");
	assert(todayBar.indexOf("█") === monthBar.indexOf("█"), "both bars start on the same column: " + JSON.stringify([todayBar, monthBar]));

	// The level colors come from the active theme's semantic slots: OK accent, WARN warning,
	// OVER error. The theme records (slot, text) pairs: literal tags would count as width and
	// truncate the render.
	const calls: { slot: string; text: string }[] = [];
	const slotTheme = { fg: (c: string, t: string) => (calls.push({ slot: c, text: t }), t), bold: (t: string) => t };
	const slotModal = new BudgetModalComponent(slotTheme as never, budgetRows(), { change: () => {}, done: () => {}, requestRender: () => {} }, BUDGET_PICKER_TEXT as never);
	slotModal.render(80); // today OVER (120% of $5), 30d OK (60% of $10)
	assert(calls.find((c) => c.text === "OVER")?.slot === "error", "OVER paints with the theme's error slot");
	assert(calls.find((c) => c.text === "OK")?.slot === "accent", "OK paints with the theme's accent slot");
	setBudgetMonth(7); // 30d $6 of $7 = 85% → WARN
	slotModal.render(80);
	assert(calls.filter((c) => c.text === "WARN").pop()?.slot === "warning", "WARN paints with the theme's warning slot");
	setBudgetMonth(undefined);

	// An estimated-cost entry adds the `Total · $X est.` line under the windows.
	writeFileSync(
		join(fixture, "sessions", "p", "e.jsonl"),
		JSON.stringify({ message: { role: "assistant", provider: "google", model: "m", timestamp: Date.now(), usage: { input: 1, output: 1, cost: { total: 2 } } } }) + "\n",
	);
	resetUsageCache();
	const estRendered = modal.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	assert(estRendered.some((l) => l.includes("Total · $4.00 est.")), "the estimated total line renders: " + estRendered.filter((l) => l.includes("Total")).join(" | "));
	rmSync(join(fixture, "sessions", "p", "e.jsonl"));
	resetUsageCache();

	// Restore: the next module load starts from the real agent dir and the stored defaults.
	rmSync(fixture, { recursive: true, force: true });
	rmSync(empty, { recursive: true, force: true });
	if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevDir;
	clearSlots();
	resetPresetCache();
	resetUsageCache();
	console.log("budget.ts self-check OK");
}
