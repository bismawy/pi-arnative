/**
 * The Prometheus exposition renderer — `extensions/usage-export.ts`, `renderProm`. Pure, no I/O:
 * the summary in, the exposition text out, so it is the unit under test here. The throttled
 * writer (`exportProm`, temp file + rename) is pinned in the extension self-check
 * (`node extensions/usage-export.ts`). Run with `npm test` (`node --test`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderProm } from "../extensions/usage-export.ts";
import type { UsageSummary } from "../lib/usage-store.ts";

const NL = String.fromCharCode(10);

/** A summary literal with the given providers and total overrides. */
const mkSummary = (providers: UsageSummary["providers"], totals: Partial<UsageSummary["totals"]>): UsageSummary => ({
	providers,
	projects: [],
	totals: { sessions: 0, msgs: 0, input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: 0, reportedCost: 0, estimatedCost: 0, ...totals },
});

/** Every sample line of an exposition must parse as `name{labels} value` with a numeric value. */
const sampleLines = (text: string): string[] =>
	text
		.trimEnd()
		.split(NL)
		.filter((l) => !l.startsWith("#"))
		.filter((l) => assert.match(l, /^[a-z_0-9]+(\{[^}]*\})? \S+$/) as unknown as boolean);

test("every sample line parses as name{labels} value, with HELP and TYPE per family", () => {
	const summary = mkSummary(
		[
			{
				name: "google",
				sessions: 2,
				msgs: 3,
				input: 1000,
				output: 500,
				cacheRead: 200,
				totalTokens: 1500,
				cost: 0.5,
				estimatedCost: 0.25,
				models: [{ name: "gemini-3.8-flash", sessions: 2, msgs: 3, input: 1000, output: 500, cacheRead: 200, totalTokens: 1500, cost: 0.5, estimatedCost: 0.25 }],
			},
		],
		{ sessions: 2, cost: 0.5, estimatedCost: 0.25, today: { cost: 0.5, input: 1000, output: 500, cacheRead: 200 }, last30d: { cost: 0.5, input: 1000, output: 500, cacheRead: 200 } },
	);
	const text = renderProm(summary, 1_700_000_000_000);
	const lines = text.trimEnd().split(NL);
	for (const line of sampleLines(text)) {
		const m = /^([a-z_0-9]+)(\{[^}]*\})? (\S+)$/.exec(line)!;
		assert.ok(Number.isFinite(Number(m[3])), `numeric value: ${line}`);
	}
	// One HELP + TYPE per metric name, each ahead of its samples.
	for (const name of ["arnative_cost_billed_total", "arnative_cost_estimated_total", "arnative_cost_today", "arnative_cost_30d", "arnative_tokens_total", "arnative_sessions_total", "arnative_usage_last_scan_timestamp_seconds"]) {
		const helpAt = lines.findIndex((l) => l.startsWith(`# HELP ${name} `));
		const typeAt = lines.findIndex((l) => l === `# TYPE ${name} gauge`);
		const firstSample = lines.findIndex((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
		assert.ok(helpAt !== -1 && typeAt === helpAt + 1 && firstSample > typeAt, `${name} carries HELP/TYPE ahead of its samples`);
	}
	assert.equal(new Set(lines.filter((l) => l.startsWith("# TYPE")).map((l) => l.slice(8, -6))).size, 7, "seven metric families");
});

test("billed and estimated cost never share a metric, and the day buckets render", () => {
	const summary = mkSummary([], { sessions: 3, cost: 0.5, estimatedCost: 0.25, today: { cost: 0.1, input: 0, output: 0, cacheRead: 0 }, last30d: { cost: 0.4, input: 0, output: 0, cacheRead: 0 } });
	const text = renderProm(summary, 1_700_000_000_000);
	assert.ok(text.includes("arnative_cost_billed_total 0.5\n"), "billed only: " + text);
	assert.ok(text.includes("arnative_cost_estimated_total 0.25\n"), "estimated under its own _estimated name: " + text);
	assert.ok(!text.includes("arnative_cost_total"), "no metric mixes the two");
	assert.ok(text.includes("arnative_cost_today 0.1\n") && text.includes("arnative_cost_30d 0.4\n"), "today/30d buckets: " + text);
	assert.ok(text.includes("arnative_sessions_total 3\n"), "sessions: " + text);
	assert.ok(text.includes("arnative_usage_last_scan_timestamp_seconds 1700000000\n"), "scan timestamp in seconds: " + text);
});

test("token rows carry provider, model and kind labels, escaped per the exposition format", () => {
	const summary = mkSummary(
		[
			{
				name: 'pro"v\\x',
				sessions: 1,
				msgs: 1,
				input: 10,
				output: 5,
				cacheRead: 2,
				totalTokens: 15,
				cost: 0,
				estimatedCost: 0,
				models: [{ name: "m\n1", sessions: 1, msgs: 1, input: 10, output: 5, cacheRead: 2, totalTokens: 15, cost: 0, estimatedCost: 0 }],
			},
		],
		{},
	);
	const text = renderProm(summary, 1_700_000_000_000);
	assert.ok(
		text.includes('arnative_tokens_total{provider="pro\\"v\\\\x",model="m\\n1",kind="input"} 10\n'),
		`backslash, quote and newline are escaped (no raw newline inside a label): ${JSON.stringify(text)}`,
	);
	assert.ok(text.includes('kind="output"} 5\n') && text.includes('kind="cache_read"} 2\n'), "all three kinds render: " + text);
	// A raw newline in a label value would split the line and break the parse.
	for (const line of sampleLines(text)) assert.match(line, /^[a-z_0-9]+(\{[^}]*\})? \S+$/);
});

test("an empty summary renders valid text with zeros", () => {
	const text = renderProm(mkSummary([], {}), 1_700_000_000_000);
	for (const line of sampleLines(text)) assert.match(line, /^[a-z_0-9]+( \S+|\{[^}]*\} \S+)$/);
	for (const name of ["arnative_cost_billed_total", "arnative_cost_estimated_total", "arnative_cost_today", "arnative_cost_30d", "arnative_sessions_total"]) {
		assert.ok(text.includes(`${name} 0\n`), `${name} renders 0: ${text}`);
	}
	assert.ok(!text.includes("arnative_tokens_total{"), "no token rows without providers: " + text);
	assert.ok(text.endsWith("\n"), "the exposition ends with a newline");
});

test("two renders of the same summary are byte-identical", () => {
	const summary = mkSummary(
		[
			{
				name: "google",
				sessions: 1,
				msgs: 1,
				input: 7,
				output: 3,
				cacheRead: 1,
				totalTokens: 10,
				cost: 0.02,
				estimatedCost: 0.01,
				models: [{ name: "m", sessions: 1, msgs: 1, input: 7, output: 3, cacheRead: 1, totalTokens: 10, cost: 0.02, estimatedCost: 0.01 }],
			},
		],
		{ sessions: 1, cost: 0.02, estimatedCost: 0.01 },
	);
	assert.equal(renderProm(summary, 42_000), renderProm(summary, 42_000));
	assert.notEqual(renderProm(summary, 42_000), renderProm(summary, 43_000), "the scan timestamp moves with `now`");
});
