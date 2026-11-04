/**
 * The budget decision function — `extensions/budget.ts`, `budgetState`. Pure, no I/O: the
 * level by percentage of a cap, no caps → ok, and rule 4 (estimate-only spend never reaches
 * `over`, because a cap on an unpriced model would enforce $0). The gate itself is pinned in
 * the budget self-check (`node extensions/budget.ts`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BUDGET_CAPS, budgetState, capLabel, nextCap } from "../extensions/budget.ts";

test("levels by percentage of the day cap: 0/79 ok, 80/99 warn, 100/120 over", () => {
	for (const [spend, level] of [[0, "ok"], [79, "ok"], [80, "warn"], [99, "warn"], [100, "over"], [120, "over"]] as const) {
		assert.equal(budgetState({ today: spend, month: 0 }, { day: 100 }, true).level, level, `${spend}% of a $100 cap`);
	}
});

test("no caps set → ok, no reason", () => {
	const v = budgetState({ today: 999, month: 999 }, {}, true);
	assert.equal(v.level, "ok");
	assert.equal(v.reason, undefined);
});

test("a zero or negative cap is not a cap", () => {
	assert.equal(budgetState({ today: 50, month: 0 }, { day: 0 }, true).level, "ok");
	assert.equal(budgetState({ today: 50, month: 0 }, { day: -5 }, true).level, "ok");
});

test("the month cap is checked too, and over wins over warn", () => {
	assert.equal(budgetState({ today: 85, month: 50 }, { day: 100, month: 100 }, true).level, "warn", "80% of the day cap warns");
	assert.equal(budgetState({ today: 85, month: 120 }, { day: 100, month: 100 }, true).level, "over", "120% of the month cap is over");
	assert.equal(budgetState({ today: 120, month: 120 }, { day: 100, month: 100 }, true).level, "over", "both over stays over");
});

test("estimate-only spend never reaches over (rule 4)", () => {
	assert.equal(budgetState({ today: 0, month: 0, estimatedToday: 120 }, { day: 100 }, true).level, "warn");
	assert.equal(budgetState({ today: 0, month: 0, estimatedToday: 120 }, { day: 100 }, false).level, "warn");
	assert.equal(budgetState({ today: 0, month: 0, estimatedToday: 79 }, { day: 100 }, true).level, "ok", "an estimate below 80% is still ok");
	assert.match(budgetState({ today: 0, month: 0, estimatedToday: 120 }, { day: 100 }, true).reason!, /estimate only, never blocked$/);
	// A billed crossing is over even when estimates are in the same window.
	assert.equal(budgetState({ today: 120, month: 0, estimatedToday: 30 }, { day: 100 }, true).level, "over");
});

test("the reason names the cap, the percent and the spend, and says what happens", () => {
	const over = budgetState({ today: 6, month: 0 }, { day: 5 }, true);
	assert.equal(over.level, "over");
	assert.equal(over.reason, "day cap $5.00 at 120% ($6.00 spent) — turn blocked");
	assert.equal(budgetState({ today: 6, month: 0 }, { day: 5 }, false).reason, "day cap $5.00 at 120% ($6.00 spent) — enforcement off");
	const warn = budgetState({ today: 4, month: 0 }, { day: 5 }, true);
	assert.equal(warn.level, "warn");
	assert.equal(warn.reason, "day cap $5.00 at 80% ($4.00 spent)");
});

test("nextCap cycles the fixed choices and wraps to off", () => {
	assert.equal(nextCap(undefined), BUDGET_CAPS[1]);
	assert.equal(nextCap(0), 1);
	assert.equal(nextCap(5), 10);
	assert.equal(nextCap(7.5), 10, "a hand-set amount lands on the next listed choice");
	assert.equal(nextCap(BUDGET_CAPS[BUDGET_CAPS.length - 1]!), 0, "past the largest choice wraps to off");
	assert.equal(capLabel(undefined), "off");
	assert.equal(capLabel(0), "off");
	assert.equal(capLabel(5), "$5.00");
});
