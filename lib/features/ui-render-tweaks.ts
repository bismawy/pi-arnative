/**
 * Six small patches to pi's fullscreen renderer (render layer only, session data
 * untouched):
 * 1. Hide pi's built-in "Reloading keybindings, extensions, skills..." box
 *    (hardcoded in handleReloadCommand, no auto-hide).
 * 2. Drag selection: pi wraps it in reverse video (\x1b[7m), unreadable in some
 *    terminals/themes -> explicit colors (bg selectedBg + fg text).
 * 3. Compaction message: pi's 3 lines (label, blank, text) squeezed into one:
 *    `[compaction] Compacted from N tokens (ctrl+o to expand)`.
 * 4. Custom `pi-jev-eye-review` message: pi adds a label + blank line inside a purple
 *    box; our renderer shows the content as-is.
 * 5. `↓ Jump to latest message` pill (fullscreen): bg selectedBg (grey) -> accent,
 *    text darkened (theme canvas) so contrast stays high (9.6:1).
 * 6. `ctx.ui.select` rows: pi paints the whole selected row accent -> keep accent on
 *    the `❯` marker and `·` separators, selected text in soft.
 */
import { AssistantMessageComponent, CompactionSummaryMessageComponent, ExtensionSelectorComponent, getMarkdownTheme, InteractiveMode, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Spacer, Text, TuiAltScreen, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { renderBoxLines } from "../box.ts";
import { statusRows } from "../status-widget.ts";
import { ansiBgOpen, getActiveTheme, setActiveTheme, stripAnsi, themeOf, softOf } from "../ansi.ts";
import { contrast } from "../color.ts";
import { expandKeyName } from "../format.ts";
import { patchOnce } from "../patch.ts";
import { getRuntime, type ThinkingLabelState } from "../runtime.ts";

type ActiveTheme = { fg(color: string, text: string): string; bg?(color: string, text: string): string; italic?(text: string): string } | null;
const activeTheme = () => getActiveTheme<Exclude<ActiveTheme, null>>();

// Hide pi's built-in "Reloading keybindings, extensions, skills..." box
// (hardcoded in handleReloadCommand, no auto-hide). Patches Container.render
// through the prototype chain (Container is not exported) and drops the whole box on match.
const RELOAD_TEXT = "Reloading keybindings, extensions, skills, prompts, themes, and context files...";
/** The reload box is a fixed 5-child container (2 borders, 2 spacers, one 78-char line), so it
 *  renders at most ~9 rows even wrapped. Anything larger cannot be the box, and this predicate
 *  runs per frame on every plain Container — including a transcript of tens of thousands of
 *  lines, where the substring scan is the single most expensive arnative render patch. */
const RELOAD_BOX_MAX_LINES = 64;
/**
 * True only for the box itself: border rows, blank spacers and (possibly wrapped) copy of the
 * message. The patch sits on every plain Container, so a bare substring test would blank a
 * whole chat the moment a transcript line mentioned the phrase. Containers larger than
 * {@link RELOAD_BOX_MAX_LINES} are refused before any scanning starts.
 */
export function shouldHideReloadBox(lines: readonly string[]): boolean {
	if (lines.length > RELOAD_BOX_MAX_LINES) return false;
	if (!lines.some((l) => l.includes("Reloading keybindings"))) return false;
	const rows = lines.map((l) => stripAnsi(l).trim());
	return rows.every((r) => r === "" || /^[─-]+$/.test(r) || RELOAD_TEXT.includes(r));
}
// Every patch below reinstalls on each load (lib/patch.ts): `/reload` re-evaluates the
// module in the same process, so a `globalThis` guard would freeze the first load.
if (UserMessageComponent?.prototype) {
	const containerProto = Object.getPrototypeOf(UserMessageComponent.prototype) as { render?: (width: number) => string[] };
	if (typeof containerProto?.render === "function") {
		patchOnce(containerProto, "render", (orig) => function (this: any, width: number): string[] {
			const lines = orig.call(this, width);
			return shouldHideReloadBox(lines) ? [] : lines;
		});
	}
}

// bg open code (no closing reset) -> lib/ansi.ts (single definition).

// Drag selection in pi fullscreen: pi only wraps the selection in reverse video
// (\x1b[7m), unreadable in some terminals/themes. Replaced with explicit colors
// (bg selectedBg + fg text) so text always stays visible.

export function recolorSelection(highlighted: string, fgOpen: string, bgOpen: string): string {
	return highlighted.split("\x1b[7m").join(fgOpen + bgOpen).split("\x1b[27m").join("\x1b[39m\x1b[49m");
}

export function ansiFgOpen(th: { fg?(c: string, t: string): string } | null, color = "text"): string {
	if (!th?.fg) return "";
	try {
		const probe = th.fg(color, "");
		const reset = "\x1b[39m";
		return probe.endsWith(reset) ? probe.slice(0, -reset.length) : probe;
	} catch {
		return "";
	}
}

// `↓ Jump to latest message` pill (fullscreen): pi colors it with bg `selectedBg`
// (grey) -> accent bg + darkened canvas text (contrast 9.6:1, WCAG AA). pi has no bg
// token for `accent` (7 exist, see PILL_INK), so the SGR escapes are swapped;
// `bg("accent")` would throw "Unknown theme background color" and stay unchanged.
const PILL_MARK = "↓ Jump to latest message";
const PILL_INK = "toolPendingBg";

const asBg = (seq: string) => seq.replace(/\x1b\[38;/g, "\x1b[48;");
const asFg = (seq: string) => seq.replace(/\x1b\[48;/g, "\x1b[38;");

export function accentPill(
	text: string,
	th: { fg?(c: string, t: string): string; bg?(c: string, t: string): string } | null,
): string {
	if (!text.includes(PILL_MARK) || !th?.fg || !th?.bg) return text;
	const accentBg = asBg(ansiFgOpen(th, "accent"));
	const inkFg = asFg(ansiBgOpen(th, PILL_INK));
	if (!accentBg || !inkFg) return text; // token missing from the theme -> leave pi's default
	return `${accentBg}${inkFg}${stripAnsi(text)}\x1b[39m\x1b[49m`;
}

// TuiAltScreen builds the pill via the per-instance `scrollToEndIndicator` callback
// (an instance field, so the prototype cannot be patched). Swap in our callback
// only while the composite runs, then restore the original.
export function withAccentPill<T>(
	host: { scrollToEndIndicator?: (() => string) | undefined },
	fn: () => T,
	th: { fg?(c: string, t: string): string; bg?(c: string, t: string): string } | null,
): T {
	const orig = host.scrollToEndIndicator;
	if (typeof orig !== "function") return fn();
	host.scrollToEndIndicator = () => accentPill(orig(), th);
	try {
		return fn();
	} finally {
		host.scrollToEndIndicator = orig;
	}
}

if (TuiAltScreen?.prototype) {
	const proto = TuiAltScreen.prototype as any;
	if (typeof proto.applySelectionHighlight === "function") {
		patchOnce(proto, "applySelectionHighlight", (orig) => function (this: any, text: string): string {
			const highlighted = orig.call(this, text);
			const fgOpen = ansiFgOpen(activeTheme());
			const bgOpen = ansiBgOpen(activeTheme(), "selectedBg");
			return fgOpen && bgOpen ? recolorSelection(highlighted, fgOpen, bgOpen) : highlighted;
		});
	}
}

if (TuiAltScreen?.prototype) {
	const proto = TuiAltScreen.prototype as unknown as {
		compositeScrollToEndIndicator?: (screen: string[], layout: unknown, width: number) => string[];
	};
	if (typeof proto.compositeScrollToEndIndicator === "function") {
		patchOnce(proto, "compositeScrollToEndIndicator", (origComposite) => function (
			this: { scrollToEndIndicator?: (() => string) | undefined },
			screen: string[],
			layout: unknown,
			width: number,
		) {
			return withAccentPill(this, () => origComposite.call(this, screen, layout, width), activeTheme());
		});
	}
}

// 6. Select menus (ctx.ui.select -> ExtensionSelectorComponent.updateList): pi colors the
// whole selected row accent. Arnative keeps accent on the `❯` marker and `·` separators
// and moves the selected text to soft (accent on themes without the token).

/** Selected row body: `·` separators accent, the text around them soft. */
export function selectRowText(row: string, th: { fg(c: string, t: string): string }): string {
	const soft = softOf(th);
	return row
		.split("·")
		.map((part) => soft(part))
		.join(th.fg("accent", "·"));
}

if (ExtensionSelectorComponent?.prototype) {
	const proto = ExtensionSelectorComponent.prototype as unknown as {
		options: string[];
		selectedIndex: number;
		listContainer: { clear(): void; addChild(c: unknown): void };
		updateList(): void;
	};
	patchOnce(proto, "updateList", (origUpdateList) => function (this: typeof proto) {
		const th = activeTheme();
		if (!th) return origUpdateList.call(this); // no theme yet -> pi's default
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const text =
				i === this.selectedIndex
					? th.fg("accent", "❯ ") + selectRowText(this.options[i]!, th)
					: `  ${th.fg("text", this.options[i]!)}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	});
}

export default function uiRenderTweaks(pi: ExtensionAPI) {
	// The active theme is re-read per session (ctx.ui.theme); render reads it lazily.
	pi.on("session_start", async (_event, ctx) => {
		const th = themeOf<Exclude<ActiveTheme, null>>(ctx);
		if (th) setActiveTheme(th);
		clearThinkingTicker();
	});

	pi.on("agent_end", async () => {
		clearThinkingTicker();
	});

	pi.on("session_shutdown", async () => {
		clearThinkingTicker();
	});

	// 4. `pi-jev-eye-review` contract message: use our own border box.
	// Collapsed by default: [pi-jev-eye] Reviewed turn contract. [click to expand]
	// On click: the full contract content appears inside the box.
	pi.registerMessageRenderer("pi-jev-eye-review", (message, { expanded }, th) => {
		const raw = customMessageText(message.content);
		return new JevReviewBoxComponent(raw, Boolean(expanded), th);
	});
}

// "Package Updates Available" notification: pi wraps the text in a DynamicBorder
// (full lines, not a box). Replaced with an arnative box (╭─╮ │ ╰─╯) through an
// InteractiveMode prototype patch; the yellow (warning) title and border stay, the
// body text is unchanged.
export class PackageUpdateBoxComponent implements Component {
	private packages: string[];
	private th: { fg(c: string, t: string): string } | null;

	constructor(packages: string[], th: { fg(c: string, t: string): string } | null) {
		this.packages = packages;
		this.th = th;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.th;
		const fg = (color: string, text: string) => (th ? th.fg(color, text) : text);
		const rows = [
			fg("warning", "\x1b[1m\uf449 Package Updates Available\x1b[22m"),
			`${fg("muted", "Package updates are available. Run ")}${fg("accent", "pi update --extensions")}`,
			fg("muted", "Packages:"),
			...this.packages.map((pkg) => `- ${pkg}`),
		];
		return renderBoxLines(th, width, rows, undefined, "warning");
	}
}

if (InteractiveMode?.prototype) {
	const proto = InteractiveMode.prototype as unknown as {
		showPackageUpdateNotification(packages: string[]): void;
	};
	patchOnce(proto, "showPackageUpdateNotification", () => function (this: typeof proto, packages: string[]) {
		const self = this as unknown as {
			chatContainer: { addChild(c: unknown): void };
			ui: { requestRender(): void };
		};
		self.chatContainer.addChild(new Spacer(1));
		self.chatContainer.addChild(new PackageUpdateBoxComponent(packages, activeTheme()));
		self.ui.requestRender();
	});
}

// arnative box border helper -> lib/box.ts (one definition for every box)

// 7. Status rows above the chat column (pi's `aboveEditor` widget slot). pi turns a string
// array into unstyled `Text`, so an extension's status line ignores the theme and lands in
// the default foreground. Every such array is handed to a component factory instead, which
// receives the live theme: the arnative mark leads the block and every row is `dim`.
if (InteractiveMode?.prototype) {
	const proto = InteractiveMode.prototype as unknown as {
		setExtensionWidget(key: string, content: unknown, options?: { placement?: string }): void;
		renderWidgets?(): void;
	};
	patchOnce(proto, "setExtensionWidget", (origSetWidget) => function (
		this: typeof proto,
		key: string,
		content: unknown,
		options?: { placement?: string },
	) {
		const ui = (this as unknown as { ui?: { requestRender(): void } }).ui;
		if (ui) thinkingState.ui = ui;
		if (Array.isArray(content) && content.every((line) => typeof line === "string")) {
			const rows = content as string[];
			content = (_tui: unknown, th: Parameters<typeof statusRows>[0]) => ({
				dispose() {
					/* no listeners, no timers */
				},
				invalidate() {
					/* the rows are fixed at set time */
				},
				render(width: number): string[] {
					return statusRows(th ?? activeTheme(), rows, width);
				},
			});
		}
		return origSetWidget.call(this, key, content, options);
	});
	if (typeof proto.renderWidgets === "function") {
		patchOnce(proto, "renderWidgets", (origRenderWidgets) => function (this: typeof proto) {
			const ui = (this as unknown as { ui?: { requestRender(): void } }).ui;
			if (ui) thinkingState.ui = ui;
			return origRenderWidgets.call(this);
		});
	}
}

class JevReviewBoxComponent implements Component {
	private text: string;
	private th: { fg(c: string, t: string): string; bg?(c: string, t: string): string };
	public isExpanded: boolean;

	constructor(text: string, isExpanded: boolean, th: { fg(c: string, t: string): string; bg?(c: string, t: string): string }) {
		this.text = text;
		this.isExpanded = isExpanded;
		this.th = th;
	}

	render(width: number): string[] {
		const tag = this.th.fg("customMessageLabel", "\x1b[1m[pi-jev-eye]\x1b[22m");
		if (!this.isExpanded) {
			const title = this.th.fg("customMessageText", "Reviewed turn contract.");
			const hint = this.th.fg("dim", "[click to expand]");
			return renderBoxLines(this.th, width, [`${tag} ${title} ${hint}`]);
		}
		// Expanded: show every content line
		const lines = this.text.split("\n");
		const formattedRows = lines.map((line, idx) => {
			if (idx === 0 && line.startsWith("[pi-jev-eye]")) {
				const rest = line.slice("[pi-jev-eye]".length).trim();
				return `${tag} ${this.th.fg("customMessageText", rest)}`;
			}
			return this.th.fg("customMessageText", line);
		});
		return renderBoxLines(this.th, width, formattedRows);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click" && event.button === "left") {
			this.isExpanded = !this.isExpanded;
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {}
}

// 3. Compaction message: one line instead of three (label, spacer, text).
// The theme is used so colors match pi's own box; before the session starts (no
// proxy yet) the built-in renderer keeps working.
export function compactionLine(th: { fg(c: string, t: string): string }, tokenStr: string): string {
	const label = th.fg("customMessageLabel", "\x1b[1m[compaction]\x1b[22m");
	return `${label} ${th.fg("customMessageText", `Compacted from ${tokenStr} tokens (`)}${th.fg("dim", expandKeyName())}${th.fg(
		"customMessageText",
		" to expand)",
	)}`;
}

// Custom message content: a plain string, or concatenated text blocks (image blocks dropped).
export function customMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((c) => (c as { type?: string })?.type === "text")
			.map((c) => (c as { text?: string }).text ?? "")
			.join("\n");
	return "";
}

if (CompactionSummaryMessageComponent?.prototype) {
	const proto = CompactionSummaryMessageComponent.prototype as any;
	patchOnce(proto, "updateDisplay", (origUpdateDisplay) => function (this: any): void {
		const th = activeTheme();
		if (!th) return origUpdateDisplay.call(this);
		const message = this.message as { tokensBefore?: number; summary?: string } | undefined;
		const tokenStr = Number(message?.tokensBefore ?? 0).toLocaleString();
		this.clear();
		const content = new Container();
		if (this.expanded) {
			content.addChild(new Text(th.fg("customMessageLabel", "\x1b[1m[compaction]\x1b[22m"), 0, 0));
			content.addChild(new Spacer(1));
			content.addChild(
				new Markdown(
					`**Compacted from ${tokenStr} tokens**\n\n${message?.summary ?? ""}`,
					0,
					0,
					this.markdownTheme ?? getMarkdownTheme(),
					{ color: (t: string) => th.fg("customMessageText", t) },
				),
			);
		} else {
			content.addChild(new Text(compactionLine(th, tokenStr), 0, 0));
		}
		this.addChild(
			new MouseRegion(content, (event: any) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	});
}

// 8. Hidden thinking label (`AssistantMessageComponent`): pi renders plain `Thinking...`
// in `thinkingText`. Arnative replaces pi's default `"Thinking..."` label with `\uec21`
// in `accent`, `Thinking...` in `dim`, and animates `.` -> `..` -> `...` while that
// thinking run is actively streaming. Finished or non-default labels stay static.
const THINKING_ICON = "\uec21";
const THINKING_DOTS = [".", "..", "..."] as const;
const THINKING_DOT_MS = 400;

const thinkingState: ThinkingLabelState = (getRuntime().thinkingLabelState ??= {
	ui: null,
	active: new Set<object>(),
	starts: new WeakMap<object, number[]>(),
	finished: new WeakMap<object, Array<string | undefined>>(),
	timer: null,
});

function stopThinkingTicker(): void {
	if (thinkingState.timer) {
		clearInterval(thinkingState.timer);
		thinkingState.timer = null;
	}
}

export function clearThinkingTicker(): void {
	thinkingState.active.clear();
	thinkingState.starts = new WeakMap<object, number[]>();
	thinkingState.finished = new WeakMap<object, Array<string | undefined>>();
	stopThinkingTicker();
}

// Clear any leftover timer on module reload so old closures never keep ticking.
clearThinkingTicker();

function syncThinkingTicker(): void {
	if (thinkingState.active.size === 0) {
		stopThinkingTicker();
		return;
	}
	if (thinkingState.timer) return;
	thinkingState.timer = setInterval(() => {
		if (thinkingState.active.size === 0) {
			stopThinkingTicker();
			return;
		}
		thinkingState.ui?.requestRender?.();
	}, THINKING_DOT_MS);
	thinkingState.timer.unref?.();
}

export function thinkingDotsAt(now: number, startMs: number): string {
	const elapsed = Math.max(0, now - startMs);
	const step = Math.floor(elapsed / THINKING_DOT_MS) % THINKING_DOTS.length;
	return THINKING_DOTS[step]!;
}

// A finished run states what it did and how long it took, so the collapsed block stops
// claiming to be thinking once the answer has started. Seconds below a minute, then
// `Xm Ys`; a run always lasts at least one second, never `0s`.
export function formatThinkingElapsed(ms: number): string {
	const total = Math.max(1, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function formatThinkingLabel(
	th: { fg(color: string, text: string): string; italic?(text: string): string } | null,
	dots = "...",
	finished?: string,
): string {
	const icon = th ? th.fg("dim", THINKING_ICON) : THINKING_ICON;
	const label = finished ?? `Thinking${dots}`;
	const styledLabel = th ? (th.italic ? th.italic(th.fg("dim", label)) : th.fg("dim", label)) : label;
	return `${icon} ${styledLabel}`;
}

export function activeThinkingRunIndex(
	message: { content?: Array<{ type?: string; text?: string; thinking?: string }> } | undefined,
	isStreaming: boolean,
): number | null {
	if (!isStreaming || !Array.isArray(message?.content)) return null;
	let runIdx = -1;
	let lastVisibleKind: "thinking" | "other" | null = null;
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (!block) continue;
		if (block.type === "thinking") {
			let hasText = false;
			for (; i < message.content.length; i++) {
				const b = message.content[i];
				if (b?.type !== "thinking") break;
				if (typeof b.thinking === "string" && b.thinking.trim()) hasText = true;
			}
			i--;
			if (hasText) {
				runIdx++;
				lastVisibleKind = "thinking";
			}
		} else if ((block.type === "text" && typeof block.text === "string" && block.text.trim()) || block.type === "toolCall") {
			lastVisibleKind = "other";
		}
	}
	return lastVisibleKind === "thinking" && runIdx >= 0 ? runIdx : null;
}

class ThinkingLabelComponent implements Component {
	private inner: Text;
	private isActive: boolean;
	private startMs: number | undefined;
	private finished: string | undefined;
	private getTheme: () => ActiveTheme;

	constructor(
		padX: number,
		isActive: boolean,
		startMs: number | undefined,
		getTheme: () => ActiveTheme,
		finished?: string,
	) {
		this.isActive = isActive;
		this.startMs = startMs;
		this.finished = finished;
		this.getTheme = getTheme;
		this.inner = new Text(this.labelText(), padX, 0);
	}

	private labelText(): string {
		const dots = this.isActive ? thinkingDotsAt(Date.now(), this.startMs ?? Date.now()) : "...";
		return formatThinkingLabel(this.getTheme(), dots, this.isActive ? undefined : this.finished);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	render(width: number): string[] {
		this.inner.setText(this.labelText());
		return this.inner.render(width);
	}
}

function isPlainTextComponent(c: unknown): boolean {
	if (!c || typeof c !== "object") return false;
	const ctorName = (c as { constructor?: { name?: string } }).constructor?.name;
	if (ctorName === "Text") return true;
	return "text" in c && typeof (c as { text?: unknown }).text === "string" && !("theme" in c);
}

function patchThinkingInAssistantMessage(comp: {
	contentContainer?: { children?: unknown[] };
	lastMessage?: { content?: Array<{ type?: string; text?: string; thinking?: string }> };
	isStreaming?: boolean;
	hiddenThinkingLabel?: string;
	outputPad?: number;
}): boolean {
	const th = activeTheme();
	if (!th || (comp.hiddenThinkingLabel ?? "Thinking...") !== "Thinking...") {
		thinkingState.active.delete(comp);
		syncThinkingTicker();
		return false;
	}
	const activeRunIdx = activeThinkingRunIndex(comp.lastMessage, Boolean(comp.isStreaming));
	const children = comp.contentContainer?.children ?? [];
	const starts = thinkingState.starts.get(comp) ?? [];
	const finished = thinkingState.finished.get(comp) ?? [];
	let runIdx = 0;
	let anyActive = false;
	let anyReplaced = false;
	for (const child of children) {
		if (!child || typeof child !== "object" || !("child" in child) || !("onMouse" in child)) continue;
		const region = child as { child: unknown };
		if (isPlainTextComponent(region.child)) {
			const isActive = activeRunIdx === runIdx;
			if (isActive) {
				anyActive = true;
				starts[runIdx] ??= Date.now();
			} else if (starts[runIdx] !== undefined && finished[runIdx] === undefined) {
				// The run just ended: keep how long it took, so the settled label reads
				// `Thought for 3s` instead of claiming to still think.
				finished[runIdx] = `Thought for ${formatThinkingElapsed(Date.now() - starts[runIdx]!)}`;
			}
			region.child = new ThinkingLabelComponent(
				comp.outputPad ?? 1,
				isActive,
				starts[runIdx],
				activeTheme,
				finished[runIdx],
			);
			anyReplaced = true;
		}
		runIdx++;
	}
	thinkingState.starts.set(comp, starts);
	thinkingState.finished.set(comp, finished);
	if (anyActive) thinkingState.active.add(comp);
	else thinkingState.active.delete(comp);
	syncThinkingTicker();
	return anyReplaced;
}

if (AssistantMessageComponent?.prototype?.updateContent) {
	const proto = AssistantMessageComponent.prototype as any;
	patchOnce(proto, "updateContent", (origUpdateContent) => function (this: any, message: unknown, isStreaming?: boolean) {
		const res = origUpdateContent.call(this, message, isStreaming);
		patchThinkingInAssistantMessage(this);
		return res;
	});
}

export const __test = {
	RELOAD_BOX_MAX_LINES,
};
