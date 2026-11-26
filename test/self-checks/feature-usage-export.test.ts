import test from "node:test";
import { assert } from "../helpers/check.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUsageCache, type UsageSummary } from "../../lib/usage-store.ts";
import { EXPORT_ENV, promFilePath, renderProm, writePromFile, exportProm } from "../../lib/features/usage.ts";

test("lib/features/usage.ts export self-check", async () => {
	const NL = String.fromCharCode(10);

	// ---- the renderer: pure, no agent dir involved ----
	const emptySummary: UsageSummary = {
		providers: [],
		projects: [],
		totals: { sessions: 0, msgs: 0, input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: 0, reportedCost: 0, estimatedCost: 0 },
	};
	const empty = renderProm(emptySummary, 1_700_000_000_000);
	assert(
		empty ===
			[
				"# HELP arnative_cost_billed_total Provider-billed cost in USD across all sessions (totalFromProvider; estimates never mixed in).",
				"# TYPE arnative_cost_billed_total gauge",
				"arnative_cost_billed_total 0",
				"# HELP arnative_cost_estimated_total Catalog-estimated cost in USD from models.json rates; never billed.",
				"# TYPE arnative_cost_estimated_total gauge",
				"arnative_cost_estimated_total 0",
				"# HELP arnative_cost_today Provider-billed cost in USD in the current UTC day (the day buckets).",
				"# TYPE arnative_cost_today gauge",
				"arnative_cost_today 0",
				"# HELP arnative_cost_30d Provider-billed cost in USD over the last 30 UTC days (the day buckets).",
				"# TYPE arnative_cost_30d gauge",
				"arnative_cost_30d 0",
				"# HELP arnative_tokens_total Token usage by provider, model and kind.",
				"# TYPE arnative_tokens_total gauge",
				"# HELP arnative_sessions_total Distinct Pi session files scanned.",
				"# TYPE arnative_sessions_total gauge",
				"arnative_sessions_total 0",
				"# HELP arnative_usage_last_change_timestamp_seconds Unix time this process last saw the usage data change (not the last scrape).",
				"# TYPE arnative_usage_last_change_timestamp_seconds gauge",
				"arnative_usage_last_change_timestamp_seconds 1700000000",
			].join(NL) + NL,
		"an empty summary renders the pinned exposition, zeros included: " + JSON.stringify(empty),
	);

	const full: UsageSummary = {
		providers: [
			{
				name: 'pro"v\\x',
				sessions: 1,
				msgs: 1,
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 4,
				totalTokens: 15,
				cost: 0.02,
				estimatedCost: 0.01,
				models: [{ name: "m\n1", sessions: 1, msgs: 1, input: 10, output: 5, cacheRead: 2, cacheWrite: 4, totalTokens: 15, cost: 0.02, estimatedCost: 0.01 }],
			},
		],
		projects: [],
		totals: {
			sessions: 1,
			msgs: 1,
			input: 10,
			output: 5,
			cacheRead: 2,
			totalTokens: 15,
			cost: 0.02,
			reportedCost: 0.02,
			estimatedCost: 0.01,
			today: { cost: 0.02, estimated: 0, input: 10, output: 5, cacheRead: 2 },
			last30d: { cost: 0.02, estimated: 0, input: 10, output: 5, cacheRead: 2 },
		},
	};
	const text = renderProm(full, 1_700_000_000_000);
	assert(text === renderProm(full, 1_700_000_000_000), "two renders of the same summary are byte-identical");
	for (const line of text.trimEnd().split(NL)) {
		if (line.startsWith("#")) continue;
		const m = /^([a-z_0-9]+)(\{[^}]*\})? (\S+)$/.exec(line);
		assert(m !== null && Number.isFinite(Number(m[3])), "a sample line parses as name{labels} value: " + JSON.stringify(line));
	}
	assert(text.includes('arnative_tokens_total{provider="pro\\"v\\\\x",model="m\\n1",kind="input"} 10'), "label values escape backslash, quote and newline: " + JSON.stringify(text));
	assert(text.includes('arnative_tokens_total{provider="pro\\"v\\\\x",model="m\\n1",kind="output"} 5'), "the output kind is labelled: " + text);
	assert(text.includes('arnative_tokens_total{provider="pro\\"v\\\\x",model="m\\n1",kind="cache_read"} 2'), "the cache_read kind is labelled: " + text);
	assert(text.includes("arnative_cost_billed_total 0.02\n"), "billed cost is its own metric: " + text);
	assert(text.includes("arnative_cost_estimated_total 0.01\n"), "the estimate is never folded into the billed _total: " + text);
	assert(text.includes("arnative_cost_today 0.02\n") && text.includes("arnative_cost_30d 0.02\n"), "the today/30d buckets render: " + text);
	assert(text.includes("arnative_sessions_total 1\n"), "the session count renders: " + text);

	// ---- the writer: pointed at a temp dir, never at the real agent dir ----
	const fixture = mkdtempSync(join(tmpdir(), "arnative-export-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = fixture;
	resetUsageCache();
	assert(promFilePath() === join(fixture, "arnative", "usage.prom"), "the default target is <agent dir>/arnative/usage.prom");

	mkdirSync(join(fixture, "sessions", "p"), { recursive: true });
	const sessionFile = join(fixture, "sessions", "p", "s.jsonl");
	const asst = (input: number, cost: number) =>
		JSON.stringify({
			message: { role: "assistant", provider: "google", model: "m1", timestamp: Date.now(), usage: { input, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: cost, totalFromProvider: true } } },
		});
	writeFileSync(sessionFile, asst(100, 0.5) + NL);
	const path = join(fixture, "usage.prom");
	// Epoch-scale `now` values, so the throttle (which starts at 0) lets the first call through.
	const T0 = 1_700_000_000_000;

	assert(exportProm(T0, path) === true, "the first export writes");
	const first = readFileSync(path, "utf8");
	assert(first.includes("arnative_cost_billed_total 0.5\n"), "the file carries the billed cost: " + first);
	assert(first.includes('arnative_tokens_total{provider="google",model="m1",kind="input"} 100\n'), "the file carries the token rows: " + first);
	assert(first.includes("arnative_usage_last_change_timestamp_seconds 1700000000\n"), "the scan timestamp is the export time in seconds: " + first);
	assert(exportProm(T0 + 2_000, path) === false, "throttled: no second write within 60s");
	assert(readFileSync(path, "utf8") === first, "the throttled attempt did not touch the file");
	assert(exportProm(T0 + 61_000, path) === false, "past the throttle but unchanged data: the diff skips the write");
	assert(readFileSync(path, "utf8") === first, "an idle session does not touch the file");

	writeFileSync(sessionFile, asst(50, 0.25) + NL, { flag: "a" });
	resetUsageCache();
	assert(exportProm(T0 + 122_000, path) === true, "changed data past the throttle writes again");
	const second = readFileSync(path, "utf8");
	assert(
		second.includes("arnative_cost_billed_total 0.75\n") && second.includes('kind="input"} 150\n') && second.includes("arnative_usage_last_change_timestamp_seconds 1700000122\n"),
		"the new spend, tokens and scan time land: " + second,
	);

	process.env[EXPORT_ENV] = "0";
	writeFileSync(sessionFile, asst(1, 0.125) + NL, { flag: "a" });
	resetUsageCache();
	assert(exportProm(T0 + 200_000, path) === false, `${EXPORT_ENV}=0 disables the export`);
	assert(readFileSync(path, "utf8") === second, "the disabled export did not touch the file");
	delete process.env[EXPORT_ENV];
	assert(exportProm(T0 + 261_000) === true, "re-enabled past the throttle, it writes to the default path");
	assert(existsSync(join(fixture, "arnative", "usage.prom")), "the default path is <agent dir>/arnative/usage.prom");

	writeFileSync(sessionFile, asst(1, 0.0625) + NL, { flag: "a" });
	resetUsageCache();
	writeFileSync(join(fixture, "blocked"), "not a directory", "utf8");
	assert(exportProm(T0 + 400_000, join(fixture, "blocked", "usage.prom")) === false, "an unwritable target is swallowed, not thrown");

	// Windows: a rename refused with EPERM falls back to an in-place write (the rename seam).
	const seamPath = join(fixture, "seam", "usage.prom");
	const locked = (): never => {
		throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
	};
	writePromFile("seamed\n", seamPath, locked);
	assert(readFileSync(seamPath, "utf8") === "seamed\n", "a refused rename still writes the file in place");
	assert(!existsSync(`${seamPath}.${process.pid}.tmp`), "no temp file is left behind after the fallback");

	rmSync(fixture, { recursive: true, force: true });
	if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevDir;
	resetUsageCache();
});
