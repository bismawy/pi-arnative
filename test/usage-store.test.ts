/**
 * The v8 usage cache (day buckets, the session cwd, the project grouping, the
 * cacheWrite/billed rows and the tool-result spend in `lib/usage-store.ts`), plus the
 * billed-vs-estimated split. Pointed at a fixture agent dir, so the real history (and
 * cache) never decide pass/fail. Run with `npm test` (`node --test`).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectUsageSummary, loadPriceTable, resetUsageCache, type UsageSummary } from "../lib/usage-store.ts";

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
const cacheOf = (dir: string) => JSON.parse(readFileSync(join(dir, "arnative", "usage-cache.json"), "utf8")) as Record<string, { r: Record<string, number[]>; d?: Record<string, number[]>; w?: string; t?: number }>;
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

test("billed cost and estimates stay apart, cache writes counted and priced", () => {
	withFixture((dir) => {
		mkdirSync(join(dir, "sessions", "a"), { recursive: true });
		const ts = Date.now();
		const line = (model: string, usage: object) =>
			JSON.stringify({ message: { role: "assistant", provider: "google", model, timestamp: ts, usage } });
		// Billed by the provider, catalog-estimated by pi, and costless (price-table only).
		const billed = line("m1", { input: 100, output: 5, cacheRead: 1, cacheWrite: 7, cost: { total: 0.42, totalFromProvider: true } });
		const catalog = line("m2", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 500_000, cost: { total: 0.12 } });
		const costless = line("m3", { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 1_000_000 });
		writeFileSync(join(dir, "sessions", "a", "a.jsonl"), [billed, catalog, costless].join(NL) + NL);
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({ providers: { google: { models: [{ id: "m3", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 } }] } } }),
		);

		const summary = collectUsageSummary(true);
		const google = summary.providers.find((p) => p.name === "google")!;
		// `cost` is the billed part only; the catalog total and the estimate are not in it.
		assert.equal(summary.totals.cost, 0.42);
		assert.equal(summary.totals.reportedCost, 0.42);
		const m1 = google.models.find((m) => m.name === "m1")!;
		const m2 = google.models.find((m) => m.name === "m2")!;
		const m3 = google.models.find((m) => m.name === "m3")!;
		assert.equal(m1.cost, 0.42);
		assert.equal(m1.estimatedCost, 0);
		assert.equal(m2.cost, 0);
		assert.ok(Math.abs(m2.estimatedCost - 0.12) < 1e-9, "a catalog total (no totalFromProvider) is an estimate");
		// m3 carried no cost at all: 2M input at $1/M + 1M cache writes at $3/M = $5.
		assert.ok(Math.abs(m3.estimatedCost - 5) < 1e-9, "a costless row is recomputed from the price table, cache writes included");
		assert.ok(Math.abs(summary.totals.estimatedCost - 5.12) < 1e-9, "the estimate total is the catalog total plus the reconstruction");

		// The cache rows are v7: cacheWrite and the billed split are stored with the rest.
		const row = cacheOf(dir)[join("a", "a.jsonl")]!.r["google\u0000m1"]!;
		assert.equal(row.length, 7);
		assert.equal(row[4], 7, "cacheWrite is stored");
		assert.ok(Math.abs(row[6]! - 0.42) < 1e-9, "the billed split of the cost is stored");

		// The price table is memoized on the unchanged models.json.
		assert.ok(loadPriceTable() === loadPriceTable(), "an unchanged models.json is read once");
	});
});

test("a tool result's usage is not read, and a child session is counted once", () => {
	withFixture((dir) => {
		mkdirSync(join(dir, "sessions", "a"), { recursive: true });
		const ts = Date.now();
		const asstLine = JSON.stringify({
			message: { role: "assistant", provider: "google", model: "m1", timestamp: ts, usage: { input: 100, output: 5, cacheRead: 1, cacheWrite: 0, cost: { total: 0.02, totalFromProvider: true } } },
		});
		const toolLine = (toolName: string, usage?: object) =>
			JSON.stringify({ message: { role: "toolResult", toolCallId: "c1", toolName, content: [], isError: false, timestamp: ts, ...(usage ? { usage } : {}) } });
		const child = { input: 40, output: 6, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01, totalFromProvider: true } };
		writeFileSync(join(dir, "sessions", "a", "a.jsonl"), [asstLine, toolLine("subagent", child), toolLine("bash")].join(NL) + NL);

		// The child's spend is on the tool result AND in the child's own session file. The store
		// reads the file only: reading both billed the same tokens twice.
		const summary = collectUsageSummary(true);
		assert.equal(summary.totals.msgs, 1);
		assert.equal(summary.totals.input, 100);
		assert.equal(summary.providers.filter((p) => p.name === "tool").length, 0, "no synthetic `tool` row in /usage");

		// pi-subagents writes <project>/<parent id>/<run id>/run-N/session.jsonl and its
		// transcript under <project>/subagent-artifacts/: both are inside the sessions tree.
		const childDir = join(dir, "sessions", "a", "parent-1", "run-1", "run-0");
		mkdirSync(childDir, { recursive: true });
		const childLine = JSON.stringify({
			message: { role: "assistant", provider: "google", model: "m1", timestamp: ts, usage: { input: 40, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01, totalFromProvider: true } } },
		});
		writeFileSync(join(childDir, "session.jsonl"), childLine + NL);
		mkdirSync(join(dir, "sessions", "a", "subagent-artifacts"), { recursive: true });
		writeFileSync(join(dir, "sessions", "a", "subagent-artifacts", "x_transcript.jsonl"), asstLine + NL);
		resetUsageCache();
		const nested = collectUsageSummary(true);
		assert.equal(nested.totals.sessions, 2, "the parent session and the child session, not the transcript");
		assert.equal(nested.totals.input, 140, "the child session counts once (100 + 40), its transcript not at all");
	});
});

test("a v7 cache item (no `t`) is re-parsed once and re-saved as v8", () => {
	withFixture((dir) => {
		mkdirSync(join(dir, "sessions", "a"), { recursive: true });
		const ts = Date.now();
		const file = join(dir, "sessions", "a", "a.jsonl");
		const asstLine = JSON.stringify({ message: { role: "assistant", provider: "google", model: "m1", timestamp: ts, usage: { input: 100, output: 5, cacheRead: 1, cost: { total: 0.02, totalFromProvider: true } } } });
		writeFileSync(file, asstLine + NL);
		const cold = collectUsageSummary(true);
		assert.equal(cold.totals.input, 100);

		// Overwrite the cache with a v7-shaped item (7-number rows, day buckets, no `t`) claiming
		// other numbers: it must not be trusted.
		const st = statSync(file);
		const today = new Date(ts).toISOString().slice(0, 10);
		const cachePath = join(dir, "arnative", "usage-cache.json");
		writeFileSync(
			cachePath,
			JSON.stringify({ [join("a", "a.jsonl")]: { m: st.mtimeMs, s: st.size, c: st.size, r: { "google\u0000m1": [99, 999, 1, 1, 1, 9, 9] }, d: { [`${today}\u0000google\u0000m1`]: [99, 999, 1, 1, 1, 9, 9] } } }),
		);
		resetUsageCache();
		const reparsed = collectUsageSummary(true);
		assert.equal(reparsed.totals.msgs, cold.totals.msgs);
		assert.equal(reparsed.totals.input, 100, "the stale 99 is not counted");
		const disk = cacheOf(dir)[join("a", "a.jsonl")]!;
		assert.equal(disk.t, 8, "the re-parsed item is re-saved as the current version");
	});
});
