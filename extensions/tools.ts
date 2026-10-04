/**
 * Codex/Claude-Code style tool boxes: every tool call in its own box.
 *   ╭────────────────────────────╮
 *   │ 󰔟 $ cmd smart…             │  running (spinner, gone once finished)
 *   ╰────────────────────────────╯
 *   ╭────────────────────────────╮
 *   │ ✓ $ cmd smart…      0.1s   │  final, collapsed; duration right-aligned
 *   │ 󱞩 first output line        │
 *   ╰────────────────────────────╯
 * Click / ctrl+e = full title + detail (output dim; edit = toolDiff*).
 * Collapsed summary: bash/write `󱞩 first line`; grep/find/read numeric
 * (→ N matches / → N files / N lines); edit `󱞩 +N / -M`. Expanded plain output
 * gets no summary line (no duplicated first line).
 * Colors: tool name accent, paths/links soft, box lines + 󱞩 dim. Execution is a
 * pure delegate (spread of the built-in tools).
 * "has a result" lives in context.state, read at render() -> restore/reload safe,
 * no stale 󰔟 box. Third-party tools with no renderer of their own (memory_write,
 * scratchpad, MCP…) get the same box: shell "self", one-line summary,
 * `[ctrl+o to expand]` for the full detail.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
	getMarkdownTheme,
	highlightCode,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { renderBoxLines as box } from "../lib/box.ts";
import { stripAnsi, accentSoftOf } from "../lib/ansi.ts";
import { assert, isMain } from "../lib/check.ts";
import { expandKeyName } from "../lib/format.ts";

type Theme = { fg(color: string, text: string): string; bg?(color: string, text: string): string };
type TResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: any };
type TCtx = { isError?: boolean; toolCallId?: string; args?: any; state?: Record<string, unknown> };
type Res = (r: TResult, th: Theme, soft: (s: string) => string, isErr: boolean, expanded: boolean) => string;

const cwd = process.cwd();
const TIMINGS = new Map<string, number>(); // duration ms per tool call (one run)

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
): string[] {
	const head = `${icon} ${name} ${argPart}`.trim();
	const durStr = dur ? theme.fg("dim", dur) : "";
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

// Expand hint `[ctrl+o to expand]` (key text follows the active keybinding).
export function expandHint(th: Theme): string {
	return th.fg("dim", `[${expandKeyName()} to expand]`);
}

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
// with a prototype render patch (same pattern as the footer patch). Only lines we
// draw ourselves are stripped: third-party tools use their own "self" shell too, so
// the marker is a name list (OWN_BOX, filled by minimal() + BOXED_TOOLS), not the shell.
const OWN_BOX = new Set<string>();
const hasOwnRendererDef = (self: { toolDefinition?: { renderCall?: unknown; renderResult?: unknown } }): boolean =>
	Boolean(self?.toolDefinition?.renderCall || self?.toolDefinition?.renderResult);

// Inline image line: kitty (\x1b_G) or iTerm2 (\x1b]1337;File=) graphics payload.
// pi renders a tool's image preview as an extra child BELOW the box, padding it with
// `result.rows - 1` blank rows; the last row carries a cursor-up prefix before the
// sequence. Not exported by pi-tui, so match both prefixes.
export const isImageLine = (line: string): boolean => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");

/** Drop the leading Spacer only when an image preview follows: its blank tail rows
 *  are the image's vertical space, and deleting them made the terminal draw the
 *  image over the rows below (chat text, editor, footer). */
export function stripEdgesKeepingImages(lines: string[]): string[] {
	const firstImage = lines.findIndex(isImageLine);
	if (firstImage < 0) return stripBlankEdges(lines);
	let s = 0;
	while (s < firstImage && isBlankLine(lines[s])) s++;
	return lines.slice(s);
}

const GAP_KEY = Symbol.for("pi-arnative.toolGapStripped");
if (ToolExecutionComponent?.prototype?.render && !(globalThis as Record<symbol, boolean>)[GAP_KEY]) {
	(globalThis as Record<symbol, boolean>)[GAP_KEY] = true;
	const origRender = ToolExecutionComponent.prototype.render;
	ToolExecutionComponent.prototype.render = function (width: number): string[] {
		const lines = origRender.call(this, width);
		const name = (this as { toolName?: string }).toolName ?? "";
		return OWN_BOX.has(name) || !hasOwnRendererDef(this) ? stripEdgesKeepingImages(lines) : lines;
	};
}

// --- Tools without their own renderer: same box, one-line summary ---
// Without this pi renders them as a plain bg block (name + 10 output lines). Our
// renderer is installed through the prototype (same pattern as the gap patch) only
// for tools that define no renderCall/renderResult of their own (our own tools and
// pi-web-access etc. are untouched).
//
// BOXED_TOOLS exceptions: the pi-web-access tools whose display names that package
// hardcodes as "search "/"fetch "/"get_content " — their renderer content is used
// as-is and only wrapped in our box. `source_check` is deliberately NOT boxed: its
// partial phase (curator: URLs + approval state) would disappear because our partial
// path returns nothing. The `todo` tool (@juicesharp/rpiv-todo) is boxed with a
// check-square icon (\uf14a) and the toolPendingBg/toolSuccessBg backgrounds.
//
// MCP tools (pi-mcp-adapter) already use the "self" shell, but their result renderer
// prints the WHOLE output on error (unbounded, outside the box) and their call args
// can run to dozens of lines: a 1-line summary + [ctrl+o to expand] is tighter while
// the invoked tool stays visible. pi-fff "override" mode re-registers `find`/`grep`
// with its own renderers, replacing our boxed versions -> box theirs too (ours carry
// renderShell "self" = minimal).
const BOXED_TOOLS = new Map([
	["web_search", "search"],
	["fetch_content", "fetch"],
	["get_search_content", "get_content"],
	["todo", "todo"],
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

const FFF_OVERRIDE = ["find", "grep"];
const usesTheirCallRenderer = (self: any): boolean =>
	BOXED_TOOLS.has(self.toolName) ||
	MCP_TOOL(self.toolName) ||
	(FFF_OVERRIDE.includes(self.toolName) && self.toolDefinition?.renderShell !== "self");

// The MCP box title names the invoked tool (full args when expanded).
const mcpInfo = (name: string, args: any, th: Theme): string => {
	if (!MCP_TOOL(name)) return "";
	const tool = String(args?.tool ?? "");
	const server = String(args?.server ?? "");
	return tool ? th.fg("dim", `${tool}${server ? ` @ ${server}` : ""}`) : "";
};

// Cap third-party lines in the call box; the rest goes behind [ctrl+o to expand].
const CALL_ROWS = 2;
const capped = (th: Theme, rows: string[], expanded: boolean): string[] =>
	expanded || rows.length <= CALL_ROWS ? rows : [...rows.slice(0, CALL_ROWS), th.fg("dim", expandHint(th))];

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

const DEFAULT_TOOL_KEY = Symbol.for("pi-arnative.defaultToolBox");
if (ToolExecutionComponent?.prototype?.render && !(globalThis as Record<symbol, boolean>)[DEFAULT_TOOL_KEY]) {
	(globalThis as Record<symbol, boolean>)[DEFAULT_TOOL_KEY] = true;
	const proto = ToolExecutionComponent.prototype as any;
	const origCall = proto.getCallRenderer;
	const origResult = proto.getResultRenderer;
	const origShell = proto.getRenderShell;
	const hasOwnRenderer = (self: any): boolean => Boolean(origCall.call(self) || origResult.call(self));

	// A tool call with no registered definition (e.g. an unknown tool name that
	// errored with "Tool X not found") makes hasRendererDefinition() false, so the
	// constructor adds the plain contentText fallback and updateDisplay() never calls
	// getCallRenderer/getResultRenderer — our patch is bypassed and the call renders
	// as bare name + pretty-printed args. Claim those calls as defined so they take
	// the same box path as any other renderer-less tool.
	const origHasRendererDefinition = proto.hasRendererDefinition;
	proto.hasRendererDefinition = function (): boolean {
		return origHasRendererDefinition.call(this) || this.toolDefinition === undefined;
	};

	proto.getRenderShell = function (): string {
		if (usesTheirCallRenderer(this)) return "self";
		return hasOwnRenderer(this) ? origShell.call(this) : "self";
	};

	proto.getCallRenderer = function () {
		const name: string = this.toolName;
		const mine = usesTheirCallRenderer(this);
		const own = origCall.call(this);
		// Chrome DevTools' own renderCall is a bare line; ours replaces it (icon + name).
		if (own && !mine && !CDP_NAME.has(name)) return own;
		return (args: any, th: Theme, ctx: TCtx) =>
			new Lines((width) => {
				if ((ctx.state as Record<string, unknown> | undefined)?.hasResult) return [];
				const icon = CDP_NAME.has(name) ? th.fg("accent", CDP_ICON) : th.fg("warning", spinIcon());
				const theirs = own ? componentLines(safeCall(() => own.call(this, args, th, ctx)), width - 6) : [];
				if (name === "todo" && theirs.length)
					return box(th, width, formatTodoRows(theirs, th), "toolPendingBg");
				if (mine && theirs.length)
					return box(th, width, boxedRows(icon, capped(th, theirs, Boolean(this.expanded))));
				const inner = Math.max(8, width - 4);
				return box(th, width, titleRow(th, icon, th.fg("accent", displayName(name)), "", inner, "", false), boxBgOf(name));
			});
	};

	proto.getResultRenderer = function () {
		const name: string = this.toolName;
		const own = origResult.call(this);
		// pi-fff splits title (renderCall) and result (renderResult); both go in one box.
		const fff = FFF_OVERRIDE.includes(name) && this.toolDefinition?.renderShell !== "self";
		// MCP: their result renderer is deliberately skipped (unbounded error dump).
		if (own && !usesTheirCallRenderer(this)) return own;
		const boxed = BOXED_TOOLS.has(name);
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
			// Errors use our own path: pi-web-access' own error box is a box inside a
			// box. Their renderer content is only used on success.
			const theirs =
				(boxed || fff) && !isErr && !cdp
					? safeCall(() => own.call(this, { content: result.content, details: result.details }, opts, th, ctx))
					: null;
			return new Lines((width) => {
				const soft = accentSoftOf(th);
				const inner = Math.max(8, width - 4);
				const icon = isErr ? th.fg("error", "x") : th.fg("success", "✓");
				const boxed2 = componentLines(theirs, width - 6);
				if (fff && boxed2.length) {
					const callLines = componentLines(safeCall(() => origCall.call(this)?.call(this, ctx.args, th, ctx)), width - 6);
					return box(th, width, boxedRows(icon, [callLines[0]?.trim() || displayName(name), ...boxed2]));
				}
				if (name === "todo" && boxed2.length) {
					// todo call result (status completed / in_progress)
					const callLines = componentLines(safeCall(() => origCall.call(this)?.call(this, ctx.args, th, ctx)), width - 6);
					const combined = [...callLines, ...boxed2];
					const bgType = isErr ? "toolErrorBg" : "toolSuccessBg";
					return box(th, width, formatTodoRows(combined, th), bgType);
				}
				if (boxed2.length && !cdp) return box(th, width, boxedRows(icon, boxed2));
				const rows = titleRow(
					th,
					icon,
					th.fg("accent", displayName(name)),
					mcpInfo(name, ctx.args, th),
					inner,
					"",
					opts.expanded,
				);
				const summary = toolSummary(name, text, ctx.args);
				const more = countLines(text) > 1;
				const hint = more && !opts.expanded ? ` ${expandHint(th)}` : "";
				rows.push(`${resHead(th)}${summary ? ` ${paintLinks(summary, soft)}` : ""}${hint}`);
				if (opts.expanded && more) {
					// MCP args are gone once the call box is replaced by the result.
					if (MCP_TOOL(name)) rows.push(th.fg("dim", `args ${JSON.stringify(ctx.args ?? {})}`));
					rows.push(...fullText(result, th, inner));
				}
				return box(th, width, rows, boxBgOf(name));
			});
		};
	};
}

// todo line format: \uf14a icon (success color) in the title, resHead prefix on the status line.
const formatTodoRows = (lines: string[], th: Theme): string[] => {
	const icon = th.fg("success", "\uf14a");
	const head = resHead(th);
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		let l = lines[i];
		if (i === 0) {
			l = l.replace(/^(\x1b\[[0-9;]*m)*todo\b/, `${icon} todo`);
		} else {
			l = `${head} ${l}`;
		}
		out.push(l);
	}
	return out;
};

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
): string[] {
	const rows = [`${icon} ${th.fg("accent", "codemode")}`];
	const script = codemodeScript(typeof args?.code === "string" ? args.code : "", expanded);
	script.lines.forEach((line, i) => rows.push(i === 0 ? `${resHead(th)} ${line}` : ` ${line}`));
	const calls = (result?.details?.calls as any[] | undefined) ?? [];
	const output = codemodeOutput(result?.content);
	const outLines = output ? output.split("\n") : [];
	const shown = expanded || isErr;
	if (shown) {
		if (calls.length || outLines.length) rows.push("");
		rows.push(...calls.map((c) => formatCodemodeCall(c, th)), ...outLines.map((l) => th.fg("toolOutput", ` ${l}`)));
	}
	const hidden = script.hidden + (shown ? 0 : calls.length + outLines.length);
	if (!expanded && hidden > 0) rows[rows.length - 1] += ` ${expandHint(th)}`;
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
				TIMINGS.set(toolCallId, Math.round(performance.now() - start));
				ACTIVE--;
				syncTicker();
			}
		},
		renderCall(args: any, theme: Theme, context: TCtx) {
			return new Lines((width) => {
				// Read context.state live (never capture): renderResult may create it after renderCall.
				if (context.state?.hasResult) return [];
				const soft = accentSoftOf(theme);
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
			const dur = fmtMs(context.toolCallId ? TIMINGS.get(context.toolCallId) : undefined);
			const icon = isErr ? theme.fg("error", "x") : theme.fg("success", "✓");
			return new Lines((width) => {
				const soft = accentSoftOf(theme);
				const inner = Math.max(8, width - 4);
				const rows = titleRow(
					theme,
					icon,
					name(theme, soft),
					call(context.args ?? {}, theme, soft, expanded),
					inner,
					dur,
					expanded,
				);
				// Anything the collapsed summary hides gets the standard hint; without it a
				// two-line box (edit: `+1 / -1`) looks complete while the diff sits behind it.
				const hasDetail = countLines(text) > 1 || Boolean((result.details as { diff?: string } | undefined)?.diff);
				const resLine = res(result, theme, soft, isErr, expanded);
				if (expanded) rows.push(...full(result, theme));
				else if (resLine) {
					const hint = hasDetail ? ` ${expandHint(theme)}` : "";
					rows.push(hint ? `${truncateToWidth(resLine, Math.max(8, inner - visibleWidth(hint)), "…")}${hint}` : resLine);
				}
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
		requestRenderFn = () => {
			try {
				(ctx.ui as { requestRender?: () => void }).requestRender?.();
			} catch {
				// ignore
			}
		};
	});
	pi.on("session_shutdown", async () => {
		if (TICK) {
			clearInterval(TICK);
			TICK = null;
		}
		requestRenderFn = null;
	});

	// Gap is only stripped for our own boxes (see OWN_BOX above).

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
			return box(th, width, codemodeBoxRows(args, undefined, th, Boolean(ctx.expanded), isErr, icon), bg);
		});
	},
	renderResult(result: TResult & { details?: any }, opts: { expanded: boolean; isPartial?: boolean }, th: Theme, ctx: TCtx) {
		if (opts.isPartial) return EMPTY;
		((ctx.state ??= {}) as Record<string, unknown>).hasResult = true;
		const isErr = Boolean(ctx.isError || result.isError);
		const icon = isErr ? th.fg("error", "x") : th.fg("success", "\uf489");
		return new Lines((width) =>
			box(th, width, codemodeBoxRows(ctx.args, result, th, Boolean(opts.expanded), isErr, icon), isErr ? "toolErrorBg" : "toolSuccessBg"),
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
	assert(kept.length === 7, "image: only the leading gap dropped, blank tail kept");
	assert(kept[0] === "╭─╮", "image: leading Spacer removed");
	assert(kept.indexOf(kittySeq) === 4 && kept.length - 5 === 2, "image: rows after the sequence intact");
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
			noDefOut.some((l: string) => l.includes('[ctrl+o to expand]')),
		"tool without a definition: title + summary + expand hint",
	);
	const withRenderer = { toolName: "bash", toolDefinition: { renderResult: () => undefined } };
	assert(ToolExecutionComponent.prototype.getRenderShell.call(noRenderer) === "self", "plain tool -> self shell");
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(withRenderer) === "default",
		"tool with a renderer -> its own shell (untouched)",
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
	const fffCall = { render: () => ["\x1b[1mfind \x1b[22m\x1b[36m*.ts in D:/Pi/x\x1b[39m"] };
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
		{ args: { pattern: "*.ts", path: "D:/Pi/x" }, state: {} },
	).render(60);
	assert(fffOut[0].startsWith("╭") && fffOut[fffOut.length - 1].startsWith("╰"), "pi-fff find: result wrapped in a box");
	assert(fffOut.some((l: string) => l.includes("*.ts in D:/Pi/x")), "pi-fff find: renderCall title goes in the box");
	assert(fffOut.some((l: string) => l.includes("6 more lines")), "pi-fff find: renderResult summary goes in the box");

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
	// -> 1-line summary + [ctrl+o to expand]; the invoked tool stays visible.
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
	assert(mcpOut.some((l: string) => l.includes("[ctrl+o to expand]")), "mcp: expand hint present");
	const mcpFull = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any)(
		mcpPayload,
		{ expanded: true, isPartial: false },
		th,
		{ args: { tool: "fetch_content", server: "tinyfish" }, state: {} },
	).render(96);
	assert(mcpFull.length > mcpOut.length, "mcp: expand shows the full dump + args");

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
	assert(hasOwnRendererDef(mcpTool) && !hasOwnRendererDef(noRenderer), "tightened benchmark: tool renderer definition");
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
	assert(out.some((l: string) => l.includes("[ctrl+o to expand]")), "collapsed: expand hint present");
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

	// todo render: \uf14a + 2 lines (title & status) + background box
	const todoCall = () => ({ render: () => ["todo → Test subject"] });
	const todoResult = () => ({ render: () => ["● completed"] });
	const todoTool = { toolName: "todo", toolDefinition: { renderCall: todoCall, renderResult: todoResult } };
	const thBgTodo: Theme = {
		fg: (_c, s) => s,
		bg: (c, s) => `[bg:${c}]${s}[/bg]`,
	};
	const todoCallOut = (ToolExecutionComponent.prototype.getCallRenderer.call(todoTool) as any)({}, thBgTodo, { state: {} }).render(60);
	assert(todoCallOut[0].includes("[bg:toolPendingBg]"), "todo call: background pending");
	assert(todoCallOut.some((l: string) => l.includes("\uf14a todo → Test subject")), "todo call: \uf14a icon in the title");

	const todoResultOut = (ToolExecutionComponent.prototype.getResultRenderer.call(todoTool) as any)(
		{ content: [] },
		{ expanded: false, isPartial: false },
		thBgTodo,
		{ state: {}, args: {} },
	).render(60);
	assert(todoResultOut[0].includes("[bg:toolSuccessBg]"), "todo result: background success");
	assert(todoResultOut.some((l: string) => l.includes("\uf14a todo → Test subject")), "todo result: \uf14a icon on line 1");
	assert(todoResultOut.some((l: string) => l.includes("● completed")), "todo result: status with the resHead prefix on line 2");

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
	const cmCollapsed = cmRender(cmArgs, cmRes);
	assert(cmCollapsed.length === 4 && cmCollapsed[0]!.startsWith("╭") && cmCollapsed[3]!.startsWith("╰"), "codemode: collapsed box is title + one script line inside the border");
	assert(cmCollapsed[2]!.includes("const l = await tools.todo") && cmCollapsed[2]!.includes("[ctrl+o to expand]"), "codemode: collapsed shows the first script line + hint");
	const cmExpanded = cmRender(cmArgs, cmRes, true);
	assert(cmExpanded.some((l) => l.includes("✓ todo") && l.includes("2ms")) && cmExpanded.some((l) => l.includes("alpha: ok")), "codemode: expanded shows the nested calls and the output");
	// A failing run is never truncated: the whole output is shown without a hint.
	const longErr = { content: [{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" + Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") }], isError: true };
	const cmErr = cmRender({ code: "boom()" }, longErr);
	assert(cmErr.some((l) => l.includes("line 12")) && !cmErr.some((l) => l.includes("to expand")), "codemode: a failed run shows all its output, no hint");
	// Running: the shared spinner, not the codemode glyph, and no hint while nothing is hidden.
	const cmRunning = cmRender({ code: "console.log(1);" }, undefined);
	assert(FRAMES.some((f) => cmRunning.join("\n").includes(f)) && !cmRunning.join("\n").includes("\uf489"), "codemode: running box uses the shared spinner, not the codemode glyph");
	assert(!cmRunning.some((l) => l.includes("to expand")), "codemode: nothing hidden on a single-line script");
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
		const ed = minRender("edit", { path: "README.md" }, diffRes);
		assert(ed.some((l) => l.includes("+1 / -1") && l.includes("to expand")), "minimal(): collapsed edit summary carries the expand hint");
		assert(!minRender("edit", { path: "README.md" }, diffRes, true).some((l) => l.includes("to expand")), "minimal(): expanded edit drops the hint");
		assert(
			minRender("bash", { command: "true" }, { content: [{ type: "text", text: "done" }], details: {} }).every((l) => !l.includes("to expand")),
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
	assert(cdpCollapsed.some((l) => l.includes("navigated") && l.includes("to expand")), "chrome-devtools: collapsed shows the first line + hint");
	assert([...cdpCollapsed, ...cdpExpanded].every((l) => visibleWidth(l) === 74), "chrome-devtools: box fills the given width");
	console.log("OK");
}
