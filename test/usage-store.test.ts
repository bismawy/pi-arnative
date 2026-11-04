/**
 * The v6 usage cache: day buckets, the session cwd and the project grouping in
 * `lib/usage-store.ts`. Pointed at a fixture agent dir, so the real history (and cache)
 * never decide pass/fail. Run with `npm test` (`node --test`).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectUsageSummary, resetUsageCache, type UsageSummary } from "../lib/usage-store.ts";

const NL = String.fromCharCode(10);

/** Fresh fixture per case; the agent dir env var is restored either way. */
function withFixture(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "arnative-usage-store-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetUsageCache();
	try {
		run(dir);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		resetUsageCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

const asst = (model: string, input: number, ts: number, cost = 0.02) =>
	JSON.stringify({ message: { role: "assistant", provider: "google", model, timestamp: ts, usage: { input, output: 5, cacheRead: 1, cost: { total: cost } } } });
const header = (cwd: string) => JSON.stringify({ type: "session", cwd });
const cacheOf = (dir: string) => JSON.parse(readFileSync(join(dir, "arnative", "usage-cache.json"), "utf8")) as Record<string, { r: Record<string, number[]>; d?: Record<string, number[]>; w?: string }>;
const msgsOf = (rows: Record<string, number[]>) => Object.values(rows).reduce((n, a) => n + a[0]!, 0);

test("day buckets, cwd and projects roll up per file", () => {
	withFixture((dir) => {
		const tsToday = Date.now();
		const tsYesterday = tsToday - 86_400_000;
		const today = new Date(tsToday).toISOString().slice(0, 10);
		mkdirSync(join(dir, "sessions", "a"), { recursive: true });
		mkdirSync(join(dir, "sessions", "b"), { recursive: true });
		// a.jsonl has a session header (cwd); b.jsonl has none.
		writeFileSync(join(dir, "sessions", "a", "a.jsonl"), [header("/repo/alpha"), asst("m1", 100, tsToday), asst("m1", 50, tsYesterday)].join(NL) + NL);
		writeFileSync(join(dir, "sessions", "b", "b.jsonl"), asst("m2", 7, tsToday) + NL);

		const summary = collectUsageSummary(true);
		assert.equal(summary.projects.length, 2);
		const alpha = summary.projects.find((p) => p.name === "/repo/alpha")!;
		const unknown = summary.projects.find((p) => p.name === "unknown")!;
		assert.equal(alpha.msgs, 2);
		assert.equal(alpha.input, 150);
		assert.equal(unknown.msgs, 1);
		assert.equal(alpha.providers[0]!.name, "google");
		assert.equal(alpha.providers[0]!.models[0]!.name, "m1");
		// Projects totals equal totals.
		assert.equal(summary.projects.reduce((n, p) => n + p.msgs, 0), summary.totals.msgs);
		assert.equal(summary.projects.reduce((n, p) => n + p.input, 0), summary.totals.input);
		assert.ok(Math.abs(summary.projects.reduce((n, p) => n + p.cost, 0) - summary.totals.cost) < 1e-9);
		// Day windows come from the buckets, keyed in UTC.
		assert.equal(summary.totals.today!.input, 107);
		assert.equal(summary.totals.last7d!.input, 157);
		assert.equal(summary.totals.last30d!.input, 157);
		// On disk: the cwd in `w`, the day rows in `d`, summing to the file's rows in `r`.
		const disk = cacheOf(dir);
		const relA = join("a", "a.jsonl");
		assert.equal(disk[relA]!.w, "/repo/alpha");
		assert.equal(msgsOf(disk[relA]!.d!), msgsOf(disk[relA]!.r));
		assert.ok(disk[relA]!.d![`${today}\u0000google\u0000m1`] !== undefined);
		assert.equal(disk[join("b", "b.jsonl")]!.w, undefined);
	});
});

test("a grown file tail-folds without re-reading the head for the cwd", () => {
	withFixture((dir) => {
		mkdirSync(join(dir, "sessions", "a"), { recursive: true });
		const file = join(dir, "sessions", "a", "a.jsonl");
		writeFileSync(file, [header("/repo/alpha"), asst("m1", 100, Date.now())].join(NL) + NL);
		const before = collectUsageSummary(true);
		assert.equal(before.projects[0]!.name, "/repo/alpha");
		writeFileSync(file, asst("m1", 1000, Date.now()) + NL, { flag: "a" });
		const grown = collectUsageSummary(true);
		assert.equal(grown.totals.msgs, before.totals.msgs + 1);
		// The project is still the cached cwd, not a re-read — and the tail landed in today's bucket.
		assert.equal(grown.projects[0]!.name, "/repo/alpha");
		assert.equal(grown.projects[0]!.input, 1100);
		assert.equal(grown.totals.today!.input, 1100);
		assert.equal(cacheOf(dir)[join("a", "a.jsonl")]!.w, "/repo/alpha");
	});
});

test("a pre-v6 (v5 compact) cache item is re-parsed once and re-saved as v6", () => {
	withFixture((dir) => {
		mkdirSync(join(dir, "sessions", "a"), { recursive: true });
		const file = join(dir, "sessions", "a", "a.jsonl");
		writeFileSync(file, [header("/repo/alpha"), asst("m1", 11, Date.now())].join(NL) + NL);
		const cold: UsageSummary = collectUsageSummary(true);
		// Overwrite the cache with a v5-shaped item (no `d`, no `w`) claiming other numbers.
		const st = statSync(file);
		const cachePath = join(dir, "arnative", "usage-cache.json");
		writeFileSync(cachePath, JSON.stringify({ [join("a", "a.jsonl")]: { m: st.mtimeMs, s: st.size, c: st.size, r: { "google\u0000m1": [99, 999, 1, 1, 9] } } }));
		resetUsageCache();
		const reparsed = collectUsageSummary(true);
		assert.equal(reparsed.totals.msgs, cold.totals.msgs);
		assert.equal(reparsed.totals.input, cold.totals.input);
		assert.equal(reparsed.projects[0]!.name, "/repo/alpha");
		const disk = cacheOf(dir);
		assert.ok(disk[join("a", "a.jsonl")]!.d !== undefined, "the re-parsed item is saved with day buckets");
		assert.equal(disk[join("a", "a.jsonl")]!.w, "/repo/alpha");
		assert.equal(msgsOf(disk[join("a", "a.jsonl")]!.d!), 1);
	});
});
