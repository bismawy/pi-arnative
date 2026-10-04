/**
 * Arnative footer (fixed 3-row grid, no click toggle).
 * Row 1: cwd | duration | branch/tag/status ...... model + thinking level.
 * Rows 2-3: extension status (mcp first) ......... tok/s · cache · token,
 * each side wrapped inside its half of the width and paired row by row.
 *
 * Preset (`/arnative footers`): "Arnative (Full)" (default) or "Pi (system)" (built-in footer), live.
 * Transcript clock & bubble bg: extensions/timestamps.ts
 * /new header: extensions/section-headers.ts
 * Selection + box reload: extensions/ui-render-tweaks.ts
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, FooterComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripAnsi } from "../lib/ansi.ts";
import { assert, isMain } from "../lib/check.ts";
import { capitalize, markedLabels, modelDisplayParts } from "../lib/format.ts";
import { IS_WINDOWS_LIKE, SHORTCUT_RELOAD } from "../lib/shortcuts.ts";
import { formatTokens } from "../lib/usage-store.ts";
import { FOOTER_PRESET_KEY as FOOTER_PRESET_CONFIG_KEY, loadChoice, resetPresetCache, saveChoice } from "../lib/preset-store.ts";

// ctrl+alt+r (alt+r on Windows/WSL — see lib/shortcuts.ts).
// The TUI drops key-release events before handleInput, so press+release cannot
// fire this twice even when the terminal reports event types (Kitty flag 2).

// Footer preset chosen through `/arnative footers`. "Arnative (Full)" = this extension's
// 3-row grid footer; "Pi (system)" = pi's built-in footer (the boxed editor stays arnative
// in both — pi's `setEditorComponent()` would close the picker mid-preview). The picker
// lives in arnative.ts, so the choice is shared through globalThis like the header preset.
// Listed built-in-first: the `(Full)` suffix is rendered dim, so the plain row reads cleaner on top.
export const FOOTER_PRESETS = ["Pi (system)", "Arnative (Full)"] as const;
export type FooterPreset = (typeof FOOTER_PRESETS)[number];
export const DEFAULT_FOOTER_PRESET: FooterPreset = "Arnative (Full)";
const FOOTER_PRESET_KEY = Symbol.for("pi-arnative.footerPreset");
const FOOTER_REGISTRAR_KEY = Symbol.for("pi-arnative.footerRegistrar");

export function activeFooterPreset(): FooterPreset {
	const stored = (globalThis as Record<symbol, unknown>)[FOOTER_PRESET_KEY] ?? loadChoice(FOOTER_PRESET_CONFIG_KEY, FOOTER_PRESETS);
	return FOOTER_PRESETS.includes(stored as FooterPreset) ? (stored as FooterPreset) : DEFAULT_FOOTER_PRESET;
}

/**
 * Hand the footer slot to the active preset: arnative's grid, or pi's built-in footer.
 * The editor is deliberately never touched here — pi's `setEditorComponent()` calls
 * `disposeActiveSelector()`, which would close the `/arnative` picker mid-preview.
 */
export function applyFooterPreset(ctx: ExtensionContext): void {
	if (activeFooterPreset() === "Pi (system)") {
		ctx.ui?.setFooter?.(undefined);
		return;
	}
	const register = (globalThis as Record<symbol, ((ctx: ExtensionContext) => void) | undefined>)[FOOTER_REGISTRAR_KEY];
	register?.(ctx);
}

/** Select a preset and apply it immediately (the footer swaps on the spot). */
export function setFooterPreset(name: FooterPreset, ctx: ExtensionContext): void {
	(globalThis as Record<symbol, unknown>)[FOOTER_PRESET_KEY] = name;
	saveChoice(FOOTER_PRESET_CONFIG_KEY, name);
	applyFooterPreset(ctx);
}

// Intercept the built-in FooterComponent to force a pure 2-line footer
const PATCHED_KEY = Symbol.for("pi-arnative.footer2LinesPatched");
if (FooterComponent?.prototype?.render && !(globalThis as Record<symbol, boolean>)[PATCHED_KEY]) {
	(globalThis as Record<symbol, boolean>)[PATCHED_KEY] = true;
	const origRender = FooterComponent.prototype.render;
	FooterComponent.prototype.render = function (width: number): string[] {
		// "Pi (system)" preset = pi's own footer, so keep its stock line count.
		if (activeFooterPreset() === "Pi (system)") return origRender.call(this, width);
		const lines = origRender.call(this, width);
		return lines.length > 2 ? lines.slice(0, 2) : lines;
	};
}

let activeThemeProxy: { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null = null;

type GitInfo = {
	branch: string;
	/** Absent (null) when git could not answer — never a false "-"/"clean". */
	tag: string | null;
	uncommitted: number | null;
	ahead: number;
	behind: number;
} | null;
let gitRefreshInFlight = false;

let git: GitInfo = null;
let currentThinkingLevel: string | undefined = undefined;
let currentModel: { id: string; name?: string; provider?: string } | undefined = undefined;
let rerender: (() => void) | null = null;
let lastPokeMs = 0;

const SESSION_START_KEY = Symbol.for("pi-arnative.sessionStartMs");
let sessionStartMs: number = (globalThis as Record<symbol, number>)[SESSION_START_KEY] || Date.now();
(globalThis as Record<symbol, number>)[SESSION_START_KEY] = sessionStartMs;

const MODEL_KEY = Symbol.for("pi-arnative.currentModel");
const THINKING_KEY = Symbol.for("pi-arnative.currentThinking");
const CWD_KEY = Symbol.for("pi-arnative.lastCwd");
const GIT_KEY = Symbol.for("pi-arnative.lastGit");
const GEN_KEY = Symbol.for("pi-arnative.footerGen");
let footerGen = (globalThis as Record<symbol, number>)[GEN_KEY] || 0;

let assistantStartMs: number | null = null;
let assistantChars = 0;
let latestSpeed: number | null = null;

// Live elapsed clock for the working loader: "⠴ Working (50s)".
const WORK_TIMER_KEY = Symbol.for("pi-arnative.workTimer");
const WORK_LABEL = "Working";
let workVerb = WORK_LABEL;
let workStartMs: number | null = null;
let workUI: { setWorkingMessage?: (message?: string) => void } | null = null;
// Verbs of tools still running (toolCallId -> verb): the label must not reset to
// "Working" while a sibling tool is still going (pi executes tools in parallel).
const activeToolVerbs = new Map<string, string>();

/** Label while `active` tools remain: last started wins, empty -> default. */
export function currentToolVerb(active: ReadonlyMap<string, string>): string {
	let verb = WORK_LABEL;
	for (const v of active.values()) verb = v;
	return verb;
}

type RunResult = { ok: boolean; out: string };
/** Distinguishes "git said nothing" from "git could not run" — the caller must not
 *  invent a clean tree when git is absent or the repo is not ours. */
function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		execFile(cmd, args, { cwd, timeout: 2000 }, (err, stdout) => {
			resolvePromise({ ok: !err, out: String(stdout).trim() });
		});
	});
}

/**
 * The branch, straight from `.git/HEAD` — the same trick pi's own footer uses.
 * `git branch --show-current` fails identically for a repo the user does not own
 * (git's dubious-ownership guard), a PATH without git, and a detached HEAD; all
 * three collapsed into a silent null before. Reading the ref needs no binary and
 * no ownership check, so a fresh user sees the branch without installing git.
 */
function branchFromDisk(cwd: string): string | null {
	// Walk up like git does: a subfolder of a repo is still inside it.
	for (let dir = resolve(cwd); ; ) {
		try {
			const dotGit = join(dir, ".git");
			// A worktree/submodule has a `.git` file pointing at the real git dir.
			const gitDir = statSync(dotGit).isDirectory()
				? dotGit
				: resolve(dir, readFileSync(dotGit, "utf8").trim().replace(/^gitdir:\s*/, ""));
			const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
			const ref = /^ref:\s+refs\/heads\/(.+)$/.exec(head);
			return ref ? ref[1] : "detached";
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null; // unreadable metadata
		}
		const parent = dirname(dir);
		if (parent === dir) return null; // reached the filesystem root: not a repo
		dir = parent;
	}
}

// A refresh arriving while one is in flight is queued (last requested cwd wins) and
// re-run afterwards — it used to be dropped, leaving the footer's git state stale
// until the next trigger.
let gitRefreshQueuedCwd: string | null = null;

/**
 * Row-1 git segment: branch(+sync), tag, worktree state. Halves git cannot answer
 * (no binary, or a repo the user does not own) are omitted, so a fresh user still sees
 * the branch but never a fabricated "-" or "clean".
 */
export function gitParts(info: GitInfo, acc: (t: string) => string, soft: (t: string) => string): string[] {
	if (!info) return [];
	const branch = `${acc("\uf126")} ${soft(info.branch)}${info.ahead > 0 ? ` ${soft(`↑${info.ahead}`)}` : ""}${info.behind > 0 ? ` ${soft(`↓${info.behind}`)}` : ""}`;
	const parts = [branch];
	if (info.tag !== null) parts.push(`${acc("\uf02b")} ${soft(info.tag)}`);
	if (info.uncommitted !== null) parts.push(`${acc("\uf172")}  ${info.uncommitted > 0 ? soft(`~${info.uncommitted}`) : soft("clean")}`);
	return parts;
}

async function refreshGit(cwd: string): Promise<void> {
	if (gitRefreshInFlight) {
		gitRefreshQueuedCwd = cwd;
		return;
	}
	gitRefreshInFlight = true;
	try {
		const branch = branchFromDisk(cwd);
		if (!branch) {
			// Clear the shared slot too, or the previous cwd's branch survives a reload.
			git = null;
			(globalThis as Record<symbol, any>)[GIT_KEY] = null;
			return;
		}
		const [tag, status, sync] = await Promise.all([
			run("git", ["describe", "--tags", "--abbrev=0"], cwd),
			run("git", ["status", "--porcelain"], cwd),
			run("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"], cwd),
		]);
		const uncommitted = status.ok ? status.out.split("\n").filter((l) => l.trim().length > 0).length : null;
		const parts = sync.ok && sync.out !== "" ? sync.out.split(/\s+/).map(Number) : [];
		const behind = parts.length > 0 && parts[0] > 0 ? parts[0] : 0;
		const ahead = parts.length > 1 && parts[1] > 0 ? parts[1] : 0;
		git = {
			branch,
			tag: tag.ok && tag.out ? tag.out : null,
			uncommitted,
			ahead,
			behind,
		};
		(globalThis as Record<symbol, any>)[GIT_KEY] = git;
	} finally {
		gitRefreshInFlight = false;
		if (gitRefreshQueuedCwd !== null) {
			const queued = gitRefreshQueuedCwd;
			gitRefreshQueuedCwd = null;
			void refreshGit(queued).then(() => poke());
		}
	}
}

function formatModelName(
	model: { id: string; name?: string; provider?: string } | undefined,
	thinkingLevel: string | undefined,
	acc: (t: string) => string,
	soft: (t: string) => string,
	dim: (t: string) => string,
): string {
	if (!model) return dim("No Model");
	const { name, provider } = modelDisplayParts({ id: model.id, name: model.name, provider: model.provider });
	const provStr = provider ? ` ${dim(`(${provider})`)}` : "";
	const capThinking = thinkingLevel && thinkingLevel !== "off" ? capitalize(thinkingLevel) : "";
	const thinkStr = capThinking ? `${acc("\udb80\udf35")} ${soft(capThinking)} ${dim("·")} ` : "";
	return `${thinkStr}${acc(name)}${provStr}`;
}

// Footer is a single line: a deep cwd (`/Users/x/Workspace/personal/proj`)
// pushes git state and the model off screen. Keep the last 2 segments.
export function shortenCwd(raw: string): string {
	const p = (raw || "").trim();
	if (!p) return p;
	const drive = p.match(/^[A-Za-z]:/);
	const body = drive ? p.slice(2) : p;
	const parts = body.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
	if (parts.length <= 2) return p;
	const head = drive ? `${drive[0]}/\u2026/` : p.startsWith("/") ? "\u2026/" : "\u2026";
	return head + parts.slice(-2).join("/");
}

export function formatDuration(ms: number): string {
	if (!ms || ms <= 0) return "-";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

// Full box editor: pi draws only the top/bottom lines (pi-tui editor.js: "no side
// borders, just horizontal lines above and below") and no prompt char, so the `│`
// sides, the round ╭╮╰╯ corners and the `> ` prompt are added here. `lines` are
// already rendered at width - 5 (2 sides + 3 prompt) and the border is patched with
// dashes to match. `visible` = content line count (private `renderedVisibleLineCount`);
// autocomplete lines stay outside the box. JetBrainsMono NF has the round glyphs.
export function boxEditorLines(
	lines: readonly string[],
	visible: number,
	color: (text: string) => string,
	prompt = " > ",
): string[] {
	const inner = lines.length > 0 ? visibleWidth(lines[0]!) : 0;
	const promptWidth = visibleWidth(prompt);
	if (inner < promptWidth + 4 || visible < 1 || lines.length < visible + 2) return [...lines];
	const out = [...lines];
	const side = color("\u2502");
	const indent = " ".repeat(promptWidth);
	for (let i = 1; i <= visible; i++) out[i] = side + (i === 1 ? prompt : indent) + lines[i]! + side;
	const patch = color("\u2500".repeat(promptWidth));
	out[0] = color("\u256d") + lines[0]! + patch + color("\u256e");
	out[visible + 1] = color("\u2570") + lines[visible + 1]! + patch + color("\u256f");
	return out;
}

/**
 * The footer as a fixed 3-row grid. Row 1 pairs the head cells (cwd line, model);
 * rows 2-3 pair the wrapped left cells (extension status, mcp first) with the
 * wrapped right cells (tok/s · cache · token), each side wrapping inside its half
 * of the terminal so the columns never collide. Right cells stay right-aligned.
 * A side that runs out of cells leaves its half blank, and a row where both sides
 * ran out is dropped, so a quiet footer stays 1-3 rows tall.
 */
export function layoutFooterGrid(
	headLeft: string,
	headRight: string,
	left: readonly string[],
	right: readonly string[],
	leftSep: string,
	rightSep: string,
	width: number,
	vw: (s: string) => number = visibleWidth,
): string[] {
	const half = Math.max(1, Math.floor(width / 2) - 1);
	// Wrap each side at half width; the first break happens at most once (rows 2-3),
	// after that the rest stays on the last row and the pairing truncates it.
	const wrap = (cells: readonly string[], sep: string): string[] => {
		const rows: string[] = [];
		let line = "";
		for (const cell of cells) {
			const candidate = line ? line + sep + cell : cell;
			if (line && rows.length === 0 && vw(candidate) > half) {
				rows.push(line);
				line = cell;
			} else {
				line = candidate;
			}
		}
		if (line) rows.push(line);
		return rows;
	};
	const leftRows = wrap(left, leftSep);
	const rightRows = wrap(right, rightSep);
	const out = [pairRow(headLeft, headRight, width, vw)];
	for (let i = 0; i < Math.max(leftRows.length, rightRows.length); i++) {
		const l = leftRows[i];
		const r = rightRows[i];
		if (l === undefined && r === undefined) break;
		out.push(pairRow(l ?? "", r ?? "", width, vw));
	}
	return out;
}

/** One grid row: `left` at the start, `right` flush to the right edge. */
function pairRow(left: string, right: string, width: number, vw: (s: string) => number): string {
	if (!right) return truncateToWidth(left, width);
	const rightWidth = Math.min(vw(right), width);
	if (!left) return " ".repeat(width - rightWidth) + truncateToWidth(right, width);
	if (vw(left) + 1 + rightWidth <= width) {
		return left + " ".repeat(width - vw(left) - rightWidth) + right;
	}
	// Too wide together: the right cell keeps its columns, the left one is cut.
	const room = Math.max(1, width - rightWidth - 1);
	return truncateToWidth(left, room) + " " + truncateToWidth(right, width - room - 1);
}

function parseOptimizer(raw: string | undefined): string | null {

	if (!raw) return null;
	const m = raw.match(/([A-Za-z0-9_-]+)\s+cache\s+(\d+\/\d+)·[^\s]+\s+([\d.]+%)/);
	return m ? `${m[1]} ${m[2]} (${m[3]})` : null;
}

let usageScanAt = 0;
let usageScanLen = -1;
let usageScanNums = { inp: 0, out: 0, read: 0 };
// Usage of the branch's last entry at scan time: a stream tick mutates that message
// in place (branch length unchanged), so the delta is applied on top of the cached
// sums — O(1) per frame, numbers always fresh, still no O(N) rescan per frame.
let usageScanLast = { inp: 0, out: 0, read: 0 };

const lastUsageOf = (branch: readonly unknown[]): { inp: number; out: number; read: number } => {
	const last = branch[branch.length - 1] as
		| { type?: string; message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } } }
		| undefined;
	const u = last?.type === "message" && last.message?.role === "assistant" ? last.message.usage : undefined;
	return u ? { inp: u.input || 0, out: u.output || 0, read: u.cacheRead || 0 } : { inp: 0, out: 0, read: 0 };
};

// 2s cache + branch length: the footer renders on every poke/stream tick, so
// without this every frame rescans the whole branch (O(N) per frame).
export function getUsage(
	ctx: { sessionManager: { getBranch(): readonly unknown[] }; getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined },
	acc: (t: string) => string,
	soft: (t: string) => string,
): string {
	const branch = ctx.sessionManager.getBranch();
	const last = lastUsageOf(branch);
	let inp = 0;
	let out = 0;
	let read = 0;
	if (Date.now() - usageScanAt < 2000 && branch.length === usageScanLen) {
		// Cached sums + the streaming delta of the last message (mutated in place).
		inp = usageScanNums.inp + last.inp - usageScanLast.inp;
		out = usageScanNums.out + last.out - usageScanLast.out;
		read = usageScanNums.read + last.read - usageScanLast.read;
	} else {
		for (const e of branch) {
			if (e && typeof e === "object" && "type" in e && e.type === "message") {
				const m = (e as { message?: unknown }).message;
				if (m && typeof m === "object" && "role" in m && m.role === "assistant" && "usage" in m) {
					const u = (m as AssistantMessage).usage;
					if (u) {
						inp += u.input || 0;
						out += u.output || 0;
						read += u.cacheRead || 0;
					}
				}
			}
		}
		usageScanNums = { inp, out, read };
		usageScanLast = last;
		usageScanAt = Date.now();
		usageScanLen = branch.length;
	}
	const parts: string[] = [];
	if (inp > 0) parts.push(`${acc("↑")}${soft(formatTokens(inp))}`);
	if (out > 0) parts.push(`${acc("↓")}${soft(formatTokens(out))}`);
	if (read > 0) parts.push(`${acc("\uf49b")} ${soft(formatTokens(read))}`);
	const u = ctx.getContextUsage();
	if (u && u.percent !== null && u.tokens !== null) {
		parts.push(`${acc("\udb81\udfaf")} ${soft(`${u.percent.toFixed(1)}%/${formatTokens(u.contextWindow)}`)}`);
	}
	return parts.join(" ");
}

function poke(): void {
	try {
		rerender?.();
	} catch {
		// ignore
	}
}

/**
 * Tool name → active progress text (gerund).
 * Fallback when unregistered: "Working".
 */
// Verb for an MCP sub-action (shared by the `mcp` and `mcp__*` tool names).
function mcpStatusOf(sub: string): string {
	if (sub.includes("search") || sub.includes("find")) return "Searching";
	if (sub.includes("fetch") || sub.includes("get") || sub.includes("read")) return "Fetching";
	if (sub.includes("edit") || sub.includes("write") || sub.includes("patch")) return "Editing";
	return "Executing";
}

/** Loader label with the elapsed suffix; no suffix below 1s (avoids a "(0s)" flicker). */
export function workingLabel(verb: string, elapsedMs: number): string {
	return elapsedMs >= 1000 ? `${verb} (${formatDuration(elapsedMs)})` : verb;
}

function paintWorking(): void {
	if (!workUI || workStartMs === null) return;
	try {
		workUI.setWorkingMessage?.(workingLabel(workVerb, Date.now() - workStartMs));
	} catch {
		// ignore
	}
}

function stopWorkingClock(): void {
	const t = (globalThis as Record<symbol, any>)[WORK_TIMER_KEY];
	if (t) clearInterval(t);
	(globalThis as Record<symbol, any>)[WORK_TIMER_KEY] = null;
	workStartMs = null;
	activeToolVerbs.clear();
}

/** Start (or restart) the 1s tick from a fresh turn. */
function startWorkingClock(ctx: { ui?: any }): void {
	stopWorkingClock();
	workUI = ctx.ui ?? null;
	workVerb = WORK_LABEL;
	workStartMs = Date.now();
	(globalThis as Record<symbol, any>)[WORK_TIMER_KEY] = setInterval(paintWorking, 1000);
}

/** Swap the verb (tool change) without resetting the turn clock. */
function setWorkingVerb(ctx: { ui?: any }, verb: string): void {
	workUI = ctx.ui ?? null;
	workVerb = verb;
	if (workStartMs === null) workStartMs = Date.now();
	paintWorking();
}

export function getToolWorkingMessage(toolName: string, args?: any): string {
	const n = (toolName ?? "").trim();
	if (!n) return WORK_LABEL;

	// Standard / file tools
	if (n === "edit") return "Editing";
	if (n === "write") return "Writing";
	if (n === "read") return "Reading";
	if (n === "grep" || n === "find" || n === "web_search" || n === "source_check") return "Searching";
	if (n === "bash") return "Executing";
	if (n === "fetch_content") return "Fetching";
	if (n === "get_search_content") return "Reading";
	if (n === "generate_image") return "Generating image";
	if (n === "todo" || n === "scratchpad") return "Updating tasks";
	if (n.startsWith("memory_")) return "Accessing memory";
	if (n.startsWith("lsp_")) return "Checking code";
	if (n.startsWith("chrome_devtools_")) return "Browsing";
	if (n === "ask_user_question" || n === "plan_mode_question") return "Waiting for input";

	// MCP tools (mcp / mcpScript / mcp__*)
	if (n === "mcpScript") return "Running script";
	if (n === "mcp") {
		const sub = typeof args === "object" && args ? (args.tool || args.search || args.describe || args.action) : "";
		return sub ? mcpStatusOf(String(sub).toLowerCase()) : "Executing";
	}
	if (n.startsWith("mcp__")) {
		const sub = typeof args === "object" && args?.tool ? String(args.tool).toLowerCase() : "";
		return mcpStatusOf(sub);
	}

	return WORK_LABEL;
}

export default function (pi: ExtensionAPI) {
	let runtimeGen = 0;

	// Assistant speed timer (user message timestamps come from extensions/timestamps.ts)
	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			assistantStartMs = Date.now();
			assistantChars = 0;
		}
	});

	pi.on("session_start", async (event, ctx) => {
		// A /reload re-imports this module while the old instance's interval (and its
		// ctx.ui closures) may still be alive; clear it before starting a new one.
		stopWorkingClock();
		if (event.reason !== "reload") {
			sessionStartMs = Date.now();
			(globalThis as Record<symbol, number>)[SESSION_START_KEY] = sessionStartMs;
			currentModel = ctx.model;
			currentThinkingLevel = ctx.thinkingLevel;
			git = null;
		} else {
			currentModel = (globalThis as Record<symbol, any>)[MODEL_KEY] ?? ctx.model;
			currentThinkingLevel = (globalThis as Record<symbol, any>)[THINKING_KEY] ?? ctx.thinkingLevel;
			git = (globalThis as Record<symbol, any>)[GIT_KEY] ?? null;
		}
		(globalThis as Record<symbol, any>)[MODEL_KEY] = currentModel;
		(globalThis as Record<symbol, any>)[THINKING_KEY] = currentThinkingLevel;
		(globalThis as Record<symbol, any>)[GIT_KEY] = git;
		activeThemeProxy = ((ctx as unknown as { ui?: { theme?: typeof activeThemeProxy } }).ui?.theme) ?? activeThemeProxy;

		const cwd = (event.reason === "reload" && (globalThis as Record<symbol, any>)[CWD_KEY])
			? (globalThis as Record<symbol, any>)[CWD_KEY]
			: ctx.cwd;
		(globalThis as Record<symbol, any>)[CWD_KEY] = cwd;

		runtimeGen = ++footerGen;
		(globalThis as Record<symbol, number>)[GEN_KEY] = footerGen;

		try {
			const registerArnative = (c: ExtensionContext) => {
				c.ui.setFooter((tui, theme, footerData) => {
					activeThemeProxy = theme;
					rerender = () => tui.requestRender();
					const unsub = footerData.onBranchChange(() => {
						void refreshGit(cwd).then(() => tui.requestRender());
					});
					return {
						dispose() {
							rerender = null;
							unsub();
						},
						invalidate() {},
						render(width: number): string[] {
							const acc = (text: string) => theme.fg("accent", text);
							const dim = (text: string) => theme.fg("dim", text);
							const fgAny = theme.fg.bind(theme) as (color: string, text: string) => string;
							let softName = "accent";
							try {
								fgAny("accentSoft", "");
								softName = "accentSoft";
							} catch {
								// fallback
							}
							const soft = (text: string) => fgAny(softName, text);
							const sep = dim(" | ");

							const durationStr = formatDuration(Date.now() - sessionStartMs);
							const pDuration = `${acc("\uf017")} ${soft(durationStr)}`;
							const cwdShort = shortenCwd(cwd);
							let left1 = `${acc("\uf07b")} ${dim(cwdShort)}${sep}${pDuration}`;
							if (git) {
								left1 = `${acc("\uf07b")} ${dim(cwdShort)}${sep}${pDuration}${gitParts(git, acc, soft).map((p) => `${sep}${p}`).join("")}`;
							}
							const right1 = formatModelName(currentModel, currentThinkingLevel, acc, soft, dim);

							const statuses: ReadonlyMap<string, string> = (() => {
								try {
									return footerData.getExtensionStatuses();
								} catch {
									return new Map<string, string>();
								}
							})();
							const rawCache = statuses.get("pi-cache-stats");
							const cleanStatus = (s: string) => {
								if (s.includes("MCP:")) {
									let clean = stripAnsi(s);
									const idx = clean.indexOf("MCP:");
									let rest = (idx >= 0 ? clean.slice(idx) : clean).replace(/\uFFFD/g, "").trim();
									rest = rest.replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u2800-\u28FF]/gu, "").replace(/\s{2,}/g, " ").trim();
									const m = rest.match(/MCP:\s*\d+\s*servers?\s*enabled/i);
									return `${acc("\uf233")} ${soft(m ? m[0] : rest || "MCP")}`;
								}
								if (s.includes("ponytail")) {
									const isActive = s.includes("●");
									const bullet = isActive ? acc("●") : dim("○");
									let mode = "FULL";
									if (/LITE/i.test(s)) mode = "LITE";
									else if (/ULTRA/i.test(s)) mode = "ULTRA";
									else if (/FULL/i.test(s)) mode = "FULL";
									return `${acc("\uef04")}  ${soft("ponytail:")} ${bullet} ${soft(mode)}`;
								}
								if (s.includes("jev-eye")) {
									const isOff = s.includes("OFF") || s.includes("○");
									const isReview = /REVIEW/i.test(s);
									let bullet = isOff ? dim("○") : acc("●");
									if (isReview) {
										try {
											bullet = theme.fg("warning", "●");
										} catch {
											bullet = acc("●");
										}
									}
									const label = isOff ? "OFF" : isReview ? "REVIEW" : "ON";
									return `${acc("\uedcf")}  ${soft("Jev:")} ${bullet} ${soft(label)}`;
								}
								let clean = stripAnsi(s);
								clean = clean.replace(/\uFFFD/g, "").replace(/\?{1,2}\s*/g, "");
								return soft(clean.trim());
							};

							const groups: string[] = [];
							const mcp = statuses.get("mcp");
							if (mcp !== undefined) groups.push(cleanStatus(mcp));
							for (const [k, s] of statuses) {
								if (k !== "mcp" && k !== "pi-cache-stats") groups.push(cleanStatus(s));
							}

							const opt = parseOptimizer(rawCache);
							let usageStr = "";
							try {
								usageStr = getUsage(ctx, acc, soft);
							} catch {
								// fallback
							}
							const speedStr = latestSpeed !== null && latestSpeed > 0 ? `${acc("\udb81\udcc5")} ${soft(`${latestSpeed.toFixed(1)} tok/s`)}` : "";
							const metricCells = [speedStr, opt ? `${acc("\udb80\udf5b")} ${soft(opt)}` : "", usageStr].filter(Boolean);

							// Fixed 3-row grid: head (cwd/model), then statuses and metrics each
							// wrapped inside their half of the width — no click toggle.
							return layoutFooterGrid(left1, right1, groups, metricCells, sep, ` ${dim("·")} `, width);
						},
					};
				});

			};
			(globalThis as Record<symbol, (ctx: ExtensionContext) => void>)[FOOTER_REGISTRAR_KEY] = registerArnative;
			applyFooterPreset(ctx);
			class ArnativeEditor extends CustomEditor {
				constructor(tui: any, editorTheme: any, keybindings: any, options?: any) {
					super(tui, editorTheme, keybindings, { ...options, embedWorkingStatus: true });
				}

				private getActiveTheme() {
					return ctx.ui?.theme ?? activeThemeProxy;
				}

				private applyFixedIndicatorColors(indicator: any) {
					if (!indicator) return;
					indicator.spinnerColorFn = (text: string) => {
						try {
							const th = this.getActiveTheme();
							return th ? th.fg("accent", text) : text;
						} catch {
							return text;
						}
					};
					indicator.messageColorFn = (text: string) => {
						try {
							const th = this.getActiveTheme();
							if (!th) return text;
							try {
								return th.fg("accentSoft", text);
							} catch {
								return th.fg("muted", text);
							}
						} catch {
							return text;
						}
					};
				}

				setWorkingStatusIndicator(indicator: any) {
					this.applyFixedIndicatorColors(indicator);
					indicator?.updateDisplay?.();
					super.setWorkingStatusIndicator(indicator);
				}

				renderTopBorder(width: number, hiddenLineCount: number): string {
					this.applyFixedIndicatorColors((this as any).workingStatusIndicator);
					return super.renderTopBorder(width, hiddenLineCount);
				}

				handleInput(data: string) {
					if (SHORTCUT_RELOAD.matches(data)) {
						this.setText("");
						if (this.onSubmit) {
							this.onSubmit("/reload");
						}
						return;
					}
					super.handleInput(data);
				}

				render(width: number): string[] {
					// The box eats 5 columns: 2 sides + the 3-column " > " prompt, so the
					// content is rendered 5 columns narrower.
					const visible = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount;
					if (typeof visible !== "number" || width < 11) return super.render(width);
					let prompt = " > ";
					try {
						prompt = this.getActiveTheme()?.fg("dim", prompt) ?? prompt;
					} catch {
						// theme not ready -> uncolored prompt
					}
					return boxEditorLines(super.render(width - 5), visible, (t) => this.borderColor(t), prompt);
				}
			}
			ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new ArnativeEditor(tui, editorTheme, keybindings));
		} catch {
			// fallback
		}
		void refreshGit(cwd).then(() => poke());
	});

	pi.on("turn_start", async (_event, ctx) => {
		currentModel = ctx.model;
		currentThinkingLevel = ctx.thinkingLevel;
		(globalThis as Record<symbol, any>)[MODEL_KEY] = currentModel;
		(globalThis as Record<symbol, any>)[THINKING_KEY] = currentThinkingLevel;
		(globalThis as Record<symbol, any>)[CWD_KEY] = ctx.cwd;
		startWorkingClock(ctx);
		void refreshGit(ctx.cwd).then(() => poke());
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		const verb = getToolWorkingMessage(event.toolName, event.args);
		activeToolVerbs.set(event.toolCallId, verb);
		setWorkingVerb(ctx, verb);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeToolVerbs.delete(event.toolCallId);
		setWorkingVerb(ctx, currentToolVerb(activeToolVerbs));
	});

	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant") {
			// Timer starts lazily if message_start never fired (fragile event pairing)
			if (assistantStartMs === null) assistantStartMs = Date.now();
			const streamEvent = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
			if (streamEvent?.delta) {
				assistantChars += streamEvent.delta.length;
			}
			const elapsed = (Date.now() - assistantStartMs) / 1000;
			if (elapsed >= 0.3) {
				const usageOut = (event.message as AssistantMessage).usage?.output;
				const currentTokens = typeof usageOut === "number" && usageOut > 0 ? usageOut : Math.ceil(assistantChars / 3.8);
				if (currentTokens > 0) {
					latestSpeed = currentTokens / elapsed;
					const now = Date.now();
					if (now - lastPokeMs >= 500) {
						lastPokeMs = now;
						poke();
					}
				}
			}
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") {
			const start = assistantStartMs ?? Date.now();
			const elapsed = (Date.now() - start) / 1000;
			assistantStartMs = null;
			const usageOut = (event.message as AssistantMessage).usage?.output;
			const finalTokens = typeof usageOut === "number" && usageOut > 0 ? usageOut : Math.ceil(assistantChars / 3.8);
			if (finalTokens > 0 && elapsed > 0.2) {
				latestSpeed = finalTokens / elapsed;
			}
		}
		poke();
	});

	pi.on("turn_end", async (_event, ctx) => {
		stopWorkingClock();
		try {
			ctx.ui?.setWorkingMessage?.();
		} catch {
			// ignore
		}
		poke();
	});

	pi.on("model_select", async (event) => {
		currentModel = event.model;
		(globalThis as Record<symbol, any>)[MODEL_KEY] = currentModel;
		poke();
	});

	pi.on("thinking_level_select", async (event) => {
		currentThinkingLevel = event.level;
		(globalThis as Record<symbol, any>)[THINKING_KEY] = currentThinkingLevel;
		poke();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopWorkingClock();
		rerender = null;
		const cur = ((globalThis as Record<symbol, number>)[GEN_KEY] ?? 0);
		if (cur !== runtimeGen) return;
		footerGen++;
		(globalThis as Record<symbol, number>)[GEN_KEY] = footerGen;
		try {
			(ctx as unknown as { ui?: { setFooter?: (f?: undefined) => void } }).ui?.setFooter?.(undefined);
		} catch {
			// ignore
		}
	});
}

// Self-check: `node extensions/footer.ts`
if (isMain(import.meta.url)) {
	assert(shortenCwd("/run/media/bisma/DATA/Pi/pi-arnative") === "\u2026/Pi/pi-arnative", "cwd inside -> last 2 segments");
	assert(shortenCwd("/home/bisma") === "/home/bisma", "shallow cwd left unchanged");
	assert(shortenCwd("D:\\Pi\\a\\pi-arnative") === "D:/\u2026/a/pi-arnative", "long Windows path: drive kept");
	assert(shortenCwd("D:\\Pi\\pi-arnative") === "D:\\Pi\\pi-arnative", "shallow Windows path left unchanged");
	assert(shortenCwd("/a/x/y/z") === "\u2026/y/z", "long path -> tail");
	assert(shortenCwd("") === "", "empty cwd");
	assert(formatDuration(0) === "-", "empty duration = -");
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
	assert(Boolean((globalThis as Record<symbol, unknown>)[WORK_TIMER_KEY]), "clock starts: timer stored on globalThis");
	stopWorkingClock();
	assert((globalThis as Record<symbol, unknown>)[WORK_TIMER_KEY] == null, "clock stops: reload guard clears the timer");
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

	// regression: a refresh arriving while one is in flight is re-run with the newest
	// cwd, not dropped (the footer's git state no longer stays stale until the next trigger).
	// "newest cwd" needs a real repo: the branch now comes from .git/HEAD, not from git.
	const repo = mkdtempSync(join(tmpdir(), "pi-arnative-repo-"));
	mkdirSync(join(repo, ".git"), { recursive: true });
	writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/arnative-tests\n");
	git = null;
	const noGit = mkdtempSync(join(tmpdir(), "pi-arnative-nogit-"));
	void refreshGit(noGit); // in flight (deterministic: sync up to the first await), resolves git = null
	await refreshGit(repo); // queued behind it with the newest cwd
	for (let i = 0; i < 100 && git === null; i++) await new Promise((r) => setTimeout(r, 20));
	assert(git !== null && git.branch === "arnative-tests", "queued git refresh re-ran on the newest cwd (not dropped)");
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
	const unknownGit = gitParts({ branch: "main", tag: null, uncommitted: null, ahead: 0, behind: 0 }, A, S);
	assert(unknownGit.length === 1 && unknownGit[0]!.endsWith("main"), "unreadable git: branch only, no fake '-'/'clean'");
	const fullGit = gitParts({ branch: "main", tag: "v1.2.3", uncommitted: 2, ahead: 1, behind: 0 }, A, S);
	assert(fullGit.length === 3 && fullGit[1]!.endsWith("v1.2.3") && fullGit[2]!.includes("~2"), "readable git: tag + dirty count present");
	assert(gitParts(null, A, S).length === 0, "not a repo: no git segment at all");

	// Footer presets: Arnative (Full) is the default; Pi (system) hands the footer slot back to pi (the editor stays arnative).
	assert(DEFAULT_FOOTER_PRESET === "Arnative (Full)" && FOOTER_PRESETS.length === 2, "Arnative (Full) is the default footer preset");
	assert(FOOTER_PRESETS.join(" | ") === "Pi (system) | Arnative (Full)", "built-in preset is listed first");
	assert(markedLabels(FOOTER_PRESETS, "Pi (system)").join(" | ") === "● Pi (system) |   Arnative (Full)", "footer preset labels mark the active one");
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
	(globalThis as Record<symbol, (ctx: ExtensionContext) => void>)[FOOTER_REGISTRAR_KEY] = () => { registered++; };
	setFooterPreset("Arnative (Full)", presetCtx);
	assert(registered === 1 && activeFooterPreset() === "Arnative (Full)", "Arnative (Full) re-runs the arnative registrar");
	delete (globalThis as Record<symbol, unknown>)[FOOTER_REGISTRAR_KEY];
	// Persist a NON-default value: asserting the default survives proves nothing.
	setFooterPreset("Pi (system)", presetCtx);
	assert(loadChoice(FOOTER_PRESET_CONFIG_KEY, FOOTER_PRESETS) === "Pi (system)", "the footer preset is persisted to disk");
	delete (globalThis as Record<symbol, unknown>)[FOOTER_PRESET_KEY];
	resetPresetCache();
	assert(activeFooterPreset() === "Pi (system)", "a restart reads the non-default footer preset back from disk");
	rmSync(presetFixture, { recursive: true, force: true });
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	resetPresetCache();

	console.log("footer.ts self-check OK");
}
