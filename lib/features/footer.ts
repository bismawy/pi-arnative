/**
 * Arnative footer (fixed 3-row grid). Row 1: cwd | active time | branch — model + thinking;
 * rows 2-3: extension status | tok/s · cache · token, each side wrapped in its half of the
 * width. The clock counts active time, not wall-clock age — see {@link ActiveClock}.
 * Preset (`/arnative footers`), live: "Pi (system)", "Pi (color)", "Arnative (Full)" (default),
 * "Arnative (Minimal)", or "Zen".
 */
import { isAbsolute, relative, resolve, sep as pathSep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, FooterComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { fgOr, setActiveTheme, softOf, softSecondaryOf, stripAnsi } from "../ansi.ts";
import { inSpans, textSpans, type TextSpan } from "../box.ts";
import { capitalize, modelDisplayParts } from "../format.ts";
import { SHORTCUT_RELOAD, SHORTCUT_TOGGLE_FOOTER } from "../shortcuts.ts";
import { markPatched, originalOf } from "../patch.ts";
import { estimateCost, formatTokens, loadPriceTable, TOOL_PROVIDER, type PriceTable } from "../usage-store.ts";
import { FOOTER_COST_KEY as FOOTER_COST_CONFIG_KEY, FOOTER_PRESET_KEY as FOOTER_PRESET_CONFIG_KEY, choiceSetting, flagSetting, loadSetting } from "../preset-store.ts";
import { formatCost } from "./usage.ts";
import { isByteLimitedModel, wireBytesSnapshot } from "./auto-compact.ts";
import { budgetLevelNow } from "./budget.ts";
import { activeSpinnerGradient, activeSpinnerPreset, applySpinnerPreset, setWorkingUi, spinnerPainter } from "../spinner.ts";
import { getRuntime } from "../runtime.ts";
import {
	ActiveClock,
	IDLE_PAUSE_MS,
	formatDuration,
	isPointerOrFocusInput,
	resolveSessionStartMs,
	seedActiveMs,
} from "../active-clock.ts";
import {
	branchFromDisk,
	collectGitInfo,
	formatDiffStat,
	gitParts,
	run,
	shortenCwd,
	sumNumstat,
	type GitInfo,
} from "../git-status.ts";
import {
	CHATBOX_DIALOG_KEY,
	CHATBOX_DIALOGS,
	CHATBOX_PRESET_KEY,
	CHATBOX_PRESETS,
	CHATBOX_PROMPT_KEY,
	CHATBOX_PROMPTS,
	DEFAULT_CHATBOX_DIALOG,
	DEFAULT_CHATBOX_PRESET,
	DEFAULT_CHATBOX_PROMPT,
	PROMPT_IDLE_MS,
	activeChatboxDialog,
	activeChatboxPreset,
	activeChatboxPrompt,
	applyChatboxDialog,
	bindChatboxPoke,
	boxEditorLines,
	chatboxPrimaryPaint,
	isPromptActive,
	isWideNerdPrompt,
	markPromptTyped,
	nextChatboxDialog,
	nextChatboxPrompt,
	overlayOutsideDialogOnWidgetLines,
	paintChatboxPrompt,
	renderChatboxLines,
	renderChatboxScrollBorder,
	setChatboxDialog,
	setChatboxPreset,
	setChatboxPrompt,
	stopPromptIdle,
	type ChatboxDialog,
	type ChatboxPreset,
	type ChatboxPrompt,
} from "../chatbox.ts";

export {
	ActiveClock,
	CHATBOX_DIALOGS,
	CHATBOX_PRESETS,
	CHATBOX_PROMPTS,
	DEFAULT_CHATBOX_DIALOG,
	DEFAULT_CHATBOX_PRESET,
	DEFAULT_CHATBOX_PROMPT,
	IDLE_PAUSE_MS,
	PROMPT_IDLE_MS,
	activeChatboxDialog,
	activeChatboxPreset,
	activeChatboxPrompt,
	applyChatboxDialog,
	boxEditorLines,
	chatboxPrimaryPaint,
	formatDiffStat,
	formatDuration,
	gitParts,
	isPointerOrFocusInput,
	isPromptActive,
	isWideNerdPrompt,
	markPromptTyped,
	nextChatboxDialog,
	nextChatboxPrompt,
	overlayOutsideDialogOnWidgetLines,
	paintChatboxPrompt,
	renderChatboxLines,
	renderChatboxScrollBorder,
	resolveSessionStartMs,
	seedActiveMs,
	setChatboxDialog,
	setChatboxPreset,
	setChatboxPrompt,
	shortenCwd,
	stopPromptIdle,
	sumNumstat,
	type ChatboxDialog,
	type ChatboxPreset,
	type ChatboxPrompt,
};

// Footer preset chosen through `/arnative footers`. "Arnative (Full)" = this extension's
// 3-row grid footer; "Pi (system)" = pi's built-in footer (the boxed editor stays arnative
// in both — pi's `setEditorComponent()` would close the picker mid-preview).
// Listed built-in-first: the `(Full)` suffix is rendered dim, so the plain row reads cleaner on top.
export const FOOTER_PRESETS = ["Pi (system)", "Pi (color)", "Arnative (Full)", "Arnative (Minimal)", "Zen"] as const;
export type FooterPreset = (typeof FOOTER_PRESETS)[number];
export const DEFAULT_FOOTER_PRESET: FooterPreset = "Arnative (Full)";
/** Presets that this extension's registrar draws (everything but pi's built-in footer). */
const ARNATIVE_PRESETS: readonly FooterPreset[] = ["Pi (color)", "Arnative (Full)", "Arnative (Minimal)", "Zen"];
/** Collapse state of the minimal footer: one flag per side, so a click on the left
 *  head does not open the right metrics. Session-scoped, not persisted. */
export function minimalExpanded(): { left: boolean; right: boolean } {
	const rt = getRuntime();
	rt.minimalFooterExpanded ??= { left: false, right: false };
	return rt.minimalFooterExpanded;
}
/** Collapse state of the Zen footer: `git` toggles inline git expansion after `···`,
 *  and `detail` opens one centered second row at a time (`left` statuses or `right` metrics). */
export function zenExpanded(): { git: boolean; detail: "left" | "right" | null } {
	const rt = getRuntime();
	rt.zenFooterExpanded ??= { git: false, detail: null };
	return rt.zenFooterExpanded;
}
const footerPreset = choiceSetting(FOOTER_PRESET_CONFIG_KEY, FOOTER_PRESETS, DEFAULT_FOOTER_PRESET);
const FOOTER_PRESET_KEY = footerPreset.slot;
const footerCost = flagSetting(FOOTER_COST_CONFIG_KEY);

/** Is the session cost cell on? */
export const activeFooterCost = (): boolean => footerCost.get();

/** Flip the cost cell, persist it, and repaint the footer at once. */
export function setFooterCost(on: boolean): void {
	footerCost.set(on);
	poke();
}

export const activeFooterPreset = (): FooterPreset => {
	const raw = (globalThis as Record<symbol, unknown>)[FOOTER_PRESET_KEY] ?? loadSetting(FOOTER_PRESET_CONFIG_KEY);
	if (raw === "Argon" || raw === "Arnative (Zen)") return "Zen";
	return footerPreset.get();
};

/**
 * Hand the footer slot to the active preset: arnative's grid, or pi's built-in footer.
 * The editor is deliberately never touched here — pi's `setEditorComponent()` calls
 * `disposeActiveSelector()`, which would close the `/arnative` picker mid-preview.
 */
function applyFooterPreset(ctx: ExtensionContext): void {
	if (activeFooterPreset() === "Pi (system)") {
		ctx.ui?.setFooter?.(undefined);
		return;
	}
	const register = getRuntime().footerRegistrar;
	register?.(ctx);
}
/** Select a preset and apply it immediately (the footer swaps on the spot). */
export function setFooterPreset(name: FooterPreset, ctx: ExtensionContext): void {
	footerPreset.set(name);
	applyFooterPreset(ctx);
}

interface FooterComponentProto {
	render(width: number): string[];
}

interface WorkingUiSurface {
	setWorkingMessage?: (message?: string) => void;
	setWorkingIndicator?: (options?: unknown) => void;
}

interface WorkingIndicatorLike {
	renderIndicatorVerbatim?: boolean;
	spinnerColorFn?: (text: string) => string;
	messageColorFn?: (text: string) => string;
	updateDisplay?: () => void;
	renderInBorder?(width: number): string;
	renderSpinnerInBorder?(width: number): string;
}

interface OutsideDialogModeLike {
	editor?: unknown;
	editorContainer?: { children?: unknown[] };
}

// Intercept the built-in FooterComponent to force a pure 2-line footer.
// Reinstalled on every load (lib/patch.ts): `/reload` must pick up a footer change.
if (FooterComponent?.prototype?.render) {
	const proto = FooterComponent.prototype as unknown as FooterComponentProto;
	const origRender = originalOf<(this: FooterComponentProto, width: number) => string[]>(proto, "render");
	proto.render = markPatched(function (this: FooterComponentProto, width: number): string[] {
		// "Pi (system)" preset = pi's own footer, so keep its stock line count.
		if (activeFooterPreset() === "Pi (system)") return origRender.call(this, width);
		const lines = origRender.call(this, width);
		return lines.length > 2 ? lines.slice(0, 2) : lines;
	});
}

let activeThemeProxy: { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null = null;

/** Painters for the footer's current theme, rebuilt only when pi hands over a new theme. */
let themeCache: {
	theme: unknown;
	acc: (t: string) => string;
	dim: (t: string) => string;
	soft: (t: string) => string;
	colorOr: (name: string, fallback: (t: string) => string) => (t: string) => string;
	primary: (t: string) => string;
	secondarySoft: (t: string) => string;
	diffAdd: (t: string) => string;
	diffDel: (t: string) => string;
	sep: string;
} | null = null;
/** The cwd cell and git segment, rebuilt only when theme, cwd, or collected git info changes. */
let gitCache: { theme: unknown; git: GitInfo; cwd: string; cwdCell: string; gitItems: string[]; gitSeg: string } | null = null;

let gitRefreshInFlight = false;
let git: GitInfo = null;
let currentThinkingLevel: string | undefined = undefined;
let currentModel: { id: string; name?: string; provider?: string } | undefined = undefined;
let rerender: (() => void) | null = null;
let lastPokeMs = 0;
/** Column ranges of the minimal footer's head cells and disclosure arrows, recorded per render
 *  (mouse coordinates are component-local, so they must come from the same frame). */
interface MinimalSpan {
	y: number;
	x0: number;
	x1: number;
}
let minimalRanges: {
	left: MinimalSpan[];
	right: MinimalSpan[];
	leftArrow: MinimalSpan | null;
	rightArrow: MinimalSpan | null;
} | null = null;
let zenRanges: {
	left: MinimalSpan[];
	right: MinimalSpan[];
	dots: MinimalSpan | null;
} | null = null;

// One shared clock: a /reload re-imports this module, so a fresh instance would restart
// a session that is already hours old. Exported so a test can drive the render path.
export let clock = new ActiveClock(Date.now());

let footerGen = getRuntime().footerGen || 0;

let assistantStartMs: number | null = null;
let assistantChars = 0;
let latestSpeed: number | null = null;

// Live elapsed clock for the working loader: "⠴ Working (50s)".
const WORK_LABEL = "Working";
let workVerb = WORK_LABEL;
let workStartMs: number | null = null;
let workUI: { setWorkingMessage?: (message?: string) => void; setWorkingIndicator?: (options?: unknown) => void } | null =
	null;
// Verbs of tools still running (toolCallId -> verb): the label must not reset to "Working"
// while a sibling tool is still going (pi executes tools in parallel).
const activeToolVerbs = new Map<string, string>();

/** Label while `active` tools remain: last started wins, empty -> default. */
export function currentToolVerb(active: ReadonlyMap<string, string>): string {
	let verb = WORK_LABEL;
	for (const v of active.values()) verb = v;
	return verb;
}

/**
 * Is this status value pi-jev-eye's own cell? It is matched on the LABEL the value carries (`Eye:`), not on
 * the internal key name: the value is `Eye: ● ON (Clef Flash)` and contains no `jev-eye` anywhere, so the
 * old `value.includes("jev-eye")` test went false and the whole cell fell through to the generic path —
 * which is exactly how it silently lost its icon and its dim backend suffix.
 *
 * Recognising the label keeps the rule honest: if pi-jev-eye renames its label, this test fails loudly in
 * the self-check below instead of degrading to a plain grey cell.
 */
export const isJevEyeStatus = (status: string): boolean => /^(?:(?:\uf21b|\ueb1b|\u{1F440})\s*)?Eye\s*:/iu.test(stripAnsi(status));

/**
 * The pi-jev-eye / pi-decision-eye status cell: `[icon] Eye: ● MODE (Backend)`.
 *
 * The trailing parenthesised backend is a modifier, so it takes `dim` while the `Eye:` label and the state
 * keep the soft and state tiers — that is what makes `(Clef Flash)` / `(mercury-decide)` recede and
 * `Eye: ● ON` / `Eye: ● BALANCED` stay readable at a glance. The backend name itself is read out of the value,
 * never hardcoded here.
 */
export function jevEyeStatusLine(
	status: string,
	acc: (text: string) => string,
	dim: (text: string) => string,
	soft: (text: string) => string,
	theme?: { fg?: (color: string, text: string) => string },
): string {
	const clean = stripAnsi(status).replace(/^(?:\uf21b|\ueb1b|\u{1F440})\s*/u, "");
	const isOff = /\bOFF\b/i.test(clean) || clean.includes("\u25CB");
	const isReview = /\bREVIEW\b/i.test(clean);
	const isStrict = /\bSTRICT\b/i.test(clean);
	const isLight = /\bLIGHT\b/i.test(clean);
	const isBalanced = /\bBALANCED\b/i.test(clean);
	const fgToken = (token: string, fallback: (t: string) => string) => {
		if (typeof theme?.fg !== "function") return fallback("\u25CF");
		try {
			return theme.fg(token, "\u25CF");
		} catch {
			return fallback("\u25CF");
		}
	};
	let bullet = isOff ? dim("\u25CB") : acc("\u25CF");
	if (isReview) bullet = fgToken("warning", acc);
	else if (isStrict) bullet = fgToken("mdHeading", acc);
	else if (isLight) bullet = fgToken("borderAccent", acc);
	const label = isOff
		? "OFF"
		: isReview
			? "REVIEW"
			: isStrict
				? "STRICT"
				: isLight
					? "LIGHT"
					: isBalanced
						? "BALANCED"
						: "ON";
	// `Eye: ● ON (Clef Flash)` -> the base before the first colon, the backend in the trailing parentheses.
	const base = clean.split(":")[0]!.trim() || "Eye";
	const at = clean.lastIndexOf("(");
	const backend = at >= 0 && clean.trimEnd().endsWith(")") ? clean.slice(at, clean.lastIndexOf(")") + 1).trim() : "";
	// One space, not the two the previous glyph needed: \uf21b's ink fits its own cell, so the label sits
	// right after it. The space before the backend stays outside the dim run, so the modifier does not
	// start with a painted blank.
	return `${acc("\uf21b")} ${soft(`${base}:`)} ${bullet} ${soft(label)}${backend ? ` ${dim(backend)}` : ""}`;
}

/**
 * The ponytail status cell. The horse lives at U+EF04 (fa-horse). U+EF51
 * (fa-circle_radiation) carries no outline in the Windows Nerd Font build, so it
 * renders as a blank cell there and the status silently loses its icon; U+EF04 does
 * draw. Kept out of the render closure so the self-check drives this exact path.
 */
export function ponytailStatusLine(
	status: string,
	acc: (text: string) => string,
	dim: (text: string) => string,
	soft: (text: string) => string,
): string {
	const bullet = status.includes("\u25CF") ? acc("\u25CF") : dim("\u25CB");
	let mode = "FULL";
	if (/LITE/i.test(status)) mode = "LITE";
	else if (/ULTRA/i.test(status)) mode = "ULTRA";
	return `${acc("\uef04")} ${soft("ponytail:")} ${bullet} ${soft(mode)}`;
}

// A refresh arriving while one is in flight is queued (last requested cwd wins) and
// re-run afterwards — it used to be dropped, leaving the footer's git state stale
// until the next trigger.
let gitRefreshQueuedCwd: string | null = null;
let lastGitRefreshMs = 0;
/** Tool bursts (a turn with ten edits) would otherwise run two git processes per tool;
 *  coalesce them into one refresh per window, with a trailing run so the final state lands. */
const GIT_REFRESH_MIN_INTERVAL_MS = 500;
let gitRefreshTrailing: ReturnType<typeof setTimeout> | null = null;

async function refreshGit(cwd: string, opts: { force?: boolean } = {}): Promise<void> {
	if (!opts.force) {
		const since = Date.now() - lastGitRefreshMs;
		if (since < GIT_REFRESH_MIN_INTERVAL_MS) {
			if (gitRefreshTrailing) clearTimeout(gitRefreshTrailing);
			gitRefreshTrailing = setTimeout(() => {
				gitRefreshTrailing = null;
				void refreshGit(cwd, { force: true }).then(() => poke());
			}, GIT_REFRESH_MIN_INTERVAL_MS - since);
			gitRefreshTrailing.unref?.();
			return;
		}
	}
	if (gitRefreshInFlight) {
		gitRefreshQueuedCwd = cwd;
		return;
	}
	lastGitRefreshMs = Date.now();
	gitRefreshInFlight = true;
	try {
		git = await collectGitInfo(cwd);
		getRuntime().lastGit = git;
	} finally {
		gitRefreshInFlight = false;
		if (gitRefreshQueuedCwd !== null) {
			const queued = gitRefreshQueuedCwd;
			gitRefreshQueuedCwd = null;
			void refreshGit(queued, { force: true }).then(() => poke());
		}
	}
}

/**
 * Head row for the minimal footer, plus the exact click zones (0-based, inclusive
 * columns) of its two heads. Placing the row here instead of guessing at `pairRow`'s
 * arithmetic is deliberate: `pairRow` truncates with an ellipsis, which shifts columns,
 * and a mirror of that logic silently drifts at narrow widths — the bug where a click on
 * blank space toggled a side. Measuring the placed cells cannot drift. The blank gap and
 * any padding stay inert; a head the row cannot fit gets `[-1, -1]`.
 */
export function placeMinimalHead(
	left: string,
	right: string,
	width: number,
): {
	row: string;
	left: [number, number];
	right: [number, number];
	leftTruncated: boolean;
	rightTruncated: boolean;
} {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + 1 + rw <= width) {
		const rightStart = width - rw;
		return {
			row: left + " ".repeat(rightStart - lw) + right,
			left: lw > 0 ? [0, lw - 1] : [-1, -1],
			right: rw > 0 ? [rightStart, width - 1] : [-1, -1],
			leftTruncated: false,
			rightTruncated: false,
		};
	}
	// Too wide: the left head is cut, the right one keeps its edge column like pairRow.
	const room = Math.max(1, width - Math.min(rw, width) - 1);
	const lCut = truncateToWidth(left, room);
	const rCut = truncateToWidth(right, width - room - 1);
	const lCutW = visibleWidth(lCut);
	const rCutW = visibleWidth(rCut);
	const rightStart = lCutW + 1;
	return {
		row: lCut + " " + rCut,
		left: lCutW > 0 ? [0, lCutW - 1] : [-1, -1],
		right: rCutW > 0 ? [rightStart, rightStart + rCutW - 1] : [-1, -1],
		leftTruncated: lCut !== left,
		rightTruncated: rCut !== right,
	};
}

function centerLine(text: string, width: number): { line: string; pad: number; textW: number } {
	const textW = visibleWidth(text);
	const pad = Math.max(0, Math.floor((width - textW) / 2));
	return { line: pad > 0 ? " ".repeat(pad) + text : text, pad, textW };
}

/**
 * Centered head row(s) for the Zen footer, plus exact 0-based inclusive hit zones for
 * `left` (cwd + clock), `right` (model), and `dots` (`···` git toggle). Measured directly
 * from the placed strings so click zones never drift across widths or narrow wraps.
 */
export function placeZenHead(
	left: string,
	right: string,
	sep: string,
	dots: string,
	gitText: string,
	width: number,
): {
	rows: string[];
	left: MinimalSpan[];
	right: MinimalSpan[];
	dots: MinimalSpan | null;
} {
	const w = Math.max(1, width);
	const leftW = visibleWidth(left);
	const sepW = visibleWidth(sep);
	const rightW = visibleWidth(right);
	const dotsW = dots ? visibleWidth(dots) : 0;
	const gitW = gitText ? visibleWidth(gitText) : 0;
	const base = `${left}${sep}${right}${dotsW > 0 ? ` ${dots}` : ""}`;
	const baseW = leftW + sepW + rightW + (dotsW > 0 ? 1 + dotsW : 0);
	const fullW = baseW + (gitW > 0 ? 1 + gitW : 0);

	if (fullW <= w) {
		const rowText = gitW > 0 ? `${base} ${gitText}` : base;
		const pad = Math.max(0, Math.floor((w - fullW) / 2));
		const rightStart = pad + leftW + sepW;
		const dotsStart = rightStart + rightW + 1;
		return {
			rows: [pad > 0 ? " ".repeat(pad) + rowText : rowText],
			left: leftW > 0 ? [{ y: 0, x0: pad, x1: pad + leftW - 1 }] : [],
			right: rightW > 0 ? [{ y: 0, x0: rightStart, x1: rightStart + rightW - 1 }] : [],
			dots: dotsW > 0 ? { y: 0, x0: dotsStart, x1: dotsStart + dotsW - 1 } : null,
		};
	}

	if (baseW <= w && gitW > 0) {
		const pad = Math.max(0, Math.floor((w - baseW) / 2));
		const rightStart = pad + leftW + sepW;
		const dotsStart = rightStart + rightW + 1;
		const gitRows = wrapTextWithAnsi(gitText, w).map((l) => centerLine(l, w).line);
		return {
			rows: [pad > 0 ? " ".repeat(pad) + base : base, ...gitRows],
			left: leftW > 0 ? [{ y: 0, x0: pad, x1: pad + leftW - 1 }] : [],
			right: rightW > 0 ? [{ y: 0, x0: rightStart, x1: rightStart + rightW - 1 }] : [],
			dots: dotsW > 0 ? { y: 0, x0: dotsStart, x1: dotsStart + dotsW - 1 } : null,
		};
	}

	// Narrow viewport: wrap each head centered so nothing clips and zones stay exact.
	const rows: string[] = [];
	const leftSpans: MinimalSpan[] = [];
	for (const seg of wrapTextWithAnsi(left, w)) {
		const { line, pad, textW } = centerLine(seg, w);
		if (textW > 0) leftSpans.push({ y: rows.length, x0: pad, x1: pad + textW - 1 });
		rows.push(line);
	}
	const rightSpans: MinimalSpan[] = [];
	let dotsSpan: MinimalSpan | null = null;
	const rightWrapped = wrapTextWithAnsi(dotsW > 0 ? `${right} ${dots}` : right, w);
	for (let i = 0; i < rightWrapped.length; i++) {
		const { line, pad, textW } = centerLine(rightWrapped[i]!, w);
		const y = rows.length;
		const isLast = i === rightWrapped.length - 1;
		if (isLast && dotsW > 0 && textW >= dotsW) {
			const dotsStart = pad + textW - dotsW;
			dotsSpan = { y, x0: dotsStart, x1: pad + textW - 1 };
			// Exclude the trailing ` ···` from the right-text zone so clicks on `···` stay distinct.
			const rightEnd = dotsStart - 2;
			if (rightEnd >= pad) rightSpans.push({ y, x0: pad, x1: rightEnd });
		} else if (textW > 0) {
			rightSpans.push({ y, x0: pad, x1: pad + textW - 1 });
		}
		rows.push(line);
	}
	if (gitW > 0) {
		for (const seg of wrapTextWithAnsi(gitText, w)) rows.push(centerLine(seg, w).line);
	}
	return { rows, left: leftSpans, right: rightSpans, dots: dotsSpan };
}

function formatModelName(
	model: { id: string; name?: string; provider?: string } | undefined,
	thinkingLevel: string | undefined,
	acc: (t: string) => string,
	soft: (t: string) => string,
	primary: (t: string) => string,
	dim: (t: string) => string,
): string {
	if (!model) return dim("No Model");
	const { name, provider } = modelDisplayParts({ id: model.id, name: model.name, provider: model.provider });
	const provStr = provider ? ` ${dim(`(${provider})`)}` : "";
	const capThinking = thinkingLevel && thinkingLevel !== "off" ? capitalize(thinkingLevel) : "";
	const thinkStr = capThinking ? `${acc("\uee9c")} ${soft(capThinking)} ${dim("·")} ` : "";
	return `${thinkStr}${primary(name)}${provStr}`;
}

/** Format `cwd` the same way Pi's built-in footer does (replace home prefix with `~`). */
export function formatPiCwd(cwd: string, home: string | undefined = process.env.HOME || process.env.USERPROFILE): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${pathSep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${pathSep}${rel}`;
}

export interface PiColorStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

export interface PiColorPainters {
	acc: (t: string) => string;
	dim: (t: string) => string;
	primary: (t: string) => string;
	secondarySoft: (t: string) => string;
	warning: (t: string) => string;
	error: (t: string) => string;
}

/** Format token counts identically to Pi's built-in FooterComponent. */
export function formatPiTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export interface PiColorFooterInput {
	cwd: string;
	home?: string;
	branch: string | null;
	sessionName?: string;
	stats: PiColorStats;
	usingSubscription?: boolean;
	budgetBand?: "ok" | "warn" | "over";
	contextPercent: number | null;
	contextWindow: number;
	autoCompactEnabled?: boolean;
	experimental?: boolean;
	model?: { id: string; provider?: string; reasoning?: boolean };
	thinkingLevel?: string;
	availableProviderCount: number;
	extensionStatuses: ReadonlyMap<string, string>;
	width: number;
	painters: PiColorPainters;
}

let piStatsCache: {
	manager: unknown;
	sessionId: string | undefined;
	entryCount: number;
	leafId: string | null | undefined;
	stats: PiColorStats;
} | null = null;

function collectPiSessionStats(sessionManager: {
	getEntries(): readonly unknown[];
	getLeafId?: () => string | null;
	getSessionId?: () => string;
}): PiColorStats {
	const entries = sessionManager.getEntries();
	const entryCount = entries.length;
	const leafId = sessionManager.getLeafId?.();
	const sessionId = sessionManager.getSessionId?.();
	if (
		piStatsCache &&
		piStatsCache.manager === sessionManager &&
		piStatsCache.sessionId === sessionId &&
		piStatsCache.entryCount === entryCount &&
		piStatsCache.leafId === leafId
	) {
		return piStatsCache.stats;
	}
	const stats: PiColorStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined };
	const addUsage = (u: MessageUsage | undefined) => {
		if (!u) return;
		stats.input += u.input || 0;
		stats.output += u.output || 0;
		stats.cacheRead += u.cacheRead || 0;
		stats.cacheWrite += u.cacheWrite || 0;
		stats.cost += u.cost?.total || 0;
	};
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || !("type" in entry)) continue;
		const e = entry as {
			type?: string;
			usage?: MessageUsage;
			message?: { role?: string; usage?: MessageUsage };
		};
		if (e.type === "usage") {
			addUsage(e.usage);
		} else if (e.type === "message" && e.message?.role === "assistant") {
			addUsage(e.message.usage);
			const u = e.message.usage;
			if (u) {
				const prompt = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
				stats.latestCacheHitRate = prompt > 0 ? ((u.cacheRead || 0) / prompt) * 100 : undefined;
			}
		} else if (e.type === "message" && e.message?.role === "toolResult" && e.message.usage) {
			addUsage(e.message.usage);
		} else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
			addUsage(e.usage);
		}
	}
	piStatsCache = { manager: sessionManager, sessionId, entryCount, leafId, stats };
	return stats;
}

function sanitizePiStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * Pi's built-in footer layout (row 1: pwd/branch/session, row 2: token stats + model/thinking,
 * row 3: extension statuses) colored with Arnative's two-toned accent + secondarySoft palette.
 */
export function renderPiColorFooter(input: PiColorFooterInput): string[] {
	const { acc, dim, primary, secondarySoft, warning, error } = input.painters;
	const width = Math.max(1, input.width);

	// Row 1: pwd (branch) • sessionName
	let pwdLine = dim(formatPiCwd(input.cwd, input.home));
	if (input.branch) {
		pwdLine += ` ${acc(`(${input.branch})`)}`;
	}
	if (input.sessionName) {
		pwdLine += `${dim(" \u2022 ")}${secondarySoft(input.sessionName)}`;
	}
	pwdLine = truncateToWidth(pwdLine, width, dim("..."));

	// Row 2 left: ↑in ↓out Rread Wwrite CHrate% $cost pct%/win (auto)
	const { stats } = input;
	const statsParts: string[] = [];
	if (stats.input) statsParts.push(`${acc("\u2191")}${secondarySoft(formatPiTokens(stats.input))}`);
	if (stats.output) statsParts.push(`${acc("\u2193")}${secondarySoft(formatPiTokens(stats.output))}`);
	if (stats.cacheRead) statsParts.push(`${acc("R")}${secondarySoft(formatPiTokens(stats.cacheRead))}`);
	if (stats.cacheWrite) statsParts.push(`${acc("W")}${secondarySoft(formatPiTokens(stats.cacheWrite))}`);
	if ((stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.latestCacheHitRate !== undefined) {
		const chPaint = stats.latestCacheHitRate < 40 ? error : stats.latestCacheHitRate < 70 ? warning : null;
		statsParts.push(`${(chPaint ?? acc)("CH")}${(chPaint ?? secondarySoft)(`${stats.latestCacheHitRate.toFixed(1)}%`)}`);
	}
	if (stats.cost || input.usingSubscription) {
		const costPaint = input.budgetBand === "over" ? error : input.budgetBand === "warn" ? warning : null;
		const sub = input.usingSubscription ? dim(" (sub)") : "";
		statsParts.push(`${(costPaint ?? acc)("$")}${(costPaint ?? secondarySoft)(stats.cost.toFixed(3))}${sub}`);
	}

	const autoIndicator = input.autoCompactEnabled ? " (auto)" : "";
	const winStr = formatPiTokens(input.contextWindow);
	const pctValue = input.contextPercent ?? 0;
	const pctStr = input.contextPercent !== null ? `${pctValue.toFixed(1)}%` : "?";
	if (pctValue > 90) {
		statsParts.push(`${error(`${pctStr}/${winStr}`)}${dim(autoIndicator)}`);
	} else if (pctValue > 70) {
		statsParts.push(`${warning(`${pctStr}/${winStr}`)}${dim(autoIndicator)}`);
	} else {
		statsParts.push(`${secondarySoft(pctStr)}${dim(`/${winStr}${autoIndicator}`)}`);
	}
	if (input.experimental) {
		statsParts.push(`${dim("\u2022")} ${warning("xp")}`);
	}

	let statsLeft = statsParts.join(" ");
	let statsLeftWidth = visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		statsLeft = truncateToWidth(statsLeft, width, dim("..."));
		statsLeftWidth = visibleWidth(statsLeft);
	}

	// Row 2 right: (provider) model.id • thinkingLevel
	const minPadding = 2;
	let rightWithoutProvider = input.model ? primary(input.model.id) : dim("no-model");
	if (input.model?.reasoning) {
		const level = input.thinkingLevel || "off";
		rightWithoutProvider += level === "off"
			? dim(" \u2022 thinking off")
			: `${dim(" \u2022 ")}${acc(level)}`;
	}
	let rightSide = rightWithoutProvider;
	if (input.availableProviderCount > 1 && input.model?.provider) {
		const withProvider = `${dim(`(${input.model.provider}) `)}${rightWithoutProvider}`;
		if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) {
			rightSide = withProvider;
		}
	}

	const rightSideWidth = visibleWidth(rightSide);
	let statsLine: string;
	if (statsLeftWidth + minPadding + rightSideWidth <= width) {
		statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
	} else {
		const availableForRight = width - statsLeftWidth - minPadding;
		if (availableForRight > 0) {
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			const truncatedRightWidth = visibleWidth(truncatedRight);
			statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth)) + truncatedRight;
		} else {
			statsLine = statsLeft;
		}
	}

	const lines = [pwdLine, statsLine];
	if (input.extensionStatuses.size > 0) {
		const sorted = Array.from(input.extensionStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => {
				const clean = sanitizePiStatus(text);
				return clean.includes("\x1b[") ? clean : secondarySoft(clean);
			});
		lines.push(truncateToWidth(sorted.join(" "), width, dim("...")));
	}
	return lines;
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
	const headLeftW = headLeft ? vw(headLeft) : 0;
	const headRightW = headRight ? vw(headRight) : 0;
	// Narrow / mobile viewport: when the two head cells cannot share one row,
	// stack left layout (head + statuses, auto-wrapped) above right layout (head + metrics, auto-wrapped).
	if (headLeft && headRight && headLeftW + 1 + headRightW > width) {
		const w = Math.max(1, width);
		const out: string[] = [...wrapTextWithAnsi(headLeft, w)];
		if (left.length > 0) out.push(...wrapTextWithAnsi(left.join(leftSep), w));
		out.push(...wrapTextWithAnsi(headRight, w));
		if (right.length > 0) out.push(...wrapTextWithAnsi(right.join(rightSep), w));
		return out;
	}
	const half = Math.max(1, Math.floor(width / 2) - 1);
	// Every cell's width is measured once up front: visibleWidth parses ANSI and
	// clusters graphemes, and wrap()/pairRow() used to re-measure the same cell 3x.
	const leftW = left.map(vw);
	const rightW = right.map(vw);
	const sepWL = vw(leftSep);
	const sepWR = vw(rightSep);
	// Wrap each side at half width; the first break happens at most once (rows 2-3),
	// after that the rest stays on the last row and the pairing truncates it.
	const wrap = (cells: readonly string[], widths: readonly number[], sep: string, sepW: number): { text: string; width: number }[] => {
		const rows: { text: string; width: number }[] = [];
		let line = "";
		let lineW = 0;
		for (let i = 0; i < cells.length; i++) {
			const cell = cells[i]!;
			const cellW = widths[i]!;
			if (line && rows.length === 0 && lineW + sepW + cellW > half) {
				rows.push({ text: line, width: lineW });
				line = cell;
				lineW = cellW;
			} else if (line) {
				line += sep + cell;
				lineW += sepW + cellW;
			} else {
				line = cell;
				lineW = cellW;
			}
		}
		if (line) rows.push({ text: line, width: lineW });
		return rows;
	};
	const leftRows = wrap(left, leftW, leftSep, sepWL);
	const rightRows = wrap(right, rightW, rightSep, sepWR);
	const out = [pairRow(headLeft, headRight, width, vw, headLeftW, headRightW)];
	for (let i = 0; i < Math.max(leftRows.length, rightRows.length); i++) {
		const l = leftRows[i];
		const r = rightRows[i];
		if (l === undefined && r === undefined) break;
		out.push(pairRow(l?.text ?? "", r?.text ?? "", width, vw, l?.width ?? 0, r?.width ?? 0));
	}
	return out;
}

/** One grid row: `left` at the start, `right` flush to the right edge. `leftW`/`rightW`
 *  are the caller's measured widths when it already has them, so the row costs no extra pass. */
function pairRow(left: string, right: string, width: number, vw: (s: string) => number, leftW?: number, rightW?: number): string {
	const lw = leftW ?? vw(left);
	if (!right) return lw <= width ? left : truncateToWidth(left, width);
	const rawRw = rightW ?? vw(right);
	const rw = Math.min(rawRw, width);
	if (!left) return " ".repeat(width - rw) + (rawRw <= width ? right : truncateToWidth(right, width));
	if (lw + 1 + rw <= width) {
		return left + " ".repeat(width - lw - rw) + (rawRw <= width ? right : truncateToWidth(right, width));
	}
	// Too wide together: the right cell keeps its columns, the left one is cut.
	const room = Math.max(1, width - rw - 1);
	const lCut = lw <= room ? left : truncateToWidth(left, room);
	const rRoom = width - room - 1;
	const rCut = rawRw <= rRoom ? right : truncateToWidth(right, rRoom);
	return lCut + " " + rCut;
}

function parseOptimizer(raw: string | undefined): string | null {

	if (!raw) return null;
	const m = raw.match(/([A-Za-z0-9_-]+)\s+cache\s+(\d+\/\d+)·[^\s]+\s+([\d.]+%)/);
	return m ? `${m[1]} ${m[2]} (${m[3]})` : null;
}

// Pi's own per-message usage: shown when pi-cache-optimizer has no adapter for the
// provider (a custom one like mytool.ts publishes no pi-cache-stats status).
// The denominator (`input + cacheRead`) includes tool-result (child) tokens, because the ↑
// cell above is total spend — the hit rate is measured against the same total, so do not
// "fix" the denominator back to assistant messages only.
let usageTotals = { inp: 0, read: 0 };
export function piCacheHit(): string | null {
	const total = usageTotals.inp + usageTotals.read;
	return total > 0 ? "pi " + ((usageTotals.read / total) * 100).toFixed(1) + "%" : null;
}

// The cache cell's COLOUR comes from a recent window, not the session-wide rate above: the
// last CACHE_WINDOW_MSGS assistant messages, with the session's first two always skipped
// (turn 1 is a cold cache, so colouring it would cry wolf on every session). The `pi …%`
// text stays session-wide; only the colour is windowed.
export const CACHE_WINDOW_MSGS = 10;
/** Windowed (input, cacheRead) sums of the last scan — read by the render for the colour. */
let usageWindow = { inp: 0, read: 0 };

export type CacheHitBand = "soft" | "warning" | "error";
/** Colour band of a windowed cache-hit rate: ≥70% keeps the current soft tier, 40–70% is
 *  amber (the theme's `warning` slot), below 40% is red (`error`). No rate yet (fewer than
 *  3 assistant messages, so an empty window) stays soft. */
export function cacheHitBand(winInp: number, winRead: number): CacheHitBand {
	const total = winInp + winRead;
	if (total <= 0) return "soft";
	const rate = winRead / total;
	if (rate >= 0.7) return "soft";
	if (rate >= 0.4) return "warning";
	return "error";
}

let usageScanAt = 0;
let usageScanLen = -1;
interface UsageTotals {
	inp: number;
	out: number;
	read: number;
	/** Sum of `cost.total` over the messages the provider billed (`totalFromProvider`). */
	costBilled: number;
	/** Everything else: catalog totals, plus a price-table reconstruction for messages that
	 *  carried no cost at all. Never blended into `costBilled`. */
	costEstimated: number;
	/** Only set on the branch-last snapshot (`lastUsageOf`): that entry is an assistant message. */
	assistant?: boolean;
}

let usageScanManager: object | undefined;
let usageScanLeaf: unknown;
// A stream mutates the same leaf, so its delta updates the cached prefix. A different
// manager or leaf must rescan: equal-length /tree branches can have different usage.

let usageScanNums: UsageTotals = { inp: 0, out: 0, read: 0, costBilled: 0, costEstimated: 0 };
// Usage of the branch's last entry at scan time (assistant or tool result): a stream tick
// mutates that entry in place (branch length unchanged), so the delta is applied on top of
// the cached sums — O(1) per frame, numbers always fresh, still no O(N) rescan per frame.
let usageScanLast: UsageTotals = { inp: 0, out: 0, read: 0, costBilled: 0, costEstimated: 0 };
// Windowed sums at scan time, plus the window contribution of the branch's last entry
// (`null` when that entry is not an assistant message inside the window): the in-place
// delta of a stream tick lands in the window exactly when the last entry is one.
let usageScanWin = { inp: 0, read: 0 };
let usageScanWinLast: { inp: number; read: number } | null = null;

type MessageUsage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number; totalFromProvider?: boolean };
	/** Only set by a tool that names what produced its own usage; absent on the main LLM calls. */
	provider?: string;
	model?: string;
};

/** True when a usage object carries any countable field: a tool result without usage (or with
 *  an all-zero one) adds nothing to the sums. */
const hasUsage = (u: MessageUsage | undefined): u is MessageUsage =>
	!!u && !!((u.input || 0) || (u.output || 0) || (u.cacheRead || 0) || (u.cacheWrite || 0) || (u.cost?.total || 0));

/** Attribution of one branch message's usage: a tool result's usage names no provider/model,
 *  so it is attributed to the tool itself (`tool` · toolName), never to the parent's model. */
/** A tool result names no provider/model: it is attributed to the tool itself, never to the
 *  parent's model. pi-subagents does not set `totalFromProvider` on that usage, so child spend
 *  always lands in the estimated part of the cell (`~`) even when the children were billed. */
const attributionOf = (
	m: { role: string; provider?: string; model?: string; toolName?: string },
	u: MessageUsage,
): { provider: string | undefined; model: string | undefined } =>
	m.role === "toolResult"
		? { provider: u.provider ?? TOOL_PROVIDER, model: u.model ?? m.toolName ?? TOOL_PROVIDER }
		: { provider: m.provider, model: m.model };

/** Billed vs estimated split of one message's usage: a provider-billed total goes to
 *  `costBilled`, a catalog total (pi's own estimate) to `costEstimated`, and a message that
 *  carried no cost at all is recomputed from the price table, cache writes included. */
const costSplitOf = (
	u: MessageUsage,
	provider: string | undefined,
	model: string | undefined,
	table: PriceTable,
): { costBilled: number; costEstimated: number } => {
	const total = u.cost?.total || 0;
	if (u.cost?.totalFromProvider === true) return { costBilled: total, costEstimated: 0 };
	if (total > 0) return { costBilled: 0, costEstimated: total };
	const est = provider && model ? estimateCost(u.input || 0, u.output || 0, u.cacheRead || 0, u.cacheWrite || 0, model, provider, table) : null;
	return { costBilled: 0, costEstimated: est ?? 0 };
};

const lastUsageOf = (branch: readonly unknown[], table: PriceTable): UsageTotals => {
	const zeros: UsageTotals = { inp: 0, out: 0, read: 0, costBilled: 0, costEstimated: 0 };
	const last = branch[branch.length - 1] as
		| {
				type?: string;
				message?: { role?: string; provider?: string; model?: string; toolName?: string; usage?: MessageUsage };
		  }
		| undefined;
	const m = last?.type === "message" ? last.message : undefined;
	const role = m?.role;
	const assistant = role === "assistant";
	const u = role === "assistant" || role === "toolResult" ? m!.usage : undefined;
	if (!hasUsage(u)) {
		zeros.assistant = assistant;
		return zeros;
	}
	const { provider, model } = attributionOf(m!, u);
	const { costBilled, costEstimated } = costSplitOf(u, provider, model, table);
	return { inp: u.input || 0, out: u.output || 0, read: u.cacheRead || 0, costBilled, costEstimated, assistant };
};

/** No burn rate below five minutes of active time: dividing a two-minute clock prints nonsense. */
export const RATE_MIN_ACTIVE_MS = 5 * 60_000;
/** Terminals narrower than this drop the rate — the cost alone still fits. */
export const RATE_MIN_WIDTH = 80;

/** The session cost cell, with the burn rate appended in parentheses (one cell, not two): `$0.42 ($1.80/h)`.
 *  Billed and estimated never blend: `$0.42` when only the provider billed, `~$0.42` when only
 *  an estimate exists, `$0.30 + ~$0.12` when the branch has both, and no cell at all when there
 *  is no cost — the same promise `/usage` makes. The rate is cost per ACTIVE hour — the clock
 *  counts active time (idle pauses excluded), not wall-clock — so it is labelled `$/h`; it
 *  carries the `~` whenever estimated cost feeds it, like the estimated part of the cell, and
 *  is hidden below RATE_MIN_ACTIVE_MS of active time and below RATE_MIN_WIDTH columns.
 *  `bandPaint` paints the whole cell (icon and text) when a budget cap is near or over —
 *  amber at `warn`, red at `over` (see `budgetLevelNow`); without it the icon keeps `acc` and
 *  the text `soft`. The rate suffix is secondary information, so it renders `dim` (or the band
 *  paint when a cap is active, keeping the alert one colour). */
export function costCell(
	costBilled: number,
	costEstimated: number,
	acc: (t: string) => string,
	soft: (t: string) => string,
	width: number = RATE_MIN_WIDTH,
	bandPaint?: (t: string) => string,
	dim?: (t: string) => string,
): string {
	if (!(costBilled > 0) && !(costEstimated > 0)) return "";
	const parts: string[] = [];
	if (costBilled > 0) parts.push(formatCost(costBilled));
	if (costEstimated > 0) parts.push(`~${formatCost(costEstimated)}`);
	const text = parts.join(" + ");
	let rate = "";
	const activeMs = clock.total();
	if (activeMs >= RATE_MIN_ACTIVE_MS && width >= RATE_MIN_WIDTH) {
		const perHour = (costBilled + costEstimated) / (activeMs / 3_600_000);
		rate = `(${costEstimated > 0 ? "~" : ""}${formatCost(perHour)}/h)`;
	}
	const cell = `${(bandPaint ?? acc)("\uf155")} ${(bandPaint ?? soft)(text)}`;
	return rate ? `${cell} ${(bandPaint ?? dim ?? soft)(rate)}` : cell;
}

// 2s cache + branch length: the footer renders on every poke/stream tick, so
// without this every frame rescans the whole branch (O(N) per frame).
export function getUsage(
	ctx: {
		sessionManager: { getBranch(): readonly unknown[] };
		getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
		model?: { id?: string; provider?: string };
	},
	acc: (t: string) => string,
	soft: (t: string) => string,
	/** Off by default: the cost cell is opt-in (`/arnative` → Footers → `[c]`). */
	showCost: boolean = activeFooterCost(),
	/** Terminal width: the burn rate is dropped below RATE_MIN_WIDTH columns. */
	width: number = RATE_MIN_WIDTH,
	/** Budget band painter for the cost cell (amber at `warn`, red at `over`); absent keeps acc/soft. */
	bandPaint?: (t: string) => string,
	/** Painter for the divider that opens the cost group; the caller passes the footer `dim`. */
	dim: (t: string) => string = soft,
): string {
	const branch = ctx.sessionManager.getBranch();
	// Memoized on models.json's stat, so this is one statSync per frame, not a read.
	const priceTable = loadPriceTable();
	const leaf = branch[branch.length - 1];
	const last = lastUsageOf(branch, priceTable);
	let inp = 0;
	let out = 0;
	let read = 0;
	let costBilled = 0;
	let costEstimated = 0;
	let winInp = 0;
	let winRead = 0;
	if (Date.now() - usageScanAt < 2000 && branch.length === usageScanLen && ctx.sessionManager === usageScanManager && leaf === usageScanLeaf) {
		// Cached sums + the streaming delta of the last message (mutated in place).
		inp = usageScanNums.inp + last.inp - usageScanLast.inp;
		out = usageScanNums.out + last.out - usageScanLast.out;
		read = usageScanNums.read + last.read - usageScanLast.read;
		costBilled = usageScanNums.costBilled + last.costBilled - usageScanLast.costBilled;
		costEstimated = usageScanNums.costEstimated + last.costEstimated - usageScanLast.costEstimated;
		// The window covers assistant messages only, so the in-place delta of the last
		// entry lands in it exactly when that entry is an assistant message in the window.
		winInp = usageScanWin.inp + (usageScanWinLast ? last.inp - usageScanWinLast.inp : 0);
		winRead = usageScanWin.read + (usageScanWinLast ? last.read - usageScanWinLast.read : 0);
	} else {
		// (input, cacheRead) of the trailing assistant messages, capped so the window below
		// is the last CACHE_WINDOW_MSGS of them once the first two are skipped.
		const assist: [number, number][] = [];
		for (const e of branch) {
			if (!e || typeof e !== "object" || !("type" in e) || e.type !== "message") continue;
			const m = (e as { message?: unknown }).message as
				| { role?: string; provider?: string; model?: string; toolName?: string; usage?: MessageUsage }
				| undefined;
			// Assistant messages carry their own call's usage; a tool result carries the child
			// (subagent / nested tool) spend — pi puts that nowhere else, so summing both roles
			// counts every token once, never twice.
			if (!m || (m.role !== "assistant" && m.role !== "toolResult")) continue;
			const u = m.usage;
			if (m.role === "assistant") {
				assist.push([u?.input || 0, u?.cacheRead || 0]);
				if (assist.length > CACHE_WINDOW_MSGS + 2) assist.shift();
			}
			if (!hasUsage(u)) continue;
			inp += u.input || 0;
			out += u.output || 0;
			read += u.cacheRead || 0;
			const { provider, model } = attributionOf(m, u);
			const split = costSplitOf(u, provider, model, priceTable);
			costBilled += split.costBilled;
			costEstimated += split.costEstimated;
		}
		usageScanNums = { inp, out, read, costBilled, costEstimated };
		usageScanLast = last;
		usageScanAt = Date.now();
		usageScanLen = branch.length;
		// Windowed cache rate, computed in this same pass: the last CACHE_WINDOW_MSGS
		// assistant messages, the session's first two skipped (turn 1 is always cold).
		const win = assist.slice(Math.max(2, assist.length - CACHE_WINDOW_MSGS));
		for (const [wi, wr] of win) {
			winInp += wi;
			winRead += wr;
		}
		usageScanWin = { inp: winInp, read: winRead };
		usageScanWinLast = last.assistant === true && assist.length > 2 ? { inp: last.inp, read: last.read } : null;
		usageScanManager = ctx.sessionManager;
		usageScanLeaf = leaf;
	}
	usageTotals = { inp, read };
	usageWindow = { inp: winInp, read: winRead };
	const parts: string[] = [];
	if (inp > 0) parts.push(`${acc("↑")}${soft(formatTokens(inp))}`);
	if (out > 0) parts.push(`${acc("↓")}${soft(formatTokens(out))}`);
	if (read > 0) parts.push(`${acc("\uf49b")} ${soft(formatTokens(read))}`);
	const u = ctx.getContextUsage();
	if (u && u.percent !== null && u.tokens !== null) {
		parts.push(`${acc("\ueb85")} ${soft(`${u.percent.toFixed(1)}%/${formatTokens(u.contextWindow)}`)}`);
	}
	if (showCost) {
		const cell = costCell(costBilled, costEstimated, acc, soft, width, bandPaint, dim);
		// The dollar icon opens a new group, so it takes the same divider the footer uses
		// between cells; the token and context parts stay a space apart.
		if (cell) parts.push(parts.length > 0 ? `${dim("·")} ${cell}` : cell);
	}
	return parts.join(" ");
}

let editorTui: { requestRender?: () => void } | null = null;

function poke(): void {
	try {
		if (rerender) rerender();
		else editorTui?.requestRender?.();
	} catch {
		// ignore
	}
}
bindChatboxPoke(poke);

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

/**
 * The spinner is one preset out of `lib/spinner.ts`, chosen through `/arnative` →
 * **Animations** and persisted in `arnative-config.json`. `Pi (system)` hands the slot back
 * to pi's own Braille indicator; every other preset installs its own frames and painter.
 * The frames are read fresh on each `session_start`, so a preset picked mid-session applies
 * on the next reload without re-registering the handler.
 */
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
	workStartMs = null;
	workUI = null;
	activeToolVerbs.clear();
	const rt = getRuntime();
	if (rt.idleTimer === null || clock.idle()) stopClockTick();
}

let idlePauseShown = false;

/** Single 1s ticker shared by the active footer clock and the working-indicator elapsed label. */
function startClockTick(): void {
	const rt = getRuntime();
	if (rt.clockTimer !== null) return;
	rt.clockTimer = setInterval(() => {
		const working = workStartMs !== null;
		const idle = clock.idle();
		if (working) paintWorking();
		if (!idle) poke();
		if (!working && (getRuntime().idleTimer === null || idle)) stopClockTick();
	}, 1000);
}

function stopClockTick(): void {
	const rt = getRuntime();
	if (rt.clockTimer) clearInterval(rt.clockTimer);
	rt.clockTimer = null;
}

/** Repaint a frozen clock on the first activity, instead of waiting for the next tick. */
export function repaintIdle(now: number = Date.now()): void {
	if (!clock.idle(now) || idlePauseShown) return;
	poke();
}

/** Intercepts terminal input on TuiBase to register keystroke activity. */
export function wrapInputListener(tui: unknown): () => void {
	const rt = getRuntime();
	rt.activityHook = (data: string) => {
		if (isPointerOrFocusInput(data)) return;
		clock.tick();
		repaintIdle();
		armIdleProbe();
	};
	const target = tui as { handleTerminalInput?: (data: string) => void };
	if (!target || typeof target.handleTerminalInput !== "function") return () => {};
	const wrapped = rt.wrappedTuis;
	if (!wrapped.has(target)) {
		wrapped.add(target);
		const original = target.handleTerminalInput;
		target.handleTerminalInput = function (this: unknown, data: string): void {
			// One keystroke, one activity. The wrapper runs before `original`, and `pi-tui`
			// has a single caller for it (`terminal.start`), so there is nothing to dedupe.
			try {
				getRuntime().activityHook?.(data);
			} catch {
				// activity bookkeeping must never break input
			}
			original.call(this, data);
		};
	}
	return () => {
		// Only the hook is torn down; the wrapper stays, since a reload re-registers it.
		getRuntime().activityHook = null;
	};
}

/** Past the boundary, where `idle()` is still false because it is a strict `>` (~one frame). */
const IDLE_PROBE_EPSILON_MS = 25;

export function armIdleProbe(now: number = Date.now()): void {
	const rt = getRuntime();
	if (rt.idleTimer) clearTimeout(rt.idleTimer);
	const wait = Math.max(0, clock.pauseMs - (now - clock.lastSeen)) + IDLE_PROBE_EPSILON_MS;
	rt.idleTimer = setTimeout(() => {
		getRuntime().idleTimer = null;
		if (!clock.idle()) return; // activity raced the probe: it re-armed itself
		idlePauseShown = true;
		if (workStartMs === null) stopClockTick();
		poke();
	}, wait);
	startClockTick();
	poke();
}

/** Stop the idle machinery: the one-shot probe and the moving clock tick. */
export function stopIdleProbe(): void {
	const rt = getRuntime();
	if (rt.idleTimer) clearTimeout(rt.idleTimer);
	rt.idleTimer = null;
	if (workStartMs === null) stopClockTick();
}

/** Start (or restart) the 1s tick from a fresh turn, reusing the shared clock ticker. */
function startWorkingClock(ctx: { ui?: WorkingUiSurface }): void {
	stopWorkingClock();
	workUI = ctx.ui ?? null;
	workVerb = WORK_LABEL;
	workStartMs = Date.now();
	startClockTick();
}

/** Swap the verb (tool change) without resetting the turn clock. */
function setWorkingVerb(ctx: { ui?: WorkingUiSurface }, verb: string): void {
	workUI = ctx.ui ?? null;
	workVerb = verb;
	if (workStartMs === null) workStartMs = Date.now();
	paintWorking();
}

export function getToolWorkingMessage(toolName: string, args?: Record<string, unknown>): string {
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

	// Keyboard path for the minimal footer's disclosure: mouse clicks only exist in
	// fullscreen mode, so pi's own rule ("always design a keyboard path") needs this.
	// One key toggles both sides: expand all unless everything is already open.
	const toggleMinimal = () => {
		if (activeFooterPreset() === "Zen") {
			const state = zenExpanded();
			if (state.detail === null && !state.git) {
				state.detail = "left";
				state.git = true;
			} else if (state.detail === "left") {
				state.detail = "right";
			} else {
				state.detail = null;
				state.git = false;
			}
			poke();
			return;
		}
		const state = minimalExpanded();
		const allOpen = state.left && state.right;
		state.left = !allOpen;
		state.right = !allOpen;
		poke();
	};
	for (const key of SHORTCUT_TOGGLE_FOOTER.keys) {
		pi.registerShortcut(key, { description: "Expand/collapse the minimal footer", handler: toggleMinimal });
	}

	// Assistant speed timer (user message timestamps come from lib/features/timestamps.ts).
	// Reset for every role: a user or tool message between two assistant runs must not
	// leave the previous run's start time behind, or the next speed reads a stale elapsed.
	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			assistantStartMs = Date.now();
			assistantChars = 0;
		} else {
			assistantStartMs = null;
			assistantChars = 0;
		}
	});

	pi.on("session_start", async (event, ctx) => {
		// A /reload re-imports this module while the old instance's timers (and its
		// ctx.ui closures) may still be alive; clear every RuntimeState timer handle first.
		const rt = getRuntime();
		stopWorkingClock();
		stopIdleProbe();
		if (event.reason !== "reload") {
			rt.activeClock = null;
			clock = new ActiveClock(resolveSessionStartMs(event.reason, ctx.sessionManager.getHeader()?.timestamp, Date.now()));
			try {
				const now = Date.now();
				clock.active = seedActiveMs(ctx.sessionManager.getEntries(), IDLE_PAUSE_MS, now);
				clock.runStarted = now;
				clock.lastSeen = now;
			} catch {
				// unreadable log -> start from now
			}
			idlePauseShown = false;
			currentModel = ctx.model;
			currentThinkingLevel = ctx.thinkingLevel;
			git = null;
			// A new session reuses this module (no re-import), so the 2s cache would serve the
			// previous session's sums whenever the fresh branch happens to be the same length.
			usageScanAt = 0;
			usageScanLen = -1;
			usageScanManager = undefined;
			usageScanLeaf = undefined;
			piStatsCache = null;
		} else {
			currentModel = (rt.currentModel as typeof currentModel) ?? ctx.model;
			currentThinkingLevel = (rt.currentThinking as typeof currentThinkingLevel) ?? ctx.thinkingLevel;
			git = (rt.lastGit as GitInfo) ?? null;
		}
		rt.currentModel = currentModel;
		rt.currentThinking = currentThinkingLevel;
		rt.lastGit = git;
		activeThemeProxy = ((ctx as unknown as { ui?: { theme?: typeof activeThemeProxy } }).ui?.theme) ?? activeThemeProxy;
		if (activeThemeProxy) setActiveTheme(activeThemeProxy);
		setWorkingUi(ctx.ui);

		const cwd = (event.reason === "reload" && rt.lastCwd) ? rt.lastCwd : ctx.cwd;
		rt.lastCwd = cwd;

		runtimeGen = ++footerGen;
		rt.footerGen = footerGen;

		try {
			armIdleProbe();
			const registerArnative = (c: ExtensionContext) => {
				c.ui.setFooter((tui, theme, footerData) => {
					activeThemeProxy = theme;
					// Wraps the dispatch (see `wrapInputListener`): the TUI's own viewport
					// listener runs first and would swallow the keys an `addInputListener` waits for.
					const dot = wrapInputListener(tui);
					rerender = () => tui.requestRender();
					const unsub = footerData.onBranchChange(() => {
						void refreshGit(cwd, { force: true }).then(() => tui.requestRender());
					});
					// Swallows the follow-up release/click after a press on the ▲/▼ arrow so it never toggles twice.
					let swallowMinimalClick = false;
					return {
						dispose() {
							rerender = null;
							dot();
							unsub();
							if (gitRefreshTrailing) {
								clearTimeout(gitRefreshTrailing);
								gitRefreshTrailing = null;
							}
							themeCache = null;
							gitCache = null;
						},
						invalidate() {},
						render(width: number): string[] {
							// Painters and the cwd/model/git segments only change when their inputs do
							// (theme, cwd, model, thinking level, git info). The footer re-renders on every
						// stream tick and clock tick, so rebuilding them per frame was pure waste.
							if (themeCache?.theme !== theme) {
								const acc = (text: string) => theme.fg("accent", text);
								const dim = (text: string) => theme.fg("dim", text);
								// `accentSoft`/`secondarySoft` are vars-only tokens on Pi 1.2+, so both soft tiers
								// are resolved through the shared painters instead of a raw fg() probe. Icons keep
								// `accent`; the cwd/branch/clock/status text takes the border-accent tier, so the
								// footer stays two-toned instead of the text inheriting the accent hue.
								const soft = softOf(theme as never);
								const softLabel = softSecondaryOf(theme as never);
								// Diff colors: the same theme slots pi uses for a diff body, with the
								// plain soft color as fallback for a theme that omits them. Optional tokens are
								// probed once per theme (fgOr), not thrown-and-caught on every frame.
								const colorOr = (name: string, fallback: (t: string) => string) => fgOr(theme, name, fallback);
								themeCache = {
									theme,
									acc,
									dim,
									soft,
									colorOr,
									primary: colorOr("mdHeading", acc),
									secondarySoft: softLabel,
									diffAdd: colorOr("toolDiffAdded", soft),
									diffDel: colorOr("toolDiffRemoved", soft),
									sep: ` ${dim("·")} `,
							};
						}
							const { acc, dim, soft, colorOr, primary, secondarySoft, diffAdd, diffDel, sep } = themeCache!;
							const preset = activeFooterPreset();

							if (preset === "Pi (color)") {
								minimalRanges = null;
								zenRanges = null;
								const statuses: ReadonlyMap<string, string> = (() => {
									try {
										return footerData.getExtensionStatuses();
									} catch {
										return new Map<string, string>();
									}
								})();
								const branch = (() => {
									try {
										return footerData.getGitBranch();
									} catch {
										return null;
									}
								})();
								const availableProviderCount = (() => {
									try {
										return footerData.getAvailableProviderCount();
									} catch {
										return 0;
									}
								})();
								const sessionMgr = ctx.sessionManager as unknown as {
									getEntries(): readonly unknown[];
									getLeafId?: () => string | null;
									getSessionId?: () => string;
									getCwd?: () => string;
									getSessionName?: () => string | undefined;
								};
								const stats = collectPiSessionStats(sessionMgr);
								const contextUsage = (() => {
									try {
										return ctx.getContextUsage();
									} catch {
										return undefined;
									}
								})();
								const model = (ctx.model ?? currentModel) as { id: string; provider?: string; reasoning?: boolean; contextWindow?: number } | undefined;
								const liveThinkingLevel = (() => {
									try {
										return (pi as unknown as { getThinkingLevel?: () => string | undefined }).getThinkingLevel?.();
									} catch {
										return undefined;
									}
								})() ?? ctx.thinkingLevel ?? currentThinkingLevel;
								const autoCompactEnabled = (() => {
									try {
										const s = (pi as unknown as { getSettings?: () => { compaction?: { enabled?: boolean } } }).getSettings?.();
										return s?.compaction?.enabled !== false;
									} catch {
										return true;
									}
								})();
								const usingSubscription = Boolean(
									model && (
										model.provider === "kimi-coding" ||
										(ctx as unknown as { modelRegistry?: { isUsingOAuth?: (m: unknown) => boolean } }).modelRegistry?.isUsingOAuth?.(model)
									),
								);
								return renderPiColorFooter({
									cwd: sessionMgr.getCwd?.() ?? cwd,
									branch,
									sessionName: sessionMgr.getSessionName?.(),
									stats,
									usingSubscription,
									budgetBand: budgetLevelNow(),
									contextPercent: contextUsage?.percent ?? null,
									contextWindow: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
									autoCompactEnabled,
									experimental: process.env.PI_EXPERIMENTAL === "1",
									model,
									thinkingLevel: liveThinkingLevel,
									availableProviderCount,
									extensionStatuses: statuses,
									width,
									painters: {
										acc,
										dim,
										primary,
										secondarySoft,
										warning: colorOr("warning", acc),
										error: colorOr("error", acc),
									},
								});
							}

							const durationStr = formatDuration(clock.total());
							const diffStat = formatDiffStat(git, acc, diffAdd, diffDel);
							const paused = clock.idle();
							idlePauseShown = paused;
							const clockIcon = paused ? dim("\uf017") : acc("\uf017");
							const clockText = paused ? dim(durationStr) : secondarySoft(durationStr);
							const clockCell = `${clockIcon} ${clockText}`;
							const pDuration = `${clockCell}${diffStat ? `${sep}${diffStat}` : ""}`;
							// The git segment (branch, sync, tag, dirty count) is rebuilt only when theme,
							// git info, or cwd changes (refreshGit replaces the git object).
							if (gitCache?.theme !== theme || gitCache?.git !== git || gitCache?.cwd !== cwd) {
								const cwdCell = `${acc("\uf07b")} ${dim(shortenCwd(cwd))}`;
								const gitItems = git ? gitParts(git, acc, secondarySoft) : [];
								const gitSeg = gitItems.map((p) => `${sep}${p}`).join("");
								gitCache = { theme, git, cwd, cwdCell, gitItems, gitSeg };
							}
							const isMinimal = preset === "Arnative (Minimal)";
							const isZen = preset === "Zen";
							const open = minimalExpanded();
							const arrow = (expanded: boolean) => dim(expanded ? " ▼" : " ▲");
							let left1 = `${gitCache.cwdCell}${sep}${pDuration}${gitCache.gitSeg}`;
							if (isMinimal) left1 += arrow(open.left);
							const modelText = formatModelName(currentModel, currentThinkingLevel, acc, secondarySoft, primary, dim);
							const right1 = modelText + (isMinimal ? arrow(open.right) : "");

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
									return `${acc("\uf233")} ${secondarySoft(m ? m[0] : rest || "MCP")}`;
								}
								if (s.includes("ponytail")) return ponytailStatusLine(s, acc, dim, secondarySoft);
								if (isJevEyeStatus(s)) return jevEyeStatusLine(s, acc, dim, secondarySoft, theme);
								let clean = stripAnsi(s);
								clean = clean.replace(/\uFFFD/g, "").replace(/\?{1,2}\s*/g, "");
								return secondarySoft(clean.trim());
							};

							const groups: string[] = [];
							const mcp = statuses.get("mcp");
							if (mcp !== undefined) groups.push(cleanStatus(mcp));
							for (const [k, s] of statuses) {
								if (k !== "mcp" && k !== "pi-cache-stats") groups.push(cleanStatus(s));
							}
							// Payload pressure sits beside the extension statuses: the right rows
							// already carry speed, cache, tokens and cost. The denominator is the shed
							// trigger from the snapshot (900KB), not the 1MB proxy wall: showing /1MB
							// understated pressure by 10 points right before the trim starts.
							const wire = wireBytesSnapshot();
							if (wire && wire.bytes > 0 && isByteLimitedModel(ctx.model)) {
								// Under a 1 MB wall the label keeps the approved shape `0.74MB/900KB`: the
								// payload in MB, the ceiling in KB. A bigger wall scales both to MB so the
								// ceiling stays readable instead of printing 14336KB.
								const label = wire.limit >= 1024 * 1024
									? `${(wire.bytes / 1024 / 1024).toFixed(2)}MB/${(wire.limit / 1024 / 1024).toFixed(2)}MB`
									: `${(wire.bytes / 1024 / 1024).toFixed(2)}MB/${Math.round(wire.limit / 1024)}KB`;
								groups.push(`${acc("\udb80\udd93")} ${secondarySoft(label)}`);
							}

							let usageStr = "";
							try {
								// The cost cell's colour follows the budget band — amber at ≥80% of a
								// cap, red at ≥100% — read from the memoized usage summary, so the
								// render path scans at most once per 5s memo expiry, never per frame.
								// Nothing is read at all while the cell is off.
								const band = activeFooterCost() ? budgetLevelNow() : "ok";
								const bandPaint = band === "warn" ? colorOr("warning", acc) : band === "over" ? colorOr("error", acc) : undefined;
								usageStr = getUsage(ctx, acc, secondarySoft, activeFooterCost(), width, bandPaint, dim);
							} catch {
								// fallback
							}
							const opt = parseOptimizer(rawCache) ?? piCacheHit();
							const speedStr = latestSpeed !== null && latestSpeed > 0 ? `${acc("\udb81\udcc5")} ${secondarySoft(`${latestSpeed.toFixed(1)} tok/s`)}` : "";
							// The cache cell's colour follows the recent window (the last 10 assistant
							// messages, the first two skipped): soft ≥70%, amber 40–70% (`warning`
							// slot, accent when the theme has none), red below 40% (`error`). A passive
							// colour only — never a notify. The `pi …%` text itself stays as is.
							// Only pi's own number may be coloured by pi's window: a cache-stats plugin
							// publishes its own rate (often per request, not per token), and painting it
							// with our band would contradict the number printed next to it.
							const fromPi = !parseOptimizer(rawCache);
							const band = fromPi ? cacheHitBand(usageWindow.inp, usageWindow.read) : null;
							const bandPaint = band === "warning" ? colorOr("warning", acc) : band === "error" ? colorOr("error", acc) : null;
							const cacheCell = opt ? `${(bandPaint ?? acc)("\udb80\udf5b")} ${(bandPaint ?? secondarySoft)(opt)}` : "";
							const metricCells = [speedStr, cacheCell, usageStr].filter(Boolean);

							if (isZen) {
								minimalRanges = null;
								const zen = zenExpanded();
								const zenLeft = `${gitCache.cwdCell}${sep}${clockCell}`;
								const zenGitCells = [diffStat, ...gitCache.gitItems].filter(Boolean);
								const hasGit = zenGitCells.length > 0;
								const dots = hasGit ? (zen.git ? acc("···") : dim("···")) : "";
								const gitText = hasGit && zen.git ? zenGitCells.join(sep) : "";
								const placed = placeZenHead(zenLeft, modelText, ` ${dim("|")} `, dots, gitText, width);
								zenRanges = { left: placed.left, right: placed.right, dots: placed.dots };
								const detailCells = zen.detail === "left" ? groups : zen.detail === "right" ? metricCells : [];
								const w = Math.max(1, width);
								const detailLines = detailCells.length > 0
									? wrapTextWithAnsi(detailCells.join(sep), w).map((l) => centerLine(l, w).line)
									: [];
								return [...placed.rows, ...detailLines];
							}
							zenRanges = null;
							// Fixed 3-row grid: head (cwd/model), then statuses and metrics each
							// wrapped inside their half of the width. Arnative (Minimal) starts collapsed
							// and reveals the same rows on click/keypress, one side at a time.
							const leftRows = isMinimal && !open.left ? [] : groups;
							const rightRows = isMinimal && !open.right ? [] : metricCells;
							if (isMinimal) {
								const rightSep = ` ${dim("·")} `;
								if (visibleWidth(left1) + 1 + visibleWidth(right1) > width) {
									// Narrow / mobile viewport: stack left layout (head + expanded statuses)
									// then right layout (head + expanded metrics), each auto-wrapped to full width.
									const w = Math.max(1, width);
									const leftHeadLines = wrapTextWithAnsi(left1, w);
									const leftDetailLines = leftRows.length > 0 ? wrapTextWithAnsi(leftRows.join(sep), w) : [];
									const rightHeadY = leftHeadLines.length + leftDetailLines.length;
									const rightHeadLines = wrapTextWithAnsi(right1, w);
									const rightDetailLines = rightRows.length > 0 ? wrapTextWithAnsi(rightRows.join(rightSep), w) : [];
									const spansOf = (lines: string[], startY: number): MinimalSpan[] => {
										const spans: MinimalSpan[] = [];
										for (let i = 0; i < lines.length; i++) {
											const lw = visibleWidth(lines[i]!);
											if (lw > 0) spans.push({ y: startY + i, x0: 0, x1: lw - 1 });
										}
										return spans;
									};
									const arrowOf = (spans: MinimalSpan[]): MinimalSpan | null => {
										const last = spans[spans.length - 1];
										return last ? { y: last.y, x0: Math.max(last.x0, last.x1 - 1), x1: last.x1 } : null;
									};
									const leftSpans = spansOf(leftHeadLines, 0);
									const rightSpans = spansOf(rightHeadLines, rightHeadY);
									minimalRanges = {
										left: leftSpans,
										right: rightSpans,
										leftArrow: arrowOf(leftSpans),
										rightArrow: arrowOf(rightSpans),
									};
									return [...leftHeadLines, ...leftDetailLines, ...rightHeadLines, ...rightDetailLines];
								}
								// Wide viewport: single head row with measured click zones.
								const placed = placeMinimalHead(left1, right1, width);
								const leftSpans: MinimalSpan[] = placed.left[0] >= 0 ? [{ y: 0, x0: placed.left[0], x1: placed.left[1] }] : [];
								const rightSpans: MinimalSpan[] = placed.right[0] >= 0 ? [{ y: 0, x0: placed.right[0], x1: placed.right[1] }] : [];
								const leftArrow: MinimalSpan | null = !placed.leftTruncated && placed.left[0] >= 0 && placed.left[1] >= placed.left[0]
									? { y: 0, x0: Math.max(placed.left[0], placed.left[1] - 1), x1: placed.left[1] }
									: null;
								const rightArrow: MinimalSpan | null = !placed.rightTruncated && placed.right[0] >= 0 && placed.right[1] >= placed.right[0]
									? { y: 0, x0: Math.max(placed.right[0], placed.right[1] - 1), x1: placed.right[1] }
									: null;
								minimalRanges = { left: leftSpans, right: rightSpans, leftArrow, rightArrow };
								const rest = layoutFooterGrid("", "", leftRows, rightRows, sep, rightSep, width).slice(1);
								return [placed.row, ...rest];
							}
							minimalRanges = null;
							return layoutFooterGrid(left1, right1, leftRows, rightRows, sep, ` ${dim("·")} `, width);
						},
						handleMouse(event: TuiMouseEvent) {
							// Matches arnative-box (tools.ts / todos.ts):
							// - Press on the ▲/▼ arrow toggles immediately and swallows the follow-up
							//   release/click so a 1-cell drift still works without double-toggling.
							// - Press on head text returns undefined so pi handles text selection
							//   (drag-select, double-click word, triple-click line).
							// - Single-click without drag on either head (clickCount === 1) toggles
							//   that side; double/triple clicks stay with pi's selection.
							if (event.button !== "left") return undefined;
							if (event.type === "press") swallowMinimalClick = false;
							if (swallowMinimalClick && (event.type === "release" || event.type === "click")) {
								if (event.type === "click") swallowMinimalClick = false;
								return { handled: true, render: false };
							}
							const hitSpan = (s: MinimalSpan | null) => !!s && event.y === s.y && event.x >= s.x0 && event.x <= s.x1;
							const hitAny = (spans: readonly MinimalSpan[]) => spans.some((s) => hitSpan(s));
							if (zenRanges) {
								const toggleGit = () => {
									const state = zenExpanded();
									state.git = !state.git;
									poke();
									return { handled: true, render: true };
								};
								const toggleDetail = (side: "left" | "right") => {
									const state = zenExpanded();
									state.detail = state.detail === side ? null : side;
									poke();
									return { handled: true, render: true };
								};
								if (event.type === "press") {
									if (!hitSpan(zenRanges.dots)) return undefined;
									swallowMinimalClick = true;
									return toggleGit();
								}
								if (event.type !== "click" || (event.clickCount ?? 1) !== 1) return undefined;
								if (hitSpan(zenRanges.dots)) return toggleGit();
								const hit = hitAny(zenRanges.left) ? "left" : hitAny(zenRanges.right) ? "right" : null;
								if (!hit) return undefined;
								return toggleDetail(hit);
							}
							const ranges = minimalRanges;
							if (!ranges) return undefined;
							const toggle = (side: "left" | "right") => {
								const state = minimalExpanded();
								state[side] = !state[side];
								poke();
								return { handled: true, render: true };
							};
							if (event.type === "press") {
								const arrowHit = hitSpan(ranges.leftArrow) ? "left" : hitSpan(ranges.rightArrow) ? "right" : null;
								if (!arrowHit) return undefined;
								swallowMinimalClick = true;
								return toggle(arrowHit);
							}
							if (event.type !== "click" || (event.clickCount ?? 1) !== 1) return undefined;
							const hit = hitAny(ranges.left) ? "left" : hitAny(ranges.right) ? "right" : null;
							if (!hit) return undefined;
							return toggle(hit);
						},
					};
				});

			};
			rt.footerRegistrar = registerArnative;
			applyFooterPreset(ctx);
			class ArnativeEditor extends CustomEditor {
				private lastHiddenLineCount = 0;
				private lastBottomHiddenCount = 0;
				private topMoreSpans: TextSpan[] = [];
				private bottomMoreSpans: TextSpan[] = [];

				constructor(
					tui: ConstructorParameters<typeof CustomEditor>[0],
					editorTheme: ConstructorParameters<typeof CustomEditor>[1],
					keybindings: ConstructorParameters<typeof CustomEditor>[2],
					options?: ConstructorParameters<typeof CustomEditor>[3],
				) {
					super(tui, editorTheme, keybindings, { ...options, embedWorkingStatus: true });
					editorTui = tui;
					// Published so `/arnative` → Animations can repaint the live spinner without
					// waiting for the next session, and so workUI has a handle to the Loader.
					getRuntime().editor = this;
				}

				private getActiveTheme() {
					return ctx.ui?.theme ?? activeThemeProxy;
				}

				private applyFixedIndicatorColors(indicator: WorkingIndicatorLike | undefined) {
					if (!indicator) return;
					// Clear renderIndicatorVerbatim so custom frames pass through spinnerColorFn.
					indicator.renderIndicatorVerbatim = false;
					indicator.spinnerColorFn = spinnerPainter(activeSpinnerPreset(), this.getActiveTheme(), activeSpinnerGradient());
					indicator.messageColorFn = (text: string) => {
						try {
							const th = this.getActiveTheme();
							if (!th) return text;
							return softSecondaryOf(th as never)(text);
						} catch {
							return text;
						}
					};
				}

				setWorkingStatusIndicator(indicator: WorkingIndicatorLike | undefined) {
					this.applyFixedIndicatorColors(indicator);
					indicator?.updateDisplay?.();
					super.setWorkingStatusIndicator(indicator as Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]);
				}

				renderTopBorder(width: number, hiddenLineCount: number): string {
					this.lastHiddenLineCount = hiddenLineCount;
					this.applyFixedIndicatorColors((this as unknown as { workingStatusIndicator?: WorkingIndicatorLike }).workingStatusIndicator);
					if (activeChatboxPreset() === "Arnative") {
						return renderChatboxScrollBorder(
							"\u2191",
							hiddenLineCount,
							width,
							(t) => this.borderColor(t),
							chatboxPrimaryPaint(this.getActiveTheme()),
						);
					}
					// Plain/scroll border only; render() positions the status dialog after boxing.
					const editorProto = Object.getPrototypeOf(CustomEditor.prototype) as {
						renderTopBorder?: (w: number, h: number) => string;
					};
					if (typeof editorProto?.renderTopBorder === "function") {
						return editorProto.renderTopBorder.call(this, width, hiddenLineCount);
					}
					return this.borderColor("\u2500".repeat(width));
				}

				renderBottomBorder(width: number, hiddenLineCount: number): string {
					this.lastBottomHiddenCount = hiddenLineCount;
					if (activeChatboxPreset() === "Arnative") {
						return renderChatboxScrollBorder(
							"\u2193",
							hiddenLineCount,
							width,
							(t) => this.borderColor(t),
							chatboxPrimaryPaint(this.getActiveTheme()),
						);
					}
					const editorProto = Object.getPrototypeOf(CustomEditor.prototype) as {
						renderBottomBorder?: (w: number, h: number) => string;
					};
					if (typeof editorProto?.renderBottomBorder === "function") {
						return editorProto.renderBottomBorder.call(this, width, hiddenLineCount);
					}
					return this.borderColor("\u2500".repeat(width));
				}

				private scrollByBorderClick(direction: -1 | 1): void {
					const ed = this as unknown as {
						lastWidth?: number;
						scrollOffset?: number;
						renderedVisibleLineCount?: number;
						buildVisualLineMap?(w: number): unknown[];
						findCurrentVisualLine?(vls: unknown[]): number;
						moveToVisualLine?(vls: unknown[], cur: number, target: number): void;
						pageScroll?(dir: number): void;
					};
					if (
						typeof ed.buildVisualLineMap === "function" &&
						typeof ed.findCurrentVisualLine === "function" &&
						typeof ed.moveToVisualLine === "function"
					) {
						const vls = ed.buildVisualLineMap(ed.lastWidth ?? 80);
						if (vls.length > 0) {
							const cur = ed.findCurrentVisualLine(vls);
							const vis = Math.max(1, ed.renderedVisibleLineCount ?? 5);
							const step = Math.max(1, Math.floor(vis / 2));
							const scrollOff = Math.max(0, ed.scrollOffset ?? 0);
							const target =
								direction < 0
									? Math.max(0, scrollOff - step)
									: Math.min(vls.length - 1, scrollOff + vis - 1 + step);
							ed.moveToVisualLine(vls, cur, target);
							return;
						}
					}
					ed.pageScroll?.(direction);
				}

				handleMouse(event: TuiMouseEvent) {
					if (activeChatboxPreset() === "Arnative" && event.type === "click" && event.button === "left") {
						if (inSpans(this.topMoreSpans, event.y, event.x)) {
							this.scrollByBorderClick(-1);
							return { handled: true, focus: true };
						}
						if (inSpans(this.bottomMoreSpans, event.y, event.x)) {
							this.scrollByBorderClick(1);
							return { handled: true, focus: true };
						}
					}
					return super.handleMouse(event);
				}

				handleInput(data: string) {
					if (SHORTCUT_RELOAD.matches(data)) {
						this.setText("");
						if (this.onSubmit) {
							this.onSubmit("/reload");
						}
						return;
					}
					if (!isPointerOrFocusInput(data)) markPromptTyped();
					super.handleInput(data);
				}

				render(width: number): string[] {
					const preset = activeChatboxPreset();
					const dialog = activeChatboxDialog();
					const indicator = (this as unknown as { workingStatusIndicator?: WorkingIndicatorLike }).workingStatusIndicator;
					this.applyFixedIndicatorColors(indicator);
					// The box eats 5 columns: 2 sides + the 3-column prompt, so the
					// content is rendered 5 columns narrower.
					const visible = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount;
					const prompt = paintChatboxPrompt(activeChatboxPrompt(), this.getActiveTheme(), isPromptActive());
					const promptW = visibleWidth(prompt);
					const lines = renderChatboxLines(preset, (w) => super.render(w), width, visible, (t) => this.borderColor(t), prompt);
					const boxed = preset === "Arnative" && typeof visible === "number" && width >= promptW + 8 && lines.length >= visible + 2;
					const statusMax = Math.max(1, width - (boxed ? promptW + 4 : 5));
					const status = indicator?.renderInBorder?.(statusMax) ?? "";
					const spinnerOnly = status ? (indicator?.renderSpinnerInBorder?.(width) ?? "") : "";
					const primary = chatboxPrimaryPaint(this.getActiveTheme());
					const out = applyChatboxDialog(lines, boxed, width, this.lastHiddenLineCount, dialog, status, spinnerOnly, (t) => this.borderColor(t), primary);
					const visNow = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount ?? 0;
					this.topMoreSpans =
						this.lastHiddenLineCount > 0 && out.length > 0
							? textSpans([out[0]!], `\u2191 ${this.lastHiddenLineCount} more`)
							: [];
					const botRow = visNow + 1;
					this.bottomMoreSpans =
						this.lastBottomHiddenCount > 0 && botRow < out.length
							? textSpans([out[botRow]!], `\u2193 ${this.lastBottomHiddenCount} more`).map((s) => ({ ...s, row: botRow }))
							: [];
					return out;
				}
			}
			ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new ArnativeEditor(tui, editorTheme, keybindings));
			applySpinnerPreset(ctx.ui, activeThemeProxy);
			rt.outsideDialogHook = (lines: string[], width: number, modeRaw: unknown): string[] => {
				if (activeChatboxDialog() !== "Outside") return lines;
				const mode = modeRaw as OutsideDialogModeLike | null | undefined;
				const editor = getRuntime().editor as
					| { workingStatusIndicator?: WorkingIndicatorLike; applyFixedIndicatorColors?: (ind: WorkingIndicatorLike) => void }
					| null;
				if (!editor || mode?.editor !== editor) return lines;
				const children = mode?.editorContainer?.children;
				if (Array.isArray(children) && !children.includes(editor)) return lines;
				const indicator = editor.workingStatusIndicator;
				if (!indicator) return lines;
				editor.applyFixedIndicatorColors?.(indicator);
				const status = indicator.renderInBorder?.(Math.max(1, width - 5)) ?? "";
				if (!status || visibleWidth(status) === 0) return lines;
				return overlayOutsideDialogOnWidgetLines(lines, width, status);
			};
		} catch {
			// fallback
		}
		void refreshGit(cwd, { force: true }).then(() => poke());
	});

	pi.on("turn_start", async (_event, ctx) => {
		const rt = getRuntime();
		clock.tick();
		armIdleProbe();
		currentModel = ctx.model;
		currentThinkingLevel = ctx.thinkingLevel;
		rt.currentModel = currentModel;
		rt.currentThinking = currentThinkingLevel;
		rt.lastCwd = ctx.cwd;
		startWorkingClock(ctx);
		void refreshGit(ctx.cwd, { force: true }).then(() => poke());
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		clock.tick();
		armIdleProbe();
		const verb = getToolWorkingMessage(event.toolName, event.args);
		activeToolVerbs.set(event.toolCallId, verb);
		setWorkingVerb(ctx, verb);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		clock.tick();
		armIdleProbe();
		activeToolVerbs.delete(event.toolCallId);
		setWorkingVerb(ctx, currentToolVerb(activeToolVerbs));
		// A finished edit/write/bash may have changed the tree (or committed it): without
		// this, the diff stat stays frozen at the turn_start snapshot — a session that
		// commits inside the turn shows "clean" forever. refreshGit coalesces concurrent
		// calls (in-flight + one queued), so a burst of tool ends costs at most two runs.
		void refreshGit(ctx.cwd).then(() => poke());
	});

	pi.on("message_update", async (event) => {
		clock.tick();
		armIdleProbe();
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
		clock.tick();
		armIdleProbe();
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
		clock.tick();
		armIdleProbe();
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
		getRuntime().currentModel = currentModel;
		poke();
	});

	pi.on("thinking_level_select", async (event) => {
		currentThinkingLevel = event.level;
		getRuntime().currentThinking = currentThinkingLevel;
		poke();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const rt = getRuntime();
		usageScanManager = undefined;
		usageScanLeaf = undefined;
		piStatsCache = null;
		stopWorkingClock();
		stopIdleProbe();
		stopPromptIdle();
		stopClockTick();
		editorTui = null;
		rt.outsideDialogHook = null;
		try {
			ctx.ui?.setWorkingIndicator?.();
		} catch {
			// ignore
		}
		rerender = null;
		const cur = rt.footerGen ?? 0;
		if (cur !== runtimeGen) return;
		footerGen++;
		rt.footerGen = footerGen;
		try {
			(ctx as unknown as { ui?: { setFooter?: (f?: undefined) => void } }).ui?.setFooter?.(undefined);
		} catch {
			// ignore
		}
	});
}

export const __test = {
	CHATBOX_PRESET_KEY,
	CHATBOX_PROMPT_KEY,
	CHATBOX_DIALOG_KEY,
	ARNATIVE_PRESETS,
	FOOTER_PRESET_KEY,
	get git() {
		return git;
	},
	set git(v) {
		git = v;
	},
	WORK_LABEL,
	run,
	branchFromDisk,
	refreshGit,
	formatModelName,
	get usageWindow() {
		return usageWindow;
	},
	get usageScanAt() {
		return usageScanAt;
	},
	set usageScanAt(v) {
		usageScanAt = v;
	},
	get usageScanLen() {
		return usageScanLen;
	},
	set usageScanLen(v) {
		usageScanLen = v;
	},
	stopWorkingClock,
	IDLE_PROBE_EPSILON_MS,
	startWorkingClock,
};
