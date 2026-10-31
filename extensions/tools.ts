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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createLsToolDefinition,
	createPowerShellTool,
	createPowerShellToolDefinition,
	createReadTool,
	createWriteTool,
	getMarkdownTheme,
	highlightCode,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { inSpans, renderBoxLines as box, type TextSpan, textSpans } from "../lib/box.ts";
import { stripAnsi, softSecondaryOf } from "../lib/ansi.ts";
import { actionWord } from "../lib/todos.ts";
import { assert, isMain } from "../lib/check.ts";
import { markPatched, originalOf } from "../lib/patch.ts";

type Theme = { fg(color: string, text: string): string; bg?(color: string, text: string): string };
type TResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: any };
type TCtx = { isError?: boolean; toolCallId?: string; args?: any; state?: Record<string, unknown>; durationMs?: number };
type Res = (r: TResult, th: Theme, soft: (s: string) => string, isErr: boolean, expanded: boolean) => string;

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
export function toolSummary(name: string, text: string, args?: any): string {
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
// A press already toggled this box; the release and the synthesized click that follow it
// must not toggle it a second time.
const PRESS_TOGGLED = Symbol.for("pi-arnative.toolBoxPressToggled");

// The patches below reinstall on every module load (pi's /reload re-evaluates the
// extension in the same process), so a UI fix applies without restarting pi; see
// lib/patch.ts for the originals/mark bookkeeping that makes that safe.
if (ToolExecutionComponent?.prototype?.render) {
	const proto = ToolExecutionComponent.prototype as any;
	const origRender = originalOf<(this: any, width: number) => string[]>(proto, "render");
	proto.render = markPatched(function (this: any, width: number): string[] {
		const lines = origRender.call(this, width);
		const stripped = OWN_BOX.has(this.toolName) || boxTheirRenderers(this) || !hasOwnRendererDef(this);
		const drawn = stripped ? stripEdgesKeepingImages(lines) : lines;
		// Only a box this module laid out is measured here; a renderer pi owns keeps pi's
		// own mouse path, since its row offsets come from a layout it did not show us.
		// Title rows only (frame + title): a [show] inside the output must not become a button.
		this[HINT_SPANS] = stripped
			? [...textSpans(drawn, HINT_EXPAND), ...textSpans(drawn, HINT_COLLAPSE)].filter((span) => span.row <= 1)
			: [];
		return drawn;
	});

	// Click to expand, on the hint text alone. pi toggles on the "click" it synthesizes from
	// a press and a release at the same cell, so a one-cell drift made the hint look inert,
	// and the stripped row above the box left its top border dead. A left press on the hint
	// toggles at once and the release plus the click that follow are swallowed; the click
	// clears the flag, not the release, or that click would toggle the box back. Any other
	// cell is left to pi: a press there starts a selection, so the output can be copied.
	const origMouse = originalOf<(this: any, event: any) => any>(proto, "handleMouse");
	proto.handleMouse = markPatched(function (this: any, event: any): any {
		const onHint = (this[HINT_SPANS] as TextSpan[] | undefined)?.length
			? inSpans(this[HINT_SPANS] as TextSpan[], event.y, event.x)
			: false;
		if (onHint && event.type === "press" && event.button === "left") {
			// A child of the box (an image preview) keeps its own press.
			const childHit = origMouse.call(this, event);
			if (childHit) return childHit;
			if (!this.result) return undefined;
			this.setExpanded(!this.expanded);
			this[PRESS_TOGGLED] = true;
			return { handled: true, render: true };
		}
		if (this[PRESS_TOGGLED] && (event.type === "release" || event.type === "click")) {
			if (event.type === "click") this[PRESS_TOGGLED] = false;
			return { handled: true, render: false };
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
const boxTheirRenderers = (self: any): boolean =>
	Boolean(self.toolDefinition) &&
	(self.toolDefinition.renderShell !== "self" || MCP_TOOL(self.toolName)) &&
	!NOT_BOXED.has(self.toolName);

// The MCP box title names the invoked tool (full args when expanded).
const mcpInfo = (name: string, args: any, th: Theme): string => {
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
const componentLines = (component: any, width: number): string[] => {
	try {
		const lines = component?.render(Math.max(8, width));
		return Array.isArray(lines) ? lines.map((l: string) => String(l).trimEnd()) : [];
	} catch {
		return [];
	}
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
	const proto = ToolExecutionComponent.prototype as any;
	const origCall = originalOf<(this: any) => any>(proto, "getCallRenderer");
	const origResult = originalOf<(this: any) => any>(proto, "getResultRenderer");
	const origShell = originalOf<(this: any) => string>(proto, "getRenderShell");
	const hasOwnRenderer = (self: any): boolean =>
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
	const origHasRendererDefinition = originalOf<(this: any) => boolean>(proto, "hasRendererDefinition");
	proto.hasRendererDefinition = markPatched(function (this: any): boolean {
		return origHasRendererDefinition.call(this) || this.toolDefinition === undefined;
	});

	proto.getRenderShell = markPatched(function (this: any): string {
		if (boxTheirRenderers(this)) return "self";
		return hasOwnRenderer(this) ? origShell.call(this) : "self";
	});

	proto.getCallRenderer = markPatched(function (this: any) {
			const name: string = this.toolName;
			const mine = boxTheirRenderers(this);
			const own = origCall.call(this);
		// Chrome DevTools' own renderCall is a bare line and pi-mcp-adapter's compact one
		// is the same flat text; ours replaces both (icon + name + invoked MCP tool).
		if (own && !mine && !CDP_NAME.has(name)) return own;
		return (args: any, th: Theme, ctx: TCtx) =>
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

	proto.getResultRenderer = markPatched(function (this: any) {
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
			const theirs =
				own && !isErr && !cdp && !MCP_TOOL(name)
					? safeCall(() => own.call(this, { content: result.content, details: result.details }, opts, th, ctx))
					: null;
			return new Lines((width) => {
				const soft = softSecondaryOf(th);
				const inner = Math.max(8, width - 4);
				const icon = isErr ? th.fg("error", "x") : th.fg("success", "✓");
				const boxed2 = componentLines(theirs, width - 6);
				if (fff && boxed2.length) {
					const callLines = componentLines(safeCall(() => origCall.call(this)?.call(this, ctx.args, th, ctx)), width - 6);
					return box(th, width, boxedRows(icon, [callLines[0]?.trim() || displayName(name), ...boxed2]));
				}
				if (boxed2.length && !cdp) return box(th, width, boxedRows(icon, boxed2));
				const more = countLines(text) > 1;
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
				rows.push(`${resHead(th)}${summary ? ` ${paintLinks(summary, soft)}` : ""}`);
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
function formatCodemodeCall(call: any, th: Theme): string {
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
	const blocks = (Array.isArray(content) ? content : []).filter((c: any) => c?.type === "text") as Array<{ text?: string }>;
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
	args: any,
	result: { content?: unknown; details?: any } | undefined,
	th: Theme,
	expanded: boolean,
	isErr: boolean,
	icon: string,
	inner: number,
	dur = "",
): string[] {
	const code = typeof args?.code === "string" ? args.code : "";
	const script = codemodeScript(code, expanded);
	const calls = (result?.details?.calls as any[] | undefined) ?? [];
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
	tool: { execute: (...a: any[]) => Promise<any> } & Record<string, unknown>,
	name: (th: Theme, soft: (s: string) => string) => string,
	call: (a: any, th: Theme, soft: (s: string) => string, expanded: boolean) => string,
	res: Res = resText,
	full: (r: TResult, th: Theme) => string[] = fullText,
): void {
	OWN_BOX.add(String(tool.name ?? ""));
	pi.registerTool({
		...tool,
		renderShell: "self",
		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
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
		renderCall(args: any, theme: Theme, context: TCtx) {
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
				const hasDetail = countLines(text) > 1 || Boolean((result.details as { diff?: string } | undefined)?.diff);
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
				if (expanded) rows.push(...full(result, theme));
				else if (resLine) rows.push(resLine);
				return box(theme, width, rows);
			});
		},
	} as any);
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
		if (TICK) {
			clearInterval(TICK);
			TICK = null;
		}
		requestRenderFn = null;
	});

	// Gap is only stripped for our own boxes (see OWN_BOX above).

	// powershell: pi core registers it as a separate builtin (only on Windows); without
	// our own registration it keeps pi's "default" shell and renders as a bg block, not a
	// box (the same reason `bash` is re-registered below). Windows only: on any other
	// platform `getPowerShellConfig()` throws, and an unregistered tool would stay off
	// while our registration is active on load.
	if (process.platform === "win32")
		minimal(
			pi,
			createPowerShellTool(cwd),
			(th) => th.fg("accent", "PS>"),
			(a, _th, soft, expanded) => {
				const cmd = (a.command ?? "").replace(/\r?\n/g, " ").trim();
				return paintLinks(expanded ? cmd : smartTitle(cmd), soft);
			},
		);

	// ls: no renderShell of its own, so pi's default shell turns it into a bg block.
	minimal(
		pi,
		createLsTool(cwd),
		(th) => th.fg("accent", "ls"),
		(a, _th, soft) => soft(shortPath(a.path ?? ".")),
		numRes((n) => `${n} entries`),
	);

	// bash: `󰔟 $ <6 words>…` / `✓ $ <full title when expanded>  0.1s`
	minimal(
		pi,
		createBashTool(cwd),
		(th) => th.fg("accent", "$"),
		(a, _th, soft, expanded) => {
			const cmd = (a.command ?? "").replace(/\r?\n/g, " ").trim();
			return paintLinks(expanded ? cmd : smartTitle(cmd), soft);
		},
	);

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
		(r, th) => {
			const diff: string = r.details?.diff ?? "";
			if (!diff) return fullText(r, th);
			return diff.split("\n").map((l) =>
				l.startsWith("+") && !l.startsWith("+++")
					? th.fg("toolDiffAdded", l)
					: l.startsWith("-") && !l.startsWith("---")
						? th.fg("toolDiffRemoved", l)
						: th.fg("toolDiffContext", l),
			);
		},
	);
}

// codemode: pi's renderer wrapped in our box. renderShell "self" keeps the
// execution defaults; renderCall/renderResult draw the box. state.hasResult
// guarantees one box per call, also after reload/restore.
const codemodeRenderers = {
	renderShell: "self" as const,
	renderCall(args: any, th: Theme, ctx: TCtx) {
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
	renderResult(result: TResult & { details?: any }, opts: { expanded: boolean; isPartial?: boolean }, th: Theme, ctx: TCtx) {
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

// Self-check: `node extensions/tools.ts`.
if (isMain(import.meta.url)) {
	const mark = (s: string) => `<${s}>`;
	const th: Theme = { fg: (_c, s) => s };
	const R = { content: [{ type: "text", text: "path:1:match a\npath:2:match b\npath:3:match c" }] };

	assert(smartTitle("echo hi") === "echo hi", "short text kept intact");
	assert(smartTitle("ls a b c d e f g h") === "ls a b c d e…", "cut at the 6-word limit");
	assert(smartTitle("a b c d e f g") === "a b c d e f…", "7 words -> 6 words + ellipsis");
	assert(smartTitle("a b c d e f") === "a b c d e f", "6 words kept intact");

	assert(paintLinks("cd /run/media/x && echo hi", mark) === "cd </run/media/x> && echo hi", "filter path absolut");
	assert(paintLinks("git clone https://github.com/a/b", mark) === "git clone <https://github.com/a/b>", "filter link URL");
	assert(paintLinks("ls extensions/tools.ts", mark) === "ls <extensions/tools.ts>", "relative path filter");
	assert(paintLinks("echo plain 2>&1", mark) === "echo plain 2>&1", "plain text untouched");

	// right-aligned duration, space-aware (overflow bug regression)
	const t1 = titleRow(th, "✓", "$", "echo hi", 30, "0.1s", false);
	assert(t1.length === 1 && visibleWidth(t1[0]) === 30, "duration right-aligned within the inner width");
	assert(t1[0].endsWith("0.1s"), "duration at the right end of the title");
	const t2 = titleRow(th, "✓", "$", "word ".repeat(40), 30, "0.1s", false);
	assert(t2.length === 1 && visibleWidth(t2[0]) === 30, "collapsed: long title stays 1 line, within width");
	const t3 = titleRow(th, "✓", "$", "word ".repeat(40), 30, "0.1s", true);
	assert(t3.every((l) => visibleWidth(l) <= 30), "expanded: every line <= inner");
	const t4 = titleRow(th, "✓", "$", "echo hi", 30, "", false);
	assert(!t4[0].includes("0.1s"), "no duration: empty (restored session)");

	// crash regression: third-party renderCall throwing at build time (pi-web-access
	// get_content: responseId.slice on undefined) must be contained, not crash pi
	assert(
		safeCall(() => {
			const args: { responseId?: string } = {};
			return args.responseId!.slice(0, 8);
		}) === null,
		"renderCall throws -> null (not a crash)",
	);
	assert(
		componentLines(
			safeCall(() => {
				throw new Error("renderer crash");
			}),
			10,
		).length === 0,
		"renderer crash -> 0 lines",
	);

	// no duplicate summary
	assert(resText(R, th, (s) => s, false, true) === "", "expand: empty summary");
	assert(resText(R, th, (s) => s, false, false) === "󱞩 path:1:match a", "collapsed: first line shown");
	assert(numRes((n) => `→ ${n} matches`)(R, th, (s) => s, false, false) === "󱞩 → 3 matches", "grep: N matches");
	assert(
		numRes((n) => `→ ${n} matches`)({ content: [{ type: "text", text: "Error: bad" }] }, th, (s) => s, true, false) ===
			"󱞩 Error: bad",
		"error: falls back to the first line",
	);

	// inter-box gap stripped
	assert(stripBlankEdges(["", "a", "", "b", "  ", ""]).join() === "a,,b", "blank edge lines dropped");
	assert(stripBlankEdges(["", "\x1b[2m\x1b[22m", "x"]).join() === "x", "blank ANSI line counts as blank");
	assert(stripBlankEdges(["a"]).join() === "a", "no blanks: kept intact");

	// Image preview: pi pads the image with blank rows (`result.rows - 1`), and the last
	// one carries a cursor-up prefix before the sequence. Those rows are the image's
	// vertical space — deleting them made the terminal paint the image over whatever
	// sits below (chat text, editor, footer). Regression: preview destroyed the layout.
	const kittySeq = "\x1b[5A\x1b_Ga=T,f=100,i=7,q=2,C=1,m=0;AAAA\x1b\\";
	const itermSeq = "\x1b]1337;File=inline=1:AAAA\x07";
	const withImage = ["", "╭─╮", "│ ✓ read form_crop.png │", "╰─╯", "", kittySeq, "", ""];
	const kept = stripEdgesKeepingImages(withImage);
	assert(kept.length === 6, "image: leading gap and box-image spacer dropped, blank tail kept");
	assert(kept[0] === "╭─╮", "image: leading Spacer removed");
	assert(kept.indexOf(kittySeq) === 3 && kept.length - 4 === 2, "image: rows after the sequence intact");
	assert(
		stripEdgesKeepingImages(["", "a", "", "b", "  ", ""]).join() === "a,,b",
		"no image: falls back to plain edge stripping",
	);
	assert(isImageLine(itermSeq) && !isImageLine("│ plain text │"), "image line detection: kitty + iTerm2 only");

	// tools without their own renderer -> same box (memory_write etc.)
	const noRenderer = { toolName: "memory_write", toolDefinition: {} };
	// tool with no definition (e.g. "Tool glob not found") -> still a box, not plain text
	const noDefinition = { toolName: "glob", toolDefinition: undefined, expanded: false };
	assert(
		ToolExecutionComponent.prototype.hasRendererDefinition.call(noDefinition) === true &&
			ToolExecutionComponent.prototype.getRenderShell.call(noDefinition) === "self",
		"tool without a definition: self shell (our box, not the plain fallback)",
	);
	assert(
		ToolExecutionComponent.prototype.hasRendererDefinition.call({ toolName: "x", toolDefinition: {} }) === true,
		"tool with a definition still has its renderer",
	);
	const noDefOut = (ToolExecutionComponent.prototype.getResultRenderer.call(noDefinition) as any)(
		{ content: [{ type: "text", text: '{\n  "pattern": "**/*.ts"\n}\nTool glob not found' }] },
		{ expanded: false, isPartial: false },
		th,
		{ args: { pattern: "**/*.ts" }, state: {} },
	).render(60);
	assert(noDefOut[0].startsWith("\u256d") && noDefOut[noDefOut.length - 1].startsWith("\u2570"), "tool without a definition: result wrapped in a box");
	assert(
		noDefOut.some((l: string) => l.includes("\u2713 glob")) &&
			noDefOut.some((l: string) => l.includes('[show]')),
		"tool without a definition: title + summary + expand hint",
	);
	// todo (this package's own tool, no renderers): the title says what the call left behind.
	const todoNoRenderer = { toolName: "todo", toolDefinition: {} };
	const todoBox = (ToolExecutionComponent.prototype.getResultRenderer.call(todoNoRenderer) as any)(
		{ content: [{ type: "text", text: "Updated #1" }], details: { detail: "completed" } },
		{ expanded: false, isPartial: false },
		th,
		{ args: { action: "update", id: 1, status: "completed" }, state: {} },
	).render(60);
	assert(
		todoBox.some((l: string) => l.includes("todo · completed")),
		`todo result: the title names the status, got ${todoBox.find((l: string) => l.includes("todo"))}`,
	);
	assert(todoBox.some((l: string) => l.includes("Updated #1")), "todo result: the status line keeps the result text");
	const todoPending = (ToolExecutionComponent.prototype.getCallRenderer.call(todoNoRenderer) as any)(
		{ action: "create", subject: "Tulis widget" },
		th,
		{ state: {}, args: {} },
	).render(60);
	assert(todoPending.some((l: string) => l.includes("todo · created")), "todo call: the title names the action");
	assert(
		!todoBox.some((l: string) => l.includes("·") && l.includes("Tulis widget")),
		"todo: the task name stays on the status line, not in the title",
	);
	// Generic predicate: any tool that ships its own renderers and no `renderShell: "self"`
	// is boxed — no name list to maintain for new extensions.
	const withRenderer = { toolName: "bash", toolDefinition: { renderResult: () => undefined } };
	assert(ToolExecutionComponent.prototype.getRenderShell.call(noRenderer) === "self", "plain tool -> self shell");
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(withRenderer) === "self",
		"tool with its own renderer -> boxed too (generic predicate, no name list)",
	);
	const extTool = { toolName: "some_ext_tool", toolDefinition: { renderCall: () => undefined } };
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(extTool) === "self",
		"unknown third-party tool with its own renderer -> boxed",
	);
	assert(
		toolSummary("memory_write", "Appended to MEMORY.md\n\nExisting MEMORY.md preview (1 lines)", {
			content: "## omaga-sync workflow (2026-08-23)\n- Repo: /x",
		}) === "Appended to MEMORY.md. ## omaga-sync workflow (2026-08-23)",
		"memory_write: summary + the heading just written",
	);
	assert(
		toolSummary("memory_write", "Appended to daily log: /x/y.md", { content: "- note without a heading" }) ===
			"Appended to daily log: /x/y.md",
		"memory_write daily: no heading -> first line",
	);
	assert(toolSummary("todo", "line1\nline2") === "line1", "other tools: first line only");
	assert(
		toolSummary("mcp", '{\n  "url": "https://example.com",\n  "ok": true\n}') === '"url": "https://example.com",',
		"first line is just '{' -> next line becomes the summary (MCP JSON)",
	);
	assert(
		toolSummary("mcp", '{\n  "url": "https://example.com",\n  "ok": true\n}', {}) === '"url": "https://example.com",' &&
			toolSummary("mcp", "{") === "{",
		"JSON summary: use the content line, fall back to the first",
	);
	assert(toolSummary("memory_write", "Appended to MEMORY.md") === "Appended to MEMORY.md", "ballast: plain summary kept intact");

	// distinct subtle bg: memory_write only
	assert(boxBgOf("memory_write") === "customMessageBg", "memory_write -> bg customMessageBg");
	assert(boxBgOf("bash") === undefined && boxBgOf("todo") === undefined, "other tools get no extra bg");
	const bgSeen: string[] = [];
	const thBgMem: Theme = { fg: (_c, s) => s, bg: (c, s) => (bgSeen.push(c), `<${s}>`) };
	const bgLines = box(thBgMem, 20, ["memory_write  0.1s", "󱞩 Appended to MEMORY.md"], boxBgOf("memory_write"));
	assert(bgSeen.length === bgLines.length && bgSeen.every((c) => c === "customMessageBg"), "bg used on every box line");
	assert(bgLines.every((l) => visibleWidth(l.replace(/[<>]/g, "")) === 20), "bg does not break the box line width");
	assert(bgLines[0]!.replace(/[<>]/g, "").startsWith("╭"), "top line stays intact");

	// pi-web-access: their renderer content, our box
	const paResult: any = { render: () => ["\x1b[32mPi Coding Agent\x1b[39m (77 matches, 77 shown)"] };
	const paCall: any = { render: () => ["\x1b[1mget_content \x1b[22m\x1b[36mfind 4\x1b[39m"] };
	const boxedRes = {
		toolName: "get_search_content",
		toolDefinition: { renderCall: () => paCall, renderResult: () => paResult },
	};
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(boxedRes) === "self",
		"pi-web-access: shell forced to self (joins our box, not a bg block)",
	);
	const searchRes = {
		toolName: "web_search",
		toolDefinition: { renderCall: () => ({ render: () => ["\x1b[1msearch \x1b[22m\x1b[36m\"site:pi.dev\"\x1b[39m"] }), renderResult: () => ({ render: () => ["\x1b[32m5 sources\x1b[39m"] }) },
	};
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(searchRes) === "self",
		"web_search: shell forced to self (joins our box)",
	);
	const bRes = ToolExecutionComponent.prototype.getResultRenderer.call(boxedRes) as any;
	const bOut = bRes(
		{ content: [{ type: "text", text: "raw text that must not be rendered" }], details: { matchCount: 77 } },
		{ expanded: false, isPartial: false },
		th,
		{ args: {} },
	).render(60);
	assert(bOut[0].startsWith("╭") && bOut[bOut.length - 1].startsWith("╰"), "pi-web-access: result wrapped in our box");
	assert(bOut.some((l: string) => l.includes("(77 matches, 77 shown)")), "pi-web-access: their renderer info kept");
	assert(!bOut.some((l: string) => l.includes("raw text")), "pi-web-access: raw text not used when a renderer exists");
	assert(
		bRes(
			{
				content: [{ type: "text", text: "No URL specified. Provide url, urlIndex, or query." }],
				details: { error: "No URL specified" },
			},
			{ expanded: false, isPartial: false },
			th,
			{ args: {} },
		)
			.render(60)
			.some((l: string) => l.includes("x get_content")),
		"pi-web-access: details.error -> x icon (not ✓)",
	);
	const bErr = bRes(
		{ content: [{ type: "text", text: "No URL specified. Provide url, urlIndex, or query." }] },
		{ expanded: false, isPartial: false },
		th,
		{ args: {}, isError: true },
	).render(60);
	assert(
		bErr.some((l: string) => l.includes("No URL specified")) &&
			bErr.filter((l: string) => l.includes("╭")).length === 1,
		"error: a single box (no nested box)",
	);
	assert(
		bRes({ content: [{ type: "text", text: "x" }] }, { expanded: false, isPartial: true }, th, { args: {} }).render(60)
			.length === 0,
		"pi-web-access: empty partial phase (no double box)",
	);
	const bCall = ToolExecutionComponent.prototype.getCallRenderer.call(boxedRes) as any;
	const bCallOut = bCall({}, th, { args: {}, state: {} }).render(60);
	assert(
		bCallOut[0].startsWith("╭") && bCallOut.some((l: string) => l.includes("find 4")),
		"pi-web-access: their renderer arg lines go in the box",
	);

	// pi-fff override mode: find/grep re-registered with own renderers, no renderShell
	const fffCall = { render: () => ["\x1b[1mfind \x1b[22m\x1b[36m*.ts in /tmp/work\x1b[39m"] };
	const fffRes = { render: () => ["src/a.ts \x1b[2m... (6 more lines)\x1b[22m"] };
	const fffFind = { toolName: "find", toolDefinition: { renderCall: () => fffCall, renderResult: () => fffRes } };
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(fffFind) === "self",
		"pi-fff find: shell forced to self (joins our box)",
	);
	const fffOut = (ToolExecutionComponent.prototype.getResultRenderer.call(fffFind) as any)(
		{ content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }] },
		{ expanded: false, isPartial: false },
		th,
		{ args: { pattern: "*.ts", path: "/tmp/work" }, state: {} },
	).render(60);
	assert(fffOut[0].startsWith("╭") && fffOut[fffOut.length - 1].startsWith("╰"), "pi-fff find: result wrapped in a box");
	assert(fffOut.some((l: string) => l.includes("*.ts in /tmp/work")), "pi-fff find: renderCall title goes in the box");
	assert(fffOut.some((l: string) => l.includes("6 more lines")), "pi-fff find: renderResult summary goes in the box");

	// pi-fff default mode (`ffgrep`/`fffind`): same renderer shape, different names.
	for (const n of ["ffgrep", "fffind"]) {
		const t = { toolName: n, toolDefinition: { renderCall: () => fffCall, renderResult: () => fffRes } };
		assert(
			ToolExecutionComponent.prototype.getRenderShell.call(t) === "self",
			`pi-fff ${n}: shell forced to self (default mode is boxed too)`,
		);
		const out = (ToolExecutionComponent.prototype.getResultRenderer.call(t) as any)(
			{ content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }] },
			{ expanded: false, isPartial: false },
			th,
			{ args: { pattern: "*.ts" }, state: {} },
		).render(60);
		assert(
			out[0].startsWith("╭") && out.some((l: string) => l.includes("6 more lines")),
			`pi-fff ${n}: result + summary merged into one box`,
		);
	}

	// pi core `powershell` / `ls` spread their renderers into the tool object and set no
	// renderShell, so pi's "default" shell used to render them as a bare bg block (see the
	// OWN_BOX block below for the registration half of this fix).
	for (const [n, t] of [
		["powershell", createPowerShellToolDefinition(cwd)],
		["ls", createLsToolDefinition(cwd)],
	] as const) {
		assert(
			ToolExecutionComponent.prototype.getRenderShell.call({ toolName: n, toolDefinition: t }) === "self",
			`pi core ${n}: shell forced to self (joins our box, not a bg block)`,
		);
	}

	const oursFind = { toolName: "find", toolDefinition: { renderShell: "self", renderCall: () => fffCall, renderResult: () => fffRes } };
	assert(
		(ToolExecutionComponent.prototype.getCallRenderer.call(oursFind) as any)() === fffCall &&
			(ToolExecutionComponent.prototype.getResultRenderer.call(oursFind) as any)() === fffRes,
		"our find (renderShell self): its own renderer as-is, not boxed again",
	);

	// Guard: source_check is deliberately NOT boxed — its curator partial carries
	// URLs + approval state, while our partial path returns nothing. Without this
	// assert a later edit of BOXED_TOOLS would swallow it silently.
	for (const n of ["source_check"]) {
		const theirs = () => "their-renderer";
		assert(
			ToolExecutionComponent.prototype.getResultRenderer.call({ toolName: n, toolDefinition: { renderResult: theirs } })() ===
				"their-renderer",
			`${n}: deliberately not boxed (the curator partial needs URLs)`,
		);
	}

	// pi-mcp-adapter: result does NOT use their renderer (unbounded error dump)
	// -> 1-line summary + [show]; the invoked tool stays visible.
	const mcpTheirs = () => "renderer-mcp";
	const mcpTool = { toolName: "mcp", toolDefinition: { renderCall: mcpTheirs, renderResult: mcpTheirs } };
	assert(
		(ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any) !== mcpTheirs,
		"mcp: third-party result renderer skipped (error dump capped)",
	);
	assert(
		(ToolExecutionComponent.prototype.getResultRenderer.call({ toolName: "mcp__tinyfish", toolDefinition: { renderResult: mcpTheirs } }) as any) !==
			mcpTheirs,
		"mcp__<server>: their renderer skipped (our box path)",
	);
	const mcpPayload = {
		content: [{ type: "text", text: "x Failed to call tool\nu Expected parameters:\n{\n  \"required\": []\n}" }],
		details: { error: "failed" },
	};
	const mcpOut = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any)(
		mcpPayload,
		{ expanded: false, isPartial: false },
		th,
		{ args: { tool: "fetch_content", server: "tinyfish" }, state: {} },
	).render(96);
	assert(mcpOut.length <= 6, `mcp error collapsed stays short (${mcpOut.length} lines)`);
	assert(
		mcpOut.some((l: string) => l.includes("fetch_content @ tinyfish")),
		"mcp: title names the invoked MCP tool",
	);
	assert(mcpOut.some((l: string) => l.includes("[show]")), "mcp: expand hint present");
	// Nothing hidden (a single output line), so the label goes away in both states.
	const mcpTiny = { content: [{ type: "text", text: "ok" }], details: {} };
	for (const expanded of [false, true]) {
		const rows = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any)(
			mcpTiny,
			{ expanded, isPartial: false },
			th,
			{ args: { tool: "fetch_content", server: "tinyfish" }, state: {} },
		).render(96);
		assert(rows.every((l: string) => !l.includes("[show]") && !l.includes("[hide]")), `mcp: nothing hidden, so no label (expanded=${expanded})`);
	}
	// A box whose content comes from a third-party renderer still shows its runtime, the
	// way pi's own box did before this module replaced it.
	recordTiming("mcp-dur", 2400);
	const mcpTimed = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any)(
		mcpPayload,
		{ expanded: false, isPartial: false },
		th,
		{ args: { tool: "fetch_content", server: "tinyfish" }, state: {}, toolCallId: "mcp-dur" },
	).render(96);
	assert(mcpTimed[1]!.includes("2.4s"), "mcp: the title row carries the runtime");
	const mcpFull = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any)(
		mcpPayload,
		{ expanded: true, isPartial: false },
		th,
		{ args: { tool: "fetch_content", server: "tinyfish" }, state: {} },
	).render(96);
	assert(mcpFull.length > mcpOut.length, "mcp: expand shows the full dump + args");

	// pi-mcp-adapter >= 2.3x defaults to `toolResultRendering: "compact"`, which sets
	// `renderShell: "self"` and paints flat text (`mcp call x @ y`, no border). That
	// `self` means "no box", not "my own box", so the MCP names must still be boxed.
	const mcpCompact = { toolName: "mcp", toolDefinition: { renderShell: "self", renderCall: mcpTheirs, renderResult: mcpTheirs } };
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(mcpCompact) === "self" &&
			(ToolExecutionComponent.prototype.getResultRenderer.call(mcpCompact) as any) !== mcpTheirs,
		"mcp compact (renderShell self): still boxed, their flat renderer skipped",
	);
	const mcpCompactOut = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpCompact) as any)(
		{ content: [{ type: "text", text: "ok" }], details: {} },
		{ expanded: false, isPartial: false },
		th,
		{ args: { tool: "cloudflare_execute", server: "cloudflare" }, state: {} },
	).render(96);
	assert(
		mcpCompactOut[0].startsWith("\u256d") && mcpCompactOut.some((l: string) => l.includes("cloudflare_execute @ cloudflare")),
		"mcp compact: bordered box naming the invoked tool",
	);
	const mcpCompactCall = (ToolExecutionComponent.prototype.getCallRenderer.call(mcpCompact) as any)(
		{ tool: "cloudflare_execute", server: "cloudflare" },
		th,
		{ args: {}, state: {} },
	).render(96);
	assert(
		mcpCompactCall[0].startsWith("\u256d") && mcpCompactCall.some((l: string) => l.includes("cloudflare_execute @ cloudflare")),
		"mcp compact: the running box is ours too (no flat `mcp call ...` line)",
	);
	// A non-MCP fourth-party `renderShell: "self"` still draws its own box: untouched.
	assert(
		ToolExecutionComponent.prototype.getResultRenderer.call({ toolName: "other_ext", toolDefinition: { renderShell: "self", renderResult: mcpTheirs } })() === "renderer-mcp",
		"renderShell self outside MCP keeps its own renderer",
	);

	// Gap is only stripped for our own box lines.
	// The default export registers the tools (filling OWN_BOX); a pi stub suffices.
	arnativeTools({
		registerTool: () => {},
		registerToolRenderer: () => {},
		on: () => {},
		registerShortcut: () => {},
		registerMessageRenderer: () => {},
	} as never);
	assert(
		OWN_BOX.has("bash") && OWN_BOX.has("read") && OWN_BOX.has("edit") && OWN_BOX.has("fetch_content") && OWN_BOX.has("web_search"),
		"OWN_BOX: our own tools + boxed tools registered",
	);
	assert(!OWN_BOX.has("mcp") && !OWN_BOX.has("source_check"), "OWN_BOX: third-party renderers not tightened");
	// pi core `powershell`/`ls` spread their renderer functions onto the tool object and
	// set no renderShell; that is exactly the shape that used to fall into pi's "default"
	// shell and render as a bare bg block. Registering them through minimal() boxes them.
	const coreReg: Record<string, any> = {};
	arnativeTools({ registerTool: (t: any) => { coreReg[t.name] = t; }, registerToolRenderer: () => {}, on: () => {} } as never);
	for (const [n, t] of [
		["powershell", createPowerShellToolDefinition(cwd)],
		["ls", createLsToolDefinition(cwd)],
	] as const) {
		const def = t as any;
		assert(
			Boolean(def.renderCall) && Boolean(def.renderResult),
			`pi core ${n}: the definition pi runs spreads its renderers onto the object`,
		);
		assert(
			ToolExecutionComponent.prototype.getRenderShell.call({ toolName: n, toolDefinition: def }) === "self",
			`pi core ${n}: shell forced to self (joins our box, not a bg block)`,
		);
	}
	// The guard is load-bearing: `getPowerShellConfig()` throws off Windows, and our
	// registration activates a tool the builtin deliberately leaves off.
	assert(
		coreReg.ls?.renderShell === "self",
		"pi core ls: registered through minimal() (boxing is live)",
	);
	assert(
		process.platform === "win32" ? coreReg.powershell?.renderShell === "self" : coreReg.powershell === undefined,
		"pi core powershell: registered on Windows only (getPowerShellConfig throws elsewhere)",
	);	assert(hasOwnRendererDef(mcpTool) && !hasOwnRendererDef(noRenderer), "tightened benchmark: tool renderer definition");
	assert(
		capped(th, ["a", "b", "c"], false).length === CALL_ROWS + 1 &&
			capped(th, ["a", "b", "c"], true).length === 3 &&
			capped(th, ["a"], false).length === 1,
		"third-party call lines capped only when collapsed",
	);
	assert(
		mcpInfo("bash", { tool: "x" }, th) === "" && mcpInfo("mcp", { tool: "x", server: "s" }, th).includes("x @ s"),
		"mcpInfo only for MCP tools",
	);

	const ctxState: TCtx = { args: { content: "## Heading\n- x" }, state: {} };
	const resRenderer = ToolExecutionComponent.prototype.getResultRenderer.call(noRenderer) as any;
	const out = resRenderer(
		{ content: [{ type: "text", text: "Appended to MEMORY.md\n\nExisting MEMORY.md preview" }] },
		{ expanded: false, isPartial: false },
		th,
		ctxState,
	).render(60);
	assert(out[0].startsWith("╭") && out[out.length - 1].startsWith("╰"), "plain tool result wrapped in a box");
	assert(
		out.some((l: string) => l.includes("Appended to MEMORY.md. ## Heading")),
		"box carries the summary + heading",
	);
	assert(out.some((l: string) => l.includes("[show]")), "collapsed: expand hint present");
	assert(
		resRenderer(
			{ content: [{ type: "text", text: "Appended to MEMORY.md\n\nExisting preview" }] },
			{ expanded: true, isPartial: false },
			th,
			ctxState,
		).render(60).length > out.length,
		"expand: full detail shown too",
	);

	// stale 󰔟 box regression (restore-safe)
	const st: Record<string, unknown> = {};
	const comp = new Lines(() => (st.hasResult ? [] : ["row"]));
	assert(comp.render(10).length === 1, "running: 󰔟 box shown");
	st.hasResult = true;
	assert(comp.render(10).length === 0, "final: running box gone (restore-safe)");
	assert(FRAMES.includes(spinIcon()), "animation icon is always a valid frame");
	ACTIVE = 3;
	syncTicker();
	assert(TICK !== null, "ticker alive while a tool is running");
	ACTIVE = 0;
	syncTicker();
	assert(TICK === null, "ticker stops when idle (no timer leak)");

	// Expanded detail: themed markdown, error text intact and no longer plain dim.
	const errDetail = fullText(
		{ content: [{ type: "text", text: '{\n  "pattern": "**/*.ts"\n}\nTool glob not found' }], isError: true },
		th,
		40,
	);
	const plain = stripAnsi(errDetail.join("\n"));
	assert(plain.includes("Tool glob not found") && plain.includes('"pattern"'), "error detail: content intact");
	assert(
		errDetail.every((l: string) => visibleWidth(l) === 40),
		"error detail: rendered as markdown (wrapped + padded to width), not a plain line split",
	);
	assert(
		fullText({ content: [{ type: "text", text: "a\nb" }] }, th, 0).join("|") === th.fg("dim", "a") + "|" + th.fg("dim", "b"),
		"no width (self-check) still dumps dim",
	);

	// codemode: one box per call, driven through the real component (what pi uses).
	const cmArgs = { code: 'const l = await tools.todo({ action: "list" });\nconsole.log(l);' };
	const cmRes = {
		content: [
			{ type: "text", text: "Script completed\nWall time 0.01 seconds\nOutput:\n" },
			{ type: "text", text: "alpha: ok" },
		],
		details: { calls: [{ status: "ok", name: "todo", args: '{"action":"list"}', durationMs: 2 }] },
	};
	initTheme(); // ToolExecutionComponent resolves a real theme, not the fg-passthrough stub
	const cmRender = (args: any, result: any, expanded = false) => {
		const c: any = new ToolExecutionComponent("codemode", "1", args, {}, codemodeRenderers as any, { requestRender() {} }, cwd);
		if (result) c.updateResult(result, false);
		c.setExpanded(expanded);
		// pi prefixes the box with a spacer blank line; drop blanks so the rows are predictable.
		return (c.render(100) as string[]).map(stripAnsi).filter((l) => l !== "");
	};
	recordTiming("1", 10);
	const cmCollapsed = cmRender(cmArgs, cmRes);
	assert(cmCollapsed.length === 4 && cmCollapsed[0]!.startsWith("╭") && cmCollapsed[3]!.startsWith("╰"), "codemode: collapsed box is title + one script line inside the border");
	assert(cmCollapsed[1]!.endsWith("10ms · [show] │"), "codemode: the title row right-aligns the runtime and expand hint");
	assert(cmCollapsed[2]!.includes("const l = await tools.todo"), "codemode: collapsed shows the first script line");
	const cmExpanded = cmRender(cmArgs, cmRes, true);
	assert(cmExpanded[1]!.endsWith("10ms · [hide] │"), "codemode: the expanded title row right-aligns the runtime and fold hint");
	assert(cmExpanded.some((l) => l.includes("✓ todo") && l.includes("2ms")) && cmExpanded.some((l) => l.includes("alpha: ok")), "codemode: expanded shows the nested calls and the output");
	// A failing run is never truncated: the whole output is shown without a hint in either state.
	const longErr = { content: [{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" + Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") }], isError: true };
	const cmErr = cmRender({ code: "boom()" }, longErr);
	assert(cmErr.some((l) => l.includes("line 12")) && !cmErr.some((l) => l.includes("[show]")), "codemode: a failed run shows all its output, no hint");
	assert(!cmRender({ code: "boom()" }, longErr, true).some((l) => l.includes("[hide]")), "codemode: a failed single-line run has nothing to fold when expanded");
	// Running: the shared spinner, not the codemode glyph, and no hint while nothing is hidden.
	const cmRunning = cmRender({ code: "console.log(1);" }, undefined);
	assert(FRAMES.some((f) => cmRunning.join("\n").includes(f)) && !cmRunning.join("\n").includes("\uf489"), "codemode: running box uses the shared spinner, not the codemode glyph");
	assert(!cmRunning.some((l) => l.includes("[show]")), "codemode: nothing hidden on a single-line script");
	assert([...cmCollapsed, ...cmExpanded, ...cmErr].every((l) => visibleWidth(l) === 100), "codemode: box fills the given width");
	assert(fmtMs(2) === "2ms" && fmtMs(1400) === "1.4s" && fmtMs(undefined) === "", "duration wording: ms under a second, s above");
	assert(codemodeOutput(cmRes.content) === "alpha: ok", "codemode: Script completed header dropped (own block)");
	assert(codemodeOutput([{ type: "text", text: "Script completed\nWall time 0.01 seconds\nOutput:\n2" }]) === "2", "codemode: header dropped when joined with the output");
	// minimal(): a collapsed summary hides more than it shows -> hint; expanded shows all.
	{
		const reg2: Record<string, any> = {};
		const fakePi: any = { registerTool: (t: any) => { reg2[t.name] = t; }, registerToolRenderer: () => {}, on: () => {} };
		arnativeTools(fakePi);
		const minRender = (name: string, args: any, result: any, expanded = false) => {
			const c: any = new ToolExecutionComponent(name, "1", args, {}, reg2[name], { requestRender() {} }, cwd);
			c.updateResult(result, false);
			c.setExpanded(expanded);
			return (c.render(74) as string[]).map(stripAnsi).filter((l) => l !== "");
		};
		const diffRes = { content: [{ type: "text", text: "ok" }], details: { diff: "@@\n-old\n+new" } };
		// The runtime comes from pi's own duration first (a restored session, a tool this
		// module does not wrap), then from the wall clock this module records. The pinned
		// devDependency predates `durationMs`, so only the fallback is reachable here; the
		// pi-supplied path is checked against the installed 1.4.0 in the release audit.
		const withDur = (id: string, expanded: boolean) => {
			const c: any = new ToolExecutionComponent("bash", id, { command: "true" }, {}, reg2.bash, { requestRender() {} }, cwd);
			c.updateResult(diffRes, false);
			c.setExpanded(expanded);
			return (c.render(74) as string[]).map(stripAnsi).filter((l) => l !== "");
		};
		recordTiming("dur-collapsed", 1400);
		const durRow = withDur("dur-collapsed", false)[1]!;
		assert(durRow.includes("1.4s"), "duration: the collapsed title row keeps the runtime");
		assert(
			durRow.indexOf("1.4s") < durRow.indexOf("[show]") && durRow.includes("1.4s · [show]"),
			"duration: the runtime comes first, the label keeps the right edge",
		);
		recordTiming("dur-open", 400);
		const durOpen = withDur("dur-open", true);
		assert(
			durOpen[1]!.includes("400ms · [hide]"),
			"duration: the expanded title row carries the runtime before the fold label",
		);
		const bare = withDur("dur-none", false)[1]!;
		assert(!/dms|d.ds/.test(bare), "duration: a call with no figure leaves the row clean");
		const ed = minRender("edit", { path: "README.md" }, diffRes);
		assert(ed[1]!.includes("[show]"), "minimal(): the title row carries the expand hint");
		assert(ed.some((l) => l.includes("+1 / -1")), "minimal(): the summary stays on its own row");
		assert(!ed.some((l) => l.includes("+1 / -1") && l.includes("[show]")), "minimal(): the summary no longer shares its row with the hint");
		assert(!minRender("edit", { path: "README.md" }, diffRes, true).some((l) => l.includes("[show]")), "minimal(): expanded edit drops the hint");
		// Expanded, the affordance stays: the same key folds the box back, on the title row.
		const opened = minRender("edit", { path: "README.md" }, diffRes, true);
		assert(opened[1]!.includes("[hide]"), "minimal(): the expanded title row offers the fold hint");
		assert(!opened.some((l) => l.includes("[show]")), "minimal(): the folded box offers no expand hint");
		assert(opened.every((l) => visibleWidth(l) === 74), "minimal(): the fold hint keeps every row the box width");
		assert(
			minRender("edit", { path: "README.md" }, { content: [{ type: "text", text: "done" }], details: {} }, true).every((l) => !l.includes("[hide]")),
			"minimal(): nothing hidden, so an expanded box offers no fold hint",
		);
		assert(
			minRender("bash", { command: "true" }, { content: [{ type: "text", text: "done" }], details: {} }).every((l) => !l.includes("[show]")),
			"minimal(): a single-line output has nothing hidden, so no hint",
		);
		// Output that merely STARTS with "Error" is content, not a failure: the box keeps its ✓.
		assert(
			minRender("bash", { command: "true" }, { content: [{ type: "text", text: "Error handling notes" }], details: {} }).some((l) => l.includes("✓")),
			"minimal(): text starting with 'Error' is not treated as a failed call",
		);
		assert(
			minRender("edit", { path: "README.md" }, diffRes).every((l) => visibleWidth(l) === 74),
			"minimal(): hint row still fills the box width",
		);
	}

	// Chrome DevTools: their bare renderers are replaced by our box (title + summary).
	const textComp = (text: string, color?: string) => ({
		render: (w: number) => (text ? text.split("\n").map((l) => (color ? th.fg(color, l) : l).slice(0, Math.max(0, w))) : []),
		invalidate() {},
	});
	const cdpRes = {
		toolName: "chrome_devtools_navigate",
		toolDefinition: {
			renderCall: () => textComp("Chrome DevTools: navigate"),
			renderResult: () => textComp(""),
		},
	};
	// The call renderer is not theirs (their bare line would swallow our icon/title).
	assert(
		ToolExecutionComponent.prototype.getCallRenderer.call(cdpRes) !== (cdpRes.toolDefinition.renderCall as any)(),
		"chrome-devtools: their bare call renderer is replaced by our box",
	);
	const cdpResult = { content: [{ type: "text", text: 'navigated\n{\n  "pageId": "p1",\n  "url": "https://example.com"\n}' }], details: {} };
	const cdpComp = (result: any, expanded = false) => {
		const c: any = new ToolExecutionComponent("chrome_devtools_navigate", "1", { url: "https://example.com" }, {}, cdpRes.toolDefinition as any, { requestRender() {} }, cwd);
		if (result) c.updateResult(result, false);
		c.setExpanded(expanded);
		return (c.render(74) as string[]).map(stripAnsi).filter((l) => l !== "");
	};
	const cdpCollapsed = cdpComp(cdpResult);
	assert(
		cdpCollapsed[0]!.startsWith("╭") && cdpCollapsed[cdpCollapsed.length - 1]!.startsWith("╰") && cdpCollapsed.some((l) => l.includes("navigate")),
		"chrome-devtools: result renders in our box with the tool name",
	);
	const cdpCall = ToolExecutionComponent.prototype.getCallRenderer.call(cdpRes) as any;
	const cdpCallOut: string[] = cdpCall({ url: "https://example.com" }, th, { args: {}, state: {} }).render(74);
	assert(
		cdpCallOut[0]!.startsWith("╭") && cdpCallOut.some((l) => stripAnsi(l).includes("Chrome DevTools: navigate")),
		"chrome-devtools: call box keeps the tool title and the CDP glyph",
	);
	assert(stripAnsi(cdpCallOut[1]!).includes(CDP_ICON), "chrome-devtools: call box uses the Chrome glyph, not the spinner");
	const cdpExpanded = cdpComp(cdpResult, true);
	assert(cdpExpanded.some((l) => l.includes('"pageId": "p1"')), "chrome-devtools: expanded shows the full tool output");
	assert(cdpCollapsed.some((l) => l.includes("navigated")), "chrome-devtools: collapsed shows the first line");
	assert(cdpCollapsed[1]!.includes("[show]"), "chrome-devtools: the title row carries the expand hint");
	assert([...cdpCollapsed, ...cdpExpanded].every((l) => visibleWidth(l) === 74), "chrome-devtools: box fills the given width");
	// Mouse on a tool box: the strip patch removes the blank rows above the box AFTER
	// pi laid out its mouse regions, so a click used to land one row high and the top
	// border was dead. pi also drops the click when the pointer drifts one cell.
	const mouseBox = () => {
		const c: any = new ToolExecutionComponent("mouse_probe", "1", {}, {}, {}, { requestRender: () => undefined }, cwd);
		c.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree" }] }, false);
		// Render before any event: pi only hit-tests a click against a box it has measured.
		c.render(60);
		return c;
	};
	// Height comes from the box as drawn, the same number pi puts in the event.
	const mouse = (c: any, type: string, y: number, x = 5): any =>
		c.handleMouse({
			type,
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width: 60,
			height: (c.render(60) as string[]).length,
			shift: false,
			alt: false,
			ctrl: false,
		});
	const click = (c: any, y: number, x = 5) => {
		mouse(c, "press", y, x);
		mouse(c, "release", y, x);
		mouse(c, "click", y, x);
	};
	const spans = (c: any) => textSpans(c.render(60) as string[], "[show]");
	const probeLines = mouseBox().render(60) as string[];
	assert(
		probeLines.length === 4 && stripAnsi(probeLines[0]!).startsWith("╭"),
		"mouse probe: 4 rows, blank edges stripped",
	);
	{
		const box = mouseBox();
		const [hint] = spans(box);
		assert(hint !== undefined, "mouse: the drawn box carries the hint span");
		const x = hint!.start;
		click(box, hint!.row, x);
		assert(box.expanded === true, "mouse: a click on the hint expands");
		click(box, hint!.row, x);
		assert(box.expanded === false, "mouse: the next click on the hint collapses");
	}
	{
		// A one-cell drift used to swallow the click: the press toggles, so it cannot.
		const box = mouseBox();
		const [hint] = spans(box);
		const x = hint!.start;
		mouse(box, "press", hint!.row, x);
		mouse(box, "move", hint!.row, x + 1);
		mouse(box, "release", hint!.row, x + 1);
		assert(box.expanded === true, "mouse: a one-cell drift on the hint still expands");
		mouse(box, "click", hint!.row, x + 1);
		assert(box.expanded === true, "mouse: the swallowed click does not toggle twice");
	}
	{
		// A label inside the output is content, not a button: only the title rows are matched.
		const outLabel: any = new ToolExecutionComponent("bash", "8", { command: "printf" }, {}, {}, { requestRender() {} }, cwd);
		outLabel.updateResult({ content: [{ type: "text", text: "line\n[show] in the output\nmore" }], details: {} }, false);
		outLabel.setExpanded(true);
		const outLines = (outLabel.render(60) as string[]).map(stripAnsi);
		const labelRow = outLines.findIndex((l) => l.includes("in the output"));
		assert(labelRow > 1, "mouse: the output label sits below the title rows");
		const labelX = outLines[labelRow]!.indexOf("[show]");
		const labelTaken = outLabel.handleMouse({ type: "press", button: "left", x: labelX, y: labelRow, screenX: labelX, screenY: labelRow, width: 60, height: outLines.length, shift: false, alt: false, ctrl: false });
		assert(labelTaken === undefined && outLabel.expanded === true, "mouse: a [show] inside the output is not a button");
	}
	{
		// Expanded, the fold hint is a click target too: the same cells, the other label.
		const box = mouseBox();
		const [open] = textSpans(box.render(60) as string[], "[show]");
		click(box, open!.row, open!.start);
		assert(box.expanded === true, "mouse: the expand hint opens the box");
		const [fold] = textSpans(box.render(60) as string[], "[hide]");
		assert(fold !== undefined, "mouse: the expanded box draws the fold hint");
		// One cell of drift: pi would drop the click, so only the hint cells can fold it.
		const fx = fold!.start;
		mouse(box, "press", fold!.row, fx);
		mouse(box, "move", fold!.row, fx + 1);
		mouse(box, "release", fold!.row, fx + 1);
		assert(box.expanded === false, "mouse: a drifting press on the fold hint closes the box");
		mouse(box, "click", fold!.row, fx + 1);
		assert(box.expanded === false, "mouse: the swallowed click does not reopen it");
	}
	{
		// Every cell off the hint stays with pi, which is what keeps the output copyable.
		const box = mouseBox();
		const taken = mouse(box, "press", 2, 6);
		assert(taken === undefined && box.expanded === false, "mouse: a press off the hint is left to pi (text selection)");
		mouse(box, "move", 2, 14);
		mouse(box, "release", 2, 14);
		assert(box.expanded === false, "mouse: a drag over the output does not expand the box");
	}

	// Capped timings map self-check
	for (let i = 0; i < 250; i++) recordTiming(`call_${i}`, i);
	assert(TIMINGS.size === MAX_TIMINGS, `TIMINGS size is bounded to ${MAX_TIMINGS}`);
	assert(!TIMINGS.has("call_0") && TIMINGS.has("call_249"), "TIMINGS evicts oldest entries");
	TIMINGS.clear();

	// /reload re-evaluates this module inside the same pi process. The prototype patches
	// must reinstall with the new closures; a globalThis guard bailed out on the second
	// load and kept the old ones, so a UI fix never appeared until pi restarted.
	{
		const before = ToolExecutionComponent.prototype.getResultRenderer;
		await import(`${import.meta.url}?reload=1`);
		const after = ToolExecutionComponent.prototype.getResultRenderer;
		assert(after !== before, "/reload: the prototype patch reinstalls on re-evaluation");
		// The stored original must stay pi's own method: capturing our previous patch
		// wrapped every box in a second one (double border + double ✓).
		const stored = (ToolExecutionComponent.prototype as any)[Symbol.for("pi-arnative.protoOriginals")];
		const patchedMark = Symbol.for("pi-arnative.patchedMethod");
		assert(
			!stored.render[patchedMark] && !stored.getResultRenderer[patchedMark],
			"/reload: originals stay pi's own methods, never a previous patch",
		);
		const plainAfter = (ToolExecutionComponent.prototype.getResultRenderer.call(noRenderer) as any)(
			{ content: [{ type: "text", text: "Appended to MEMORY.md" }] },
			{ expanded: false, isPartial: false },
			th,
			{ args: {}, state: {} },
		).render(60);
		assert(
			plainAfter.filter((l: string) => l.startsWith("\u256d")).length === 1,
			"/reload: a plain tool draws one box, not a box inside a box",
		);
		const mcpAfter = (after as any).call(mcpCompact);
		assert(mcpAfter !== mcpTheirs, "/reload: MCP stays boxed after re-evaluation");
		const out2 = mcpAfter(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			{ expanded: false, isPartial: false },
			th,
			{ args: { tool: "cloudflare_execute", server: "cloudflare" }, state: {} },
		).render(96);
		assert(
			out2[0].startsWith("\u256d") && out2.some((l: string) => l.includes("cloudflare_execute @ cloudflare")),
			"/reload: the box still renders (no double-patch loop, originals kept once)",
		);
	}

	console.log("OK");
}
