/**
 * Five small patches to pi's fullscreen renderer (render layer only, session data
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
 *    the `→` marker and `·` separators, selected text in soft.
 */
import {
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	ExtensionSelectorComponent,
	getMarkdownTheme,
	initTheme,
	InteractiveMode,
	Theme,
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	MouseRegion,
	Spacer,
	Text,
	TuiAltScreen,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { readdirSync, readFileSync } from "node:fs";
import { renderBoxLines } from "../lib/box.ts";
import { ansiBgOpen, getActiveTheme, setActiveTheme, stripAnsi, themeOf, accentSoftOf } from "../lib/ansi.ts";
import { assert, isMain } from "../lib/check.ts";
import { contrast, parseOklch, toHex } from "../lib/color.ts";
import { expandKeyName } from "../lib/format.ts";

type ActiveTheme = { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null;
const activeTheme = () => getActiveTheme<Exclude<ActiveTheme, null>>();

// Hide pi's built-in "Reloading keybindings, extensions, skills..." box
// (hardcoded in handleReloadCommand, no auto-hide). Patches Container.render
// through the prototype chain (Container is not exported) and drops the whole box on match.
const RELOAD_TEXT = "Reloading keybindings, extensions, skills, prompts, themes, and context files...";
/**
 * True only for the box itself: border rows, blank spacers and (possibly wrapped) copy of the
 * message. The patch sits on every plain Container, so a bare substring test would blank a
 * whole chat the moment a transcript line mentioned the phrase.
 */
export function shouldHideReloadBox(lines: readonly string[]): boolean {
	const rows = lines.map((l) => stripAnsi(l).trim());
	return rows.some((r) => r.includes("Reloading keybindings")) && rows.every((r) => r === "" || /^[─-]+$/.test(r) || RELOAD_TEXT.includes(r));
}
const RELOAD_BOX_KEY = Symbol.for("pi-arnative.reloadBoxHidden");
if (UserMessageComponent?.prototype && !(globalThis as Record<symbol, boolean>)[RELOAD_BOX_KEY]) {
	(globalThis as Record<symbol, boolean>)[RELOAD_BOX_KEY] = true;
	const containerProto = Object.getPrototypeOf(UserMessageComponent.prototype) as { render?: (width: number) => string[] };
	if (typeof containerProto?.render === "function") {
		const origContainerRender = containerProto.render;
		containerProto.render = function (width: number): string[] {
			const lines = origContainerRender.call(this, width);
			return shouldHideReloadBox(lines) ? [] : lines;
		};
	}
}

// bg open code (no closing reset) -> lib/ansi.ts (single definition).

// Drag selection in pi fullscreen: pi only wraps the selection in reverse video
// (\x1b[7m), unreadable in some terminals/themes. Replaced with explicit colors
// (bg selectedBg + fg text) so text always stays visible.
const SELECTION_COLOR_KEY = Symbol.for("pi-arnative.selectionColorsPatched");

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
const PILL_KEY = Symbol.for("pi-arnative.accentPill");
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

if (TuiAltScreen?.prototype && !(globalThis as Record<symbol, boolean>)[SELECTION_COLOR_KEY]) {
	(globalThis as Record<symbol, boolean>)[SELECTION_COLOR_KEY] = true;
	const origHighlight = TuiAltScreen.prototype.applySelectionHighlight;
	if (typeof origHighlight === "function") {
		TuiAltScreen.prototype.applySelectionHighlight = function (text: string): string {
			const highlighted = origHighlight.call(this, text);
			const fgOpen = ansiFgOpen(activeTheme());
			const bgOpen = ansiBgOpen(activeTheme(), "selectedBg");
			return fgOpen && bgOpen ? recolorSelection(highlighted, fgOpen, bgOpen) : highlighted;
		};
	}
}

if (TuiAltScreen?.prototype && !(globalThis as Record<symbol, boolean>)[PILL_KEY]) {
	(globalThis as Record<symbol, boolean>)[PILL_KEY] = true;
	const proto = TuiAltScreen.prototype as unknown as {
		compositeScrollToEndIndicator?: (screen: string[], layout: unknown, width: number) => string[];
	};
	const origComposite = proto.compositeScrollToEndIndicator;
	if (typeof origComposite === "function") {
		proto.compositeScrollToEndIndicator = function (
			this: { scrollToEndIndicator?: (() => string) | undefined },
			screen: string[],
			layout: unknown,
			width: number,
		) {
			return withAccentPill(this, () => origComposite.call(this, screen, layout, width), activeTheme());
		};
	}
}

// 6. Select menus (ctx.ui.select -> ExtensionSelectorComponent.updateList): pi colors the
// whole selected row accent. Arnative keeps accent on the `→` marker and `·` separators
// and moves the selected text to soft (accent on themes without the token).
const SELECT_ROW_KEY = Symbol.for("pi-arnative.selectRowColors");

/** Selected row body: `·` separators accent, the text around them soft. */
export function selectRowText(row: string, th: { fg(c: string, t: string): string }): string {
	const soft = accentSoftOf(th);
	return row
		.split("·")
		.map((part) => soft(part))
		.join(th.fg("accent", "·"));
}

if (ExtensionSelectorComponent?.prototype && !(globalThis as Record<symbol, boolean>)[SELECT_ROW_KEY]) {
	(globalThis as Record<symbol, boolean>)[SELECT_ROW_KEY] = true;
	const proto = ExtensionSelectorComponent.prototype as unknown as {
		options: string[];
		selectedIndex: number;
		listContainer: { clear(): void; addChild(c: unknown): void };
		updateList(): void;
	};
	const origUpdateList = proto.updateList;
	proto.updateList = function (this: typeof proto) {
		const th = activeTheme();
		if (!th) return origUpdateList.call(this); // no theme yet -> pi's default
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const text =
				i === this.selectedIndex
					? th.fg("accent", "→ ") + selectRowText(this.options[i]!, th)
					: `  ${th.fg("text", this.options[i]!)}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	};
}

export default function uiRenderTweaks(pi: ExtensionAPI) {
	// The active theme is re-read per session (ctx.ui.theme); render reads it lazily.
	pi.on("session_start", async (_event, ctx) => {
		const th = themeOf<Exclude<ActiveTheme, null>>(ctx);
		if (th) setActiveTheme(th);
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

const PACKAGE_BOX_KEY = Symbol.for("pi-arnative.packageUpdateBox");
if (InteractiveMode?.prototype && !(globalThis as Record<symbol, boolean>)[PACKAGE_BOX_KEY]) {
	(globalThis as Record<symbol, boolean>)[PACKAGE_BOX_KEY] = true;
	const proto = InteractiveMode.prototype as unknown as {
		showPackageUpdateNotification(packages: string[]): void;
	};
	proto.showPackageUpdateNotification = function (packages: string[]) {
		const self = this as unknown as {
			chatContainer: { addChild(c: unknown): void };
			ui: { requestRender(): void };
		};
		self.chatContainer.addChild(new Spacer(1));
		self.chatContainer.addChild(new PackageUpdateBoxComponent(packages, activeTheme()));
		self.ui.requestRender();
	};
}

// arnative box border helper -> lib/box.ts (one definition for every box)

export class JevReviewBoxComponent implements Component {
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

const COMPACTION_KEY = Symbol.for("pi-arnative.compactionOneLine");
if (CompactionSummaryMessageComponent?.prototype && !(globalThis as Record<symbol, boolean>)[COMPACTION_KEY]) {
	(globalThis as Record<symbol, boolean>)[COMPACTION_KEY] = true;
	const proto = CompactionSummaryMessageComponent.prototype as any;
	const origUpdateDisplay = proto.updateDisplay;
	proto.updateDisplay = function (): void {
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
	};
}

// Self-check: `node extensions/ui-render-tweaks.ts`
if (isMain(import.meta.url)) {
	// reload box fully hidden (not line by line)
	assert(shouldHideReloadBox(["────", "", " Reloading keybindings, extensions, skills, prompts, themes, and context files... ", "", "────"]) === true, "reload box detected");
	assert(shouldHideReloadBox(["────", "", " Reloading keybindings, extensions,", " skills, prompts, themes, and context files...", "", "────"]) === true, "wrapped reload box detected");
	assert(shouldHideReloadBox(["hello", "the log says Reloading keybindings", "world"]) === false, "chat lines that mention the phrase stay visible");
	assert(shouldHideReloadBox(["hello", "world"]) === false, "normal lines pass through");

	// selection: reverse video replaced with explicit colors (bg selectedBg + fg text)
	assert(
		recolorSelection("\x1b[7mhi\x1b[27m", "<F>", "<B>") === "<F><B>hi\x1b[39m\x1b[49m",
		"recolorSelection: open with fg+bg, close with fg+bg reset",
	);
	assert(recolorSelection("plain", "<F>", "<B>") === "plain", "no reverse video: unchanged");
	assert(ansiFgOpen(null) === "", "no theme: empty fgOpen");
	assert(ansiFgOpen({ fg: (_c, t) => `\x1b[38;2;1;2;3m${t}\x1b[39m` }) === "\x1b[38;2;1;2;3m", "fgOpen taken from the theme probe");
	assert(ansiBgOpen({ bg: (_c, t) => `\x1b[48;2;9;9;9m${t}\x1b[49m` }, "selectedBg") === "\x1b[48;2;9;9;9m", "bgOpen selectedBg taken");

	// "Jump to latest message" pill: accent bg + canvas text (not grey selectedBg).
	// Use the REAL theme: the permissive stub would let `bg("accent")` through,
	// which pi throws on.
	const themeJson = JSON.parse(readFileSync(new URL("../themes/arnative.json", import.meta.url), "utf8")) as {
		vars: Record<string, string>;
		colors: Record<string, string>;
	};
	// Themes store OKLCH; the Theme class shipped in node_modules (0.87.1) only parses
	// hex, so resolve every token through lib/color before constructing it.
	const resolve = (value: string) => toHex(themeJson.vars[value] ?? value);
	const hex = (tok: string) => resolve(themeJson.colors[tok] ?? tok);
	// The built-in theme adds fallbacks (scrollbarTrack<-muted, thinkingMax<-thinkingXhigh),
	// so the fg map must be complete; take the whole palette like pi's loader does.
	const fgPalette = Object.fromEntries(Object.entries(themeJson.colors).map(([k, v]) => [k, resolve(v)]));
	const thPill = new Theme(fgPalette, { toolPendingBg: hex("toolPendingBg"), selectedBg: hex("selectedBg") }, "truecolor");
	const pillOriginal = thPill.bg("selectedBg", thPill.fg("text", " ↓ Jump to latest message · End "));
	const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
	assert(
		accentPill(pillOriginal, thPill) ===
			`\x1b[48;2;${rgb(hex("accent"))}m\x1b[38;2;${rgb(hex("toolPendingBg"))}m ↓ Jump to latest message · End \x1b[39m\x1b[49m`,
		"pill: accent bg + canvas text, old ANSI dropped",
	);
	let rejected = false;
	try {
		thPill.bg("accent", "x");
	} catch {
		rejected = true;
	}
	assert(rejected, "pi really rejects bg('accent') -> the SGR direction must be swapped");
	assert(accentPill("other text", thPill) === "other text", "pill: non-pill text untouched");
	assert(accentPill(pillOriginal, null) === pillOriginal, "pill: no theme -> passed through");

	// select rows: `→` + `·` stay accent, selected text moves to accentSoft
	const tagFg = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
	assert(
		selectRowText("Routing  ·  off", tagFg) === "<accentSoft>Routing  </accentSoft><accent>·</accent><accentSoft>  off</accentSoft>",
		"select row: separators accent, text accentSoft",
	);
	assert(selectRowText("plain", tagFg) === "<accentSoft>plain</accentSoft>", "select row without separators: all accentSoft");

	// Theme variants: every themes/*.json must be valid — name = file name, all
	// required colors present, valid hex, and contrast measured against that theme's
	// own canvas (userMessageBg): content >= 3.0, secondary text >= 2.0, thinking
	// ramp 1.3-4.0, accent pill >= 4.5 — the thresholds that already pass in the
	// base `arnative` (not invented numbers).
	const themesDir = new URL("../themes/", import.meta.url);
	const required = Object.keys(themeJson.colors);
	// Non-text keys (backgrounds/borders/scrollbar) — contrast is not measured.
	const nonText = new Set([
		"selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
		"searchMatchBg", "border", "borderAccent", "borderMuted", "mdCodeBlockBorder", "mdQuoteBorder",
		"scrollbarTrack", "scrollbarThumb",
	]);
	const secondary = new Set(["muted", "dim", "mdQuote", "mdHr", "mdLinkUrl", "toolOutput", "toolDiffContext", "thinkingText", "syntaxComment"]);
	// Thinking ramp: the higher the more readable; thinkingMax = accent (measured on the pill path).
	const ramp: Record<string, number> = {
		thinkingOff: 1.3, thinkingMinimal: 1.3, thinkingLow: 2.0,
		thinkingMedium: 2.7, thinkingHigh: 3.6, thinkingXhigh: 4.0,
	};
	const isColor = (v: string) => /^#[0-9a-f]{6}$/i.test(v) || parseOklch(v) !== null;
	for (const f of readdirSync(themesDir).filter((n) => n.endsWith(".json")).sort()) {
		const d = JSON.parse(readFileSync(new URL(f, themesDir), "utf8")) as {
			name: string;
			vars: Record<string, string>;
			colors: Record<string, string>;
		};
		assert(d.name === f.replace(/\.json$/, ""), `theme ${f}: name = file name`);
		const missing = required.filter((k) => !(k in d.colors));
		assert(missing.length === 0, `theme ${f}: required colors complete (missing ${missing.join(",")})`);
		// colors values may only be: hex, oklch, 256-index, empty, or a REAL variable name —
		// a bare color name (e.g. "muted") makes pi reject the theme with no clear reason.
		for (const [tok, value] of Object.entries(d.colors)) {
			if (typeof value !== "string") continue;
			if (value === "" || isColor(value) || value in d.vars) continue;
			assert(false, `theme ${f}: colors.${tok} = "${value}" is not hex/oklch/var`);
		}
		// Every var must itself be a real color, and no two vars may resolve to the
		// same value — near-identical hand-written hex was the original problem.
		for (const [name, value] of Object.entries(d.vars)) {
			assert(isColor(value), `theme ${f}: vars.${name} is a color (${value})`);
		}
		const seenVar = new Map<string, string>();
		for (const [name, value] of Object.entries(d.vars)) {
			const h = toHex(value);
			assert(!seenVar.has(h), `theme ${f}: vars.${name} duplicates vars.${seenVar.get(h)} (${h})`);
			seenVar.set(h, name);
		}
		const hex = (tok: string) => toHex(d.vars[d.colors[tok] ?? tok] ?? d.colors[tok]!);
		for (const tok of ["accent", "text", "selectedBg", "toolPendingBg"]) {
			assert(isColor(d.vars[d.colors[tok] ?? tok] ?? d.colors[tok]!), `theme ${f}: ${tok} is a color (${hex(tok)})`);
		}
		// Accent pill: accent bg + toolPendingBg colored text.
		assert(contrast(hex("accent"), hex("toolPendingBg")) >= 4.5, `theme ${f}: accent vs toolPendingBg contrast >= 4.5`);
		assert(isColor(d.vars.accentSoft ?? ""), `theme ${f}: vars.accentSoft is a color`);
		const canvas = hex("userMessageBg");
		for (const tok of Object.keys(d.colors)) {
			if (nonText.has(tok) || tok === "thinkingMax") continue;
			const color = hex(tok);
			const limit = ramp[tok] ?? (secondary.has(tok) ? 2.0 : 3.0);
			const c = contrast(color, canvas);
			assert(c >= limit, `theme ${f}: ${tok} vs canvas contrast ${c.toFixed(2)} < ${limit}`);
		}
		// Thinking ramp must rise monotonically (Off < Minimal < … < Xhigh).
		const rampKeys = ["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh"];
		for (let i = 1; i < rampKeys.length; i++) {
			const [lo, hi] = [hex(rampKeys[i - 1]!), hex(rampKeys[i]!)];
			assert(contrast(lo, canvas) < contrast(hi, canvas), `theme ${f}: ${rampKeys[i]} is brighter than ${rampKeys[i - 1]}`);
		}
		// Tool box text must be readable on the success background AND in errors, and
		// the error text in the error box — three pairs that used to pass (3.48-4.46)
		// without being caught.
		for (const [fg, bg] of [
			["toolOutput", "toolSuccessBg"], ["toolOutput", "toolErrorBg"],
			["error", "toolErrorBg"], ["toolDiffRemoved", "toolErrorBg"],
		] as const) {
			const c = contrast(hex(fg), hex(bg));
			assert(c >= 4.5, `theme ${f}: ${fg} on ${bg} contrast ${c.toFixed(2)} < 4.5`);
		}
		// The error box must not be heavier than the success box (matching background luminance).
		const [lErr, lOk] = [hex("toolErrorBg"), hex("toolSuccessBg")].map((h) => {
			const ch = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) =>
				c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
			);
			return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
		});
		assert(Math.abs(lErr! - lOk!) / Math.max(lErr!, lOk!) <= 0.25, `theme ${f}: toolErrorBg vs toolSuccessBg weight (${lErr!.toFixed(3)} vs ${lOk!.toFixed(3)})`);
		// Scrollbar thumb & highlight must be distinguishable from track/selection (they used to be identical).
		assert(hex("scrollbarThumb") !== hex("scrollbarTrack"), `theme ${f}: scrollbarThumb still equals scrollbarTrack`);
		assert(hex("searchMatchBg") !== hex("selectedBg"), `theme ${f}: searchMatchBg still equals selectedBg`);
	}
	// Only `muted`, `text` and `selectedBg` exist. pi's Theme constructor maps whatever
	// it gets — including the thinkingMax <- thinkingXhigh fallback — so these probe
	// values must already be hex: the bundled parser (0.87.1) rejects OKLCH, which is
	// exactly why the real theme self-check resolves through lib/color first.
	const tokenGapTheme = new Theme(
		{ muted: "#808080", text: "#d4d4d4", thinkingXhigh: "#20caee" },
		{ selectedBg: "#3a3a4a" },
		"truecolor",
	);
	assert(accentPill(pillOriginal, tokenGapTheme) === pillOriginal, "pill: token absent -> passed through");
	const hostPil: { scrollToEndIndicator?: () => string } = { scrollToEndIndicator: () => pillOriginal };
	const inPill = withAccentPill(hostPil, () => hostPil.scrollToEndIndicator?.(), thPill);
	assert(inPill.includes(`\x1b[48;2;${rgb(hex("accent"))}m`), "pill: instance callback injected with accent bg");
	assert(hostPil.scrollToEndIndicator?.() === pillOriginal, "pill: original callback restored after render");

	// compaction: pi's three lines -> one
	assert(
		stripAnsi(compactionLine({ fg: (_c, t) => t }, "112,247")) ===
			"[compaction] Compacted from 112,247 tokens (ctrl+o to expand)",
		"compaction: label + text + expand hint on one line (no blank line)",
	);

	// custom message: content as-is, no extra label/lines
	assert(
		customMessageText("[pi-jev-eye] Reviewed turn contract:\n- Language follows the user") ===
			"[pi-jev-eye] Reviewed turn contract:\n- Language follows the user",
		"custom message content intact",
	);
	assert(
		customMessageText([
			{ type: "text", text: "a" },
			{ type: "image", data: "x" },
			{ type: "text", text: "b" },
		]) === "a\nb",
		"non-text blocks dropped",
	);

	// Integration: run the factory like pi, then call updateDisplay / the original renderer
	const fakePi = {
		handlers: [] as any[],
		renderers: {} as Record<string, any>,
		on(_e: string, h: any) {
			this.handlers.push(h);
			return () => {};
		},
		registerMessageRenderer(t: string, r: any) {
			this.renderers[t] = r;
		},
	};
	initTheme(); // markdown + pi's internal theme (already active in a real session)
	uiRenderTweaks(fakePi as any);
	await fakePi.handlers[0]({}, { ui: { theme: { fg: (_c: string, t: string) => t } } });

	const kids: any[] = [];
	const fake = {
		expanded: false,
		message: { tokensBefore: 112247, summary: "**Summary** long\n\n- one" },
		clear() {
			kids.length = 0;
		},
		addChild(c: any) {
			kids.push(c);
		},
	};
	CompactionSummaryMessageComponent.prototype.updateDisplay.call(fake as any);
	const collapsed = kids[0].render(120);
	assert(
		collapsed.length === 1 && collapsed[0].trimEnd().endsWith("Compacted from 112,247 tokens (ctrl+o to expand)"),
		"compaction collapsed: exactly one line",
	);

	fake.expanded = true;
	CompactionSummaryMessageComponent.prototype.updateDisplay.call(fake as any);
	const expanded = kids[0].render(120);
	assert(
		expanded.length > 1 && expanded.some((l: string) => l.includes("[compaction]")) && expanded.join(" ").includes("Summary"),
		"compaction expanded: label + markdown summary still there",
	);

	const contractCollapsed = fakePi.renderers["pi-jev-eye-review"](
		{ customType: "pi-jev-eye-review", content: "[pi-jev-eye] Reviewed turn contract:\n- Language follows the user" },
		{ expanded: false, outputPad: 1 },
		{ fg: (_c: string, t: string) => t },
	);
	const cLines = contractCollapsed.render(120).map((l: string) => l.trimEnd());
	assert(
		cLines[0].startsWith("╭") && cLines[cLines.length - 1].startsWith("╰") && cLines[1].includes("[click to expand]"),
		"contract message collapsed: border box with [click to expand]",
	);

	// Package update notification: arnative box, body and yellow kept
	const upd = new PackageUpdateBoxComponent(["github.com/bismawy/pi-arnative", "pkg-two"], {
		fg: (c: string, t: string) => (c === "warning" ? `\x1b[33m${t}\x1b[39m` : t),
	}).render(60);
	assert(upd[0]!.includes("\x1b[33m") && upd[0]!.includes("╭"), "update box: round frame + warning color");
	assert(upd[upd.length - 1]!.includes("╰"), "update box: bottom frame");
	assert(upd[1]!.includes("Package Updates Available"), "update title inside the box");
	assert(upd[1]!.includes("\uf449"), "\uf449 icon on the update title");
	assert(upd.some((l: string) => l.includes("- github.com/bismawy/pi-arnative")), "package list inside the box");
	assert(upd.every((l: string) => visibleWidth(l) === 60), "update box is 60 wide");

	// Test invalidate and the handleMouse click toggle
	contractCollapsed.invalidate();
	const mouseRes = contractCollapsed.handleMouse({ type: "click", button: "left" });
	assert(mouseRes?.handled === true, "left click handled");
	assert(contractCollapsed.isExpanded === true, "left click toggles expanded");
	const toggledLines = contractCollapsed.render(120).map((l: string) => l.trimEnd());
	assert(toggledLines.some((l: string) => l.includes("Language follows the user")), "after the click: full content shown");

	const contractExpanded = fakePi.renderers["pi-jev-eye-review"](
		{ customType: "pi-jev-eye-review", content: "[pi-jev-eye] Reviewed turn contract:\n- Language follows the user" },
		{ expanded: true, outputPad: 1 },
		{ fg: (_c: string, t: string) => t },
	);
	const expLines = contractExpanded.render(120).map((l: string) => l.trimEnd());
	assert(
		expLines[0].startsWith("╭") && expLines[expLines.length - 1].startsWith("╰") && expLines.some((l: string) => l.includes("Language follows the user")),
		"contract message expanded: border box with the full content",
	);
	console.log("ui-render-tweaks.ts self-check OK");
}
