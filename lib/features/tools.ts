/**
 * Codex/Claude-Code style tool boxes: every tool call in its own box.
 *   ╭────────────────────────────╮
 *   │ 󰔟 $ cmd smart…             │  running (spinner, gone once finished)
 *   ╰────────────────────────────╯
 *   ╭────────────────────────────╮
 *   │ ✓ $ cmd smart…      0.1s   │  final, collapsed; duration right-aligned
 *   │ 󱞩 first output line        │
 *   ╰────────────────────────────╯
 * Click `[show]` / `[hide]` or press the `app.tools.expand` key (ctrl+o by default) = full title + detail
 * (output dim; edit = toolDiff*).
 * Collapsed summary: bash/write `󱞩 first line`; grep/find/read numeric
 * (→ N matches / → N files / N lines); edit `󱞩 +N / -M`. Expanded plain output
 * gets no summary line (no duplicated first line).
 * Colors: tool name accent, paths/links soft, box lines + 󱞩 dim. Execution is a
 * pure delegate (spread of the built-in tools).
 * "has a result" lives in context.state, read at render() -> restore/reload safe,
 * no stale 󰔟 box. Third-party tools with no renderer of their own (memory_write,
 * scratchpad, MCP…) get the same box: shell "self", one-line summary,
 * `[show]` for the full detail.
 */
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createPowerShellTool, createReadTool, createWriteTool, getMarkdownTheme, highlightCode, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHoldRepeat, inSpans, renderBoxLines as box, type HoldRepeat, type TextSpan, textSpans } from "../box.ts";
import { getActiveTheme, stripAnsi, softSecondaryOf } from "../ansi.ts";
import { actionWord } from "../todos.ts";
import {
	EDIT_DIFF_CHOICES,
	EDIT_DIFF_CONFIG_KEY,
	activeEditDiff,
	formatEditDiff,
	setEditDiff,
	type EditDiffMode,
} from "../edit-diff.ts";
import { markPatched, originalOf } from "../patch.ts";
import {
	TOOL_BOX_SCROLL_HOLD_KEY as SCROLL_HOLD,
	TOOL_BOX_SCROLL_OFFSET_KEY as SCROLL_OFFSET,
} from "../runtime.ts";

export { EDIT_DIFF_CHOICES, activeEditDiff, formatEditDiff, setEditDiff, type EditDiffMode };

export type Theme = { fg(color: string, text: string): string; bg?(color: string, text: string): string; inverse?(text: string): string };
type ToolArgs = Record<string, unknown>;
type ToolDetails = { diff?: string; calls?: CodemodeCall[] } & Record<string, unknown>;
type TResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: ToolDetails };
export type TCtx = { isError?: boolean; toolCallId?: string; args?: ToolArgs; state?: Record<string, unknown>; durationMs?: number; expanded?: boolean };
type Res = (r: TResult, th: Theme, soft: (s: string) => string, isErr: boolean, expanded: boolean) => string;

interface CodemodeCall {
	status?: string;
	durationMs?: number;
	name?: string;
	args?: string;
}

interface RenderableComponent {
	render?(width: number): string[];
}

interface ToolMouseEventLike {
	type: string;
	button?: string;
	x: number;
	y: number;
}

type ToolRendererFn = (args: ToolArgs, th: Theme, ctx: TCtx) => RenderableComponent;
type ToolResultRendererFn = (
	result: TResult,
	opts: { expanded: boolean; isPartial?: boolean },
	th: Theme,
	ctx: TCtx,
) => RenderableComponent;

interface PatchedToolComponent extends Record<symbol, unknown> {
	toolName: string;
	expanded?: boolean;
	toolDefinition?: { renderShell?: string; renderCall?: ToolRendererFn; renderResult?: ToolResultRendererFn };
	render(width: number): string[];
	handleMouse?(event: ToolMouseEventLike): unknown;
	hasRendererDefinition(): boolean;
	getRenderShell(): string;
	getCallRenderer(): ToolRendererFn | undefined;
	getResultRenderer(): ToolResultRendererFn | undefined;
	invalidate?: () => void;
	ui?: { requestRender?: () => void };
}

const cwd = process.cwd();
const MAX_TIMINGS = 200;
const TIMINGS = new Map<string, number>();

/** Runtime of one call: pi's own figure first (it survives a restore and covers tools this
 *  module does not wrap), then the wall time recorded by the execute wrapper. */
const durationOf = (ctx: TCtx): string =>
	fmtMs(ctx.durationMs ?? (ctx.toolCallId ? TIMINGS.get(ctx.toolCallId) : undefined));

export function recordTiming(toolCallId: string, durationMs: number): void {
	if (TIMINGS.size >= MAX_TIMINGS) {
		const oldest = TIMINGS.keys().next().value;
		if (oldest !== undefined) TIMINGS.delete(oldest);
	}
	TIMINGS.set(toolCallId, durationMs);
}

// Running icon 󰔟 󱦠 󱦟: 500ms spin frames from a ticker that only runs while
// a tool is active (idle = no wasteful re-renders).
const FRAMES = ["󰔟", "󱦠", "󱦟"];
let ACTIVE = 0;
let TICK: ReturnType<typeof setInterval> | null = null;
let requestRenderFn: (() => void) | null = null;

function syncTicker(): void {
	if (ACTIVE > 0 && !TICK) {
		TICK = setInterval(() => requestRenderFn?.(), 500);
	} else if (ACTIVE <= 0 && TICK) {
		clearInterval(TICK);
		TICK = null;
	}
}

export function spinIcon(): string {
	return FRAMES[Math.floor(Date.now() / 500) % FRAMES.length];
}

/** Tool duration: `2ms` under a second, `1.4s` above — the wording pi itself uses. */
function fmtMs(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export class Lines {
	private get: (width: number) => string[];
	constructor(get: (width: number) => string[]) {
		this.get = get;
	}
	render(width: number): string[] {
		return this.get(width);
	}
	invalidate(): void {}
}
const EMPTY = new Lines(() => []);

const shortPath = (p: string): string => {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

const textOf = (r: TResult): string =>
	r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();

const firstLine = (s: string): string => s.split("\n").find((l) => l.trim()) ?? "";

// Summary = first line with content. Punctuation-only lines (e.g. a lone `{` from
// pretty-printed MCP JSON) explain nothing -> take the next one.
const firstMeaningful = (s: string): string => {
	const lines = s.split("\n").filter((l) => l.trim());
	return lines.find((l) => !/^[\s{}\[\],;:]+$/.test(l)) ?? lines[0] ?? "";
};

const countLines = (s: string): number => (s ? s.split("\n").filter(Boolean).length : 0);

// Tint folder paths / URLs; everything else default.
export const LINK_RE = /(?:https?:\/\/[^\s"'`)}\]]+|(?:~|\.{1,2})?\/[\w.+@~%/-]+|[\w.+@~-]+(?:\/[\w.+@~%/-]+)+)/g;
export function paintLinks(text: string, soft: (s: string) => string): string {
	return text.replace(LINK_RE, (m) => soft(m));
}

// Word-limited smart title: `maxWords` words + ellipsis; full text when expanded.
export function smartTitle(cmd: string, maxWords = 6): string {
	const words = cmd.replace(/\r?\n/g, " ").trim().split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return words.join(" ");
	return `${words.slice(0, maxWords).join(" ")}…`;
}

// Result line prefix: 󱞩 dim (duration lives at the right end of the title).
export function resHead(theme: Theme): string {
	return theme.fg("dim", "󱞩");
}

/** Rows a block of text takes once painted at `width`, blank lines dropped: one long JSON
 *  string is a single newline but twenty-five rows on screen. */
const drawnRows = (text: string, width: number): number =>
	text
		.split("\n")
		.filter((l) => l.trim())
		.reduce((n, l) => n + Math.max(1, Math.ceil(visibleWidth(l) / Math.max(1, width))), 0);

/** A summary is one row by definition: a single-line JSON payload of 40k chars would
 *  otherwise wrap into a full screen and the box would look expanded while folded. */
const oneRow = (text: string, inner: number): string => truncateToWidth(text, inner, "…");

// Title line: duration right-aligned and space-aware (title truncated when it
// doesn't fit); expanded = full title wrapped. All lines stay <= inner (overflow bug).
export function titleRow(
	theme: Theme,
	icon: string,
	name: string,
	argPart: string,
	inner: number,
	dur: string,
	expanded: boolean,
	hint = "",
): string[] {
	const head = `${icon} ${name} ${argPart}`.trim();
	// Runtime first, label last: the figure is what you read, the label is the button.
	const right = [dur, hint].filter(Boolean).join(" · ");
	const durStr = right ? theme.fg("dim", right) : "";
	if (!durStr) {
		return expanded ? wrapTextWithAnsi(head, inner) : [truncateToWidth(head, inner, "…")];
	}
	const durW = visibleWidth(durStr);
	const avail = Math.max(8, inner - durW);
	const wrapW = Math.max(4, avail - 1); // keep at least 1 space before the duration
	const lines = expanded ? wrapTextWithAnsi(head, wrapW) : [truncateToWidth(head, wrapW, "…")];
	const pad = Math.max(1, avail - visibleWidth(lines[0]));
	lines[0] = `${lines[0]}${" ".repeat(pad)}${durStr}`;
	return lines;
}

// Default summary: collapsed `󱞩 first output line`, empty when expanded (the
// full output is right below — no duplicate first line).
export const resText: Res = (r, th, soft, isErr, expanded) => {
	if (expanded && !isErr) return "";
	const f = firstLine(textOf(r));
	return f ? `${resHead(th)} ${paintLinks(f, soft)}` : resHead(th);
};

// Numeric summary `󱞩 → N matches`; errors fall back to the first line (most important).
export const numRes =
	(fmt: (n: number) => string): Res =>
	(r, th, soft, isErr, expanded) => {
		if (isErr) return resText(r, th, soft, isErr, false);
		if (expanded) return "";
		return `${resHead(th)} ${fmt(countLines(textOf(r)))}`;
	};

// First markdown heading in the text (e.g. `## omaga-sync workflow (2026-08-23)`).
const firstHeading = (s: unknown): string =>
	typeof s === "string" ? (s.split("\n").find((l) => /^#{1,6}\s/.test(l.trim()))?.trim() ?? "") : "";

// One-line summary for tools without their own renderer. memory_write appends the
// heading it just wrote (from args.content) so the line names WHAT was written
// instead of just "Appended to MEMORY.md".
export function toolSummary(name: string, text: string, args?: ToolArgs): string {
	const head = firstMeaningful(text).trim();
	const title = name === "memory_write" ? firstHeading(args?.content) : "";
	return title ? `${head}. ${title}` : head;
}

// The box says whether it is open with a word: [show] folded, [hide] open. The label is
// also the click target (see HINT_SPANS) and sits on the title row, so the affordance a
// click just used stays visible instead of vanishing with the summary line.
export const HINT_EXPAND = "[show]";
export const HINT_COLLAPSE = "[hide]";

// Expanded detail: themed markdown (same layout as a normal pi message — code
// blocks, lists, colors) instead of a plain dim dump.
export const fullText = (r: TResult, _th: Theme, width = 0): string[] => {
	const text = textOf(r);
	if (!text) return [];
	if (!width) return text.split("\n").map((l) => _th.fg("dim", l));
	try {
		return new Markdown(text, 0, 0, getMarkdownTheme()).render(Math.max(8, width));
	} catch {
		return text.split("\n").map((l) => _th.fg("dim", l));
	}
};

const isBlankLine = (l: string): boolean => stripAnsi(l).trim() === "";

// Drop blank lines at both edges (the built-in Spacer) — that's the gap between boxes.
export function stripBlankEdges(lines: string[]): string[] {
	let s = 0;
	let e = lines.length;
	while (s < e && isBlankLine(lines[s])) s++;
	while (e > s && isBlankLine(lines[e - 1])) e--;
	return lines.slice(s, e);
}

// The inter-box gap is the built-in Spacer(1) of ToolExecutionComponent, stripped
// with a prototype render patch (same pattern as the footer patch). Own boxes (our
// minimal() tools + codemode) and every box forced by the generic predicate below
// are stripped; a box-owning third party left untouched is not.
const OWN_BOX = new Set<string>();
const hasOwnRendererDef = (self: { toolDefinition?: { renderCall?: unknown; renderResult?: unknown } }): boolean =>
	Boolean(self?.toolDefinition?.renderCall || self?.toolDefinition?.renderResult);

// Inline image line: kitty (\x1b_G) or iTerm2 (\x1b]1337;File=) graphics payload.
// pi renders a tool's image preview as an extra child BELOW the box, padding it with
// `result.rows - 1` blank rows; the last row carries a cursor-up prefix before the
// sequence. Not exported by pi-tui, so match both prefixes.
export const isImageLine = (line: string): boolean => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");

/** Drop the leading Spacer and the gap between box and image preview:
 *  its blank tail rows are kept as the image's vertical space so the
 *  terminal draws the image with balanced spacing above and below. */
export function stripEdgesKeepingImages(lines: string[]): string[] {
	const firstImage = lines.findIndex(isImageLine);
	if (firstImage < 0) return stripBlankEdges(lines);
	let s = 0;
	while (s < firstImage && isBlankLine(lines[s])) s++;
	const head = lines.slice(s, firstImage);
	while (head.length > 0 && isBlankLine(head[head.length - 1]!)) head.pop();
	return [...head, ...lines.slice(firstImage)];
}

// Per box: did this module strip the blank rows above it? Those rows shift every mouse
// row index, so a press on the border and the title row is found at 0 and 1 only for a
// stripped box. `Symbol.for` keeps the state across the re-import a `/reload` performs.
// Cells of the expand hint in this box's own drawn lines. The hint is the whole click
// target: every other cell of the box keeps pi's text selection, so the output stays
// copyable. Recomputed on every render, because the label moves with the width and the key.
const HINT_SPANS = Symbol.for("pi-arnative.toolBoxHintSpans");

function stopScrollHold(comp: Record<symbol, unknown>): void {
	const hold = comp[SCROLL_HOLD] as HoldRepeat | undefined;
	if (hold && typeof hold.stop === "function") hold.stop();
	comp[SCROLL_HOLD] = undefined;
}

function startScrollHold(
	comp: Record<symbol, unknown> & { expanded?: boolean; ui?: { requestRender?: () => void } },
	dir: -1 | 1,
): void {
	stopScrollHold(comp);
	const hold = createHoldRepeat();
	comp[SCROLL_HOLD] = hold;
	hold.start(() => {
		if (!comp.expanded) return false;
		const meta = (comp[SCROLL_META] as { maxOffset: number; step: number } | undefined) ?? { maxOffset: 0, step: 6 };
		const cur = Number(comp[SCROLL_OFFSET] ?? 0);
		const next = Math.max(0, Math.min(meta.maxOffset, cur + dir * meta.step));
		if (next === cur) return false;
		comp[SCROLL_OFFSET] = next;
		comp.ui?.requestRender?.();
		return true;
	});
}
const SCROLL_UP_SPANS = Symbol.for("pi-arnative.toolBoxScrollUpSpans");
const SCROLL_DOWN_SPANS = Symbol.for("pi-arnative.toolBoxScrollDownSpans");
const SCROLL_META = Symbol.for("pi-arnative.toolBoxScrollMeta");
// A press already toggled this box; the release and the synthesized click that follow it
// must not toggle it a second time.
const PRESS_TOGGLED = Symbol.for("pi-arnative.toolBoxPressToggled");
const STRIPPED_BOX = Symbol.for("pi-arnative.toolBoxStripped");

export function expandedBoxBodyLimit(rows = process.stdout.rows || 28): number {
	return Math.min(12, Math.max(6, Math.floor(rows * 0.35)));
}

function boxTokenPaint(tokens: readonly string[]): (text: string) => string {
	const th = getActiveTheme<{ fg?(c: string, t: string): string }>();
	if (!th?.fg) return (s) => s;
	for (const token of tokens) {
		try {
			const probe = th.fg(token, "x");
			if (typeof probe === "string" && probe.includes("x")) return (s) => th.fg!(token, s);
		} catch {
			// try next token
		}
	}
	return (s) => s;
}

export function paintScrollEdge(
	edgeLine: string,
	leftCorner: string,
	rightCorner: string,
	label: string,
	width: number,
	borderPaint: (text: string) => string,
	primaryPaint: (text: string) => string,
): string {
	const inner = width - 2;
	const labelW = visibleWidth(label);
	if (inner < labelW + 4) return edgeLine;
	const bgOpen = edgeLine.match(/^(\x1b\[48;[0-9;]*m)+/)?.[0] ?? "";
	const bgClose = bgOpen ? "\x1b[49m" : "";
	const totalDashes = inner - (labelW + 2);
	const leftDashes = Math.floor(totalDashes / 2);
	const rightDashes = totalDashes - leftDashes;
	const content = `${borderPaint(`${leftCorner}${"\u2500".repeat(leftDashes)} `)}${primaryPaint(label)}${borderPaint(` ${"\u2500".repeat(rightDashes)}${rightCorner}`)}`;
	return `${bgOpen}${content}${bgClose}`;
}

export function capExpandedToolBox(
	drawn: string[],
	scrollOffset: number,
	maxBody: number,
	width: number,
	borderPaint: (text: string) => string,
	primaryPaint: (text: string) => string,
): { lines: string[]; maxOffset: number; aboveLabel: string; belowLabel: string; botRow: number } {
	if (drawn.length < 4 || !stripAnsi(drawn[0] ?? "").trimStart().startsWith("\u256d")) {
		return { lines: drawn, maxOffset: 0, aboveLabel: "", belowLabel: "", botRow: -1 };
	}
	let botIdx = -1;
	for (let i = drawn.length - 1; i >= 2; i--) {
		const p = stripAnsi(drawn[i]!).trim();
		if (p.startsWith("\u2570") && p.endsWith("\u256f")) {
			botIdx = i;
			break;
		}
	}
	if (botIdx < 3) return { lines: drawn, maxOffset: 0, aboveLabel: "", belowLabel: "", botRow: -1 };
	const body = drawn.slice(2, botIdx);
	if (body.length <= maxBody) return { lines: drawn, maxOffset: 0, aboveLabel: "", belowLabel: "", botRow: botIdx };

	const maxOffset = body.length - maxBody;
	const offset = Math.max(0, Math.min(scrollOffset, maxOffset));
	const visible = body.slice(offset, offset + maxBody);
	const above = offset;
	const below = body.length - (offset + visible.length);
	const aboveLabel = above > 0 ? `\u2191 ${above} more` : "";
	const belowLabel = below > 0 ? `\u2193 ${below} more` : "";
	const top = aboveLabel ? paintScrollEdge(drawn[0]!, "\u256d", "\u256e", aboveLabel, width, borderPaint, primaryPaint) : drawn[0]!;
	const bot = belowLabel ? paintScrollEdge(drawn[botIdx]!, "\u2570", "\u256f", belowLabel, width, borderPaint, primaryPaint) : drawn[botIdx]!;
	const lines = [top, drawn[1]!, ...visible, bot, ...drawn.slice(botIdx + 1)];
	return { lines, maxOffset, aboveLabel, belowLabel, botRow: 2 + visible.length };
}

// The patches below reinstall on every module load (pi's /reload re-evaluates the
// extension in the same process), so a UI fix applies without restarting pi; see
// lib/patch.ts for the originals/mark bookkeeping that makes that safe.
if (ToolExecutionComponent?.prototype?.render) {
	const proto = ToolExecutionComponent.prototype as unknown as PatchedToolComponent;
	const origRender = originalOf<(this: PatchedToolComponent, width: number) => string[]>(proto, "render");
	proto.render = markPatched(function (this: PatchedToolComponent, width: number): string[] {
		const lines = origRender.call(this, width);
		const stripped = OWN_BOX.has(this.toolName) || boxTheirRenderers(this) || !hasOwnRendererDef(this);
		this[STRIPPED_BOX] = stripped;
		let drawn = stripped ? stripEdgesKeepingImages(lines) : lines;
		if (stripped && this.expanded) {
			const maxBody = expandedBoxBodyLimit();
			const capped = capExpandedToolBox(
				drawn,
				Number(this[SCROLL_OFFSET] ?? 0),
				maxBody,
				width,
				boxTokenPaint(["dim"]),
				boxTokenPaint(["dim"]),
			);
			drawn = capped.lines;
			this[SCROLL_OFFSET] = Math.max(0, Math.min(Number(this[SCROLL_OFFSET] ?? 0), capped.maxOffset));
			this[SCROLL_META] = { maxOffset: capped.maxOffset, step: Math.max(1, Math.floor(maxBody / 2)) };
			this[SCROLL_UP_SPANS] = capped.aboveLabel ? textSpans([drawn[0]!], capped.aboveLabel) : [];
			this[SCROLL_DOWN_SPANS] =
				capped.belowLabel && capped.botRow >= 0
					? textSpans([drawn[capped.botRow]!], capped.belowLabel).map((s) => ({ ...s, row: capped.botRow }))
					: [];
		} else {
			stopScrollHold(this);
			this[SCROLL_OFFSET] = 0;
			this[SCROLL_UP_SPANS] = [];
			this[SCROLL_DOWN_SPANS] = [];
			this[SCROLL_META] = undefined;
		}
		// Only a box this module laid out is measured here; a renderer pi owns keeps pi's
		// own mouse path, since its row offsets come from a layout it did not show us.
		// Title rows only (frame + title): a [show] inside the output must not become a button.
		this[HINT_SPANS] = stripped
			? [...textSpans(drawn, HINT_EXPAND), ...textSpans(drawn, HINT_COLLAPSE)].filter((span) => span.row <= 1)
			: [];
		return drawn;
	});

	// Click to expand/collapse or scroll, on the hint/more text alone. pi toggles on the
	// "click" it synthesizes from a press and a release at the same cell, so a one-cell
	// drift made the hint look inert, and the stripped row above the box left its top
	// border dead. A left press on the button acts at once and the release plus the click
	// that follow are swallowed; the click clears the flag, not the release, or that click
	// would trigger twice. Any other cell is left to pi: a press there starts a selection,
	// so the output can be copied.
	const origMouse = originalOf<(this: PatchedToolComponent, event: ToolMouseEventLike) => unknown>(proto, "handleMouse");
	proto.handleMouse = markPatched(function (this: PatchedToolComponent, event: ToolMouseEventLike): unknown {
		const onHint = (this[HINT_SPANS] as TextSpan[] | undefined)?.length
			? inSpans(this[HINT_SPANS] as TextSpan[], event.y, event.x)
			: false;
		const onUp = (this[SCROLL_UP_SPANS] as TextSpan[] | undefined)?.length
			? inSpans(this[SCROLL_UP_SPANS] as TextSpan[], event.y, event.x)
			: false;
		const onDown = (this[SCROLL_DOWN_SPANS] as TextSpan[] | undefined)?.length
			? inSpans(this[SCROLL_DOWN_SPANS] as TextSpan[], event.y, event.x)
			: false;
		if ((onHint || onUp || onDown) && event.type === "press" && event.button === "left") {
			stopScrollHold(this);
			// A child of the box (an image preview) keeps its own press.
			const childHit = origMouse.call(this, event);
			if (childHit) return childHit;
			if (onHint) {
				if (!this.result) return undefined;
				this.setExpanded(!this.expanded);
				this[PRESS_TOGGLED] = true;
				return { handled: true, render: true };
			}
			const meta = (this[SCROLL_META] as { maxOffset: number; step: number } | undefined) ?? { maxOffset: 0, step: 6 };
			const cur = Number(this[SCROLL_OFFSET] ?? 0);
			const dir: -1 | 1 = onUp ? -1 : 1;
			const next = Math.max(0, Math.min(meta.maxOffset, cur + dir * meta.step));
			this[SCROLL_OFFSET] = next;
			this[PRESS_TOGGLED] = true;
			startScrollHold(this, dir);
			this.ui?.requestRender?.();
			return { handled: true, render: true };
		}
		if (this[PRESS_TOGGLED] && (event.type === "release" || event.type === "click")) {
			stopScrollHold(this);
			if (event.type === "click") this[PRESS_TOGGLED] = false;
			return { handled: true, render: false };
		}
		if (
			this[STRIPPED_BOX] &&
			this.result &&
			event.type === "click" &&
			event.button === "left"
		) {
			if ((event.clickCount ?? 1) !== 1) return undefined;
			const origHit = origMouse.call(this, event);
			if (origHit) return origHit;
			this.setExpanded(!this.expanded);
			return { handled: true, render: true };
		}
		return origMouse.call(this, event);
	});
}

// --- Tools without their own renderer: same box, one-line summary ---
// Without this pi renders them as a plain bg block (name + 10 output lines). Our
// renderer is installed through the prototype (same pattern as the gap patch) only
// for tools that define no renderCall/renderResult of their own; third-party
// renderers are handled by the generic predicate below.
//
// BOXED_TOOLS is now a display-name map (plus the cdp special render path);
// boxing itself is generic (see boxTheirRenderers). The pi-web-access tools get a
// friendlier title ("search "/"fetch "/"get_content ") and their renderer content is
// reused inside our box.
//
// MCP tools (pi-mcp-adapter) declare `renderShell: "default"`, so the generic
// predicate boxes them, but their result renderer prints the WHOLE output on error
// (unbounded) and their call args can run to dozens of lines: a 1-line summary +
// [show] is tighter while the invoked tool stays visible.
const BOXED_TOOLS = new Map([
	["web_search", "search"],
	["fetch_content", "fetch"],
	["get_search_content", "get_content"],
]);

// @narumitw/pi-chrome-devtools ships bare-text renderers ("Chrome DevTools: navigate",
// collapsed output is empty) so they are ignored and these tools take our default box
// path. CDP_ICON marks them in the call box (no hook for the generic tool icon).
const CDP_ICON = "\uf268";
const CDP_TOOLS: [string, string][] = [
	["chrome_devtools_load", "load"],
	["chrome_devtools_list_pages", "list pages"],
	["chrome_devtools_select_page", "select page"],
	["chrome_devtools_navigate", "navigate"],
	["chrome_devtools_evaluate", "evaluate"],
	["chrome_devtools_screenshot", "screenshot"],
	["chrome_devtools_webmcp_list_tools", "list WebMCP tools"],
	["chrome_devtools_webmcp_call_tool", "call WebMCP tool"],
];
const CDP_NAME = new Map(CDP_TOOLS);
for (const [n] of CDP_TOOLS) BOXED_TOOLS.set(n, n);

const displayName = (name: string): string =>
	CDP_NAME.has(name) ? `Chrome DevTools: ${CDP_NAME.get(name)}` : (BOXED_TOOLS.get(name) ?? name);
for (const n of BOXED_TOOLS.keys()) OWN_BOX.add(n);

const MCP_TOOL = (name: string): boolean => name === "mcp" || name === "mcpScript" || name.startsWith("mcp__");

// Generic, not a name list: any tool that ships its own renderers is boxed, unless
// it declares `renderShell: "self"` (our own `minimal()`/codemode boxes) or sits in
// NOT_BOXED. That covers every third-party extension without a registration step:
// pi-fff (`ffgrep`/`fffind`, and `find`/`grep` in its override mode), pi core's
// `powershell`/`ls` (their definitions spread `renderCall`/`renderResult` onto the
// tool object) and pi-mcp-adapter (`renderShell: "default"`) all fall in by shape.
//
// MCP is boxed even when pi-mcp-adapter declares `renderShell: "self"`: since 2.3x
// its default `toolResultRendering: "compact"` paints flat text (`mcp call x @ y`,
// no border), so a `self` shell there means "no box", not "my own box".
//
// `source_check` is the single exception: its partial phase (curator URLs + approval
// state) would disappear because our partial path returns nothing.
const NOT_BOXED = new Set(["source_check"]);
const boxTheirRenderers = (self: Pick<PatchedToolComponent, "toolName" | "toolDefinition">): boolean =>
	Boolean(self.toolDefinition) &&
	(self.toolDefinition?.renderShell !== "self" || MCP_TOOL(self.toolName)) &&
	!NOT_BOXED.has(self.toolName);

// The MCP box title names the invoked tool (full args when expanded).
const mcpInfo = (name: string, args: ToolArgs | undefined, th: Theme): string => {
	if (!MCP_TOOL(name)) return "";
	const tool = String(args?.tool ?? "");
	const server = String(args?.server ?? "");
	return tool ? th.fg("dim", `${tool}${server ? ` @ ${server}` : ""}`) : "";
};

// Cap third-party lines in the call box; the rest goes behind [show].
const CALL_ROWS = 2;
const capped = (th: Theme, rows: string[], expanded: boolean): string[] =>
	expanded || rows.length <= CALL_ROWS ? rows : [...rows.slice(0, CALL_ROWS), th.fg("dim", HINT_EXPAND)];

// Third-party renderers run unguarded here (at render time, unlike pi's own
// updateDisplay which wraps them in try/catch + fallback): a throw becomes an
// uncaughtException that exits pi. e.g. pi-web-access' get_content renderCall
// slices args.responseId — undefined on a partial/malformed tool call.
const safeCall = <T>(fn: () => T): T | null => {
	try {
		return fn();
	} catch {
		return null;
	}
};

// Lines from a third-party renderer component (right padding trimmed, ANSI kept).
const componentLines = (component: RenderableComponent | null | undefined, width: number): string[] => {
	try {
		const lines = component?.render(Math.max(8, width));
		return Array.isArray(lines) ? lines.map((l: string) => String(l).trimEnd()) : [];
	} catch {
		return [];
	}
};

/** Right-align a label on the first row of `rows`, for a row pi did not build: the fold
 *  hint and the runtime still land where every other box puts them. */
const rightAlign = (th: Theme, rows: string[], inner: number, right: string): string[] => {
	if (!right || rows.length === 0) return rows;
	const label = th.fg("dim", right);
	const avail = Math.max(4, inner - visibleWidth(label) - 1);
	const head = truncateToWidth(rows[0]!, avail, "…");
	const pad = Math.max(1, avail - visibleWidth(head));
	return [`${head}${" ".repeat(pad)}${label}`, ...rows.slice(1)];
};

// Status icon + third-party lines -> our box content lines.
const boxedRows = (icon: string, lines: string[]): string[] => {
	const body = lines.filter((l) => !isBlankLine(l));
	return body.length ? [`${icon} ${body[0]}`, ...body.slice(1)] : [icon];
};

/**
 * Subtle per-tool bg (see also toolPendingBg/toolSuccessBg for `todo`).
 * `memory_write` uses customMessageBg: thin, violet-ish = "note", just distinct
 * from the plain progress boxes. Use `name.startsWith("memory_")` to cover all
 * memory tools.
 */
export const boxBgOf = (name: string): string | undefined => (name === "memory_write" ? "customMessageBg" : undefined);

if (ToolExecutionComponent?.prototype?.render) {
	const proto = ToolExecutionComponent.prototype as unknown as PatchedToolComponent;
	const origCall = originalOf<(this: PatchedToolComponent) => ToolRendererFn | undefined>(proto, "getCallRenderer");
	const origResult = originalOf<(this: PatchedToolComponent) => ToolResultRendererFn | undefined>(proto, "getResultRenderer");
	const origShell = originalOf<(this: PatchedToolComponent) => string>(proto, "getRenderShell");
	const hasOwnRenderer = (self: PatchedToolComponent): boolean =>
		!boxTheirRenderers(self) && Boolean(origCall.call(self) || origResult.call(self));
	// pi-fff splits title (renderCall) and result (renderResult) — both merge into one box.
	// Its two naming modes are covered: `find`/`grep` (override) and `ffgrep`/`fffind` (default).
	const FFF_TOOLS = ["find", "grep", "ffgrep", "fffind"];

	// A tool call with no registered definition (e.g. an unknown tool name that
	// errored with "Tool X not found") makes hasRendererDefinition() false, so the
	// constructor adds the plain contentText fallback and updateDisplay() never calls
	// getCallRenderer/getResultRenderer — our patch is bypassed and the call renders
	// as bare name + pretty-printed args. Claim those calls as defined so they take
	// the same box path as any other renderer-less tool.
	const origHasRendererDefinition = originalOf<(this: PatchedToolComponent) => boolean>(proto, "hasRendererDefinition");
	proto.hasRendererDefinition = markPatched(function (this: PatchedToolComponent): boolean {
		return origHasRendererDefinition.call(this) || this.toolDefinition === undefined;
	});

	proto.getRenderShell = markPatched(function (this: PatchedToolComponent): string {
		if (boxTheirRenderers(this)) return "self";
		return hasOwnRenderer(this) ? origShell.call(this) : "self";
	});

	proto.getCallRenderer = markPatched(function (this: PatchedToolComponent) {
			const name: string = this.toolName;
			const mine = boxTheirRenderers(this);
			const own = origCall.call(this);
		// Chrome DevTools' own renderCall is a bare line and pi-mcp-adapter's compact one
		// is the same flat text; ours replaces both (icon + name + invoked MCP tool).
		if (own && !mine && !CDP_NAME.has(name)) return own;
		return (args: ToolArgs, th: Theme, ctx: TCtx) =>
			new Lines((width) => {
				if ((ctx.state as Record<string, unknown> | undefined)?.hasResult) return [];
				const icon = CDP_NAME.has(name) ? th.fg("accent", CDP_ICON) : th.fg("warning", spinIcon());
				const theirs =
					own && !CDP_NAME.has(name) && !MCP_TOOL(name)
						? componentLines(safeCall(() => own.call(this, args, th, ctx)), width - 6)
						: [];
				if (mine && theirs.length)
					return box(th, width, boxedRows(icon, capped(th, theirs, Boolean(this.expanded))));
				const inner = Math.max(8, width - 4);
				const rows = titleRow(
					th,
					icon,
					th.fg("accent", displayName(name)),
					name === "todo" ? todoTitleDetail(th, softSecondaryOf(th), actionWord(args?.action, args?.status)) : mcpInfo(name, args, th),
					inner,
					"",
					false,
				);
				return box(th, width, rows, boxBgOf(name));
			});
	});

	proto.getResultRenderer = markPatched(function (this: PatchedToolComponent) {
		const name: string = this.toolName;
		const own = origResult.call(this);
		// pi-fff splits title (renderCall) and result (renderResult); both go in one box.
		const fff = FFF_TOOLS.includes(name) && this.toolDefinition?.renderShell !== "self";
		// MCP: their result renderer is deliberately skipped (unbounded error dump).
		if (own && !boxTheirRenderers(this)) return own;
		// Chrome DevTools are in BOXED_TOOLS for the title/icon only: their renderResult
		// (raw text, empty when collapsed) would drop our title row, so it is ignored.
		const cdp = CDP_NAME.has(name);
		return (result: TResult, opts: { expanded: boolean; isPartial?: boolean }, th: Theme, ctx: TCtx) => {
			if (opts.isPartial) return EMPTY;
			((ctx.state ??= {}) as Record<string, unknown>).hasResult = true;
			const text = textOf(result);
			// pi-web-access reports failure via `details.error` without throwing, so
			// ctx.isError alone is not enough: without this the error box shows ✓.
			const isErr = Boolean(ctx.isError || result.isError || (result.details as { error?: unknown } | undefined)?.error);
			// Their renderer content is reused inside our box unless it is unusable:
			// MCP dumps the whole output on error (1-line summary instead), Chrome
			// DevTools is a bare line, and errors take our own path (pi-web-access'
			// own error box would nest a box inside a box).
			return new Lines((width) => {
				const soft = softSecondaryOf(th);
				const inner = Math.max(8, width - 4);
				const icon = isErr ? th.fg("error", "x") : th.fg("success", "✓");
				// Their renderer already answers `expanded`, so both states are measured: the fold
				// label appears only when the other state really shows a different number of rows.
				const theirsAt = (exp: boolean) =>
					own && !isErr && !cdp && !MCP_TOOL(name)
						? componentLines(
								safeCall(() =>
									own.call(this, { content: result.content, details: result.details }, { ...opts, expanded: exp }, th, ctx),
								),
								width - 6,
							)
						: [];
				const boxed2 = theirsAt(opts.expanded);
				// Only rows on screen decide: a renderer that answers `expanded` with the same visible
				// height (a trailing newline, a blank row) has nothing to fold.
				const rowsShown = (rows: string[]) => rows.filter((l) => !isBlankLine(l)).length;
				const foldHint = rowsShown(theirsAt(!opts.expanded)) === rowsShown(boxed2) ? "" : opts.expanded ? HINT_COLLAPSE : HINT_EXPAND;
				if (fff && boxed2.length) {
					const callLines = componentLines(safeCall(() => origCall.call(this)?.call(this, ctx.args, th, ctx)), width - 6);
					const head = `${icon} ${callLines[0]?.trim() || th.fg("accent", displayName(name))}`;
					const right = [durationOf(ctx), foldHint].filter(Boolean).join(" · ");
					return box(th, width, rightAlign(th, [head, ...boxed2], inner, right));
				}
				// Third-party content keeps its own template but not its own chrome: without this the
				// box had no title row, so the tool name, the runtime and the fold label were all lost.
				if (boxed2.length && !cdp) {
					const rows = titleRow(
						th,
						icon,
						th.fg("accent", displayName(name)),
						mcpInfo(name, ctx.args, th),
						inner,
						durationOf(ctx),
						opts.expanded,
						foldHint,
					);
					return box(th, width, [...rows, ...boxed2]);
				}
				// A payload with no newline can still be a full screen of wrapped text, so the row
				// count is measured at this width: a 40k-char JSON line folds like any other box.
				const more = drawnRows(text, inner) > 1;
				const rows = titleRow(
					th,
					icon,
					th.fg("accent", displayName(name)),
					name === "todo"
						? todoTitleDetail(th, soft, (result.details as { detail?: unknown } | undefined)?.detail)
						: mcpInfo(name, ctx.args, th),
					inner,
					durationOf(ctx),
					opts.expanded,
					more ? (opts.expanded ? HINT_COLLAPSE : HINT_EXPAND) : "",
				);
				const summary = toolSummary(name, text, ctx.args);
				const summaryRow = oneRow(
					`${resHead(th)}${summary ? ` ${paintLinks(summary, soft)}` : ""}`,
					inner,
				);
				rows.push(summaryRow);
				if (opts.expanded && more) {
					// MCP args are gone once the call box is replaced by the result.
					if (MCP_TOOL(name)) rows.push(th.fg("dim", `args ${JSON.stringify(ctx.args ?? {})}`));
					rows.push(...fullText(result, th, inner));
				}
				return box(th, width, rows, boxBgOf(name));
			});
		};
	});
}

/** `todo · completed`: the status the call left behind (or its action word), so the title says
 *  what happened and not just which tool ran. The word takes the soft accent tier, the dot stays
 *  dim. */
function todoTitleDetail(th: Theme, soft: (s: string) => string, word: unknown): string {
	const text = typeof word === "string" ? word.trim() : "";
	return text ? `${th.fg("dim", "·")} ${soft(text)}` : "";
}

// codemode: the script is highlighted, the calls and output come from pi's own details.
function codeLines(code: string): string[] {
	const js = code.replace(/\r/g, "").trimEnd().replace(/\t/g, "   ");
	if (!js) return [];
	try {
		return highlightCode(js, "javascript");
	} catch {
		return js.split("\n");
	}
}

/** `✓ todo {"action":"list"} 2ms` — status icon, tool name, muted args, dim duration. */
function formatCodemodeCall(call: CodemodeCall, th: Theme): string {
	const [color, glyph] = STATUS_ICON[String(call?.status ?? "ok")] ?? ["error", "x"];
	const dur = fmtMs(Number(call?.durationMs));
	let line = ` ${th.fg(color, glyph)} ${th.fg("accent", String(call?.name ?? ""))}`;
	if (call?.args) line += ` ${th.fg("muted", String(call.args))}`;
	if (dur) line += ` ${th.fg("dim", dur)}`;
	return line;
}

// codemode call status -> [theme colour, glyph], same mapping pi's own renderer uses.
const STATUS_ICON: Record<string, [string, string]> = {
	running: ["warning", "…"],
	ok: ["success", "✓"],
	cancelled: ["muted", "⊘"],
	error: ["error", "x"],
};

/** Drop pi's "Script completed\nWall time …\nOutput:" header (a rejected input has none). */
function codemodeOutput(content: unknown): string {
	const blocks = (Array.isArray(content) ? content : []).filter(
		(c): c is { type: string; text?: string } => Boolean(c && typeof c === "object" && (c as { type?: unknown }).type === "text"),
	);
	const header = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/;
	return blocks
		.map((c, i) => (i === 0 ? String(c.text ?? "").replace(header, "") : String(c.text ?? "")))
		.join("\n")
		.trim();
}

/** Script lines; collapsed keeps only the first, like the other tools' one-line call. */
function codemodeScript(code: string, expanded: boolean): { lines: string[]; hidden: number } {
	const lines = codeLines(code);
	if (expanded || lines.length <= 1) return { lines, hidden: 0 };
	return { lines: lines.slice(0, 1), hidden: lines.length - 1 };
}

/** Every box row: title, script, nested calls, output. Collapsed is the title plus the
 *  script's first line, with the rest behind the expand hint. Expanding — or failing —
 *  shows everything: a truncated error would read as a short, successful run. */
function codemodeBoxRows(
	args: ToolArgs | undefined,
	result: { content?: unknown; details?: ToolDetails } | undefined,
	th: Theme,
	expanded: boolean,
	isErr: boolean,
	icon: string,
	inner: number,
	dur = "",
): string[] {
	const code = typeof args?.code === "string" ? args.code : "";
	const script = codemodeScript(code, expanded);
	const calls: CodemodeCall[] = Array.isArray(result?.details?.calls) ? result.details.calls : [];
	const output = codemodeOutput(result?.content);
	const outLines = output ? output.split("\n") : [];
	const shown = expanded || isErr;
	// A failing run shows its calls and output even when collapsed, so only a multi-line
	// script gives it anything to fold; a passing run folds multi-line scripts, calls and output.
	const foldable = countLines(code) > 1 || (!isErr && (calls.length > 0 || outLines.length > 0));
	const label = foldable ? (expanded ? HINT_COLLAPSE : HINT_EXPAND) : "";
	const rows = titleRow(th, icon, th.fg("accent", "codemode"), "", inner, dur, expanded, label);
	script.lines.forEach((line, i) => rows.push(i === 0 ? `${resHead(th)} ${line}` : ` ${line}`));
	if (shown) {
		if (calls.length || outLines.length) rows.push("");
		rows.push(...calls.map((c) => formatCodemodeCall(c, th)), ...outLines.map((l) => th.fg("toolOutput", ` ${l}`)));
	}
	return rows;
}

// One render path for all tools (no per-tool duplication).
// renderCall = running box (󰔟); renderResult = final box (✓/x + right-aligned
// duration + 󱞩 summary); state.hasResult is written by renderResult and read at
// render() -> exactly one box, also after reload/restore. res & full are optional
// (default: first output line / dim detail).
function minimal(
	pi: ExtensionAPI,
	tool: { execute: (...a: unknown[]) => Promise<unknown> } & Record<string, unknown>,
	name: (th: Theme, soft: (s: string) => string) => string,
	call: (a: ToolArgs, th: Theme, soft: (s: string) => string, expanded: boolean) => string,
	res: Res = resText,
	full: (r: TResult, th: Theme, inner: number) => string[] = fullText,
): void {
	OWN_BOX.add(String(tool.name ?? ""));
	pi.registerTool({
		...tool,
		renderShell: "self",
		async execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) {
			const start = performance.now();
			ACTIVE++;
			syncTicker();
			try {
				return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
			} finally {
				recordTiming(toolCallId, Math.round(performance.now() - start));
				ACTIVE--;
				syncTicker();
			}
		},
		renderCall(args: ToolArgs, theme: Theme, context: TCtx) {
			return new Lines((width) => {
				// Read context.state live (never capture): renderResult may create it after renderCall.
				if (context.state?.hasResult) return [];
				const soft = softSecondaryOf(theme);
				const inner = Math.max(8, width - 4);
				const rows = titleRow(
					theme,
					theme.fg("warning", spinIcon()),
					name(theme, soft),
					call(args, theme, soft, false),
					inner,
					"",
					false,
				);
				return box(theme, width, rows);
			});
		},
		renderResult(
			result: TResult,
			{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			context: TCtx,
		) {
			if (isPartial) return EMPTY;
			((context.state ??= {}) as Record<string, unknown>).hasResult = true;
			const text = textOf(result);
			// `ctx.isError`/`result.isError` are the only honest sources: output text starting with
			// "Error" is normal content (a file whose first line says "Error handling...").
			const isErr = Boolean(context.isError || result.isError);
			const dur = durationOf(context as TCtx);
			const icon = isErr ? theme.fg("error", "x") : theme.fg("success", "✓");
			return new Lines((width) => {
				const soft = softSecondaryOf(theme);
				const inner = Math.max(8, width - 4);
				// Anything the collapsed summary hides gets the standard hint; without it a
				// two-line box (edit: `+1 / -1`) looks complete while the diff sits behind it.
				const hasDetail =
					drawnRows(text, inner) > 1 || Boolean((result.details as { diff?: string } | undefined)?.diff);
				const label = hasDetail ? (expanded ? HINT_COLLAPSE : HINT_EXPAND) : "";
				const rows = titleRow(
					theme,
					icon,
					name(theme, soft),
					call(context.args ?? {}, theme, soft, expanded),
					inner,
					dur,
					expanded,
					label,
				);
				const resLine = res(result, theme, soft, isErr, expanded);
				if (expanded) rows.push(...full(result, theme, inner));
				else if (resLine) rows.push(oneRow(resLine, inner));
				return box(theme, width, rows);
			});
		},
	} as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
}

function arnativeTools(pi: ExtensionAPI) {
	// codemode keeps pi's own data (script + nested calls + output) wrapped in the arnative
	// box, bg like every other tool. A resolver runs first and returns our renderers for
	// that name; `next()` would give pi's unboxed ones.
	OWN_BOX.add("codemode");
	pi.registerToolRenderer((toolName, next) => (toolName === "codemode" ? codemodeRenderers : next()));

	// Re-render source for the spinner + ticker cleanup when the session closes
	pi.on("session_start", async (_event, ctx) => {
		TIMINGS.clear();
		requestRenderFn = () => {
			try {
				(ctx.ui as { requestRender?: () => void }).requestRender?.();
			} catch {
				// ignore
			}
		};
	});
	pi.on("session_shutdown", async () => {
		TIMINGS.clear();
		ACTIVE = 0;
		if (TICK) {
			clearInterval(TICK);
			TICK = null;
		}
		requestRenderFn = null;
	});

	// Gap is only stripped for our own boxes (see OWN_BOX above).

	const shellCall = (a: { command?: string }, _th: Theme, soft: (s: string) => string, expanded: boolean): string => {
		const cmd = (a.command ?? "").replace(/\r?\n/g, " ").trim();
		return paintLinks(expanded ? cmd : smartTitle(cmd), soft);
	};

	// powershell: pi core registers it as a separate builtin (only on Windows); without
	// our own registration it keeps pi's "default" shell and renders as a bg block, not a
	// box (the same reason `bash` is re-registered below). Windows only: on any other
	// platform `getPowerShellConfig()` throws, and an unregistered tool would stay off
	// while our registration is active on load.
	if (process.platform === "win32")
		minimal(pi, createPowerShellTool(cwd), (th) => th.fg("accent", "PS>"), shellCall);

	// ls: no renderShell of its own, so pi's default shell turns it into a bg block.
	minimal(
		pi,
		createLsTool(cwd),
		(th) => th.fg("accent", "ls"),
		(a, _th, soft) => soft(shortPath(a.path ?? ".")),
		numRes((n) => `${n} entries`),
	);

	// bash: `󰔟 $ <6 words>…` / `✓ $ <full title when expanded>  0.1s`
	minimal(pi, createBashTool(cwd), (th) => th.fg("accent", "$"), shellCall);

	// read: `read path[:range]` → `󱞩 N lines`
	minimal(
		pi,
		createReadTool(cwd),
		(th) => th.fg("accent", "read"),
		(a, _th, soft) => {
			const range =
				a.offset || a.limit ? `:${a.offset ?? 1}${a.limit ? `-${(a.offset ?? 1) + a.limit - 1}` : ""}` : "";
			return `${soft(shortPath(a.path ?? ""))}${range}`;
		},
		numRes((n) => `${n} lines`),
	);

	// grep: `grep /pattern/ in path (glob)` → `󱞩 → N matches`
	minimal(
		pi,
		createGrepTool(cwd),
		(th) => th.fg("accent", "grep"),
		(a, _th, soft) =>
			`/${a.pattern ?? ""}/ in ${soft(shortPath(a.path ?? "."))}${a.glob ? ` (${a.glob})` : ""}`,
		numRes((n) => `→ ${n} matches`),
	);

	// find: `find pattern in path` → `󱞩 → N files`
	minimal(
		pi,
		createFindTool(cwd),
		(th) => th.fg("accent", "find"),
		(a, _th, soft) => `${a.pattern ?? ""} in ${soft(shortPath(a.path ?? "."))}`,
		numRes((n) => `→ ${n} files`),
	);

	// write: `write path`, default res (first output line)
	minimal(
		pi,
		createWriteTool(cwd),
		(th) => th.fg("accent", "write"),
		(a, _th, soft) => soft(shortPath(a.path ?? "")),
	);

	// edit: `edit path`, `󱞩 +N / -M`, expand = diff toolDiff*
	minimal(
		pi,
		createEditTool(cwd),
		(th) => th.fg("accent", "edit"),
		(a, _th, soft) => soft(shortPath(a.path ?? "")),
		(r, th, _soft, isErr, expanded) => {
			if (isErr) return resText(r, th, (s) => s, isErr, false);
			const diff: string = r.details?.diff ?? "";
			let add = 0;
			let del = 0;
			for (const l of diff.split("\n")) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) del++;
			}
			return `${resHead(th)} ${th.fg("toolDiffAdded", `+${add}`)} / ${th.fg("toolDiffRemoved", `-${del}`)}`;
		},
		(r, th, inner) => formatEditDiff(r, th, inner),
	);
}

// codemode: pi's renderer wrapped in our box. renderShell "self" keeps the
// execution defaults; renderCall/renderResult draw the box. state.hasResult
// guarantees one box per call, also after reload/restore.
const codemodeRenderers = {
	renderShell: "self" as const,
	renderCall(args: ToolArgs, th: Theme, ctx: TCtx) {
		return new Lines((width) => {
			if (ctx.state?.hasResult) return [];
			const isErr = Boolean(ctx.isError);
			const bg = isErr ? "toolErrorBg" : "toolPendingBg";
			// Same spinner as every other box while the tool runs; the codemode glyph
			// only appears once the result is in (renderResult).
			const icon = th.fg("warning", spinIcon());
			return box(th, width, codemodeBoxRows(args, undefined, th, Boolean(ctx.expanded), isErr, icon, Math.max(8, width - 4)), bg);
		});
	},
	renderResult(result: TResult, opts: { expanded: boolean; isPartial?: boolean }, th: Theme, ctx: TCtx) {
		if (opts.isPartial) return EMPTY;
		((ctx.state ??= {}) as Record<string, unknown>).hasResult = true;
		const isErr = Boolean(ctx.isError || result.isError);
		const icon = isErr ? th.fg("error", "x") : th.fg("success", "\uf489");
		const dur = durationOf(ctx);
		return new Lines((width) =>
			box(th, width, codemodeBoxRows(ctx.args, result, th, Boolean(opts.expanded), isErr, icon, Math.max(8, width - 4), dur), isErr ? "toolErrorBg" : "toolSuccessBg"),
		);
	},
};

export default arnativeTools;

export const __test = {
	cwd,
	MAX_TIMINGS,
	TIMINGS,
	FRAMES,
	get ACTIVE() {
		return ACTIVE;
	},
	set ACTIVE(v) {
		ACTIVE = v;
	},
	get TICK() {
		return TICK;
	},
	set TICK(v) {
		TICK = v;
	},
	syncTicker,
	fmtMs,
	OWN_BOX,
	hasOwnRendererDef,
	BOXED_TOOLS,
	CDP_ICON,
	mcpInfo,
	CALL_ROWS,
	capped,
	safeCall,
	componentLines,
	codemodeOutput,
	minimal,
	EDIT_DIFF_CONFIG_KEY,
	codemodeRenderers,
};
