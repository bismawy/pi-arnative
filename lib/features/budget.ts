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
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { screenTitle } from "../box.ts";
import { announce } from "../status-widget.ts";
import { ListPicker, rowText, type ListPickerText, type ListRow } from "../list-picker.ts";
import { BUDGET_DAY_KEY, BUDGET_ENFORCE_KEY, BUDGET_MONTH_KEY, flagSetting, loadNumber, saveChoice } from "../preset-store.ts";
import { collectUsageSummary } from "../usage-store.ts";
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
const budgetEnforce = flagSetting(BUDGET_ENFORCE_KEY);
const BUDGET_ENFORCE_SLOT = budgetEnforce.slot;

export function activeBudgetDay(): number | undefined {
	const stored = (globalThis as Record<symbol, unknown>)[BUDGET_DAY_SLOT] ?? loadNumber(BUDGET_DAY_KEY, BUDGET_AMOUNT_RANGE);
	return typeof stored === "number" && stored > 0 ? stored : undefined;
}

export function activeBudgetMonth(): number | undefined {
	const stored = (globalThis as Record<symbol, unknown>)[BUDGET_MONTH_SLOT] ?? loadNumber(BUDGET_MONTH_KEY, BUDGET_AMOUNT_RANGE);
	return typeof stored === "number" && stored > 0 ? stored : undefined;
}

/** Enforce off by default: the guardrail warns unless the user explicitly turned it on. */
export const activeBudgetEnforce = (): boolean => budgetEnforce.get();

export function setBudgetDay(n: number | undefined): void {
	(globalThis as Record<symbol, unknown>)[BUDGET_DAY_SLOT] = n !== undefined && n > 0 ? n : undefined;
	saveChoice(BUDGET_DAY_KEY, n !== undefined && n > 0 ? String(n) : "");
}

export function setBudgetMonth(n: number | undefined): void {
	(globalThis as Record<symbol, unknown>)[BUDGET_MONTH_SLOT] = n !== undefined && n > 0 ? n : undefined;
	saveChoice(BUDGET_MONTH_KEY, n !== undefined && n > 0 ? String(n) : "");
}

export const setBudgetEnforce = (on: boolean): void => budgetEnforce.set(on);

export function resetBudget(): void {
	setBudgetDay(undefined);
	setBudgetMonth(undefined);
	setBudgetEnforce(false);
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
const WARN_PCT = 0.8;

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
	legend: "[↑↓] Move  [Space] Change  [R] Reset  [Esc] Back",
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
const BUDGET_BAR_WIDTH = 20;

/** Total estimated spend across the displayed windows: rolling 30d already includes today. */
export function estimatedWindowTotal(spend: BudgetSpend | null): number {
	if (!spend) return 0;
	return Math.max(spend.estimatedMonth ?? 0, spend.estimatedToday ?? 0);
}

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

/** Spend-vs-cap status rows shown above the Budget editable rows inside `ListPicker`. */
function budgetSummaryLines(th: { fg(c: string, t: string): string }): string[] {
	const dim = (s: string) => th.fg("dim", s);
	const acc = (s: string) => th.fg("accent", s);
	const levelPaint = (level: BudgetLevel) =>
		level === "ok" ? acc : level === "warn" ? (s: string) => th.fg("warning", s) : (s: string) => th.fg("error", s);
	const spend = spendNow();
	const windows = budgetWindows(spend, { day: activeBudgetDay(), month: activeBudgetMonth() }, activeBudgetEnforce());
	const capText = (w: BudgetWindow): string => (w.cap !== undefined && w.cap > 0 ? `${formatCost(w.total)} of ${formatCost(w.cap)}` : "");
	const partW = Math.max(0, ...windows.map((w) => visibleWidth(capText(w))));
	const body: string[] = [];
	for (const w of windows) {
		const label = dim(w.label.padEnd(5));
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
	// Rolling 30d already includes today, so use the 30d estimate without adding today twice.
	const estimated = estimatedWindowTotal(spend);
	if (estimated > 0) body.push(`${dim("Total")} · ${th.fg("text", `${formatCost(estimated)} est.`)}`);
	return body;
}

/** The Budget dashboard built on the shared `ListPicker` chrome. */
function createBudgetPicker(
	theme: { fg(c: string, t: string): string; bold?(t: string): string },
	rows: ListRow[],
	hooks: { change(index: number): void; reset(): void; done(back: boolean): void; requestRender(): void },
	text: ListPickerText,
	thinkingLevel?: string,
): ListPicker {
	const picker = new ListPicker(
		theme,
		rows,
		undefined,
		{
			preview: () => {},
			revert: () => {},
			done: () => {},
			back: () => hooks.done(true),
			cancel: () => hooks.done(false),
			toggle: () => {
				hooks.change(picker.index);
				hooks.requestRender();
			},
			press: (keyData) => {
				if (keyData !== "R" && !matchesKey(keyData, "r")) return;
				hooks.reset();
				hooks.requestRender();
			},
			note: budgetRowNote,
			summary: () => budgetSummaryLines(theme),
			requestRender: hooks.requestRender,
		},
		text,
		false,
		thinkingLevel,
	);
	return picker;
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
		announce(ctx.ui, `Budget: ${rowText(budgetRows()[index]!)}.`);
		return;
	}

	const goBack = await ctx.ui.custom<boolean>((tui, theme, _kb, done) =>
		createBudgetPicker(
			theme,
			budgetRows(),
			{
				change: (index) => {
					changeBudgetRow(index);
					announce(ctx.ui, `Budget: ${rowText(budgetRows()[index]!)}.`);
				},
				reset: () => {
					resetBudget();
					announce(ctx.ui, "Budget reset to defaults.");
				},
				done: (back) => done(back),
				requestRender: () => tui.requestRender(),
			},
			BUDGET_PICKER_TEXT,
			ctx.thinkingLevel,
		),
	);
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

export const __test = {
	BUDGET_DAY_SLOT,
	BUDGET_MONTH_SLOT,
	BUDGET_ENFORCE_SLOT,
	BUDGET_PICKER_TEXT,
	ENFORCE_ON_NOTE,
	createBudgetPicker,
};
