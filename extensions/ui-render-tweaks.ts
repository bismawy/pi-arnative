/**
 * Five small patches to pi's fullscreen renderer (render layer only, session data
 * untouched):
 * 1. Hide pi's built-in "Reloading keybindings, extensions, skills..." box
 *    (hardcoded in handleReloadCommand, no auto-hide).
 * 2. Drag selection: pi only wraps the selection in reverse video (\x1b[7m), which
 *    is unreadable in some terminals/themes. Replaced with explicit colors
 *    (bg selectedBg + fg text) so text always stays visible.
 * 3. Compaction message: pi's built-in is label + blank line + text (3 lines);
 *    we squeeze it into one line: `[compaction] Compacted from N tokens (ctrl+o to expand)`.
 * 4. Custom `pi-jev-eye-review` message: pi adds a `[pi-jev-eye-review]` label +
 *    blank line inside a purple box; our renderer shows the content as-is.
 * 5. `↓ Jump to latest message` pill (fullscreen): bg selectedBg (grey) -> accent,
 *    text darkened (theme canvas) so contrast stays high (9.6:1).
 */
import {
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	initTheme,
	InteractiveMode,
	keyText,
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
import { ansiBgOpen } from "../lib/ansi.ts";
export { ansiBgOpen };

let activeThemeProxy: { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null = null;

// Hide pi's built-in "Reloading keybindings, extensions, skills..." box
// (hardcoded in handleReloadCommand, no auto-hide). Patches Container.render
// through the prototype chain (Container is not exported) and drops the whole box on match.
export function shouldHideReloadBox(lines: readonly string[]): boolean {
	return lines.some((l) => l.includes("Reloading keybindings"));
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
// (grey). Switched to accent bg + darkened canvas text (contrast 9.6:1, WCAG AA).
// Note: pi only has 7 background tokens (selectedBg/userMessageBg/customMessageBg/
// toolPendingBg/toolSuccessBg/toolErrorBg/searchMatchBg) — `accent` is a text
// token, so the SGR escapes are swapped. `bg("accent")` would throw "Unknown theme
// background color" and the pill would silently stay unchanged.
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
	if (!accentBg || !inkFg) return text; // token tak ada di tema -> biarkan bawaan pi
	return `${accentBg}${inkFg}${text.replace(/\x1b\[[0-9;]*m/g, "")}\x1b[39m\x1b[49m`;
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
			const fgOpen = ansiFgOpen(activeThemeProxy);
			const bgOpen = ansiBgOpen(activeThemeProxy, "selectedBg");
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
			return withAccentPill(this, () => origComposite.call(this, screen, layout, width), activeThemeProxy);
		};
	}
}

export default function uiRenderTweaks(pi: ExtensionAPI) {
	// The active theme is re-read per session (ctx.ui.theme); render reads it lazily.
	pi.on("session_start", async (_event, ctx) => {
		activeThemeProxy = ((ctx as unknown as { ui?: { theme?: typeof activeThemeProxy } }).ui?.theme) ?? activeThemeProxy;
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
	private th: { fg(c: string, t: string): string };

	constructor(packages: string[], th: { fg(c: string, t: string): string }) {
		this.packages = packages;
		this.th = th;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.th;
		const rows = [
			th.fg("warning", "\x1b[1m\uf449  Package Updates Available\x1b[22m"),
			`${th.fg("muted", "Package updates are available. Run ")}${th.fg("accent", "pi update --extensions")}`,
			th.fg("muted", "Packages:"),
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
		self.chatContainer.addChild(new PackageUpdateBoxComponent(packages, activeThemeProxy ?? Theme));
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
	return `${label} ${th.fg("customMessageText", `Compacted from ${tokenStr} tokens (`)}${th.fg("dim", expandKey())}${th.fg(
		"customMessageText",
		" to expand)",
	)}`;
}

// Button text follows the active keybinding; outside a pi session keyText() is empty.
function expandKey(): string {
	try {
		return keyText("app.tools.expand") || "ctrl+o";
	} catch {
		return "ctrl+o";
	}
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
		const th = activeThemeProxy;
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
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"));
if (isMain) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};
	// reload box fully hidden (not line by line)
	assert(shouldHideReloadBox(["╭──╮", "│ Reloading keybindings, extensions, skills... │"]) === true, "box reload terdeteksi");
	assert(shouldHideReloadBox(["hello", "world"]) === false, "baris biasa lolos");

	// selection: reverse video replaced with explicit colors (bg selectedBg + fg text)
	assert(
		recolorSelection("\x1b[7mhi\x1b[27m", "<F>", "<B>") === "<F><B>hi\x1b[39m\x1b[49m",
		"recolorSelection: buka dgn fg+bg, tutup dgn reset fg+bg",
	);
	assert(recolorSelection("plain", "<F>", "<B>") === "plain", "tanpa reverse video: tak berubah");
	assert(ansiFgOpen(null) === "", "tanpa tema: fgOpen kosong");
	assert(ansiFgOpen({ fg: (_c, t) => `\x1b[38;2;1;2;3m${t}\x1b[39m` }) === "\x1b[38;2;1;2;3m", "fgOpen terambil dari probe tema");
	assert(ansiBgOpen({ bg: (_c, t) => `\x1b[48;2;9;9;9m${t}\x1b[49m` }, "selectedBg") === "\x1b[48;2;9;9;9m", "bgOpen selectedBg terambil");

	// "Jump to latest message" pill: accent bg + canvas text (not grey selectedBg).
	// Use the REAL theme: the permissive stub would let `bg("accent")` through,
	// which pi throws on.
	const temaJson = JSON.parse(readFileSync(new URL("../themes/arnative.json", import.meta.url), "utf8")) as {
		vars: Record<string, string>;
		colors: Record<string, string>;
	};
	const hex = (tok: string) => temaJson.vars[temaJson.colors[tok] ?? tok];
	// The built-in theme adds fallbacks (scrollbarTrack<-muted, thinkingMax<-thinkingXhigh),
	// so the fg map must be complete; take the whole palette like pi's loader does.
	const fgPalet = Object.fromEntries(Object.entries(temaJson.colors).map(([k, v]) => [k, temaJson.vars[v] ?? v]));
	const thPil = new Theme(fgPalet, { toolPendingBg: hex("toolPendingBg"), selectedBg: hex("selectedBg") }, "truecolor");
	const pilAsli = thPil.bg("selectedBg", thPil.fg("text", " ↓ Jump to latest message · End "));
	const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
	assert(
		accentPill(pilAsli, thPil) ===
			`\x1b[48;2;${rgb(hex("accent"))}m\x1b[38;2;${rgb(hex("toolPendingBg"))}m ↓ Jump to latest message · End \x1b[39m\x1b[49m`,
		"pil: bg aksen + teks kanvas, ANSI lama dibuang",
	);
	let ditolak = false;
	try {
		thPil.bg("accent", "x");
	} catch {
		ditolak = true;
	}
	assert(ditolak, "pi memang menolak bg('accent') -> arah SGR harus ditukar");
	assert(accentPill("teks lain", thPil) === "teks lain", "pil: teks non-pil tak disentuh");
	assert(accentPill(pilAsli, null) === pilAsli, "pil: tanpa tema -> apa adanya");

	// Theme variants: every themes/*.json must be valid — name = file name, all
	// required colors present, valid hex, and contrast measured against that theme's
	// own canvas (userMessageBg): content >= 3.0, secondary text >= 2.0, thinking
	// ramp 1.3-4.0, accent pill >= 4.5 — the thresholds that already pass in the
	// base `arnative` (not invented numbers).
	const dirTema = new URL("../themes/", import.meta.url);
	const wajib = Object.keys(temaJson.colors);
	// Non-text keys (backgrounds/borders/scrollbar) — contrast is not measured.
	const bukanTeks = new Set([
		"selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
		"searchMatchBg", "border", "borderAccent", "borderMuted", "mdCodeBlockBorder", "mdQuoteBorder",
		"scrollbarTrack", "scrollbarThumb",
	]);
	const sekunder = new Set(["muted", "dim", "mdQuote", "mdHr", "mdLinkUrl", "toolOutput", "toolDiffContext", "thinkingText", "syntaxComment"]);
	// Thinking ramp: the higher the more readable; thinkingMax = accent (measured on the pill path).
	const ramp: Record<string, number> = {
		thinkingOff: 1.3, thinkingMinimal: 1.3, thinkingLow: 2.0,
		thinkingMedium: 2.7, thinkingHigh: 3.6, thinkingXhigh: 4.0,
	};
	const luminansi = (h: string) => {
		const ch = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) =>
			c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
		);
		return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
	};
	const kontras = (a: string, b: string) => {
		const [x, y] = [luminansi(a), luminansi(b)].sort((m, n) => n - m);
		return (x! + 0.05) / (y! + 0.05);
	};
	for (const f of readdirSync(dirTema).filter((n) => n.endsWith(".json")).sort()) {
		const d = JSON.parse(readFileSync(new URL(f, dirTema), "utf8")) as {
			name: string;
			vars: Record<string, string>;
			colors: Record<string, string>;
		};
		assert(d.name === f.replace(/\.json$/, ""), `tema ${f}: name = nama berkas`);
		const kurang = wajib.filter((k) => !(k in d.colors));
		assert(kurang.length === 0, `tema ${f}: warna wajib lengkap (kurang ${kurang.join(",")})`);
		// colors values may only be: hex, 256-index, empty, or a REAL variable name —
		// a bare color name (e.g. "muted") makes pi reject the theme with no clear reason.
		for (const [tok, nilai] of Object.entries(d.colors)) {
			if (typeof nilai !== "string") continue;
			if (nilai === "" || /^#[0-9a-f]{6}$/i.test(nilai) || nilai in d.vars) continue;
			assert(false, `tema ${f}: colors.${tok} = "${nilai}" bukan hex/var`);
		}
		const hex = (tok: string) => d.vars[d.colors[tok] ?? tok] ?? d.colors[tok];
		for (const tok of ["accent", "text", "selectedBg", "toolPendingBg"]) {
			assert(/^#[0-9a-f]{6}$/i.test(hex(tok)), `tema ${f}: ${tok} hex (${hex(tok)})`);
		}
		// Accent pill: accent bg + toolPendingBg colored text.
		assert(kontras(hex("accent"), hex("toolPendingBg")) >= 4.5, `tema ${f}: kontras accent vs toolPendingBg >= 4.5`);
		assert(/^#[0-9a-f]{6}$/i.test(d.vars.softCyan ?? ""), `tema ${f}: vars.softCyan (tint) hex`);
		const kanvas = hex("userMessageBg");
		for (const tok of Object.keys(d.colors)) {
			if (bukanTeks.has(tok) || tok === "thinkingMax") continue;
			const warna = hex(tok);
			if (!/^#[0-9a-f]{6}$/i.test(warna)) continue; // indeks 256 warna: biarkan pi yang menilai
			const batas = ramp[tok] ?? (sekunder.has(tok) ? 2.0 : 3.0);
			const c = kontras(warna, kanvas);
			assert(c >= batas, `tema ${f}: kontras ${tok} vs kanvas ${c.toFixed(2)} < ${batas}`);
		}
		// Tool box text must be readable on the success background AND in errors, and
		// the error text in the error box — three pairs that used to pass (3.48-4.46)
		// without being caught.
		for (const [fg, bg] of [
			["toolOutput", "toolSuccessBg"], ["toolOutput", "toolErrorBg"],
			["error", "toolErrorBg"], ["toolDiffRemoved", "toolErrorBg"],
		] as const) {
			const c = kontras(hex(fg), hex(bg));
			assert(c >= 4.5, `tema ${f}: kontras ${fg} di ${bg} ${c.toFixed(2)} < 4.5`);
		}
		// The error box must not be heavier than the success box (matching background luminance).
		const [lErr, lOk] = [luminansi(hex("toolErrorBg")), luminansi(hex("toolSuccessBg"))];
		assert(Math.abs(lErr - lOk) / Math.max(lErr, lOk) <= 0.25, `tema ${f}: bobot toolErrorBg vs toolSuccessBg (${lErr.toFixed(3)} vs ${lOk.toFixed(3)})`);
		// Scrollbar thumb & highlight must be distinguishable from track/selection (they used to be identical).
		assert(hex("scrollbarThumb") !== hex("scrollbarTrack"), `tema ${f}: scrollbarThumb masih sama dengan scrollbarTrack`);
		assert(hex("searchMatchBg") !== hex("selectedBg"), `tema ${f}: searchMatchBg masih sama dengan selectedBg`);
	}
	const thKosong = new Theme(
		{ muted: "#808080", text: "#d4d4d4", thinkingXhigh: "#20caee" },
		{ selectedBg: "#3a3a4a" },
		"truecolor",
	);
	assert(accentPill(pilAsli, thKosong) === pilAsli, "pil: token absen -> apa adanya");
	const hostPil: { scrollToEndIndicator?: () => string } = { scrollToEndIndicator: () => pilAsli };
	const dalamPil = withAccentPill(hostPil, () => hostPil.scrollToEndIndicator?.(), thPil);
	assert(dalamPil.includes("\x1b[48;2;0;215;255m"), "pil: callback instance disisipi bg aksen");
	assert(hostPil.scrollToEndIndicator?.() === pilAsli, "pil: callback asli dipulihkan setelah render");

	// compaction: pi's three lines -> one
	assert(
		compactionLine({ fg: (_c, t) => t }, "112,247").replace(/\x1b\[[0-9;]*m/g, "") ===
			"[compaction] Compacted from 112,247 tokens (ctrl+o to expand)",
		"compaction: label + teks + petunjuk expand dalam satu baris (tanpa baris kosong)",
	);

	// custom message: content as-is, no extra label/lines
	assert(
		customMessageText("[pi-jev-eye] Reviewed turn contract:\n- Bahasa ikut user") ===
			"[pi-jev-eye] Reviewed turn contract:\n- Bahasa ikut user",
		"isi pesan custom utuh",
	);
	assert(
		customMessageText([
			{ type: "text", text: "a" },
			{ type: "image", data: "x" },
			{ type: "text", text: "b" },
		]) === "a\nb",
		"blok non-teks dibuang",
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
	initTheme(); // markdown + tema internal pi (di sesi nyata sudah aktif)
	uiRenderTweaks(fakePi as any);
	await fakePi.handlers[0]({}, { ui: { theme: { fg: (_c: string, t: string) => t } } });

	const kids: any[] = [];
	const fake = {
		expanded: false,
		message: { tokensBefore: 112247, summary: "**Ringkasan** panjang\n\n- satu" },
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
		"compaction collapsed: tepat satu baris",
	);

	fake.expanded = true;
	CompactionSummaryMessageComponent.prototype.updateDisplay.call(fake as any);
	const expanded = kids[0].render(120);
	assert(
		expanded.length > 1 && expanded.some((l: string) => l.includes("[compaction]")) && expanded.join(" ").includes("Ringkasan"),
		"compaction expanded: label + ringkasan markdown tetap ada",
	);

	const contractCollapsed = fakePi.renderers["pi-jev-eye-review"](
		{ customType: "pi-jev-eye-review", content: "[pi-jev-eye] Reviewed turn contract:\n- Bahasa ikut user" },
		{ expanded: false, outputPad: 1 },
		{ fg: (_c: string, t: string) => t },
	);
	const cLines = contractCollapsed.render(120).map((l: string) => l.trimEnd());
	assert(
		cLines[0].startsWith("╭") && cLines[cLines.length - 1].startsWith("╰") && cLines[1].includes("[click to expand]"),
		"pesan kontrak collapsed: kotak border dengan teks [click to expand]",
	);

	// Package update notification: arnative box, body and yellow kept
	const upd = new PackageUpdateBoxComponent(["github.com/bismawy/pi-arnative", "pkg-dua"], {
		fg: (c: string, t: string) => (c === "warning" ? `\x1b[33m${t}\x1b[39m` : t),
	}).render(60);
	assert(upd[0]!.includes("\x1b[33m") && upd[0]!.includes("╭"), "kotak pembaruan: bingkai bulat + warna warning");
	assert(upd[upd.length - 1]!.includes("╰"), "kotak pembaruan: bingkai bawah");
	assert(upd[1]!.includes("Package Updates Available"), "judul pembaruan di dalam kotak");
	assert(upd[1]!.includes("\uf449"), "ikon \uf449 pada judul pembaruan");
	assert(upd.some((l: string) => l.includes("- github.com/bismawy/pi-arnative")), "daftar paket di dalam kotak");
	assert(upd.every((l: string) => visibleWidth(l) === 60), "kotak pembaruan selebar 60");

	// Test invalidate and the handleMouse click toggle
	contractCollapsed.invalidate();
	const mouseRes = contractCollapsed.handleMouse({ type: "click", button: "left" });
	assert(mouseRes?.handled === true, "klik kiri handled");
	assert(contractCollapsed.isExpanded === true, "klik kiri toggle expanded");
	const toggledLines = contractCollapsed.render(120).map((l: string) => l.trimEnd());
	assert(toggledLines.some((l: string) => l.includes("Bahasa ikut user")), "setelah klik: isi lengkap tampil");

	const contractExpanded = fakePi.renderers["pi-jev-eye-review"](
		{ customType: "pi-jev-eye-review", content: "[pi-jev-eye] Reviewed turn contract:\n- Bahasa ikut user" },
		{ expanded: true, outputPad: 1 },
		{ fg: (_c: string, t: string) => t },
	);
	const expLines = contractExpanded.render(120).map((l: string) => l.trimEnd());
	assert(
		expLines[0].startsWith("╭") && expLines[expLines.length - 1].startsWith("╰") && expLines.some((l: string) => l.includes("Bahasa ikut user")),
		"pesan kontrak expanded: kotak border dengan isi lengkap",
	);
	console.log("ui-render-tweaks.ts self-check OK");
}
