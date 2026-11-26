import test from "node:test";
import { assert } from "../helpers/check.ts";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../../lib/ansi.ts";
import { parsePorcelainV2 } from "../../lib/git-status.ts";
import { markedLabels } from "../../lib/format.ts";
import { IS_WINDOWS_LIKE, SHORTCUT_RELOAD } from "../../lib/shortcuts.ts";
import { CHATBOX_DIALOG_KEY as CHATBOX_DIALOG_CONFIG_KEY, CHATBOX_PRESET_KEY as CHATBOX_PRESET_CONFIG_KEY, CHATBOX_PROMPT_KEY as CHATBOX_PROMPT_CONFIG_KEY, FOOTER_PRESET_KEY as FOOTER_PRESET_CONFIG_KEY, loadChoice, resetPresetCache } from "../../lib/preset-store.ts";
import { getRuntime } from "../../lib/runtime.ts";
import { CHATBOX_PRESETS, DEFAULT_CHATBOX_PRESET, CHATBOX_PROMPTS, DEFAULT_CHATBOX_PROMPT, CHATBOX_DIALOGS, DEFAULT_CHATBOX_DIALOG, activeChatboxPreset, setChatboxPreset, activeChatboxPrompt, setChatboxPrompt, nextChatboxPrompt, activeChatboxDialog, setChatboxDialog, nextChatboxDialog, isPromptActive, stopPromptIdle, markPromptTyped, paintChatboxPrompt, renderChatboxScrollBorder, FOOTER_PRESETS, DEFAULT_FOOTER_PRESET, minimalExpanded, zenExpanded, activeFooterPreset, setFooterPreset, IDLE_PAUSE_MS, ActiveClock, seedActiveMs, clock, currentToolVerb, isJevEyeStatus, jevEyeStatusLine, ponytailStatusLine, gitParts, formatDiffStat, placeMinimalHead, placeZenHead, shortenCwd, resolveSessionStartMs, sumNumstat, formatDuration, renderChatboxLines, boxEditorLines, applyChatboxDialog, overlayOutsideDialogOnWidgetLines, layoutFooterGrid, piCacheHit, CACHE_WINDOW_MSGS, cacheHitBand, RATE_MIN_ACTIVE_MS, RATE_MIN_WIDTH, costCell, getUsage, workingLabel, isPointerOrFocusInput, armIdleProbe, stopIdleProbe, getToolWorkingMessage, __test } from "../../lib/features/footer.ts";

const { CHATBOX_PRESET_KEY, CHATBOX_PROMPT_KEY, CHATBOX_DIALOG_KEY, ARNATIVE_PRESETS, FOOTER_PRESET_KEY, WORK_LABEL, run, branchFromDisk, refreshGit, formatModelName, stopWorkingClock, IDLE_PROBE_EPSILON_MS, startWorkingClock } = __test;

test("lib/features/footer.ts self-check", async () => {
	assert(shortenCwd("/run/media/dev/DATA/work/app") === "\u2026/work/app", "cwd inside -> last 2 segments");
	assert(shortenCwd("/home/dev") === "/home/dev", "shallow cwd left unchanged");
	assert(shortenCwd("D:\\Pi\\a\\pi-arnative") === "D:/\u2026/a/pi-arnative", "long Windows path: drive kept");
	assert(shortenCwd("D:\\Pi\\pi-arnative") === "D:\\Pi\\pi-arnative", "shallow Windows path left unchanged");
	assert(shortenCwd("/a/x/y/z") === "\u2026/y/z", "long path -> tail");
	assert(shortenCwd("") === "", "empty cwd");
	assert(formatDuration(0) === "-", "empty duration = -");
	assert(formatDuration(1) === "-" && formatDuration(999) === "-", "sub-second is '-' too: no 0s flicker on a fresh clock");
	assert(formatDuration(1_000) === "1s", "a full second reads as 1s");
	assert(formatDuration(5_000) === "5s", "seconds only");
	assert(formatDuration(65_000) === "1m 5s", "minutes + seconds");
	assert(formatDuration(3_700_000) === "1h 1m", "hours + minutes");

	// Self-check: the footer grid — head row, then statuses/metrics paired per row.
	// truncateToWidth appends ANSI resets, so measure through stripAnsi (the real
	// renderer measures with visibleWidth, which ignores them the same way).
	const vw = (s: string) => stripAnsi(s).length;
	const g = (n: number) => "g".repeat(n);
	// Head row: cwd line left, model right-aligned; groups and metrics pair below.
	const grid = layoutFooterGrid("H".repeat(10), "M".repeat(6), [g(10), g(10), g(10)], ["s".repeat(10), "u".repeat(10)], " | ", " · ", 40, vw);
	assert(grid.length === 3, "grid: head + two paired rows");
	assert(grid[0]!.startsWith("H".repeat(10)) && grid[0]!.endsWith("M".repeat(6)), "grid: head pairs cwd and model");
	assert(grid[0]!.length === 40, "grid: head right-aligns the model");
	assert(grid[1]!.includes("g") && grid[1]!.endsWith("s".repeat(10)), "grid: row 2 pairs statuses and metrics");
	assert(grid.every((l) => vw(l) <= 40), "grid: every row fits the terminal");
	// Each side wraps inside its half: 3 groups + 2 metrics at width 20 -> 3 rows.
	const tight = layoutFooterGrid("h", "m", [g(6), g(6), g(6)], [g(6), g(6)], " | ", " · ", 20, vw);
	assert(tight.length === 3, "grid: wraps inside the half width");
	assert(tight.every((l) => vw(l) <= 20), "grid: wrapped rows still fit");
	// The right cell survives an oversized left cell (the left one is truncated).
	const cut = layoutFooterGrid("h", "m", [g(30)], ["R".repeat(4)], " | ", " · ", 12, vw);
	assert(cut[1]!.endsWith("R".repeat(4)) && vw(cut[1]!) === 12, "grid: right cell survives a wide left cell");
	// A side that runs out leaves its half blank; rows where both ran out drop.
	const blank = layoutFooterGrid("h", "m", [], [], " | ", " · ", 20, vw);
	assert(blank.length === 1, "grid: empty sides drop their rows");

	const plain = (s: string) => s;
	const D = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"; // 8 columns = content width in this test
	const boxed = boxEditorLines([D, "  hi    ", "  lo    ", D, "  /mo "], 2, plain);
	assert(boxed[0] === `\u256d${D}\u2500\u2500\u2500\u256e`, "editor box: top corner spans the content");
	assert(boxed[1] === "\u2502 >   hi    \u2502", "editor box: ' > ' prompt on the first line");
	assert(boxed[2] === "\u2502     lo    \u2502", "editor box: continuation indented, no second >");
	assert(boxed[3] === `\u2570${D}\u2500\u2500\u2500\u256f`, "editor box: bottom corner");
	assert(boxed[4] === "  /mo ", "autocomplete lines stay outside the box");
	const dimP = (s: string) => `\x1b[2m${s}\x1b[0m`;
	const boxedDim = boxEditorLines([D, "  hi    ", D], 1, plain, dimP(" > "));
	assert(visibleWidth(boxedDim[1]!) === visibleWidth(D) + 5, "ANSI (dim) prompt does not shift the width");
	assert(boxedDim[1]!.startsWith(`\u2502${dimP(" > ")}`), "dim prompt kept as-is");

	const widthsSeen: number[] = [];
	const piChatbox = renderChatboxLines("Pi (system)", (w) => (widthsSeen.push(w), [D, "  hi    ", D]), 16, 1, plain);
	assert(widthsSeen[0] === 16 && piChatbox[0] === D, "Pi (system) chatbox renders stock lines at full width");
	const arnativeChatbox = renderChatboxLines("Arnative", (w) => (widthsSeen.push(w), [D, "  hi    ", D]), 16, 1, plain);
	assert(widthsSeen[1] === 11 && arnativeChatbox[0]!.startsWith("\u256d"), "Arnative chatbox renders boxed lines at width - 5");

	// Self-check: getToolWorkingMessage
	assert(getToolWorkingMessage("edit") === "Editing", "edit -> Editing");
	assert(getToolWorkingMessage("write") === "Writing", "write -> Writing");
	assert(getToolWorkingMessage("read") === "Reading", "read -> Reading");
	assert(getToolWorkingMessage("grep") === "Searching", "grep -> Searching");
	assert(getToolWorkingMessage("find") === "Searching", "find -> Searching");
	assert(getToolWorkingMessage("web_search") === "Searching", "web_search -> Searching");
	assert(getToolWorkingMessage("bash") === "Executing", "bash -> Executing");
	assert(getToolWorkingMessage("fetch_content") === "Fetching", "fetch_content -> Fetching");
	assert(getToolWorkingMessage("todo") === "Updating tasks", "todo -> Updating tasks");
	assert(getToolWorkingMessage("unknown_tool") === "Working", "unknown -> Working");
	assert(getToolWorkingMessage("mcp", { tool: "fetch_repo" }) === "Fetching", "mcp fetch -> Fetching");

	// Self-check: working loader clock
	assert(workingLabel("Working", 0) === "Working", "no elapsed suffix below 1s");
	assert(workingLabel("Working", 999) === "Working", "no elapsed suffix at 999ms");
	assert(workingLabel("Working", 50_000) === "Working (50s)", "elapsed seconds suffix");
	assert(workingLabel("Executing", 65_000) === "Executing (1m 5s)", "elapsed minutes suffix");

	assert(currentToolVerb(new Map()) === WORK_LABEL, "no active tool -> default label");
	assert(currentToolVerb(new Map([["a", "Reading"], ["b", "Writing"]])) === "Writing", "parallel tools: last started wins");
	assert(currentToolVerb(new Map([["a", "Reading"]])) === "Reading", "after one ends, the remaining tool's label shows");
	startWorkingClock({ ui: { setWorkingMessage: () => {} } });
	assert(Boolean(getRuntime().clockTimer), "clock starts: shared 1s timer stored on RuntimeState");
	stopWorkingClock();
	assert(getRuntime().clockTimer == null, "clock stops: reload guard clears the timer");
	assert(boxed.slice(0, 4).every((l) => visibleWidth(l) === visibleWidth(D) + 5), "uniform box width (sides + prompt)");
	assert(boxEditorLines(["\u2500\u2500\u2500\u2500"], 1, plain).length === 1, "too narrow: left unchanged");

	// Guard: the reload shortcut must match every encoding a terminal can deliver,
	// so a typo in the key id fails here instead of silently doing nothing.
	assert(SHORTCUT_RELOAD.matches("\x1b\x12"), "shortcut matches legacy ctrl+alt+r (ESC + 0x12)");
	assert(SHORTCUT_RELOAD.matches("\x1b[114;7u"), "shortcut matches Kitty CSI-u ctrl+alt+r");
	assert(SHORTCUT_RELOAD.matches("\x1br") === IS_WINDOWS_LIKE, "ESC + r triggers reload only where alt+r is bound");
	assert(!SHORTCUT_RELOAD.matches("\x12"), "plain ctrl+r does not trigger reload");
	assert(!SHORTCUT_RELOAD.matches("r"), "bare letter r does not trigger reload");

	// getUsage cache: a stream tick mutates the last assistant message in place —
	// the delta is applied on top of the cached sums (fresh numbers, no O(N) rescan)
	const usageBranch: Array<{ type: string; message: { role: string; usage?: { input?: number; output?: number; cacheRead?: number } } }> = [
		{ type: "message", message: { role: "user", content: "hi" } as never },
		{ type: "message", message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 10 } } },
	];
	const usageCtx = { sessionManager: { getBranch: () => usageBranch }, getContextUsage: () => undefined } as Parameters<typeof getUsage>[0];
	const id = (t: string) => t;
	const s1 = getUsage(usageCtx, id, id);
	assert(s1.includes("↑100") && s1.includes("↓50"), "getUsage scans the branch");
	usageBranch[1]!.message.usage = { input: 100, output: 80, cacheRead: 10 }; // stream tick in place
	const s2 = getUsage(usageCtx, id, id);
	assert(s2.includes("↓80") && !s2.includes("↓50"), "stream tick: delta applied without a rescan (length unchanged)");
	usageBranch.push({ type: "message", message: { role: "assistant", usage: { input: 1000, output: 2500, cacheRead: 0 } } });
	const s3 = getUsage(usageCtx, id, id);
	assert(s3.includes("↑1.1k") && s3.includes("↓2.6k"), "branch length changed: full rescan");
	// No pi-cache-stats status (provider without an optimizer adapter): the cache cell
	// falls back to Pi's own usage, cacheRead / (input + cacheRead) = 10 / 1110.
	assert(piCacheHit() === "pi 0.9%", "cache fallback reads Pi's built-in usage: " + piCacheHit());
	// Cost cell: opt-in, and the branch scan splits billed from estimated cost.
	assert(costCell(0, 0, id, id) === "", "no cost at all: no cell");
	assert(costCell(0.42, 0, id, id).endsWith("$0.42") && !costCell(0.42, 0, id, id).includes("~"), "billed only: $0.42 without ~");
	assert(costCell(0, 0.42, id, id).includes("~$0.42") && !costCell(0, 0.42, id, id).includes("+"), "estimated only: ~$0.42");
	assert(costCell(0.3, 0.12, id, id).includes("$0.30 + ~$0.12"), "both: $0.30 + ~$0.12, never blended");
	// The budget band paints the cost cell — amber at `warn`, red at `over`; no band keeps acc/soft.
	const warnPaint = (t: string) => `<warn>${t}</warn>`;
	const overPaint = (t: string) => `<error>${t}</error>`;
	assert(costCell(0.42, 0, id, id, RATE_MIN_WIDTH, warnPaint) === `<warn>\uf155</warn> <warn>$0.42</warn>`, "the warn band paints icon and text: " + costCell(0.42, 0, id, id, RATE_MIN_WIDTH, warnPaint));
	assert(costCell(0.42, 0, id, id, RATE_MIN_WIDTH, overPaint) === `<error>\uf155</error> <error>$0.42</error>`, "the over band paints icon and text: " + costCell(0.42, 0, id, id, RATE_MIN_WIDTH, overPaint));
	assert(costCell(0.42, 0, id, id, RATE_MIN_WIDTH) === "\uf155 $0.42", "no band: acc icon, soft text, as before");

	// Self-check: the burn rate appended to the cost cell — cost / ACTIVE hours of the clock
	// (idle pauses excluded, not wall-clock), hidden below 5 active minutes, when the cost
	// is 0, and below 80 columns. Freeze the clock's live part so total() is exactly `active`.
	const clockBackup = { active: clock.active, runStarted: clock.runStarted, lastSeen: clock.lastSeen };
	const freezeClock = (activeMs: number) => {
		clock.active = activeMs;
		clock.runStarted = Date.now();
		clock.lastSeen = clock.runStarted - clock.pauseMs - 1;
	};
	freezeClock(14 * 60_000); // $0.42 over 14 active minutes = $1.80/h
	assert(costCell(0.42, 0, id, id).includes("$0.42 ($1.80/h)"), "the rate is cost / active hours: $0.42 over 14 active minutes is $1.80/h: " + costCell(0.42, 0, id, id));
	assert(!costCell(0.42, 0, id, id).includes("~"), "a billed-only rate carries no ~");
	assert(costCell(0, 0.42, id, id).includes("~$1.80/h"), "an estimate-based rate is prefixed ~, like the estimated part of the cell");
	freezeClock(RATE_MIN_ACTIVE_MS - 1);
	assert(!costCell(0.42, 0, id, id).includes("/h"), "no rate below 5 minutes of active time (a two-minute clock would print nonsense)");
	freezeClock(RATE_MIN_ACTIVE_MS);
	assert(costCell(0.42, 0, id, id).includes("/h"), "the rate appears at exactly 5 active minutes");
	assert(costCell(0.42, 0, id, id, RATE_MIN_WIDTH - 1).endsWith("$0.42"), "below 80 columns the rate is dropped, the cost stays");
	assert(costCell(0.42, 0, id, id, RATE_MIN_WIDTH).includes("/h"), "at 80 columns the rate is kept");
	assert(costCell(0, 0, id, id) === "", "zero cost: no cell at all, so no rate either");
	clock.active = clockBackup.active;
	clock.runStarted = clockBackup.runStarted;
	clock.lastSeen = clockBackup.lastSeen;

	// Self-check: the cache cell's colour bands (the `pi …%` text itself stays session-wide).
	assert(cacheHitBand(300, 700) === "soft" && cacheHitBand(200, 800) === "soft", "a windowed rate ≥70% keeps the soft tier");
	assert(cacheHitBand(600, 400) === "warning" && cacheHitBand(550, 450) === "warning", "40–70% is the amber (warning) band");
	assert(cacheHitBand(700, 300) === "error" && cacheHitBand(601, 399) === "error", "below 40% is the red (error) band");
	assert(cacheHitBand(0, 0) === "soft", "an empty window (fewer than 3 assistant messages) stays soft");
	// The windowed rate itself, through the scan pass: the first two assistant messages are
	// ignored, the window is capped at the last CACHE_WINDOW_MSGS, and a stream tick moves
	// it through the in-place delta without a rescan.
	const asstMsg = (inp: number, read: number) => ({ type: "message", message: { role: "assistant", usage: { input: inp, output: 5, cacheRead: read } } });
	const winBranch = [asstMsg(1000, 0), asstMsg(1000, 0), asstMsg(1000, 1000), asstMsg(1000, 1000)];
	const winCtx = { sessionManager: { getBranch: () => winBranch }, getContextUsage: () => undefined } as Parameters<typeof getUsage>[0];
	__test.usageScanAt = 0;
	__test.usageScanLen = -1;
	getUsage(winCtx, id, id, false);
	assert(__test.usageWindow.inp === 2000 && __test.usageWindow.read === 2000, "the windowed rate ignores the first two assistant messages: " + JSON.stringify(__test.usageWindow));
	assert(piCacheHit() === "pi 33.3%", "the pi …% text stays session-wide while the colour is windowed: " + piCacheHit());
	const scanAtWin = __test.usageScanAt;
	// A stream tick mutates the last entry in place; replacing it would be a new leaf, and the
	// i7 identity check would (correctly) rescan instead of taking the delta.
	(winBranch[3] as { message: { usage: { cacheRead: number } } }).message.usage.cacheRead = 0;
	getUsage(winCtx, id, id, false);
	assert(__test.usageWindow.inp === 2000 && __test.usageWindow.read === 1000, "a stream tick moves the window through the delta: " + JSON.stringify(__test.usageWindow));
	assert(__test.usageScanAt === scanAtWin, "the windowed delta took the cached path, not a rescan");
	assert(cacheHitBand(__test.usageWindow.inp, __test.usageWindow.read) === "error", "a collapsed recent window is red even though the session rate is still 33.3%");
	__test.usageScanAt = 0;
	__test.usageScanLen = -1;
	const capBranch = [asstMsg(1000, 0), asstMsg(1000, 0), asstMsg(1000, 0), ...Array.from({ length: CACHE_WINDOW_MSGS }, () => asstMsg(600, 400))];
	const capCtx = { sessionManager: { getBranch: () => capBranch }, getContextUsage: () => undefined } as Parameters<typeof getUsage>[0];
	getUsage(capCtx, id, id, false);
	assert(__test.usageWindow.inp === 6_000 && __test.usageWindow.read === 4_000, "the window is capped at the last " + CACHE_WINDOW_MSGS + " assistant messages: " + JSON.stringify(__test.usageWindow));
	assert(cacheHitBand(__test.usageWindow.inp, __test.usageWindow.read) === "warning", "a 40% windowed rate is the amber band");
	const costBranch: Array<{
		type: string;
		message: { role: string; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number; totalFromProvider?: boolean } } };
	}> = [{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.42, totalFromProvider: true } } } }];
	const costCtx = { sessionManager: { getBranch: () => costBranch }, getContextUsage: () => undefined } as Parameters<typeof getUsage>[0];
	assert(!getUsage(costCtx, id, id, false).includes("$0.42"), "cost cell is off unless the switch is on");
	assert(getUsage(costCtx, id, id, true).includes("$0.42"), "cost cell sums the branch's billed cost when on");
	assert(
		getUsage(costCtx, id, id, true).includes("·  $0.42"),
		"the cost cell opens with the footer divider, so the dollar icon reads as its own group",
	);
	assert(getUsage(costCtx, id, id, true, RATE_MIN_WIDTH, warnPaint).includes("<warn>$0.42</warn>"), "the warn band reaches the cost cell through getUsage");
	assert(getUsage(costCtx, id, id, true, RATE_MIN_WIDTH, overPaint).includes("<error>$0.42</error>"), "the over band reaches the cost cell through getUsage");

	// Child spend from a tool result: one assistant message + one tool result carrying usage —
	// the sums are the sum of both, once each — and a tool result mutated in place (a finished
	// child call updates its usage, branch length unchanged) still applies the delta on the
	// cached sums, no rescan.
	const childBranch: Array<{
		type: string;
		message: { role: string; toolName?: string; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number; totalFromProvider?: boolean } } };
	}> = [
		{ type: "message", message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 10 } } },
		{
			type: "message",
			message: { role: "toolResult", toolName: "subagent", usage: { input: 400, output: 60, cacheRead: 20, cost: { total: 0.05, totalFromProvider: true } } },
		},
	];
	const childCtx = { sessionManager: { getBranch: () => childBranch }, getContextUsage: () => undefined } as Parameters<typeof getUsage>[0];
	__test.usageScanAt = 0;
	__test.usageScanLen = -1;
	const child1 = getUsage(childCtx, id, id, true);
	assert(child1.includes("↑500") && child1.includes("↓110"), "a tool result's usage is summed with the assistant message's, once each: " + child1);
	assert(child1.includes("$0.05"), "the tool result's billed cost is summed too: " + child1);
	childBranch[1]!.message.usage = { input: 700, output: 60, cacheRead: 20, cost: { total: 0.05, totalFromProvider: true } }; // child finished, same branch length
	const scanAtBefore = __test.usageScanAt;
	const child2 = getUsage(childCtx, id, id, true);
	assert(child2.includes("↑800") && !child2.includes("↑500"), "a tool result mutated in place: the delta is applied without a rescan (length unchanged): " + child2);
	assert(__test.usageScanAt === scanAtBefore, "the tool-result tick took the in-place delta path, not a rescan");
	childBranch[1]!.message.usage = undefined; // a tool result without usage adds nothing
	__test.usageScanAt = 0;
	__test.usageScanLen = -1;
	const child3 = getUsage(childCtx, id, id, true);
	assert(child3.includes("↑100") && child3.includes("↓50") && !child3.includes("$0.05"), "a tool result without usage adds nothing: " + child3);

	// Billed vs estimated in getUsage: a costless message is recomputed from models.json
	// (cache writes included) and shown next to the billed total, not folded into it.
	const costFixture = mkdtempSync(join(tmpdir(), "pi-arnative-cost-"));
	const prevCostDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = costFixture;
	writeFileSync(
		join(costFixture, "models.json"),
		JSON.stringify({ providers: { google: { models: [{ id: "m", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 } }] } } }),
	);
	__test.usageScanAt = 0;
	__test.usageScanLen = -1;
	const mixedBranch: Array<{
		type: string;
		message: { role: string; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number; totalFromProvider?: boolean } } };
	}> = [
		{ type: "message", message: { role: "assistant", provider: "google", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.3, totalFromProvider: true } } } },
		// No cost at all: 1M input at $1/M + 500k cache writes at $3/M = ~$2.50.
		{ type: "message", message: { role: "assistant", provider: "google", model: "m", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 500_000 } } },
	];
	const mixedCtx = { sessionManager: { getBranch: () => mixedBranch }, getContextUsage: () => undefined } as Parameters<typeof getUsage>[0];
	const mixedCell = getUsage(mixedCtx, id, id, true);
	assert(mixedCell.includes("$0.30 + ~$2.50"), "a mixed branch shows the billed and estimated parts apart: " + mixedCell);
	__test.usageScanAt = 0;
	__test.usageScanLen = -1;
	const catalogBranch: typeof mixedBranch = [
		{ type: "message", message: { role: "assistant", provider: "google", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.12 } } } },
	];
	const catalogCtx = { sessionManager: { getBranch: () => catalogBranch }, getContextUsage: () => undefined } as Parameters<typeof getUsage>[0];
	const catalogCell = getUsage(catalogCtx, id, id, true);
	assert(catalogCell.includes("~$0.12") && !catalogCell.includes("+"), "a catalog total (no totalFromProvider) is an estimate, marked ~: " + catalogCell);
	if (prevCostDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevCostDir;
	rmSync(costFixture, { recursive: true, force: true });

	// regression: a refresh arriving while one is in flight is re-run with the newest
	// cwd, not dropped (the footer's git state no longer stays stale until the next trigger).
	// "newest cwd" needs a real repo: the branch now comes from .git/HEAD, not from git.
	const repo = mkdtempSync(join(tmpdir(), "pi-arnative-repo-"));
	mkdirSync(join(repo, ".git"), { recursive: true });
	writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/arnative-tests\n");
	__test.git = null;
	const noGit = mkdtempSync(join(tmpdir(), "pi-arnative-nogit-"));
	// `noGit` is not always repo-free: a temp dir under a versioned home finds the home
	// repo, so this first refresh really is in flight and can publish the home branch
	// before the queued one lands. Wait for the queued result, not for "not null".
	void refreshGit(noGit);
	await refreshGit(repo); // queued behind it with the newest cwd
	for (let i = 0; i < 250 && __test.git?.branch !== "arnative-tests"; i++) await new Promise((r) => setTimeout(r, 20));
	assert(__test.git !== null && __test.git.branch === "arnative-tests", "queued git refresh re-ran on the newest cwd (not dropped)");
	rmSync(noGit, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });

	// A repo whose branch is readable without git on PATH: the branch comes from .git/HEAD
	// (pi's own footer does this too), so a fresh user needs no git install for row 1.
	const bare = mkdtempSync(join(tmpdir(), "pi-arnative-disk-"));
	mkdirSync(join(bare, ".git"), { recursive: true });
	writeFileSync(join(bare, ".git", "HEAD"), "ref: refs/heads/arnative-smoke\n");
	assert(branchFromDisk(bare) === "arnative-smoke", "branch is read from .git/HEAD without running git");
	writeFileSync(join(bare, ".git", "HEAD"), "1234567890abcdef1234567890abcdef12345678\n");
	assert(branchFromDisk(bare) === "detached", "a raw HEAD hash reports detached, not null");
	// A subfolder of the repo resolves to the repo's branch (walks up like git).
	writeFileSync(join(bare, ".git", "HEAD"), "ref: refs/heads/arnative-smoke\n");
	mkdirSync(join(bare, "src", "deep"), { recursive: true });
	assert(branchFromDisk(join(bare, "src", "deep")) === "arnative-smoke", "branch resolves from a subfolder of the repo");
	rmSync(bare, { recursive: true, force: true });

	// Honesty: with the branch known but git unable to answer, tag/status must be absent
	// rather than the old false "-"/"clean".
	const A = (t: string) => t;
	const S = (t: string) => t;
	const unknownGit = gitParts({ branch: "main", tag: null, uncommitted: null, added: null, removed: null, ahead: 0, behind: 0 }, A, S);
	assert(unknownGit.length === 1 && unknownGit[0]!.endsWith("main"), "unreadable git: branch only, no fake '-'/'clean'");
	const fullGit = gitParts({ branch: "main", tag: "v1.2.3", uncommitted: 2, added: 500, removed: 100, ahead: 1, behind: 0 }, A, S);
	assert(fullGit.length === 3 && fullGit[1]!.endsWith("v1.2.3") && fullGit[2]!.includes("~2"), "readable git: tag + dirty count present");
	assert(gitParts(null, A, S).length === 0, "not a repo: no git segment at all");
	// Diff stat is clock-adjacent, so it renders with or without a repo.
	const dirty = { branch: "main", tag: null, uncommitted: 2, added: 500, removed: 100, ahead: 0, behind: 0 };
	assert(formatDiffStat(dirty, A, (t) => `<A>${t}</A>`, (t) => `<D>${t}</D>`).includes("<A>+500</A> <D>-100</D>"), "+/- use the diff colors");
	assert(formatDiffStat({ ...dirty, added: 0, removed: 0 }, A, A, A) === "", "a clean tree hides the diff segment");
	assert(formatDiffStat(null, A, A, A) === "", "no repo: the diff segment is hidden, never a fake 0");
	assert(formatDiffStat({ ...dirty, added: null, removed: null }, A, A, A) === "", "git cannot answer: the diff segment is hidden");
	assert(sumNumstat("12\t3\tsrc/a.ts\n-\t-\timg.png\n4\t0\tb.ts\n").added === 16, "numstat sums added lines and skips binary");
	assert(sumNumstat("12\t3\tsrc/a.ts\n-\t-\timg.png\n4\t0\tb.ts\n").removed === 3, "numstat sums removed lines and skips binary");
	assert(sumNumstat("").added === 0 && sumNumstat("").removed === 0, "empty numstat is zero, not NaN")

	// Footer presets: Arnative (Full) is the default; Pi (system) hands the footer slot back to pi (the editor stays arnative).
	assert(DEFAULT_FOOTER_PRESET === "Arnative (Full)" && FOOTER_PRESETS.length === 5, "Arnative (Full) is the default footer preset");
	assert(FOOTER_PRESETS.join(" | ") === "Pi (system) | Pi (color) | Arnative (Full) | Arnative (Minimal) | Zen", "built-in preset is listed first, Pi (color) right below it, Zen last");
	assert(markedLabels(FOOTER_PRESETS, "Pi (system)").join(" | ") === "● Pi (system) |   Pi (color) |   Arnative (Full) |   Arnative (Minimal) |   Zen", "footer preset labels mark the active one");
	assert(ARNATIVE_PRESETS.join(" | ") === "Pi (color) | Arnative (Full) | Arnative (Minimal) | Zen", "the arnative-drawn presets exclude pi's built-in footer");
	// Zen disclosure: starts collapsed, tracks inline git and exclusive detail row.
	getRuntime().zenFooterExpanded = null;
	const zen0 = zenExpanded();
	assert(zen0.git === false && zen0.detail === null, "Zen starts fully collapsed");
	zen0.git = true;
	zen0.detail = "left";
	assert(zenExpanded().git === true && zenExpanded().detail === "left", "Zen state persists across reads");
	getRuntime().zenFooterExpanded = null;
	const aWide = placeZenHead("cwd · 4m 0s", "Gemini", " | ", "···", "", 60);
	assert(aWide.rows.length === 1, "Zen wide head fits on one row");
	assert(aWide.left[0]!.x0 > 0, "Zen centers the head row");
	assert(aWide.left[0]!.x1 + 4 === aWide.right[0]!.x0, "Zen leaves the separator outside left/right click zones");
	assert(aWide.dots !== null && aWide.dots.x0 === aWide.right[0]!.x1 + 2, "Zen places the dots zone right after the model");
	const aNoGit = placeZenHead("cwd · 4m 0s", "Gemini", " | ", "", "", 60);
	assert(aNoGit.dots === null && !aNoGit.rows[0]!.includes("···"), "Zen omits dots when there is no git data");
	const aGitWrap = placeZenHead("cwd · 4m 0s", "Gemini", " | ", "···", "+97 -24 · perf/footer · v0.16.1", 34);
	assert(aGitWrap.rows.length >= 2 && aGitWrap.dots?.y === 0, "Zen wraps overflowing git text below row 0 without breaking head zones");
	const aNarrow = placeZenHead("cwd · 4m 0s", "Gemini 4 Neon", " | ", "···", "", 18);
	assert(aNarrow.rows.length >= 2 && aNarrow.left.length > 0 && aNarrow.right.length > 0 && aNarrow.dots !== null, "Zen narrow wrap preserves all three click zones");
	// Minimal disclosure: both sides start closed, then toggle independently.
	getRuntime().minimalFooterExpanded = null;
	const expand0 = minimalExpanded();
	assert(expand0.left === false && expand0.right === false, "the minimal footer starts fully collapsed");
	expand0.left = true;
	assert(minimalExpanded().left === true && minimalExpanded().right === false, "one side opens without opening the other");
	getRuntime().minimalFooterExpanded = null;
	// Disclosure arrows: the left zone ends the left head, the right one the terminal edge.
	const normal = placeMinimalHead("L".repeat(20), "R".repeat(10), 80);
	assert(visibleWidth(normal.row) === 80, "the head row fills the terminal width");
	assert(normal.left[0] === 0 && normal.left[1] === 19, "the left zone is exactly the left head text");
	assert(normal.right[0] === 70 && normal.right[1] === 79, "the right zone is exactly the right head text");
	assert(50 > normal.left[1] && 50 < normal.right[0], "the gap between the heads is inert");
	const clipped = placeMinimalHead("L".repeat(70), "R".repeat(20), 80);
	assert(visibleWidth(clipped.row) <= 80, "a cut head row never exceeds the width");
	assert(clipped.left[1] < clipped.right[0], "cut zones stay ordered and disjoint");
	assert(clipped.row.slice(clipped.left[0], clipped.left[1] + 1) === clipped.row.slice(0, clipped.left[1] + 1), "the left zone matches the placed text");
	// Squeezed: the left head keeps at least one column, the right one is dropped once
	// nothing is left for it. Both outcomes are measured from the placed row.
	const squeezed = placeMinimalHead("L".repeat(30), "R".repeat(30), 12);
	assert(visibleWidth(squeezed.row) <= 12, "a squeezed head row never exceeds the width");
	assert(squeezed.left[0] === 0, "the left head keeps its columns");
	assert(squeezed.right[0] === -1 || squeezed.right[0] > squeezed.left[1], "zones stay disjoint when squeezed");
	const noRight = placeMinimalHead("L", "R".repeat(40), 2);
	assert(noRight.right[0] === -1, "a right head with no room gets no zone");
	const onlyLeft = placeMinimalHead("L".repeat(5), "", 20);
	assert(onlyLeft.left[0] === 0 && onlyLeft.left[1] === 4 && onlyLeft.right[0] === -1, "an empty head has no zone");
	let footerCleared = 0;
	let editorTouched = 0;
	const presetCtx: any = {
		ui: {
			setFooter: (f: unknown) => { if (f === undefined) footerCleared++; },
			setEditorComponent: () => { editorTouched++; },
		},
	};
	// Persisting a preset writes a config file: point it at a fixture so the real agent dir stays clean.
	const presetFixture = mkdtempSync(join(tmpdir(), "arnative-ftr-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = presetFixture;
	resetPresetCache();
	setFooterPreset("Pi (system)", presetCtx);
	assert(footerCleared === 1 && editorTouched === 0 && activeFooterPreset() === "Pi (system)", "Pi (system) clears the footer only (an editor swap would close the picker)");
	let registered = 0;
	getRuntime().footerRegistrar = () => { registered++; };
	setFooterPreset("Arnative (Full)", presetCtx);
	assert(registered === 1 && activeFooterPreset() === "Arnative (Full)", "Arnative (Full) re-runs the arnative registrar");
	getRuntime().footerRegistrar = null;
	// Persist a NON-default value: asserting the default survives proves nothing.
	setFooterPreset("Pi (system)", presetCtx);
	assert(loadChoice(FOOTER_PRESET_CONFIG_KEY, FOOTER_PRESETS) === "Pi (system)", "the footer preset is persisted to disk");
	delete (globalThis as Record<symbol, unknown>)[FOOTER_PRESET_KEY];
	resetPresetCache();
	assert(activeFooterPreset() === "Pi (system)", "a restart reads the non-default footer preset back from disk");

	// Chatbox presets & prompt arrows: Arnative + ❯ are the defaults; Pi (system) and prompt choice persist across restarts.
	assert(DEFAULT_CHATBOX_PRESET === "Arnative" && CHATBOX_PRESETS.join(" | ") === "Pi (system) | Arnative", "chatbox presets are Pi (system) then Arnative");
	assert(activeChatboxPreset() === "Arnative", "Arnative is the default chatbox preset");
	assert(DEFAULT_CHATBOX_PROMPT === "❯" && CHATBOX_PROMPTS[0] === "❯" && CHATBOX_PROMPTS.length === 12, "chatbox prompts default to ❯ with 12 choices");
	assert(CHATBOX_PROMPTS.every((g) => visibleWidth(g) === 1), "every chatbox prompt glyph is 1 cell wide");
	assert(nextChatboxPrompt("❯") === ">" && nextChatboxPrompt("\udb80\udd7a") === "❯", "nextChatboxPrompt cycles through every arrow and wraps");
	assert(DEFAULT_CHATBOX_DIALOG === "Left" && CHATBOX_DIALOGS.join(" | ") === "Left | Center | Right | Inside | Outside", "chatbox dialog defaults to Left with 5 positions");
	assert(nextChatboxDialog("Left") === "Center" && nextChatboxDialog("Outside") === "Left", "nextChatboxDialog cycles through every position and wraps");
	setChatboxPreset("Pi (system)");
	setChatboxPrompt("▸");
	setChatboxDialog("Outside");
	assert(loadChoice(CHATBOX_PRESET_CONFIG_KEY, CHATBOX_PRESETS) === "Pi (system)", "the chatbox preset is persisted to disk");
	assert(loadChoice(CHATBOX_PROMPT_CONFIG_KEY, CHATBOX_PROMPTS) === "▸", "the chatbox prompt is persisted to disk");
	assert(loadChoice(CHATBOX_DIALOG_CONFIG_KEY, CHATBOX_DIALOGS) === "Outside", "the chatbox dialog is persisted to disk");
	delete (globalThis as Record<symbol, unknown>)[CHATBOX_PRESET_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHATBOX_PROMPT_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHATBOX_DIALOG_KEY];
	resetPresetCache();
	assert(activeChatboxPreset() === "Pi (system)", "a restart reads the non-default chatbox preset back from disk");
	assert(activeChatboxPrompt() === "▸", "a restart reads the non-default chatbox prompt back from disk");
	assert(activeChatboxDialog() === "Outside", "a restart reads the non-default chatbox dialog back from disk");
	delete (globalThis as Record<symbol, unknown>)[CHATBOX_PRESET_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHATBOX_PROMPT_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHATBOX_DIALOG_KEY];

	// Chatbox dialog placement: Left, Center, Right, Inside, and Outside keep exact box width.
	const dW = 36;
	const dBox = boxEditorLines(["\u2500".repeat(dW - 5), "hi" + " ".repeat(dW - 7), "\u2500".repeat(dW - 5)], 1, plain, " ❯ ");
	const dStatus = "Working (1s)";
	for (const pos of CHATBOX_DIALOGS) {
		const rendered = applyChatboxDialog(dBox, true, dW, 0, pos, dStatus, "*", plain);
		assert(rendered.every((r) => visibleWidth(r) <= dW), `dialog ${pos} never exceeds width`);
		if (pos === "Outside") {
			assert(rendered.length === dBox.length && rendered[0] === dBox[0], "Outside dialog leaves editor box unchanged");
		} else if (pos === "Inside") {
			assert(rendered.length === dBox.length && rendered[0] === dBox[0] && rendered[1]!.includes(dStatus) && rendered[1]!.endsWith("│"), "Inside dialog sits inside line 1 at the right corner");
		} else if (pos === "Left") {
			assert(rendered[0]!.startsWith("╭── Working (1s) ") && visibleWidth(rendered[0]!) === dW, "Left dialog sits on the left of the top border");
		} else if (pos === "Center") {
			const idx = rendered[0]!.indexOf(dStatus);
			assert(idx > 4 && idx < dW - dStatus.length - 4 && visibleWidth(rendered[0]!) === dW, "Center dialog sits centered on the top border");
		} else if (pos === "Right") {
			assert(rendered[0]!.endsWith(" Working (1s) ──╮") && visibleWidth(rendered[0]!) === dW, "Right dialog sits on the right of the top border");
		}
	}
	const outZero = overlayOutsideDialogOnWidgetLines([], dW, dStatus);
	assert(outZero.length === 3 && outZero[0] === "" && outZero[1] === ` ${dStatus}` && outZero[2] === "", "Outside dialog renders with 1 blank line above and below even when widgetContainerAbove is empty");
	const outEmpty = overlayOutsideDialogOnWidgetLines([""], dW, dStatus);
	assert(outEmpty.length === 3 && outEmpty[0] === "" && outEmpty[1] === ` ${dStatus}` && outEmpty[2] === "", "Outside dialog pads 1 blank line above and below when no widget is shown");
	const outNotice = overlayOutsideDialogOnWidgetLines(["", " \ueb1b Chatbox: Arnative."], 60, dStatus);
	assert(outNotice.length === 3 && outNotice[0] === "" && outNotice[1] === ` ${dStatus}  \ueb1b Chatbox: Arnative.` && outNotice[2] === "", "Outside dialog sits on the left with the notice beside it and 1 blank line below");
	const outTodos = overlayOutsideDialogOnWidgetLines(["", "\u256d" + "\u2500".repeat(58) + "\u256e", "\u2570" + "\u2500".repeat(58) + "\u256f"], 60, dStatus);
	assert(outTodos.length === 5 && outTodos[0] === "" && outTodos[1] === ` ${dStatus}` && outTodos[2] === "" && outTodos[3]!.startsWith("\u256d"), "Outside dialog leaves 1 blank line above and below when Todos is visible");

	const scrollBorder = renderChatboxScrollBorder("\u2191", 3, 24, (t) => `<bdr>${t}</bdr>`, (t) => `<pri>${t}</pri>`);
	assert(scrollBorder.includes("<pri>↑ 3 more</pri>") && visibleWidth(stripAnsi(scrollBorder.replace(/<\/?(bdr|pri)>/g, ""))) === 24, "chatbox scroll border paints N more in primary at exact width");
	const dialogWithScroll = applyChatboxDialog(dBox, true, dW, 2, "Left", dStatus, "*", (t) => `<bdr>${t}</bdr>`, (t) => `<pri>${t}</pri>`);
	assert(dialogWithScroll[0]!.includes("<pri>↑ 2 more</pri>"), "top border dialog keeps ↑ N more painted in primary");

	// Prompt idle/active coloring: idle uses dim, active typing uses primary (mdHeading, accent fallback).
	assert(isPromptActive(10_000, 0) === false, "untyped prompt starts idle");
	assert(isPromptActive(10_000, 8_000) === true, "prompt stays active within 3s of typing");
	assert(isPromptActive(10_000, 7_000) === true, "prompt is still active at exact 3s boundary");
	assert(isPromptActive(10_001, 7_000) === false, "prompt turns idle past 3s without typing");
	const promptTheme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
	assert(paintChatboxPrompt("❯", promptTheme, false) === "<dim> ❯ </dim>", "idle prompt paints with dim");
	assert(paintChatboxPrompt("❯", promptTheme, true) === "<mdHeading> ❯ </mdHeading>", "active prompt paints with primary (mdHeading)");
	assert(paintChatboxPrompt("\udb80\udf7d", promptTheme, false) === "<dim> \udb80\udf7d  </dim>", "Nerd Font PUA prompt gets 2 trailing spaces");
	const nerdBox = renderChatboxLines("Arnative", (w) => ["\u2500".repeat(w), "hi" + " ".repeat(w - 2), "\u2500".repeat(w)], 30, 1, (t) => t, " \udb80\udf7d  ");
	assert(nerdBox.length === 3 && nerdBox.every((l) => visibleWidth(l) === 30) && nerdBox[1]!.startsWith("\u2502 \udb80\udf7d  hi"), "4-col Nerd Font prompt preserves exact box width");
	const fallbackTheme = {
		fg: (c: string, t: string) => {
			if (c === "mdHeading") throw new Error("missing");
			return `<${c}>${t}</${c}>`;
		},
	};
	assert(paintChatboxPrompt("❯", fallbackTheme, true) === "<accent> ❯ </accent>", "active prompt falls back to accent when mdHeading is absent");
	markPromptTyped(Date.now());
	assert(isPromptActive() === true && getRuntime().promptIdleTimer != null, "markPromptTyped activates prompt and arms idle timer");
	stopPromptIdle();
	assert(getRuntime().promptIdleTimer == null, "stopPromptIdle clears the prompt idle timer");
	getRuntime().promptTypedAt = 0;
	rmSync(presetFixture, { recursive: true, force: true });
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	resetPresetCache();

	// Self-check: formatModelName thinking icon
	const fmnRes = formatModelName({ id: "claude-3-7-sonnet", name: "Sonnet" }, "low", (s) => s, (s) => s, (s) => s, (s) => s);
	assert(fmnRes.includes("\uee9c Low"), "formatModelName includes \\uee9c Low thinking indicator");

	// Self-check: the ponytail glyph. \uef51 carries no outline in the Windows Nerd Font
	// build and renders blank there, so the status silently loses its icon (this is what
	// a past commit did). Pin the codepoint so a swap back to an invisible one fails here.
	const ponyLine = ponytailStatusLine("ponytail: FULL", (s) => s, (s) => s, (s) => s);
	assert(ponyLine.includes("\uef04"), "the ponytail status renders the \\uef04 horse, not the blank \\uef51");
	assert(!ponyLine.includes("\uef51"), "the blank \\uef51 glyph must never come back");
	assert(ponytailStatusLine("ponytail: LITE", (s) => s, (s) => s, (s) => s).includes("LITE"), "the ponytail mode is read from the status text");

	// Self-check: the status router must recognise the pi-jev-eye cell by the label its VALUE carries.
	// The old test was `value.includes("jev-eye")`, and the value is `Eye: ● ON (Clef Flash)` — no
	// `jev-eye` anywhere — so the branch went false and the cell silently lost its icon and dim suffix.
	// This pins the recognition rule itself, at the same place the router uses it.
	assert(isJevEyeStatus("Eye: ● ON (Clef Flash)"), "the value pi-jev-eye publishes is recognised as its own cell");
	assert(isJevEyeStatus("Eye: ○ OFF (Jev)"), "and so is every other mode's value");
	assert(!isJevEyeStatus("Jev: ● ON"), "the previous format is not claimed as this cell");
	assert(!isJevEyeStatus("MCP: 2 servers enabled"), "and neither is another extension's status");
	assert(
		!stripAnsi("Eye: ● ON (Clef Flash)").includes("jev-eye"),
		"the value carries no internal key name, which is what broke the old matcher",
	);

	// Self-check: the pi-jev-eye status cell. The value is `Eye: ● MODE (Backend)`; the backend is read out
	// of that string rather than hardcoded, and it takes `dim` while the base label and the state stay
	// readable — a backend painted like the label would bury `Eye: ● ON`, which is the case this cell
	// exists for. Both footer formats the operator asked for are pinned here.
	const jevPlain = (s: string) => s;
	const jevDim = (s: string) => `[dim]${s}[/dim]`;
	assert(
		jevEyeStatusLine("Eye: ● ON (Clef Flash)", jevPlain, jevDim, jevPlain, undefined) ===
			"\uf21b" + " Eye: ● ON [dim](Clef Flash)[/dim]",
		"Clef Flash is dim while `Eye:` and the state are not",
	);
	assert(
		jevEyeStatusLine("Eye: ● ON (Jev)", jevPlain, jevDim, jevPlain, undefined) === "\uf21b" + " Eye: ● ON [dim](Jev)[/dim]",
		"TypeSafe and OpenRouter both read as (Jev)",
	);
	assert(
		jevEyeStatusLine("Eye: ● ON (Clef)", jevPlain, jevDim, jevPlain, undefined) === "\uf21b" + " Eye: ● ON [dim](Clef)[/dim]",
		"the untiered Clef model draws no tier word",
	);
	assert(
		jevEyeStatusLine("Eye: ● ON (Clef Omni)", jevPlain, jevDim, jevPlain, undefined) === "\uf21b" + " Eye: ● ON [dim](Clef Omni)[/dim]",
		"a model added upstream draws its own tier",
	);
	assert(
		jevEyeStatusLine("Eye: ○ OFF (Jev)", jevPlain, jevDim, jevPlain, undefined) === "\uf21b" + " Eye: [dim]○[/dim] OFF [dim](Jev)[/dim]",
		"OFF takes the dim bullet",
	);
	assert(
		jevEyeStatusLine("Eye: ● REVIEW (Clef Flash)", jevPlain, jevDim, jevPlain, { fg: (color, text) => `<${color}>${text}</${color}>` }) ===
			"\uf21b" + " Eye: <warning>●</warning> REVIEW [dim](Clef Flash)[/dim]",
		"REVIEW keeps the warning bullet",
	);
	// A value with no parenthesised backend (an older pi-jev-eye) must not gain a stray `(`: the suffix is
	// drawn only when the value actually carries one.
	assert(
		jevEyeStatusLine("Eye: ● ON", jevPlain, jevDim, jevPlain, undefined) === "\uf21b" + " Eye: ● ON",
		"no backend suffix means no parenthesis, never a guessed one",
	);
	assert(isJevEyeStatus("\uf21b Eye: ● BALANCED (mercury-decide)"), "pi-decision-eye nerd-icon status is recognised");
	assert(
		jevEyeStatusLine("\uf21b Eye: ● BALANCED (mercury-decide)", jevPlain, jevDim, jevPlain, { fg: (color, text) => `<${color}>${text}</${color}>` }) ===
			"\uf21b" + " Eye: ● BALANCED [dim](mercury-decide)[/dim]",
		"BALANCED keeps accent bullet and dim backend",
	);
	assert(
		jevEyeStatusLine("\uf21b Eye: ● STRICT (mercury-decide)", jevPlain, jevDim, jevPlain, { fg: (color, text) => `<${color}>${text}</${color}>` }) ===
			"\uf21b" + " Eye: <mdHeading>●</mdHeading> STRICT [dim](mercury-decide)[/dim]",
		"STRICT takes primary (mdHeading) bullet",
	);
	assert(
		jevEyeStatusLine("\uf21b Eye: ● LIGHT (mercury-decide)", jevPlain, jevDim, jevPlain, { fg: (color, text) => `<${color}>${text}</${color}>` }) ===
			"\uf21b" + " Eye: <borderAccent>●</borderAccent> LIGHT [dim](mercury-decide)[/dim]",
		"LIGHT takes secondary (borderAccent) bullet",
	);
	assert(
		jevEyeStatusLine("\uf21b Eye: ○ OFF (mercury-decide)", jevPlain, jevDim, jevPlain, undefined) ===
			"\uf21b" + " Eye: [dim]○[/dim] OFF [dim](mercury-decide)[/dim]",
		"OFF takes dim bullet and dim backend",
	);

	// Self-check: session age survives /resume (header timestamp wins over now).
	const NOW = Date.parse("2026-10-08T12:00:00.000Z");
	assert(resolveSessionStartMs("resume", "2026-10-08T09:00:00.000Z", NOW) === Date.parse("2026-10-08T09:00:00.000Z"), "resume restores the session age from the header");
	assert(resolveSessionStartMs("startup", "2026-10-08T11:59:59.000Z", NOW) === Date.parse("2026-10-08T11:59:59.000Z"), "startup reads the freshly written header");
	assert(resolveSessionStartMs("resume", undefined, NOW) === NOW, "a missing header falls back to now");
	assert(resolveSessionStartMs("resume", "not-a-date", NOW) === NOW, "an unparsable header falls back to now");
	assert(resolveSessionStartMs("resume", "2026-10-08T13:00:00.000Z", NOW) === NOW, "a future header is clamped to now, never a negative age");

	// Self-check: the active clock. The run keeps counting after the last event and then
	// freezes at the threshold, so the display runs on its own and a pause costs at most
	// `pauseMs` — but the value never goes backwards.
	const ACTIVE_SYM = Symbol.for("pi-arnative.activeClock");
	const t0 = 1_000_000;
	const P = 180_000;
	delete (globalThis as Record<symbol, unknown>)[ACTIVE_SYM];
	const c = new ActiveClock(t0, P);
	assert(c.total(t0) === 0, "a fresh clock starts at zero");
	assert(c.total(t0 + 60_000) === 60_000, "the clock runs on its own, with no event arriving");
	assert(c.total(t0 + P) === P, "it keeps counting until the threshold");
	assert(c.total(t0 + P + 100_000) === P, "past the threshold the display freezes, it does not run forever");
	assert(c.total(t0 + 30_000) === 30_000 && c.total(t0 + 60_000) === 60_000, "an earlier read never rewinds the value");
	assert(c.total(t0 - 5_000) === 0, "a read before the run started is zero, never negative");
	assert(c.idle(t0) === false, "idle() is false at the start of a run");
	assert(c.idle(t0 + P) === false, "idle() at exactly the threshold is not idle");
	assert(c.idle(t0 + P + 1) === true, "idle() turns true past the threshold");
	// Activity after being away: the old run is committed at its frozen value and a new
	// run starts here, so a night away adds exactly `pauseMs`, never the away time.
	const away = t0 + P + 12 * 3600_000;
	c.tick(away);
	assert(c.total(away) === P, "an away gap commits the frozen run, not the away time");
	assert(c.idle(away) === false, "the tick resumes the clock");
	assert(c.total(away + 30_000) === P + 30_000, "the new run counts from the tick");
	const restored = new ActiveClock(away, P);
	assert(restored.active === c.active, "/reload reads the committed total back from globalThis");
	assert(restored.total(away) === P, "/reload does not restart the session at zero");
	delete (globalThis as Record<symbol, unknown>)[ACTIVE_SYM];

	// Self-check: seedActiveMs reconstructs the active time already on disk. Sorted by
	// time first (a fork keeps the parent's older timestamps), unparsable and future
	// entries ignored, empty log -> zero.
	const at = (ms: number) => ({ timestamp: new Date(t0 + ms).toISOString() });
	const SEED_NOW = t0 + 86_400_000; // a day later: every fixture timestamp is in the past
	assert(seedActiveMs([], 180_000, SEED_NOW) === 0, "empty log seeds zero");
	assert(seedActiveMs([at(0), at(60_000), at(120_000)], 180_000, SEED_NOW) === 120_000, "short gaps all count");
	assert(seedActiveMs([at(0), at(5 * 3600_000), at(5 * 3600_000 + 30_000)], 180_000, SEED_NOW) === 30_000, "a long gap is dropped, the tail still counts");
	assert(seedActiveMs([at(120_000), at(0), at(60_000)], 180_000, SEED_NOW) === 120_000, "out-of-order entries are sorted before summing");
	assert(seedActiveMs([at(0), at(0), at(60_000)], 180_000, SEED_NOW) === 60_000, "duplicate timestamps add nothing");
	assert(seedActiveMs([{ timestamp: "not-a-date" }, at(0), at(60_000)], 180_000, SEED_NOW) === 60_000, "unparsable timestamps are ignored");
	assert(seedActiveMs([at(2 * 86_400_000)], 180_000, SEED_NOW) === 0, "a future timestamp is ignored");

	// The watchdog: activity arms it, it paints the freeze once, then stops. The epsilon keeps
	// it off the boundary, where `idle()` is still false (strict `>`). `IDLE_PAUSE_MS` itself is
	// not pinned: it is a documented knob and the behaviour tests read `pauseMs` from the clock.
	assert(IDLE_PROBE_EPSILON_MS > 0, "the probe must fire past the boundary, not on it");
	clock.lastSeen = Date.now();
	armIdleProbe();
	assert(getRuntime().idleTimer != null, "activity arms the idle watchdog");
	stopIdleProbe();
	assert(getRuntime().idleTimer == null, "the watchdog is cleared on stop/shutdown");

	// Only keyboard input is activity. Mouse motion is sent continuously by the terminal
	// (it asks for all-motion mode), so counting it kept the clock open for as long as
	// the terminal had focus and the dim freeze never appeared.
	assert(isPointerOrFocusInput("\u001b[<35;10;5M"), "SGR mouse motion is not activity");
	assert(isPointerOrFocusInput("\u001b[<64;10;5M"), "SGR wheel is not activity");
	assert(isPointerOrFocusInput("\u001b[M !!"), "legacy X10 mouse is not activity");
	assert(isPointerOrFocusInput("\u001b[I") && isPointerOrFocusInput("\u001b[O"), "terminal focus is not activity");
	assert(!isPointerOrFocusInput("a") && !isPointerOrFocusInput("\r"), "keystrokes are activity");
	assert(!isPointerOrFocusInput("\u001b[A") && !isPointerOrFocusInput("\u001b[5~"), "arrow and page keys are activity");

	// parsePorcelainV2: single-call branch sync + uncommitted count, LF and CRLF safe.
	const pClean = parsePorcelainV2("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n");
	assert(pClean.ahead === 0 && pClean.behind === 0 && pClean.uncommitted === 0, "porcelain v2 clean repo");
	const pDirty = parsePorcelainV2("# branch.head feat\r\n# branch.ab +3 -2\r\n1 .M N... 100644 100644 100644 a b file.ts\r\n? untracked.txt\r\n");
	assert(pDirty.ahead === 3 && pDirty.behind === 2 && pDirty.uncommitted === 2, "porcelain v2 ahead/behind + dirty + CRLF");
	const pNoUpstream = parsePorcelainV2("# branch.head local\n1 M. N... 100644 100644 100644 a b a.ts\n");
	assert(pNoUpstream.ahead === 0 && pNoUpstream.behind === 0 && pNoUpstream.uncommitted === 1, "porcelain v2 without upstream");

	// layoutFooterGrid: pre-measures each body cell once and still truncates a right-only cell wider than width.
	let vwCalls = 0;
	const countingVw = (s: string) => {
		vwCalls++;
		return s.length;
	};
	const gridRows = layoutFooterGrid("H-L", "H-R", ["L1", "L2", "L3"], ["R1", "R2"], " | ", " | ", 80, countingVw);
	// Expected vw calls: 3 left cells + 2 right cells + 2 seps + 2 head cells = 9 (no re-measurement in wrap/pairRow).
	assert(vwCalls === 9, `layoutFooterGrid measures each cell once (got ${vwCalls} calls)`);
	assert(gridRows.length === 2, "layoutFooterGrid packs short rows into 1 body row");
	const narrowRight = layoutFooterGrid("H", "R", [], ["0123456789abcdef"], " | ", " | ", 8);
	assert(visibleWidth(narrowRight[1]!) <= 8, "right-only cell wider than width is truncated to fit");
});
