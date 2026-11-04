/**
 * The footer cost cell's burn rate (`$/h`) guard — `extensions/footer.ts`, `costCell`.
 * Drives the exported cell against the real module clock: below five minutes of active
 * time, at zero cost and below 80 columns no rate is shown; above them the rate is
 * exactly cost / active hours, with `~` when the cost is an estimate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { clock, costCell, RATE_MIN_ACTIVE_MS, RATE_MIN_WIDTH } from "../extensions/footer.ts";

const id = (t: string) => t;

/** Freeze the clock's live part so `clock.total()` is exactly `activeMs`. */
function setActiveMs(activeMs: number): void {
	clock.active = activeMs;
	clock.runStarted = Date.now();
	clock.lastSeen = clock.runStarted - clock.pauseMs - 1;
}

test("the rate is cost per active hour for a known clock", () => {
	setActiveMs(14 * 60_000); // $0.42 over 14 active minutes
	const cell = costCell(0.42, 0, id, id);
	assert.ok(cell.includes("$0.42 · $1.80/h"), `rate = cost / active hours, got ${cell}`);
	assert.ok(!cell.includes("~"), "a billed-only rate carries no ~");
});

test("an estimate-based rate is prefixed ~", () => {
	setActiveMs(14 * 60_000);
	assert.ok(costCell(0, 0.42, id, id).includes("~$1.80/h"), "an estimated cost marks the rate ~, like the cell's estimated part");
});

test("no rate below five minutes of active time", () => {
	setActiveMs(RATE_MIN_ACTIVE_MS - 1);
	assert.ok(!costCell(0.42, 0, id, id).includes("/h"), "below 5 active minutes: no rate");
	setActiveMs(RATE_MIN_ACTIVE_MS);
	assert.ok(costCell(0.42, 0, id, id).includes("/h"), "at exactly 5 active minutes: the rate appears");
});

test("no cell at all when the cost is zero", () => {
	setActiveMs(60 * 60_000);
	assert.equal(costCell(0, 0, id, id), "", "zero cost: no cell, so no rate either");
});

test("a terminal below 80 columns drops the rate but keeps the cost", () => {
	setActiveMs(14 * 60_000);
	const narrow = costCell(0.42, 0, id, id, RATE_MIN_WIDTH - 1);
	assert.ok(narrow.endsWith("$0.42") && !narrow.includes("/h"), `narrow terminal: cost only, got ${narrow}`);
	assert.ok(costCell(0.42, 0, id, id, RATE_MIN_WIDTH).includes("/h"), "at 80 columns the rate is kept");
});
