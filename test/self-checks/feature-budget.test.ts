import test from "node:test";
import { assert } from "../helpers/check.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rowText } from "../../lib/list-picker.ts";
import { BUDGET_DAY_KEY, BUDGET_ENFORCE_KEY, loadChoice, loadNumber, resetPresetCache } from "../../lib/preset-store.ts";
import { resetUsageCache } from "../../lib/usage-store.ts";
import registerBudget, { BUDGET_AMOUNT_RANGE, activeBudgetDay, activeBudgetMonth, activeBudgetEnforce, setBudgetDay, setBudgetMonth, setBudgetEnforce, resetBudget, nextCap, capLabel, budgetState, spendNow, budgetLevelNow, budgetRows, budgetWindows, __test } from "../../lib/features/budget.ts";

const { BUDGET_DAY_SLOT, BUDGET_MONTH_SLOT, BUDGET_ENFORCE_SLOT, BUDGET_PICKER_TEXT, ENFORCE_ON_NOTE, createBudgetPicker } = __test;

test("lib/features/budget.ts self-check", async () => {
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
	assert(BUDGET_PICKER_TEXT.legend === "[↑↓] Move  [Space] Change  [R] Reset  [Esc] Back", "the Budget legend is pinned");
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
	let resets = 0;
	const modal = createBudgetPicker(
		modalTheme as never,
		budgetRows(),
		{ change: (i) => void changed.push(i), reset: () => void resets++, done: () => {}, requestRender: () => {} },
		BUDGET_PICKER_TEXT as never,
	);
	const rendered = modal.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	assert(rendered.some((l) => l.includes("Budget - Arnative")), "the modal keeps the shared screen title");
	assert(rendered[0]!.includes("╭") && rendered[rendered.length - 1]!.includes("╰"), "the modal keeps the shared screen frame");
	assert(rendered.some((l) => l.includes("Today") && l.includes("█") && l.includes("120%") && l.includes("OVER")), "the Today row shows spend, bar, percent and level");
	assert(rendered.some((l) => l.includes("30d") && l.includes("no cap")), "the uncapped window says no cap");
	assert(rendered.some((l) => l.includes("Day cap") && l.includes("$5.00")), "the editable rows render with their notes");
	modal.handleInput("\x1b[B"); // down
	modal.handleInput(" "); // space
	assert(changed.length === 1 && changed[0] === 1, "down+space changes the second row (30d cap), not the first");
	modal.handleInput("R");
	modal.handleInput("r");
	assert(resets === 2, "R/r triggers budget reset");
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
	const slotModal = createBudgetPicker(slotTheme as never, budgetRows(), { change: () => {}, reset: () => {}, done: () => {}, requestRender: () => {} }, BUDGET_PICKER_TEXT as never);
	slotModal.render(80); // today OVER (120% of $5), 30d OK (60% of $10)
	assert(calls.find((c) => c.text === "Today")?.slot === "dim", "Today label uses dim");
	assert(calls.find((c) => c.text === "30d  ")?.slot === "dim", "30d label uses dim");
	assert(calls.find((c) => c.text === "OVER")?.slot === "error", "OVER paints with the theme's error slot");
	assert(calls.find((c) => c.text === "OK")?.slot === "accent", "OK paints with the theme's accent slot");
	setBudgetMonth(7); // 30d $6 of $7 = 85% → WARN
	slotModal.render(80);
	assert(calls.filter((c) => c.text === "WARN").pop()?.slot === "warning", "WARN paints with the theme's warning slot");
	setBudgetEnforce(true);
	resetBudget();
	assert(activeBudgetDay() === undefined && activeBudgetMonth() === undefined && activeBudgetEnforce() === false, "resetBudget clears caps and enforce");

	// An estimated-cost entry adds the `Total · $X est.` line under the windows.
	writeFileSync(
		join(fixture, "sessions", "p", "e.jsonl"),
		JSON.stringify({ message: { role: "assistant", provider: "google", model: "m", timestamp: Date.now(), usage: { input: 1, output: 1, cost: { total: 2 } } } }) + "\n",
	);
	resetUsageCache();
	calls.length = 0;
	const estRendered = slotModal.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	assert(estRendered.some((l) => l.includes("Total · $2.00 est.")), "the estimated total line renders: " + estRendered.filter((l) => l.includes("Total")).join(" | "));
	assert(calls.find((c) => c.text === "Total")?.slot === "dim", "Total label uses dim");
	assert(calls.find((c) => c.text === "$2.00 est.")?.slot === "text", "Total value beside label uses default text color");
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
});
