import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { UsageModalComponent } from "../extensions/usage.ts";
import { collectUsageSummary, getModelAllTimeUsage, resetUsageCache, USAGE_RANGES } from "../lib/usage-store.ts";

let dir: string;
let previous: string | undefined;
const theme = { fg: (_color: string, text: string) => text };
const modal = () => new UsageModalComponent(theme, () => {}, () => {});
const confirm = (panel: UsageModalComponent, key = "R") => {
	panel.handleInput(key);
	panel.handleInput("y");
};
const message = (provider: string, input: number, timestamp = new Date().toISOString()) => JSON.stringify({ timestamp, message: { role: "assistant", provider, model: "test-model", usage: { input, output: 10, cacheRead: 20, cost: { total: 0.01 } } } }) + "\n";
const seed = (name: string, content: string) => {
	const file = join(dir, "sessions", "project", name);
	writeFileSync(file, content);
	return file;
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "arnative-usage-reset-"));
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	mkdirSync(join(dir, "sessions", "project"), { recursive: true });
	resetUsageCache();
});

afterEach(() => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	resetUsageCache();
	rmSync(dir, { recursive: true, force: true });
});

test("reset zeros statistics across providers without changing any session bytes", () => {
	const first = message("first-provider", 100);
	const second = message("second-provider", 200);
	const a = seed("a.jsonl", first);
	const b = seed("b.jsonl", second);
	const panel = modal();
	confirm(panel);
	assert.equal(readFileSync(a, "utf8"), first);
	assert.equal(readFileSync(b, "utf8"), second);
	assert.equal(existsSync(join(dir, "arnative", "usage-trash")), false);
	for (const range of USAGE_RANGES) {
		const summary = collectUsageSummary(true, range);
		assert.equal(summary.totals.msgs, 0, range);
		assert.equal(summary.totals.totalTokens, 0, range);
		assert.equal(summary.totals.cost, 0, range);
		assert.equal(summary.totals.sessions, 0, range);
		assert.deepEqual(summary.providers, [], range);
	}
});


test("new messages in existing and new sessions count after reset and cache rebuild", () => {
	const original = message("provider", 100);
	const active = seed("active.jsonl", original);
	confirm(modal());
	const appended = message("provider", 300);
	appendFileSync(active, appended);
	seed("new.jsonl", message("other-provider", 400));
	for (const range of USAGE_RANGES) {
		const summary = collectUsageSummary(true, range);
		assert.equal(summary.totals.msgs, 2, range);
		assert.equal(summary.totals.input, 700, range);
		assert.equal(summary.totals.output, 20, range);
		assert.equal(summary.totals.cacheRead, 40, range);
		assert.equal(summary.totals.totalTokens, 760, range);
		assert.equal(summary.totals.sessions, 2, range);
		assert.ok(Math.abs(summary.totals.cost - 0.02) < 1e-12, range);
	}
	assert.deepEqual(getModelAllTimeUsage("test-model"), { input: 700, output: 20, cacheRead: 40 });
	rmSync(join(dir, "arnative", "usage-cache.json"));
	resetUsageCache();
	assert.equal(collectUsageSummary(true).totals.input, 700);
	assert.equal(readFileSync(active, "utf8"), original + appended);
});

test("a new process sees the persisted reset without depending on its working directory", () => {
	seed("old.jsonl", message("provider", 100));
	confirm(modal());
	const store = new URL("../lib/usage-store.ts", import.meta.url).href;
	const summary = execFileSync(process.execPath, ["--input-type=module", "-e", 'import { collectUsageSummary } from ' + JSON.stringify(store) + '; console.log(JSON.stringify(collectUsageSummary(true)));'], { cwd: tmpdir(), env: process.env, encoding: "utf8" });
	assert.equal(JSON.parse(summary).totals.msgs, 0);
	assert.equal(existsSync(join(dir, "sessions", "project", "old.jsonl")), true);
});

test("cancel changes neither statistics nor session files", () => {
	const content = message("provider", 100);
	const file = seed("a.jsonl", content);
	const panel = modal();
	panel.handleInput("R");
	assert.match(panel.render(120).join("\n"), /Reset all usage statistics\?.*sessions stay/);
	panel.handleInput("\x1b");
	assert.equal(collectUsageSummary(true).totals.msgs, 1);
	assert.equal(existsSync(join(dir, "arnative", "usage-baseline.json")), false);
	assert.equal(readFileSync(file, "utf8"), content);
});

test("undo restores the prior baseline and includes messages appended since reset", () => {
	const file = seed("a.jsonl", message("provider", 100));
	const panel = modal();
	confirm(panel);
	appendFileSync(file, message("provider", 200));
	assert.equal(collectUsageSummary(true).totals.input, 200);
	confirm(panel, "U");
	assert.equal(collectUsageSummary(true).totals.input, 300);
	assert.equal(existsSync(join(dir, "arnative", "usage-baseline.json")), false);
	assert.match(panel.render(120).join("\n"), /Previous statistics restored\./);
});

test("repeated reset undoes only the latest counting baseline", () => {
	const file = seed("a.jsonl", message("provider", 100));
	const panel = modal();
	confirm(panel);
	appendFileSync(file, message("provider", 200));
	confirm(panel);
	appendFileSync(file, message("provider", 300));
	assert.equal(collectUsageSummary(true).totals.input, 300);
	confirm(panel, "U");
	resetUsageCache();
	assert.equal(collectUsageSummary(true).totals.input, 500);
	assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3);
});

test("reset from a filtered range excludes history in every range", () => {
	const old = new Date();
	old.setDate(old.getDate() - 60);
	const file = seed("a.jsonl", message("provider", 100, old.toISOString()) + message("provider", 200));
	const panel = modal();
	panel.handleInput("\t");
	confirm(panel);
	appendFileSync(file, message("provider", 300));
	for (const range of USAGE_RANGES) assert.equal(collectUsageSummary(true, range).totals.input, 300, range);
});

test("a message completed after reset counts even if its write began before reset", () => {
	const pending = message("provider", 200);
	const split = Math.floor(pending.length / 2);
	const file = seed("a.jsonl", message("provider", 100) + pending.slice(0, split));
	confirm(modal());
	assert.equal(collectUsageSummary(true).totals.msgs, 0);
	appendFileSync(file, pending.slice(split));
	assert.equal(collectUsageSummary(true).totals.input, 200);
	assert.equal(collectUsageSummary(true).totals.msgs, 1);
});

test("empty history resets safely and counts the first new session", () => {
	const panel = modal();
	confirm(panel);
	seed("first.jsonl", message("provider", 100));
	assert.equal(collectUsageSummary(true).totals.input, 100);
	confirm(panel, "U");
	assert.equal(collectUsageSummary(true).totals.input, 100);
});

test("earlier usage-trash files are neither restored nor removed", () => {
	const trash = join(dir, "arnative", "usage-trash", "older-reset", "project");
	mkdirSync(trash, { recursive: true });
	const content = message("old-provider", 100);
	const old = join(trash, "old.jsonl");
	writeFileSync(old, content);
	seed("a.jsonl", message("provider", 200));
	const panel = modal();
	confirm(panel);
	confirm(panel, "U");
	assert.equal(readFileSync(old, "utf8"), content);
	assert.equal(existsSync(join(dir, "sessions", "project", "old.jsonl")), false);
	assert.equal(collectUsageSummary(true).totals.input, 200);
});

test("another process can reset statistics after this process cached its baseline", () => {
	const file = seed("a.jsonl", message("provider", 100));
	confirm(modal());
	appendFileSync(file, message("provider", 200));
	assert.equal(collectUsageSummary(true).totals.input, 200);
	const store = new URL("../lib/usage-store.ts", import.meta.url).href;
	execFileSync(process.execPath, ["--input-type=module", "-e", 'import { resetUsageStats } from ' + JSON.stringify(store) + '; resetUsageStats();'], { cwd: tmpdir(), env: process.env });
	assert.equal(collectUsageSummary(true).totals.input, 0);
});

test("invalid baseline data raises an error instead of silently reviving old statistics", () => {
	const file = seed("a.jsonl", message("provider", 100));
	const before = readFileSync(file, "utf8");
	const panel = modal();
	confirm(panel);
	writeFileSync(join(dir, "arnative", "usage-baseline.json"), "null");
	resetUsageCache();
	assert.throws(() => collectUsageSummary(true), /Invalid usage baseline/);
	assert.equal(readFileSync(file, "utf8"), before);
});


test("cache rebuild keeps untimestamped history excluded after the file modification day changes", () => {
	const undated = (input: number) => {
		const record = JSON.parse(message("provider", input));
		delete record.timestamp;
		return JSON.stringify(record) + "\n";
	};
	const file = seed("a.jsonl", undated(100));
	const yesterday = new Date();
	yesterday.setDate(yesterday.getDate() - 1);
	utimesSync(file, yesterday, yesterday);
	confirm(modal());
	appendFileSync(file, undated(200));
	rmSync(join(dir, "arnative", "usage-cache.json"));
	resetUsageCache();
	for (const range of USAGE_RANGES) assert.equal(collectUsageSummary(true, range).totals.input, 200, range);
});
