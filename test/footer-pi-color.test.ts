import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../lib/ansi.ts";
import { formatPiTokens, renderPiColorFooter, type PiColorPainters } from "../lib/features/footer.ts";

const tagPainters: PiColorPainters = {
	acc: (t) => `<acc:${t}>`,
	dim: (t) => `<dim:${t}>`,
	primary: (t) => `<pri:${t}>`,
	secondarySoft: (t) => `<soft:${t}>`,
	warning: (t) => `<warn:${t}>`,
	error: (t) => `<err:${t}>`,
};

test("Pi (color) keeps Pi's built-in 2-row + status-row structure with Arnative colors", () => {
	const lines = renderPiColorFooter({
		cwd: "/home/bisma/project",
		home: "/home/bisma",
		branch: "main",
		sessionName: "refactor",
		stats: {
			input: 12400,
			output: 3400,
			cacheRead: 89000,
			cacheWrite: 4200,
			cost: 0.123,
			latestCacheHitRate: 84.3,
		},
		contextPercent: 42.5,
		contextWindow: 200000,
		autoCompactEnabled: true,
		model: { id: "remote/agy-cli/gemini-4-neon", provider: "magpie", reasoning: true },
		thinkingLevel: "medium",
		availableProviderCount: 2,
		extensionStatuses: new Map([
			["z-last", "tail"],
			["a-first", "head"],
		]),
		width: 320,
		painters: tagPainters,
	});

	assert.equal(lines.length, 3);
	// Row 1: dim cwd, full accent (branch), secondarySoft session name.
	assert.ok(lines[0]!.includes("<dim:~"));
	assert.ok(lines[0]!.includes("<acc:(main)>"));
	assert.ok(lines[0]!.includes("<dim: • ><soft:refactor>"));

	// Row 2: accent symbols + soft values (matching Pi's built-in token rounding) on the left, dim provider + primary model + accent thinking on the right.
	assert.ok(lines[1]!.includes("<acc:↑><soft:12k>"));
	assert.equal(formatPiTokens(0), "0");
	assert.equal(formatPiTokens(2000), "2.0k");
	assert.equal(formatPiTokens(12400), "12k");
	assert.equal(formatPiTokens(1000000), "1.0M");
	assert.equal(formatPiTokens(12300000), "12M");
	assert.ok(lines[1]!.includes("<acc:↓><soft:3.4k>"));
	assert.ok(lines[1]!.includes("<acc:R><soft:89k>"));
	assert.ok(lines[1]!.includes("<acc:W><soft:4.2k>"));
	assert.ok(lines[1]!.includes("<acc:CH><soft:84.3%>"));
	assert.ok(lines[1]!.includes("<acc:$><soft:0.123>"));
	assert.ok(lines[1]!.includes("<soft:42.5%><dim:/200k (auto)>"));
	assert.ok(lines[1]!.includes("<dim:(magpie) ><pri:remote/agy-cli/gemini-4-neon><dim: • ><acc:medium>"));

	// Row 3: sorted alphabetically by key, plain statuses painted secondarySoft.
	assert.equal(lines[2], "<soft:head> <soft:tail>");
});

test("Pi (color) omits row 3 when there are no extension statuses and applies warning/error thresholds", () => {
	const warnLines = renderPiColorFooter({
		cwd: "/tmp/work",
		home: "/home/bisma",
		branch: null,
		stats: { input: 500, output: 100, cacheRead: 100, cacheWrite: 0, cost: 1.5, latestCacheHitRate: 55.0 },
		budgetBand: "warn",
		contextPercent: 75.0,
		contextWindow: 100000,
		model: { id: "claude-sonnet", provider: "anthropic", reasoning: true },
		thinkingLevel: "off",
		availableProviderCount: 1,
		extensionStatuses: new Map(),
		width: 240,
		painters: tagPainters,
	});

	assert.equal(warnLines.length, 2);
	assert.ok(warnLines[1]!.includes("<warn:CH><warn:55.0%>"));
	assert.ok(warnLines[1]!.includes("<warn:$><warn:1.500>"));
	assert.ok(warnLines[1]!.includes("<warn:75.0%/100k>"));
	assert.ok(warnLines[1]!.includes("<pri:claude-sonnet><dim: • thinking off>"));
	assert.ok(!warnLines[1]!.includes("(anthropic)"));

	const errLines = renderPiColorFooter({
		cwd: "/tmp/work",
		home: "/home/bisma",
		branch: null,
		stats: { input: 500, output: 100, cacheRead: 10, cacheWrite: 0, cost: 2.0, latestCacheHitRate: 20.0 },
		budgetBand: "over",
		contextPercent: 95.2,
		contextWindow: 100000,
		model: undefined,
		availableProviderCount: 1,
		extensionStatuses: new Map(),
		width: 240,
		painters: tagPainters,
	});

	assert.ok(errLines[1]!.includes("<err:CH><err:20.0%>"));
	assert.ok(errLines[1]!.includes("<err:$><err:2.000>"));
	assert.ok(errLines[1]!.includes("<err:95.2%/100k>"));
	assert.ok(errLines[1]!.includes("<dim:no-model>"));
});

test("Pi (color) drops provider prefix before truncating right side on narrow widths", () => {
	const ansiPainters: PiColorPainters = {
		acc: (t) => `\x1b[36m${t}\x1b[0m`,
		dim: (t) => `\x1b[2m${t}\x1b[0m`,
		primary: (t) => `\x1b[1m${t}\x1b[0m`,
		secondarySoft: (t) => `\x1b[37m${t}\x1b[0m`,
		warning: (t) => `\x1b[33m${t}\x1b[0m`,
		error: (t) => `\x1b[31m${t}\x1b[0m`,
	};
	const lines = renderPiColorFooter({
		cwd: "/tmp/work",
		home: "/home/bisma",
		branch: "feat/test",
		stats: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
		contextPercent: 10.0,
		contextWindow: 100000,
		autoCompactEnabled: true,
		model: { id: "gemini-4-neon", provider: "magpie", reasoning: true },
		thinkingLevel: "low",
		availableProviderCount: 2,
		extensionStatuses: new Map(),
		width: 50,
		painters: ansiPainters,
	});

	const plainRow2 = stripAnsi(lines[1]!);
	assert.ok(plainRow2.length <= 50, `row 2 width ${plainRow2.length} must fit within 50`);
	assert.ok(!plainRow2.includes("(magpie)"), "provider prefix is dropped when it would overflow");
	assert.ok(plainRow2.includes("gemini-4-neon • low"), "model id and thinking level stay visible");
});
