import test from "node:test";
import { assert } from "../helpers/check.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPriceTable, estimateCost, TOOL_PROVIDER, resetUsageCache, collectUsageSummary, __test } from "../../lib/usage-store.ts";

const { CACHE_VERSION, SUBAGENT_ARTIFACTS_DIR } = __test;

test("lib/usage-store.ts self-check", async () => {
	const NL = String.fromCharCode(10);
	const fixture = mkdtempSync(join(tmpdir(), "arnative-store-"));
	process.env.PI_CODING_AGENT_DIR = fixture;
	const asst = (model: string, input: number, ts: number, cost = 0.02) =>
		JSON.stringify({
			message: {
				role: "assistant",
				provider: "google",
				model,
				timestamp: ts,
				usage: { input, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: cost, totalFromProvider: true } },
			},
		});
	const header = (cwd: string) => JSON.stringify({ type: "session", cwd });
	const tsToday = Date.now();
	const tsYesterday = Date.now() - 86_400_000;
	const today = new Date(tsToday).toISOString().slice(0, 10);
	const yesterday = new Date(tsYesterday).toISOString().slice(0, 10);

	mkdirSync(join(fixture, "sessions", "proj-a"), { recursive: true });
	mkdirSync(join(fixture, "sessions", "proj-b"), { recursive: true });
	// proj-a carries a session header (cwd); proj-b has none, so it must land in "unknown".
	const fileA = join(fixture, "sessions", "proj-a", "a.jsonl");
	writeFileSync(fileA, [header("/repo/alpha"), asst("m1", 100, tsToday), asst("m1", 50, tsYesterday)].join(NL) + NL);
	writeFileSync(join(fixture, "sessions", "proj-b", "b.jsonl"), asst("m2", 7, tsToday) + NL);

	const summary = collectUsageSummary(true);
	assert(summary.projects.length === 2, "one project per cwd plus unknown");
	const alpha = summary.projects.find((p) => p.name === "/repo/alpha")!;
	const unknown = summary.projects.find((p) => p.name === "unknown")!;
	assert(alpha.msgs === 2 && alpha.input === 150 && Math.abs(alpha.cost - 0.04) < 1e-9, "a project row carries its files' totals");
	assert(unknown.msgs === 1 && unknown.input === 7, "a file with no cwd lands in unknown");
	assert(alpha.providers.length === 1 && alpha.providers[0]!.name === "google" && alpha.providers[0]!.models[0]!.name === "m1", "a project trees into its providers and models");
	const sumOf = (f: (p: (typeof summary.projects)[number]) => number) => summary.projects.reduce((n, p) => n + f(p), 0);
	assert(
		sumOf((p) => p.msgs) === summary.totals.msgs &&
			sumOf((p) => p.input) === summary.totals.input &&
			sumOf((p) => p.output) === summary.totals.output &&
			Math.abs(sumOf((p) => p.cost) - summary.totals.cost) < 1e-9,
		"projects totals equal totals",
	);

	// Day buckets: windows come from them, and on disk they sum to the file total.
	assert(summary.totals.today !== undefined && summary.totals.last7d !== undefined && summary.totals.last30d !== undefined, "day buckets produce the today/7d/30d windows");
	assert(summary.totals.today.input === 107 && Math.abs(summary.totals.today.cost - 0.04) < 1e-9, "today sums only today's bucket");
	assert(summary.totals.last7d.input === 157 && Math.abs(summary.totals.last7d.cost - 0.06) < 1e-9, "last7d includes yesterday");
	assert(summary.totals.last30d.input === 157, "last30d includes yesterday too");
	const cachePath = join(fixture, "arnative", "usage-cache.json");
	const disk = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { r: Record<string, number[]>; d?: Record<string, number[]>; w?: string }>;
	const relA = join("proj-a", "a.jsonl");
	const msgsOf = (rows: Record<string, number[]>) => Object.values(rows).reduce((n, a) => n + a[0]!, 0);
	assert(disk[relA]!.w === "/repo/alpha", "v8 stores the session cwd in w");
	assert(disk[relA]!.d !== undefined && msgsOf(disk[relA]!.d!) === msgsOf(disk[relA]!.r), "day buckets sum to the file total on disk");
	const rowA = disk[relA]!.r["google\u0000m1"]!;
	assert(rowA.length === 7 && rowA[4] === 4, "v8 rows carry cacheWrite (two entries x 2)");
	assert(Math.abs(rowA[6]! - 0.04) < 1e-9, "v8 rows carry the billed split of the cost");
	assert(
		Object.keys(disk[relA]!.d!).every((k) => k.startsWith(`${today}\u0000`) || k.startsWith(`${yesterday}\u0000`)) && disk[relA]!.d![`${today}\u0000google\u0000m1`] !== undefined,
		"day keys are the UTC day + provider + model",
	);
	assert(disk[join("proj-b", "b.jsonl")]!.w === "", "a file with no cwd stores the empty marker (it reads as unknown)");

	// A grown file tail-folds: the cwd stays the cached one (the head is not re-read) and the
	// new entry lands in its day bucket.
	writeFileSync(fileA, asst("m1", 1000, tsToday) + NL, { flag: "a" });
	const grown = collectUsageSummary(true);
	assert(grown.totals.msgs === 4, "an appended record is folded from the tail");
	assert(grown.projects.find((p) => p.name === "/repo/alpha")!.input === 1150, "the tail fold keeps the cached cwd (the project is unchanged)");
	assert(grown.totals.today!.input === 1107, "the appended entry lands in today's bucket");
	const grownDisk = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { w?: string }>;
	assert(grownDisk[relA]!.w === "/repo/alpha", "the cwd survives a tail fold on disk too");

	// A pre-v8 (v5 compact, no `d`) cache item is re-parsed once from its file — not trusted —
	// and re-saved as v8 with its days, cwd, cache writes, billed split and tool-result spend.
	const fileC = join(fixture, "sessions", "proj-b", "c.jsonl");
	writeFileSync(fileC, asst("m2", 11, tsToday) + NL);
	const cStat = statSync(fileC);
	writeFileSync(
		cachePath,
		JSON.stringify({ [join("proj-b", "c.jsonl")]: { m: cStat.mtimeMs, s: cStat.size, c: cStat.size, r: { "google\u0000m2": [99, 999, 1, 1, 9] } } }),
	);
	resetUsageCache();
	const reparsed = collectUsageSummary(true);
	assert(reparsed.totals.msgs === 5 && reparsed.totals.input === 1168, "a v5 cache item is re-parsed from the file (the stale 99 is not counted)");
	const afterDisk = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { d?: Record<string, number[]>; w?: string }>;
	const relC = join("proj-b", "c.jsonl");
	assert(afterDisk[relC]!.d !== undefined && msgsOf(afterDisk[relC]!.d!) === 1, "the re-parsed item is re-saved as v8 with day buckets");

	// A v6 item (day buckets but 5-number rows) is also re-parsed once: its rows carry neither
	// cacheWrite nor the billed split, so it is stamped 6 and not trusted.
	const fileD = join(fixture, "sessions", "proj-b", "d.jsonl");
	writeFileSync(fileD, asst("m2", 13, tsToday) + NL);
	const dStat = statSync(fileD);
	writeFileSync(
		cachePath,
		JSON.stringify({
			[join("proj-b", "d.jsonl")]: {
				m: dStat.mtimeMs,
				s: dStat.size,
				c: dStat.size,
				r: { "google\u0000m2": [99, 999, 1, 1, 9] },
				d: { [`${today}\u0000google\u0000m2`]: [99, 999, 1, 1, 9] },
			},
		}),
	);
	resetUsageCache();
	const reparsed6 = collectUsageSummary(true);
	assert(reparsed6.totals.msgs === 6 && reparsed6.totals.input === 1181, "a v6 cache item is re-parsed from its file (the stale 99 is not counted)");

	// Child spend: pi attaches it to the tool result, but the child also writes its own session
	// file, so the store must not read the tool result — that counts the same tokens twice.
	// Its own fixture, so the totals above stay untouched.
	assert(TOOL_PROVIDER === "tool", "child spend is attributed to the synthetic `tool` provider");
	const toolFixture = mkdtempSync(join(tmpdir(), "arnative-tool-"));
	process.env.PI_CODING_AGENT_DIR = toolFixture;
	resetUsageCache();
	mkdirSync(join(toolFixture, "sessions", "p"), { recursive: true });
	const toolFile = join(toolFixture, "sessions", "p", "t.jsonl");
	const toolResult = (toolName: string, usage?: object) =>
		JSON.stringify({
			message: { role: "toolResult", toolCallId: "c1", toolName, content: [], isError: false, timestamp: tsToday, ...(usage ? { usage } : {}) },
		});
	writeFileSync(
		toolFile,
		[
			header("/repo/alpha"),
			asst("m1", 100, tsToday),
			toolResult("subagent", { input: 40, output: 6, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01, totalFromProvider: true } }),
			toolResult("bash"), // no usage at all
		].join(NL) + NL,
	);
	const parentOnly = collectUsageSummary(true);
	assert(parentOnly.totals.msgs === 1 && parentOnly.totals.input === 100, "a tool result's usage is not read: the child's own session file carries it");
	assert(parentOnly.providers.every((p) => p.name !== TOOL_PROVIDER), "no synthetic `tool` row: /usage never sees child spend twice");

	// A subagent run writes <project>/<parent id>/<run id>/run-N/session.jsonl, and its
	// transcript under <project>/subagent-artifacts/: the child session is real spend, the
	// transcript is the same messages again.
	const childDir = join(toolFixture, "sessions", "p", "parent-1", "run-1", "run-0");
	mkdirSync(childDir, { recursive: true });
	writeFileSync(join(childDir, "session.jsonl"), [header("/repo/alpha"), asst("m1", 40, tsToday)].join(NL) + NL);
	mkdirSync(join(toolFixture, "sessions", "p", SUBAGENT_ARTIFACTS_DIR), { recursive: true });
	writeFileSync(
		join(toolFixture, "sessions", "p", SUBAGENT_ARTIFACTS_DIR, "x_transcript.jsonl"),
		[header("/repo/alpha"), asst("m1", 7, tsToday)].join(NL) + NL,
	);
	resetUsageCache();
	const nested = collectUsageSummary(true);
	assert(nested.totals.msgs === 2 && nested.totals.input === 140, "a child session is counted once (40), its transcript not at all (7)");
	assert(nested.totals.sessions === 2, "the parent session and the child session, not the transcript");

	// A v7 item (7-number rows with day buckets, no `t`) is re-parsed once from its file — not
	// trusted — and re-saved as v8.
	const tStat = statSync(toolFile);
	writeFileSync(
		join(toolFixture, "arnative", "usage-cache.json"),
		JSON.stringify({
			[join("p", "t.jsonl")]: {
				m: tStat.mtimeMs,
				s: tStat.size,
				c: tStat.size,
				r: { "google\u0000m1": [99, 999, 1, 1, 1, 9, 9] },
				d: { [`${today}\u0000google\u0000m1`]: [99, 999, 1, 1, 1, 9, 9] },
			},
		}),
	);
	resetUsageCache();
	const reparsed7 = collectUsageSummary(true);
	assert(reparsed7.totals.msgs === 2 && reparsed7.totals.input === 140, "a v7 cache item is re-parsed from its file (the stale 99 is not counted)");
	const after7 = JSON.parse(readFileSync(join(toolFixture, "arnative", "usage-cache.json"), "utf8")) as Record<string, { t?: number }>;
	assert(after7[join("p", "t.jsonl")]!.t === CACHE_VERSION, "the re-parsed item is re-saved as the current version");

	// A cache written by the build that also stored tool-result rows is stamped `t: 8`: it must
	// be re-parsed, or the child spend it holds is counted a second time next to the child's file.
	const staleDisk = JSON.parse(readFileSync(join(toolFixture, "arnative", "usage-cache.json"), "utf8")) as Record<string, unknown>;
	staleDisk[join("p", "t.jsonl")] = {
		m: tStat.mtimeMs,
		s: tStat.size,
		c: tStat.size,
		t: 8,
		r: { [`${TOOL_PROVIDER}\u0000subagent`]: [1, 40, 6, 2, 1, 0.01, 0.01], "google\u0000m1": [1, 100, 5, 1, 0, 0.02, 0.02] },
	};
	writeFileSync(join(toolFixture, "arnative", "usage-cache.json"), JSON.stringify(staleDisk));
	resetUsageCache();
	const afterStale = collectUsageSummary(true);
	assert(afterStale.providers.every((p) => p.name !== TOOL_PROVIDER), "a `t: 8` item's tool rows are dropped: the item is re-parsed");
	assert(afterStale.totals.input === 140, "the re-parsed item keeps the parent and the child, once each");

	// An empty session (no assistant message) writes `r: {}`: that is a current item, not a
	// pre-v7 one — `some` over an empty map is false, and treating it as old would re-read that
	// file on every start. A tampered row proves the item is trusted rather than re-parsed.
	const emptyFile = join(toolFixture, "sessions", "p", "empty.jsonl");
	writeFileSync(emptyFile, header("/repo/alpha") + NL);
	resetUsageCache();
	collectUsageSummary(true);
	const emptyCachePath = join(toolFixture, "arnative", "usage-cache.json");
	const emptyDisk = JSON.parse(readFileSync(emptyCachePath, "utf8")) as Record<string, { r: Record<string, number[]> }>;
	assert(emptyDisk[join("p", "empty.jsonl")] !== undefined, "an empty session is cached");
	emptyDisk[join("p", "empty.jsonl")]!.r = { "google\u0000m9": [5, 500, 0, 0, 0, 0, 0] };
	writeFileSync(emptyCachePath, JSON.stringify(emptyDisk));
	resetUsageCache();
	assert(collectUsageSummary(true).totals.input === 640, "an empty `r` item is trusted, not re-read on every start");
	rmSync(toolFixture, { recursive: true, force: true });
	process.env.PI_CODING_AGENT_DIR = fixture;
	resetUsageCache();

	// Price table: cacheWrite is priced like the other three, and an unchanged models.json is
	// read once — two loadPriceTable() calls return the same memo object.
	writeFileSync(
		join(fixture, "models.json"),
		JSON.stringify({ providers: { google: { models: [{ id: "m1", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 } }] } } }),
	);
	const table1 = loadPriceTable();
	assert(table1 === loadPriceTable(), "two loadPriceTable() calls with an unchanged file read it once (memo identity)");
	assert(estimateCost(1_000_000, 0, 0, 0, "m1", "google") === 1, "input keeps its own rate");
	assert(estimateCost(0, 0, 0, 1_000_000, "m1", "google") === 3, "cache writes use their own rate");
	assert(Math.abs(estimateCost(0, 0, 1_000_000, 1_000_000, "m1", "google")! - 3.1) < 1e-9, "cache read and cache write add up");
	await new Promise((r) => setTimeout(r, 5)); // mtime granularity: a rewrite must change the memo key
	writeFileSync(
		join(fixture, "models.json"),
		JSON.stringify({ providers: { google: { models: [{ id: "m1", cost: { input: 10, output: 2, cacheRead: 0.1, cacheWrite: 3 } }] } } }),
	);
	const table2 = loadPriceTable();
	assert(table2 !== table1 && estimateCost(1_000_000, 0, 0, 0, "m1", "google") === 10, "a changed models.json is re-read");

	rmSync(fixture, { recursive: true, force: true });
});
