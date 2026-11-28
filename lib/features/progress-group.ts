/**
 * ADE-style chronological phase progress box for tool-heavy turns.
 *
 * Projects contiguous tool-execution turns (intermediate assistant messages with tool calls +
 * their ToolExecutionComponents) into a single virtual TurnProgressBoxComponent at render time
 * without mutating `chatContainer.children`. The final conclusion AssistantMessageComponent
 * always renders normally below the progress box.
 */
import { basename, dirname, relative } from "node:path";
import {
	AssistantMessageComponent,
	InteractiveMode,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getActiveTheme, softOf, stripAnsi } from "../ansi.ts";
import { boxRow, createHoldRepeat, inSpans, type BoxTheme, type HoldRepeat, type TextSpan } from "../box.ts";
import { chatboxPrimaryPaint } from "../chatbox.ts";
import { patchOnce } from "../patch.ts";
import { TOOL_LAYOUT_KEY, choiceSetting } from "../preset-store.ts";
import { expandedBoxBodyLimit, fmtMs, getToolTiming, paintScrollEdge, shortPath, smartTitle, spinIcon } from "./tools.ts";

export type ToolLayoutMode = "Grouped" | "Classic";
export const TOOL_LAYOUT_CHOICES: readonly ToolLayoutMode[] = ["Grouped", "Classic"];

const toolLayoutSetting = choiceSetting(TOOL_LAYOUT_KEY, TOOL_LAYOUT_CHOICES, "Grouped");
const layoutListeners = new Set<() => void>();

export const activeToolLayout = (): ToolLayoutMode => toolLayoutSetting.get();

export function onToolLayoutChange(fn: () => void): void {
	layoutListeners.add(fn);
}

export function setToolLayout(mode: ToolLayoutMode): void {
	toolLayoutSetting.set(mode);
	for (const fn of layoutListeners) fn();
}

export type PhaseCategory = "explore" | "edit" | "run" | "other";

export interface ToolLike {
	toolName?: string;
	toolCallId?: string;
	args?: Record<string, unknown>;
	expanded?: boolean;
	isPartial?: boolean;
	hideComponent?: boolean;
	cwd?: string;
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
		durationMs?: number;
	};
	ui?: { requestRender?: () => void };
	setExpanded?: (expanded: boolean) => void;
	render: (width: number) => readonly string[];
	handleMouse?: (event: unknown) => unknown;
	invalidate?: () => void;
}

export interface AssistantLike {
	hasToolCalls?: boolean;
	isStreaming?: boolean;
	lastMessage?: {
		content?: Array<{ type?: string; text?: string; thinking?: string }>;
	};
}

export interface ProgressPhase {
	title: string;
	explicitTitle: boolean;
	category: PhaseCategory;
	tools: ToolLike[];
	running: boolean;
	hasError: boolean;
	errorCount: number;
	durationMs: number;
	added: number;
	removed: number;
}

export interface TurnBoxState {
	/** Explicit user overrides per phase index. */
	phaseOverrides: Map<number, boolean>;
	/** Explicit user overrides for nested tool detail previews. */
	detailOpen: WeakMap<object, boolean>;
	/** Header [expand all] / [collapse all] override. */
	allOverride?: boolean;
	/** Manual viewport scroll offset into logical body lines; null/undefined auto-anchors. */
	scrollOffset?: number | null;
	/** Monotonic version bumped on every local interaction for render-cache invalidation. */
	interactionVersion: number;
}

interface HitPhaseRow {
	row: number;
	phaseIndex: number;
}

interface HitToolRow {
	row: number;
	tool: ToolLike;
	hintSpans: TextSpan[];
}

interface HitDetailRegion {
	startRow: number;
	endRow: number;
	rowOffset: number;
	indentCols: number;
	width: number;
	tool: ToolLike;
}

interface RenderedHitMap {
	width: number;
	maxBody: number;
	headerToggleSpans: TextSpan[];
	scrollUpSpans: TextSpan[];
	scrollDownSpans: TextSpan[];
	scrollOffset: number;
	maxOffset: number;
	scrollStep: number;
	allExpanded: boolean;
	phases: HitPhaseRow[];
	tools: HitToolRow[];
	details: HitDetailRegion[];
}

interface ProgressMouseEvent {
	type: string;
	button?: string;
	x: number;
	y: number;
	width: number;
	height: number;
	screenX: number;
	screenY: number;
	clickCount?: number;
}

function forwardMouseEvent(component: ToolLike, event: ProgressMouseEvent): unknown {
	const result = component.handleMouse?.(event) as Record<string, unknown> | undefined;
	if (!result) return undefined;
	if ("target" in result) return result;
	if (!result.handled && !result.capture && !result.focus) return undefined;
	return {
		...result,
		handled: true,
		...(result.focus ? { focusTarget: component } : {}),
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

const EXPAND_ALL_LABEL = "[expand all]";
const COLLAPSE_ALL_LABEL = "[collapse all]";
const SHOW_LABEL = "[show]";
const HIDE_LABEL = "[hide]";

const EXPLORE_TOOLS = new Set([
	"read",
	"grep",
	"ffgrep",
	"find",
	"fffind",
	"ls",
	"lsp_diagnostics",
	"web_search",
	"fetch_content",
	"get_search_content",
	"source_check",
	"memory_read",
	"memory_search",
	"memory_status",
]);

const EDIT_TOOLS = new Set([
	"edit",
	"write",
	"lsp_fix",
	"memory_write",
	"memory_forget",
	"memory_restore",
	"scratchpad",
	"todo",
]);

const RUN_TOOLS = new Set(["bash", "powershell", "codemode", "mcpScript"]);

/** Classify a tool name into a chronological ADE phase category. */
export function classifyTool(toolName: string | undefined): PhaseCategory {
	const name = (toolName ?? "").toLowerCase();
	if (EXPLORE_TOOLS.has(name)) return "explore";
	if (EDIT_TOOLS.has(name)) return "edit";
	if (RUN_TOOLS.has(name)) return "run";
	if (/(search|find|grep|read|list|get_|inspect|describe|status|query|fetch)/.test(name)) return "explore";
	if (/(edit|write|create|update|delete|remove|patch|fix|save)/.test(name)) return "edit";
	if (/(bash|shell|exec|run|powershell|terminal|eval|script)/.test(name)) return "run";
	return "other";
}

function isToolComponent(child: unknown): child is ToolLike {
	if (!child || typeof child !== "object") return false;
	if (child instanceof ToolExecutionComponent) return true;
	// Support lightweight test doubles with explicit marker.
	return (child as Record<symbol, unknown>)[TEST_TOOL_MARKER] === true;
}

function isIntermediateAssistant(child: unknown): child is AssistantLike {
	if (!child || typeof child !== "object") return false;
	if (child instanceof AssistantMessageComponent) {
		return Boolean((child as unknown as AssistantLike).hasToolCalls);
	}
	return (
		(child as Record<symbol, unknown>)[TEST_ASSISTANT_MARKER] === true &&
		Boolean((child as AssistantLike).hasToolCalls)
	);
}

const TEST_TOOL_MARKER = Symbol.for("pi-arnative.testTool");
const TEST_ASSISTANT_MARKER = Symbol.for("pi-arnative.testAssistant");
const PROGRESS_BOX_MARKER = Symbol.for("pi-arnative.turnProgressBox");
const SCROLL_HOLD_KEY = Symbol.for("pi-arnative.toolBoxScrollHold");
const SCROLL_OFFSET_KEY = Symbol.for("pi-arnative.toolBoxScrollOffset");

export function isProgressBox(child: unknown): child is TurnProgressBoxComponent {
	return Boolean(child && typeof child === "object" && (child as Record<symbol, unknown>)[PROGRESS_BOX_MARKER] === true);
}

/** Extract a concise single-line phase title from an intermediate assistant message's text content. */
export function extractNarration(assistant: AssistantLike): string {
	const blocks = assistant.lastMessage?.content;
	if (!Array.isArray(blocks)) return "";
	for (const block of blocks) {
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const line = block.text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find((l) => l.length > 0);
		if (!line) continue;
		const cleaned = line
			.replace(/^#{1,6}\s+/, "")
			.replace(/^[-*•]\s+/, "")
			.replace(/^\d+\.\s+/, "")
			.replace(/\*\*(.*?)\*\*/g, "$1")
			.replace(/`([^`]+)`/g, "$1")
			.replace(/[:：]\s*$/, "")
			.trim();
		if (cleaned) return cleaned.length > 72 ? `${cleaned.slice(0, 71).trimEnd()}…` : cleaned;
	}
	return "";
}

/** Count added and removed lines in a unified diff string from `edit` tool details. */
export function countDiffStats(tool: ToolLike): { added: number; removed: number } {
	const diff = (tool.result?.details as { diff?: unknown } | undefined)?.diff;
	if (typeof diff !== "string" || !diff) return { added: 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return { added, removed };
}

function durationMsOf(tool: ToolLike): number {
	if (tool.isPartial) return 0;
	const raw = tool.result?.durationMs ?? getToolTiming(tool.toolCallId);
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function rawPathOf(tool: ToolLike): string {
	const a = tool.args;
	if (!a) return "";
	const p = a.path ?? a.file_path ?? a.filePath ?? a.file;
	return typeof p === "string" ? p.trim() : "";
}

function displayPath(p: string, cwd?: string): string {
	if (!p) return "";
	const norm = p.replace(/\\/g, "/");
	if (cwd) {
		const rel = relative(cwd, p).replace(/\\/g, "/");
		if (rel && !rel.startsWith("..") && !rel.startsWith("/")) return rel;
	}
	return shortPath(norm);
}

function sharedFolder(paths: readonly string[]): string {
	const dirs = paths
		.map((p) => {
			const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
			const d = dirname(norm);
			return d && d !== "." && d !== "/" ? basename(d) : "";
		})
		.filter(Boolean);
	if (dirs.length < 2) return "";
	const first = dirs[0]!;
	return dirs.every((d) => d === first) ? first : "";
}

function commandOf(tool: ToolLike): string {
	const a = tool.args;
	if (!a) return "";
	if (typeof a.command === "string") return a.command.trim();
	if (typeof a.code === "string") return a.code.trim();
	return "";
}

function summaryArgOf(tool: ToolLike): string {
	const a = tool.args;
	if (!a) return "";
	return typeof a.toolSummary === "string" ? a.toolSummary.trim() : "";
}

function friendlyToolName(name: string | undefined): string {
	const n = name ?? "tool";
	if (n === "powershell") return "PS>";
	if (n === "web_search") return "search";
	if (n === "fetch_content") return "fetch";
	if (n === "get_search_content") return "get_content";
	return n;
}

function targetLabelOf(tool: ToolLike): string {
	const name = (tool.toolName ?? "").toLowerCase();
	const a = tool.args ?? {};
	const p = rawPathOf(tool);
	if (name === "read" || name === "edit" || name === "write" || name === "ls") {
		return displayPath(p, tool.cwd) || ".";
	}
	if (name === "grep" || name === "ffgrep") {
		const pat = typeof a.pattern === "string" ? a.pattern.trim() : "";
		const scope = p ? ` in ${displayPath(p, tool.cwd)}` : "";
		return pat ? `"${pat}"${scope}` : displayPath(p, tool.cwd);
	}
	if (name === "find" || name === "fffind") {
		const pat = typeof a.pattern === "string" ? a.pattern.trim() : "";
		const scope = p ? displayPath(p, tool.cwd) : "";
		return [pat, scope].filter(Boolean).join(" · ");
	}
	if (name === "bash" || name === "powershell") {
		const cmd = commandOf(tool);
		return cmd ? smartTitle(cmd, 6) : summaryArgOf(tool);
	}
	if (name === "codemode" || name === "mcpscript") {
		const sum = summaryArgOf(tool);
		if (sum) return sum;
		const first = commandOf(tool)
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find((l) => l && !l.startsWith("//"));
		return first ? smartTitle(first, 6) : "script";
	}
	if (name === "web_search") {
		const q = typeof a.query === "string" ? a.query : Array.isArray(a.queries) ? String(a.queries[0] ?? "") : "";
		return q.trim();
	}
	if (name === "fetch_content") {
		const u = typeof a.url === "string" ? a.url : Array.isArray(a.urls) ? String(a.urls[0] ?? "") : "";
		return u.trim();
	}
	for (const key of ["toolSummary", "tool", "path", "query", "pattern", "action", "subject", "url"]) {
		const v = a[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

/** Generate a descriptive heuristic phase title when the agent did not narrate the step. */
function heuristicPhaseTitle(category: PhaseCategory, tools: readonly ToolLike[]): string {
	const paths = tools.map(rawPathOf).filter(Boolean);
	const uniqueFiles = [...new Set(paths.map((p) => basename(p.replace(/\\/g, "/"))))].filter(Boolean);
	const names = tools.map((t) => (t.toolName ?? "").toLowerCase());

	if (category === "explore") {
		if (names.every((n) => n === "web_search" || n === "fetch_content" || n === "get_search_content" || n === "source_check")) {
			const firstQ = targetLabelOf(tools[0]!);
			return firstQ ? `Researched ${smartTitle(firstQ, 5)}` : "Researched web sources";
		}
		if (names.every((n) => n === "grep" || n === "ffgrep") && tools.length === 1) {
			const pat = typeof tools[0]?.args?.pattern === "string" ? tools[0].args.pattern.trim() : "";
			return pat ? `Searched for "${smartTitle(pat, 4)}"` : "Searched codebase";
		}
		if (uniqueFiles.length === 1) {
			const verb = names.every((n) => n === "read") ? "Read" : "Explored";
			return `${verb} ${uniqueFiles[0]}`;
		}
		const folder = sharedFolder(paths);
		if (folder) return `Explored ${folder} files`;
		if (uniqueFiles.length > 1) return `Explored ${uniqueFiles[0]} +${uniqueFiles.length - 1}`;
		return tools.length === 1 ? `Inspected ${targetLabelOf(tools[0]!) || "workspace"}` : "Explored workspace";
	}

	if (category === "edit") {
		if (names.every((n) => n === "todo" || n === "scratchpad")) return "Updated task plan";
		if (names.every((n) => n.startsWith("memory_"))) return "Updated memory";
		const hasWrite = names.some((n) => n === "write");
		const hasEdit = names.some((n) => n === "edit" || n === "lsp_fix");
		const verb = hasWrite && hasEdit ? "Created & updated" : hasWrite ? "Created" : "Updated";
		if (uniqueFiles.length === 1) return `${verb} ${uniqueFiles[0]}`;
		const folder = sharedFolder(paths);
		if (folder) return `${verb} ${folder} files`;
		if (uniqueFiles.length > 1) return `${verb} ${uniqueFiles.length} files`;
		return `${verb} ${tools.length} ${tools.length === 1 ? "item" : "items"}`;
	}

	if (category === "run") {
		if (tools.length === 1) {
			const cmd = commandOf(tools[0]!);
			const sum = summaryArgOf(tools[0]!);
			if (/\b(go\s+test|npm\s+test|bun\s+test|pytest|vitest|jest|cargo\s+test|node\s+--test)\b/i.test(cmd)) {
				return "Verified tests";
			}
			if (/\b(npm\s+run\s+build|tsc\b|cargo\s+build|go\s+build|vite\s+build)\b/i.test(cmd)) {
				return "Built project";
			}
			const gitMatch = cmd.match(/\bgit\s+(status|diff|log|branch|switch|checkout|commit|push|pull)\b/i);
			if (gitMatch) return `Ran git ${gitMatch[1]!.toLowerCase()}`;
			if (sum) return sum;
			if (cmd) return `Ran ${smartTitle(cmd, 4)}`;
		}
		const allTests = tools.every((t) =>
			/\b(go\s+test|npm\s+test|bun\s+test|pytest|vitest|jest|cargo\s+test|node\s+--test)\b/i.test(commandOf(t)),
		);
		if (allTests) return "Verified tests";
		return `Ran ${tools.length} commands`;
	}

	if (tools.length === 1) {
		const sum = summaryArgOf(tools[0]!);
		return sum || `Used ${friendlyToolName(tools[0]!.toolName)}`;
	}
	return `Completed ${tools.length} tool actions`;
}

/** Group a turn's intermediate assistant messages and tool calls into chronological phases. */
export function buildPhases(items: readonly (AssistantLike | ToolLike)[]): ProgressPhase[] {
	interface DraftPhase {
		title: string;
		explicitTitle: boolean;
		category: PhaseCategory;
		tools: ToolLike[];
		batchOwner?: AssistantLike;
	}

	const drafts: DraftPhase[] = [];
	let lastAssistant: AssistantLike | undefined;
	let pendingNarration: string | undefined;

	for (const item of items) {
		if (isIntermediateAssistant(item)) {
			lastAssistant = item;
			const narration = extractNarration(item);
			if (narration) pendingNarration = narration;
			continue;
		}
		if (!isToolComponent(item) || item.hideComponent) continue;

		const cat = classifyTool(item.toolName);
		const prev = drafts[drafts.length - 1];
		if (pendingNarration) {
			drafts.push({
				title: pendingNarration,
				explicitTitle: true,
				category: cat,
				tools: [item],
				batchOwner: lastAssistant,
			});
			pendingNarration = undefined;
		} else if (
			prev &&
			((prev.explicitTitle && prev.batchOwner !== undefined && prev.batchOwner === lastAssistant) ||
				(!prev.explicitTitle && prev.category === cat))
		) {
			prev.tools.push(item);
		} else {
			drafts.push({
				title: "",
				explicitTitle: false,
				category: cat,
				tools: [item],
				batchOwner: lastAssistant,
			});
		}
	}

	return drafts.map((d) => {
		let running = false;
		let errorCount = 0;
		let durationMs = 0;
		let added = 0;
		let removed = 0;
		for (const tool of d.tools) {
			if (tool.isPartial || !tool.result) running = true;
			if (tool.result?.isError) errorCount += 1;
			durationMs += durationMsOf(tool);
			const stat = countDiffStats(tool);
			added += stat.added;
			removed += stat.removed;
		}
		return {
			title: d.explicitTitle ? d.title : heuristicPhaseTitle(d.category, d.tools),
			explicitTitle: d.explicitTitle,
			category: d.category,
			tools: d.tools,
			running,
			hasError: errorCount > 0,
			errorCount,
			durationMs,
			added,
			removed,
		};
	});
}

function formatPhaseBadge(phase: ProgressPhase, th: BoxTheme | null): string {
	const fg = (color: string, s: string) => (th ? th.fg(color, s) : s);
	const parts: string[] = [];

	if (phase.category === "explore") {
		let searches = 0;
		let reads = 0;
		let other = 0;
		for (const t of phase.tools) {
			const n = (t.toolName ?? "").toLowerCase();
			if (n === "read") reads += 1;
			else if (n.includes("grep") || n.includes("find") || n.includes("search") || n === "ls") searches += 1;
			else other += 1;
		}
		if (searches) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
		if (reads) parts.push(`${reads} ${reads === 1 ? "read" : "reads"}`);
		if (other) parts.push(`${other} ${other === 1 ? "step" : "steps"}`);
	} else if (phase.category === "edit") {
		const files = new Set(phase.tools.map(rawPathOf).filter(Boolean));
		const count = files.size || phase.tools.length;
		const unit = files.size ? (count === 1 ? "file" : "files") : count === 1 ? "change" : "changes";
		parts.push(`${count} ${unit}`);
		if (phase.added > 0 || phase.removed > 0) {
			parts.push(`${fg("toolDiffAdded", `+${phase.added}`)}${fg("dim", "/")}${fg("toolDiffRemoved", `-${phase.removed}`)}`);
		}
	} else if (phase.category === "run") {
		const n = phase.tools.length;
		parts.push(`${n} ${n === 1 ? "command" : "commands"}`);
		if (phase.running) parts.push(fg("warning", "running"));
		else if (phase.hasError) parts.push(fg("error", `${phase.errorCount} failed`));
		else parts.push(fg("success", "ok"));
	} else {
		const n = phase.tools.length;
		parts.push(`${n} ${n === 1 ? "step" : "steps"}`);
	}

	if (phase.category !== "run" && phase.hasError) {
		parts.push(fg("error", `${phase.errorCount} failed`));
	}
	if (parts.length === 0) return "";
	const sep = phase.category === "explore" ? ", " : " · ";
	return `${fg("dim", "(")}${parts.map((p) => (p.includes("\x1b[") ? p : fg("dim", p))).join(fg("dim", sep))}${fg("dim", ")")}`;
}

function renderTopBorder(
	width: number,
	leftStyled: string,
	centerStyled: string,
	rightStyled: string,
	dim: (s: string) => string,
): string {
	if (width < 6) return dim("╭" + "─".repeat(Math.max(0, width - 2)) + "╮");
	const rightPart = rightStyled ? ` ${rightStyled} ` : "";
	const rightW = visibleWidth(rightPart);
	const centerPart = centerStyled ? ` ${centerStyled} ` : "";
	const centerW = visibleWidth(centerPart);

	// Place `↑ N more` centered in the top border (matching chatbox) when room allows.
	if (centerW > 0 && width >= 8 + rightW + centerW + 4) {
		const maxLeft = Math.max(4, width - 8 - rightW - centerW);
		const fittedLeft = truncateToWidth(leftStyled, maxLeft, "…");
		const leftW = visibleWidth(fittedLeft);
		const minStart = 4 + leftW + 1;
		const maxStart = width - 2 - rightW - 1 - centerW;
		const centerStart = Math.max(minStart, Math.min(maxStart, Math.floor((width - centerW) / 2)));
		const fill1 = Math.max(1, centerStart - (4 + leftW));
		const fill2 = Math.max(1, width - 2 - rightW - (centerStart + centerW));
		const raw = `${dim("╭─")} ${fittedLeft} ${dim("─".repeat(fill1))}${centerPart}${dim("─".repeat(fill2))}${rightPart}${dim("─╮")}`;
		return truncateToWidth(raw, width, "");
	}

	// Fixed columns: `╭─ ` (3) + ` ` (1) + at least 1 fill `─` (1) + rightPart + `─╮` (2) = 7 + rightW.
	const maxLeft = Math.max(4, width - 7 - rightW);
	const fittedLeft = truncateToWidth(leftStyled, maxLeft, "…");
	const leftW = visibleWidth(fittedLeft);
	const fillCount = Math.max(1, width - 6 - leftW - rightW);
	const raw = `${dim("╭─")} ${fittedLeft} ${dim("─".repeat(fillCount))}${rightPart}${dim("─╮")}`;
	return truncateToWidth(raw, width, "");
}

function renderBottomBorder(width: number, dim: (s: string) => string): string {
	return dim(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function padBetween(left: string, right: string, inner: number): string {
	const rightW = visibleWidth(right);
	if (rightW === 0) return truncateToWidth(left, inner, "…");
	const avail = Math.max(4, inner - rightW - 1);
	const fittedLeft = truncateToWidth(left, avail, "…");
	const gap = Math.max(1, inner - visibleWidth(fittedLeft) - rightW);
	return `${fittedLeft}${" ".repeat(gap)}${right}`;
}

/** Right-most clickable span for a button label (`[show]`, `[hide]`, `[expand all]`, `[collapse all]`),
 *  padded by 1 cell on each side so near-edge clicks never miss and tool args containing the
 *  same text never steal the hitbox. */
function buttonSpan(line: string, row: number, label: string, maxCol: number): TextSpan[] {
	if (!label) return [];
	const plain = stripAnsi(line);
	const at = plain.lastIndexOf(label);
	if (at < 0) return [];
	const start = visibleWidth(plain.slice(0, at));
	const end = start + visibleWidth(label) - 1;
	return [{ row, start: Math.max(0, start - 1), end: Math.min(maxCol, end + 1) }];
}

export class TurnProgressBoxComponent {
	readonly [PROGRESS_BOX_MARKER] = true;
	private items: (AssistantLike | ToolLike)[] = [];
	private readonly state: TurnBoxState;
	private lastHitMap: RenderedHitMap | null = null;
	/** True between a press-handled toggle and its matching release. */
	private pressConsumed = false;
	/** True right after a press-handled release so a synchronous trailing click is ignored. */
	private suppressNextClick = false;
	private scrollHold: HoldRepeat | null = null;
	private scrollHoldActive = false;
	private requestRender?: () => void;

	constructor(state: TurnBoxState) {
		this.state = state;
	}

	private stopScrollHold(): void {
		this.scrollHold?.stop();
		this.scrollHold = null;
		this.scrollHoldActive = false;
	}

	private startScrollHold(dir: -1 | 1): void {
		this.stopScrollHold();
		const hold = createHoldRepeat();
		this.scrollHold = hold;
		this.scrollHoldActive = true;
		hold.start(() => {
			const hit = this.lastHitMap;
			if (!hit || hit.maxOffset <= 0) {
				this.scrollHoldActive = false;
				return false;
			}
			const cur = this.state.scrollOffset ?? hit.scrollOffset;
			const next = Math.max(0, Math.min(hit.maxOffset, cur + dir * Math.max(1, hit.scrollStep)));
			if (next === cur) {
				this.scrollHoldActive = false;
				return false;
			}
			this.state.scrollOffset = next;
			this.bumpAndRequestRender();
			return true;
		});
	}

	update(items: (AssistantLike | ToolLike)[], requestRender?: () => void): void {
		this.items = items;
		if (requestRender) this.requestRender = requestRender;
	}

	getItems(): readonly (AssistantLike | ToolLike)[] {
		return this.items;
	}

	getInteractionVersion(): number {
		return this.state.interactionVersion;
	}

	isDynamic(): boolean {
		if (this.scrollHoldActive) return true;
		for (const item of this.items) {
			if (isToolComponent(item)) {
				if (item.isPartial || !item.result) return true;
				if ((item as unknown as Record<symbol, unknown>)[SCROLL_HOLD_KEY] !== undefined) return true;
			}
			if (isIntermediateAssistant(item) && item.isStreaming) return true;
		}
		return false;
	}

	/** 32-bit FNV-1a scroll offset hash across the box viewport and contained tools so render-cache detects scroll ticks at any turn length. */
	getScrollSignature(): number {
		let sig = 0x811c9dc5 | 0;
		const ownOffset = this.state.scrollOffset == null ? -1 : this.state.scrollOffset | 0;
		sig = Math.imul(sig ^ ownOffset, 0x01000193) | 0;
		for (const item of this.items) {
			if (isToolComponent(item)) {
				const offset = Number((item as unknown as Record<symbol, unknown>)[SCROLL_OFFSET_KEY] ?? 0) | 0;
				sig = Math.imul(sig ^ offset, 0x01000193) | 0;
			}
		}
		return sig;
	}

	invalidate(): void {
		// Keep lastHitMap intact until the next render replaces it; mouse events can arrive
		// between invalidate/requestRender and the throttled frame paint.
	}

	private isPhaseExpanded(phase: ProgressPhase, index: number): boolean {
		if (this.state.phaseOverrides.has(index)) return this.state.phaseOverrides.get(index)!;
		if (this.state.allOverride !== undefined) return this.state.allOverride;
		if (phase.running || phase.hasError) return true;
		if (phase.tools.some((t) => this.isDetailOpen(t))) return true;
		return false;
	}

	private isDetailOpen(tool: ToolLike): boolean {
		// Real ToolExecutionComponents own `expanded`, so reading it keeps parent [show]/[hide],
		// nested tool [hide]/body clicks, and Ctrl+O in lockstep. Fallback map is only for mocks
		// without `setExpanded`.
		if (typeof tool.setExpanded === "function") return Boolean(tool.expanded);
		if (this.state.detailOpen.has(tool)) return Boolean(this.state.detailOpen.get(tool));
		return Boolean(tool.expanded);
	}

	private setDetailOpen(tool: ToolLike, open: boolean): void {
		this.state.detailOpen.set(tool, open);
		tool.setExpanded?.(open);
	}

	private bumpAndRequestRender(): void {
		this.state.interactionVersion += 1;
		this.requestRender?.();
		for (const item of this.items) {
			if (isToolComponent(item) && item.ui?.requestRender) {
				item.ui.requestRender();
				break;
			}
		}
	}

	render(width: number): string[] {
		if (width < 8) return [];
		const th = getActiveTheme<BoxTheme>();
		const fg = (color: string, s: string) => (th ? th.fg(color, s) : s);
		const bold = th?.bold?.bind(th) ?? ((s: string) => s);
		const dim = (s: string) => fg("dim", s);
		const soft = softOf(th);
		const inner = Math.max(8, width - 4);

		const phases = buildPhases(this.items);
		if (phases.length === 0) return [];

		let totalTools = 0;
		let totalMs = 0;
		let totalErrors = 0;
		let anyRunning = false;
		for (const p of phases) {
			totalTools += p.tools.length;
			totalMs += p.durationMs;
			totalErrors += p.errorCount;
			if (p.running) anyRunning = true;
		}

		const expandedFlags = phases.map((p, i) => this.isPhaseExpanded(p, i));
		const allExpanded = expandedFlags.every(Boolean);

		const headerIcon = anyRunning
			? fg("warning", spinIcon())
			: totalErrors > 0
				? fg("error", "✗")
				: fg("success", "✓");
		const stepCount = `${totalTools} ${totalTools === 1 ? "step" : "steps"}`;
		const headerMeta = [
			fg("muted", stepCount),
			totalMs > 0 ? dim(fmtMs(totalMs)) : "",
			totalErrors > 0 ? fg("error", `${totalErrors} failed`) : "",
		]
			.filter(Boolean)
			.join(dim(" · "));
		const headerLeft = `${headerIcon} ${fg("accent", bold("Progress"))}${dim(" · ")}${headerMeta}`;
		const toggleText = allExpanded ? COLLAPSE_ALL_LABEL : EXPAND_ALL_LABEL;
		const headerRight = dim(toggleText);

		const bodyLines: string[] = [];
		const logicalPhases: Array<{ bodyRow: number; phaseIndex: number }> = [];
		const logicalTools: Array<{ bodyRow: number; tool: ToolLike; hintLabel: string }> = [];
		const logicalDetails: Array<{
			startBodyRow: number;
			endBodyRow: number;
			rowOffset: number;
			indentCols: number;
			width: number;
			tool: ToolLike;
		}> = [];

		for (let i = 0; i < phases.length; i++) {
			const phase = phases[i]!;
			const expanded = expandedFlags[i]!;
			const arrow = expanded ? fg("accent", "▾") : dim("▸");
			const statusIcon = phase.running
				? fg("warning", spinIcon())
				: phase.hasError
					? fg("error", "✗")
					: fg("success", "✓");
			const titleText = phase.hasError ? fg("error", phase.title) : fg("text", phase.title);
			const badge = width >= 54 ? formatPhaseBadge(phase, th) : "";
			const durText = phase.durationMs > 0 ? dim(fmtMs(phase.durationMs)) : "";

			const leftMain = `${arrow} ${statusIcon} ${titleText}`;
			const rightMain = [badge, durText].filter(Boolean).join("  ");
			const phaseBodyRow = bodyLines.length;
			bodyLines.push(boxRow(padBetween(leftMain, rightMain, inner), width, dim));
			logicalPhases.push({ bodyRow: phaseBodyRow, phaseIndex: i });

			if (!expanded) continue;

			for (let j = 0; j < phase.tools.length; j++) {
				const tool = phase.tools[j]!;
				const isLast = j === phase.tools.length - 1;
				const branch = dim(isLast ? "  └─" : "  ├─");
				const toolRunning = Boolean(tool.isPartial || !tool.result);
				const toolErr = Boolean(tool.result?.isError);
				const toolIcon = toolRunning
					? fg("warning", spinIcon())
					: toolErr
						? fg("error", "✗")
						: fg("success", "✓");
				const nameText = fg("accent", friendlyToolName(tool.toolName));
				const target = targetLabelOf(tool);
				const targetStyled = target ? ` ${soft(target)}` : "";
				const stat = countDiffStats(tool);
				const statText =
					stat.added > 0 || stat.removed > 0
						? `  ${fg("toolDiffAdded", `+${stat.added}`)}${dim("/")}${fg("toolDiffRemoved", `-${stat.removed}`)}`
						: "";
				const detailOpen = this.isDetailOpen(tool);
				const dur = fmtMs(durationMsOf(tool) || undefined);
				const hintLabel = detailOpen ? HIDE_LABEL : SHOW_LABEL;
				const rightParts = [dur, hintLabel].filter(Boolean).join(" · ");
				const toolRight = dim(rightParts);
				const toolLeft = `${branch} ${toolIcon} ${nameText}${targetStyled}${statText}`;
				const toolBodyRow = bodyLines.length;
				bodyLines.push(boxRow(padBetween(toolLeft, toolRight, inner), width, dim));
				logicalTools.push({ bodyRow: toolBodyRow, tool, hintLabel });

				if (!detailOpen) continue;

				const detailIndent = isLast ? "      " : "  │   ";
				const indentCols = 2 + visibleWidth(detailIndent); // `│ ` + detailIndent
				const detailWidth = Math.max(16, width - indentCols - 2);
				const rawDetail = tool.render(detailWidth);
				// Drop leading empty spacer line from fallback tool renderers.
				let startIdx = 0;
				while (startIdx < rawDetail.length && stripAnsi(rawDetail[startIdx]!).trim() === "") startIdx += 1;
				const detailLines = rawDetail.slice(startIdx);
				if (detailLines.length > 0) {
					const startBodyRow = bodyLines.length;
					for (const dl of detailLines) {
						bodyLines.push(boxRow(`${dim(detailIndent)}${dl}`, width, dim));
					}
					logicalDetails.push({
						startBodyRow,
						endBodyRow: bodyLines.length - 1,
						rowOffset: startIdx,
						indentCols,
						width: detailWidth,
						tool,
					});
				}
			}
		}

		// Cap tall boxes with the same adaptive viewport limit and `↑/↓ N more` border
		// affordances used by chatbox and expanded tool boxes.
		const maxBody = expandedBoxBodyLimit();
		const maxOffset = Math.max(0, bodyLines.length - maxBody);
		let offset = 0;
		if (maxOffset === 0) {
			this.stopScrollHold();
			if (this.state.scrollOffset != null) this.state.scrollOffset = null;
		} else if (this.state.scrollOffset != null) {
			offset = Math.max(0, Math.min(this.state.scrollOffset, maxOffset));
			this.state.scrollOffset = offset;
		} else {
			// Auto mode always tails the newest row. Anchoring to an early error would fight
			// the running-anchor: in every inter-tool gap nothing is running, so the viewport
			// bounced error → bottom → error for the rest of the turn.
			offset = maxOffset;
		}

		const visibleBody = maxOffset > 0 ? bodyLines.slice(offset, offset + maxBody) : bodyLines;
		const above = offset;
		const below = bodyLines.length - (offset + visibleBody.length);
		const aboveLabel = above > 0 ? `\u2191 ${above} more` : "";
		const belowLabel = below > 0 ? `\u2193 ${below} more` : "";
		const scrollPaint = chatboxPrimaryPaint(th);

		// Leading spacer separates the progress box cleanly from the preceding user bubble.
		const topLine = renderTopBorder(width, headerLeft, aboveLabel ? scrollPaint(aboveLabel) : "", headerRight, dim);
		const plainBot = renderBottomBorder(width, dim);
		const botLine = belowLabel ? paintScrollEdge(plainBot, "╰", "╯", belowLabel, width, dim, scrollPaint) : plainBot;
		const lines: string[] = ["", topLine, ...visibleBody, botLine];
		const botRow = lines.length - 1;

		const headerToggleSpans = buttonSpan(topLine, 1, toggleText, width - 1);
		const scrollUpSpans = aboveLabel ? buttonSpan(topLine, 1, aboveLabel, width - 1) : [];
		const scrollDownSpans = belowLabel ? buttonSpan(botLine, botRow, belowLabel, width - 1) : [];

		const visEndExclusive = offset + visibleBody.length;
		const hitPhases: HitPhaseRow[] = [];
		for (const p of logicalPhases) {
			if (p.bodyRow >= offset && p.bodyRow < visEndExclusive) {
				hitPhases.push({ row: 2 + (p.bodyRow - offset), phaseIndex: p.phaseIndex });
			}
		}
		const hitTools: HitToolRow[] = [];
		for (const t of logicalTools) {
			if (t.bodyRow >= offset && t.bodyRow < visEndExclusive) {
				const row = 2 + (t.bodyRow - offset);
				const renderedRow = visibleBody[t.bodyRow - offset]!;
				hitTools.push({ row, tool: t.tool, hintSpans: buttonSpan(renderedRow, row, t.hintLabel, width - 1) });
			}
		}
		const hitDetails: HitDetailRegion[] = [];
		for (const d of logicalDetails) {
			const visStart = Math.max(d.startBodyRow, offset);
			const visEnd = Math.min(d.endBodyRow, visEndExclusive - 1);
			if (visStart <= visEnd) {
				hitDetails.push({
					startRow: 2 + (visStart - offset),
					endRow: 2 + (visEnd - offset),
					rowOffset: d.rowOffset + (visStart - d.startBodyRow),
					indentCols: d.indentCols,
					width: d.width,
					tool: d.tool,
				});
			}
		}

		this.lastHitMap = {
			width,
			maxBody,
			headerToggleSpans,
			scrollUpSpans,
			scrollDownSpans,
			scrollOffset: offset,
			maxOffset,
			scrollStep: Math.max(1, Math.floor(maxBody / 2)),
			allExpanded,
			phases: hitPhases,
			tools: hitTools,
			details: hitDetails,
		};
		return lines;
	}

	private togglePhase(hit: RenderedHitMap, hitPhase: HitPhaseRow): boolean {
		const phase = buildPhases(this.items)[hitPhase.phaseIndex];
		if (!phase) return false;
		const nextExp = !this.isPhaseExpanded(phase, hitPhase.phaseIndex);
		const clickedBodyRow = hit.scrollOffset + (hitPhase.row - 2);
		if (nextExp && clickedBodyRow > hit.scrollOffset + Math.max(1, hit.maxBody - 3)) {
			this.state.scrollOffset = Math.max(hit.scrollOffset, clickedBodyRow - Math.max(1, hit.maxBody - 4));
		} else if (this.state.scrollOffset == null) {
			this.state.scrollOffset = hit.scrollOffset;
		}
		this.state.phaseOverrides.set(hitPhase.phaseIndex, nextExp);
		return true;
	}

	private toggleTool(hit: RenderedHitMap, hitTool: HitToolRow): void {
		const nextOpen = !this.isDetailOpen(hitTool.tool);
		const clickedBodyRow = hit.scrollOffset + (hitTool.row - 2);
		if (nextOpen && clickedBodyRow > hit.scrollOffset + Math.max(1, hit.maxBody - 5)) {
			this.state.scrollOffset = Math.max(hit.scrollOffset, clickedBodyRow - 1);
		} else if (this.state.scrollOffset == null) {
			this.state.scrollOffset = hit.scrollOffset;
		}
		this.setDetailOpen(hitTool.tool, nextOpen);
	}

	handleMouse(event: ProgressMouseEvent): unknown {
		// Swallow the release/drag/click tail of an action already performed on press,
		// independent of whether a re-render has painted yet or the pointer drifted by 1 cell.
		if (event.type === "press") {
			this.stopScrollHold();
			this.pressConsumed = false;
			this.suppressNextClick = false;
		} else if (this.pressConsumed) {
			if (event.type === "release") {
				this.stopScrollHold();
				this.pressConsumed = false;
				this.suppressNextClick = true;
				return { handled: true, render: false };
			}
			if (event.type === "drag") {
				return { handled: true, render: false };
			}
		} else if (this.suppressNextClick && event.type === "click") {
			this.suppressNextClick = false;
			return { handled: true, render: false };
		} else if (event.type === "release") {
			this.stopScrollHold();
		}

		if (!this.lastHitMap || (event.width > 0 && this.lastHitMap.width !== event.width)) {
			this.render(event.width);
		}
		const hit = this.lastHitMap;
		if (!hit) return undefined;

		// Forward any mouse event inside an open nested tool detail directly to the real ToolExecutionComponent.
		for (const region of hit.details) {
			if (
				event.y >= region.startRow &&
				event.y <= region.endRow &&
				event.x >= region.indentCols &&
				event.x < region.indentCols + region.width
			) {
				const wasOpen = this.isDetailOpen(region.tool);
				const localEvent = {
					...event,
					x: event.x - region.indentCols,
					y: event.y - region.startRow + region.rowOffset,
					width: region.width,
					height: region.endRow - region.startRow + 1 + region.rowOffset,
				};
				const res = forwardMouseEvent(region.tool, localEvent);
				// If clicking [hide] or the body inside the nested tool box collapsed it, keep box state in sync.
				if (wasOpen && !this.isDetailOpen(region.tool)) {
					this.state.detailOpen.set(region.tool, false);
					this.bumpAndRequestRender();
				} else if (res) {
					this.state.interactionVersion += 1;
				}
				return res;
			}
		}

		const onHeaderToggle = inSpans(hit.headerToggleSpans, event.y, event.x);
		const onScrollUp = inSpans(hit.scrollUpSpans, event.y, event.x);
		const onScrollDown = inSpans(hit.scrollDownSpans, event.y, event.x);
		const hitPhase = hit.phases.find((p) => p.row === event.y);
		const onPhaseChevron = Boolean(hitPhase && event.x >= 1 && event.x <= 6);
		const hitTool = hit.tools.find((t) => t.row === event.y);
		const onToolHint = hitTool ? inSpans(hitTool.hintSpans, event.y, event.x) : false;

		// Explicit controls ([expand all], [collapse all], ↑/↓ N more, [show], [hide], and
		// phase ▸/▾ chevron) act immediately on left press so 1-cell drift never drops the action.
		if ((onHeaderToggle || onScrollUp || onScrollDown || onToolHint || onPhaseChevron) && event.type === "press" && event.button === "left") {
			if (onScrollUp || onScrollDown) {
				const dir: -1 | 1 = onScrollUp ? -1 : 1;
				const next = Math.max(0, Math.min(hit.maxOffset, hit.scrollOffset + dir * Math.max(1, hit.scrollStep)));
				this.state.scrollOffset = next;
				this.pressConsumed = true;
				this.startScrollHold(dir);
				this.bumpAndRequestRender();
				return { handled: true, render: true };
			}
			if (onHeaderToggle) {
				const nextAll = !hit.allExpanded;
				this.state.phaseOverrides.clear();
				this.state.allOverride = nextAll;
				this.state.scrollOffset = nextAll ? 0 : null;
				if (!nextAll) {
					for (const item of this.items) {
						if (isToolComponent(item)) this.setDetailOpen(item, false);
					}
				}
			} else if (onToolHint && hitTool) {
				this.toggleTool(hit, hitTool);
			} else if (onPhaseChevron && hitPhase) {
				this.togglePhase(hit, hitPhase);
			}
			this.pressConsumed = true;
			this.bumpAndRequestRender();
			return { handled: true, render: true };
		}

		// Row body clicks act on single left click so drag-to-select still works for copying text.
		if (event.type === "click" && event.button === "left" && (event.clickCount ?? 1) === 1) {
			if (hitPhase && this.togglePhase(hit, hitPhase)) {
				this.bumpAndRequestRender();
				return { handled: true, render: true };
			}
			if (hitTool) {
				this.toggleTool(hit, hitTool);
				this.bumpAndRequestRender();
				return { handled: true, render: true };
			}
		}

		return undefined;
	}
}

// Persistent plain state across /reload (WeakMap keyed by the turn's first tool);
// component instances stay module-local so /reload always runs the freshly loaded class.
const PROGRESS_STATES_KEY = Symbol.for("pi-arnative.progressGroupStates");
const moduleBoxes = new WeakMap<object, TurnProgressBoxComponent>();

function getProgressStates(): WeakMap<object, TurnBoxState> {
	const g = globalThis as Record<symbol, WeakMap<object, TurnBoxState> | undefined>;
	let states = g[PROGRESS_STATES_KEY];
	if (!states) {
		states = new WeakMap();
		g[PROGRESS_STATES_KEY] = states;
	}
	return states;
}

function boxForAnchor(anchor: object): TurnProgressBoxComponent {
	let box = moduleBoxes.get(anchor);
	if (!box) {
		const states = getProgressStates();
		let state = states.get(anchor);
		if (!state) {
			state = {
				phaseOverrides: new Map(),
				detailOpen: new WeakMap(),
				interactionVersion: 0,
			};
			states.set(anchor, state);
		}
		box = new TurnProgressBoxComponent(state);
		moduleBoxes.set(anchor, box);
	}
	return box;
}

/** Synchronize all turn progress boxes with Pi's Ctrl+O (`setToolsExpanded`) shortcut. */
export function syncProgressBoxesExpanded(children: readonly unknown[], expanded: boolean): void {
	const states = getProgressStates();
	let changed = false;
	for (const child of children) {
		if (!child || typeof child !== "object") continue;
		const state = states.get(child);
		if (!state) continue;
		state.phaseOverrides.clear();
		state.detailOpen = new WeakMap();
		state.allOverride = expanded;
		state.scrollOffset = expanded ? 0 : null;
		state.interactionVersion += 1;
		changed = true;
	}
	if (changed) {
		for (const fn of layoutListeners) fn();
	}
}

/**
 * Project raw `chatContainer.children` into virtual render children:
 * contiguous runs of intermediate assistant messages + tool executions become one
 * `TurnProgressBoxComponent`, while user messages and final conclusion assistant messages
 * pass through unchanged.
 */
export function projectTranscriptChildren(
	children: readonly unknown[],
	requestRender?: () => void,
): unknown[] {
	if (activeToolLayout() !== "Grouped") return [...children];

	const out: unknown[] = [];
	let i = 0;

	while (i < children.length) {
		const child = children[i];
		if (!isIntermediateAssistant(child) && !isToolComponent(child)) {
			out.push(child);
			i += 1;
			continue;
		}

		// Collect contiguous run of intermediate assistants and tool executions.
		const run: (AssistantLike | ToolLike)[] = [];
		let firstVisibleTool: ToolLike | undefined;
		while (i < children.length) {
			const cur = children[i];
			if (isIntermediateAssistant(cur)) {
				run.push(cur);
				i += 1;
			} else if (isToolComponent(cur)) {
				run.push(cur);
				if (!cur.hideComponent && !firstVisibleTool) firstVisibleTool = cur;
				i += 1;
			} else {
				break;
			}
		}

		// A run with zero visible tools (e.g. tool call streaming hasn't created a component yet)
		// passes through untouched so nothing disappears.
		if (!firstVisibleTool) {
			for (const item of run) out.push(item);
			continue;
		}

		const box = boxForAnchor(firstVisibleTool);
		box.update(run, requestRender);
		out.push(box);
	}

	return out;
}

// Keep Ctrl+O (`setToolsExpanded`) synchronized with progress box accordion state.
if (InteractiveMode?.prototype) {
	const modeProto = InteractiveMode.prototype as unknown as Record<string, unknown>;
	if (typeof modeProto.setToolsExpanded === "function") {
		patchOnce(
			modeProto,
			"setToolsExpanded",
			(orig) =>
				function (this: { chatContainer?: { children?: unknown[] } }, expanded: boolean) {
					const res = orig.call(this, expanded);
					if (Array.isArray(this.chatContainer?.children)) {
						syncProgressBoxesExpanded(this.chatContainer.children, expanded);
					}
					return res;
				},
		);
	}
}

export const __test = {
	TEST_TOOL_MARKER,
	TEST_ASSISTANT_MARKER,
	PROGRESS_BOX_MARKER,
	EXPAND_ALL_LABEL,
	COLLAPSE_ALL_LABEL,
	SHOW_LABEL,
	HIDE_LABEL,
	extractNarration,
	countDiffStats,
	heuristicPhaseTitle,
};
