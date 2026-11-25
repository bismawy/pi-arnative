import test from "node:test";
import { assert } from "../helpers/check.ts";
import { AssistantMessageComponent, CompactionSummaryMessageComponent, getMarkdownTheme, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readdirSync, readFileSync } from "node:fs";
import { ansiBgOpen, stripAnsi } from "../../lib/ansi.ts";
import { contrast, hexToRgb, oklchToRgb, parseOklch, rgbToAnsi256, toHex } from "../../lib/color.ts";
import uiRenderTweaks, { shouldHideReloadBox, recolorSelection, ansiFgOpen, accentPill, withAccentPill, selectRowText, PackageUpdateBoxComponent, compactionLine, customMessageText, clearThinkingTicker, thinkingDotsAt, formatThinkingElapsed, formatThinkingLabel, activeThinkingRunIndex, __test } from "../../lib/features/ui-render-tweaks.ts";

const { RELOAD_BOX_MAX_LINES } = __test;

test("lib/features/ui-render-tweaks.ts self-check", async () => {
	// reload box fully hidden (not line by line)
	assert(shouldHideReloadBox(["────", "", " Reloading keybindings, extensions, skills, prompts, themes, and context files... ", "", "────"]) === true, "reload box detected");
	assert(shouldHideReloadBox(["────", "", " Reloading keybindings, extensions,", " skills, prompts, themes, and context files...", "", "────"]) === true, "wrapped reload box detected");
	assert(shouldHideReloadBox(["hello", "the log says Reloading keybindings", "world"]) === false, "chat lines that mention the phrase stay visible");
	assert(shouldHideReloadBox(["hello", "world"]) === false, "normal lines pass through");
	assert(
		shouldHideReloadBox([...Array(RELOAD_BOX_MAX_LINES + 1).fill(""), " Reloading keybindings, extensions, skills, prompts, themes, and context files... "]) === false,
		"a container larger than any reload box is refused before scanning",
	);

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
	const themeJson = JSON.parse(readFileSync(new URL("../../themes/arnative.json", import.meta.url), "utf8")) as {
		vars: Record<string, string>;
		colors: Record<string, string>;
	};
	// Themes store OKLCH; the Theme class shipped in node_modules (0.87.1) only parses
	// hex, so resolve every token through lib/color before constructing it.
	const resolve = (value: string) => toHex(themeJson.vars[value] ?? value);
	const hex = (tok: string) => resolve(themeJson.colors[tok] ?? tok);
	// Mirrors `soften()` (themes/gen-themes.mjs) and `softenColor` (lib/ansi.ts): the soft
	// tier is the base color at L 0.82 with a fifth of its chroma. Both sides read the
	// declared OKLCH string (not the 8-bit hex), so the comparison is not rounded twice.
	const softenToHex = (base: string, scale = 0.35, l = 0.90) => {
		const o = parseOklch(base);
		assert(o !== null, `cannot soften a non-oklch color: ${base}`);
		return toHex(`oklch(${+(l * 100).toFixed(1)}% ${oklchToRgb(l, o.C * scale, o.H).chroma} ${o.H})`);
	};
	// The built-in theme adds fallbacks (scrollbarTrack<-muted, thinkingMax<-thinkingXhigh),
	// so the fg map must be complete; take the whole palette like pi's loader does.
	const fgPalette = Object.fromEntries(
		Object.entries(themeJson.colors)
			.filter(([k]) => k !== "accentSoft")
			.map(([k, v]) => [k, resolve(v)]),
	);
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

	// select rows: `❯` + `·` stay accent, selected text moves to accentSoft
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
	const themesDir = new URL("../../themes/", import.meta.url);
	const required = Object.keys(themeJson.colors);
	// Non-text keys (backgrounds/borders/scrollbar) — contrast is not measured.
	const nonText = new Set([
		"selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
		"searchMatchBg", "border", "borderAccent", "borderMuted", "mdCodeBlockBorder", "mdQuoteBorder", "mdHr",
		"scrollbarTrack", "scrollbarThumb",
	]);
	// Every background a box or a highlight paints. These carry no text contrast
	// requirement, but each must still be *visible*: a box the same color as the
	// terminal canvas is not a box.
	const BOX_TOKENS = [
		"userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
		"selectedBg", "searchMatchBg",
	];
	const secondary = new Set(["muted", "dim", "mdQuote", "mdLinkUrl", "toolOutput", "toolDiffContext", "thinkingText", "syntaxComment"]);
	// Thinking ramp: the higher the more readable; thinkingMax = accent (measured on the pill path).
	const ramp: Record<string, number> = {
		thinkingOff: 1.3, thinkingMinimal: 1.3, thinkingLow: 2.0,
		thinkingMedium: 2.7, thinkingHigh: 3.6, thinkingXhigh: 4.0,
	};
	const isColor = (v: string) => /^#[0-9a-f]{6}$/i.test(v) || parseOklch(v) !== null;
	// The tokens pi's published theme schema allows as keys in `colors`. Pi 1.2.0 validates
	// with `additionalProperties: false`, so ANY other key (arnative's `accentSoft` was the
	// offender) fails the whole theme at startup with "must not have additional properties"
	// and "Theme not found". Arnative's own colors belong in `vars`, referenced from these.
	const SCHEMA_TOKENS = new Set([
		"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
		"muted", "dim", "text", "thinkingText", "scrollbarTrack", "scrollbarThumb",
		"selectedBg", "searchMatchBg", "searchMatchText", "userMessageBg", "userMessageText",
		"customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg",
		"toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink",
		"mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
		"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
		"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
		"syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff",
		"thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
		"thinkingMax", "bashMode",
	]);
	for (const f of readdirSync(themesDir).filter((n) => n.endsWith(".json")).sort()) {
		const d = JSON.parse(readFileSync(new URL(f, themesDir), "utf8")) as {
			$schema?: string;
			name: string;
			vars: Record<string, string>;
			colors: Record<string, string>;
		};
		assert(d.name === f.replace(/\.json$/, ""), `theme ${f}: name = file name`);
		// Pi 1.2.0 validates `colors` strictly; an extra key rejects the theme at startup.
		const rogue = Object.keys(d.colors).filter((k) => !SCHEMA_TOKENS.has(k));
		assert(rogue.length === 0, `theme ${f}: colors has non-schema keys [${rogue.join(", ")}] — move them to vars`);
		assert(
			d.$schema === "https://pi.dev/schemas/theme.schema.json",
			`theme ${f}: $schema must be the published pi.dev theme schema (got ${d.$schema})`,
		);
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
		assert(isColor(d.vars.secondarySoft ?? ""), `theme ${f}: vars.secondarySoft is a color`);
		assert(isColor(d.vars.primary ?? ""), `theme ${f}: vars.primary is a color`);
		assert(isColor(d.vars.secondary ?? ""), `theme ${f}: vars.secondary is a color`);
		// The declared soft vars must equal what the extensions derive at runtime, or the
		// footer label colour drifts from the theme file. `softenToHex` mirrors
		// `soften()` in gen-themes.mjs and `softenColor` in lib/ansi.ts.
		for (const [softName, baseName] of [["accentSoft", "accent"], ["secondarySoft", "secondary"]] as const) {
			const base = d.vars[d.colors[baseName] ?? baseName]!;
			const declared = toHex(d.vars[softName]!);
			const derived = softenToHex(base);
			assert(declared === derived, `theme ${f}: vars.${softName} ${declared} != runtime ${derived} (derived from ${baseName})`);
		}
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
		// Every box must be visible on a pure-black terminal AND survive 256-color
		// quantization. At L 0.19 the panel was `#001817` (1.14:1 on black) and every
		// theme's boxes quantized to cube black (index 16) — invisible in both modes.
		for (const tok of BOX_TOKENS) {
			const color = hex(tok);
			assert(contrast(color, "#000000") >= 1.4, `theme ${f}: ${tok} ${color} is invisible on a black terminal`);
			const quantized = rgbToAnsi256(hexToRgb(color));
			assert(quantized !== 16, `theme ${f}: ${tok} ${color} quantizes to index 16 (pure black) in 256-color mode`);
		}
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

	// Thinking label: accent \uec21 + dim Thinking... + animated . -> .. -> ... while active streaming
	assert(thinkingDotsAt(0, 0) === "." && thinkingDotsAt(400, 0) === ".." && thinkingDotsAt(800, 0) === "..." && thinkingDotsAt(1200, 0) === ".", "thinking dots loop . -> .. -> ...");
	const tLabel = formatThinkingLabel(
		{ fg: (c, t) => `[${c}]${t}[/${c}]`, italic: (t) => `<i>${t}</i>` },
		"..",
	);
	assert(tLabel === "[dim]\uec21[/dim] <i>[dim]Thinking..[/dim]</i>", "thinking label paints icon dim and label dim italic");
	const doneLabel = formatThinkingLabel(
		{ fg: (c, t) => `[${c}]${t}[/${c}]`, italic: (t) => `<i>${t}</i>` },
		"...",
		"Thought for 3s",
	);
	assert(doneLabel === "[dim]\uec21[/dim] <i>[dim]Thought for 3s[/dim]</i>", "a finished run states Thought for Ns, same dim italic paint");
	assert(formatThinkingElapsed(0) === "1s" && formatThinkingElapsed(2999) === "3s", "a short run counts in whole seconds, never 0s");
	assert(formatThinkingElapsed(60_000) === "1m" && formatThinkingElapsed(83_000) === "1m 23s", "a long run adds minutes");

	const fakeThinkingMsg = { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, api: "openai-completions", provider: "test", model: "test", timestamp: 0 };
	const activeComp = new AssistantMessageComponent(undefined, true, getMarkdownTheme(), "Thinking...", 1);
	activeComp.updateContent(fakeThinkingMsg as any, true);
	const stripOsc = (s: string) => stripAnsi(s.replace(/\x1b\][^\x07]*\x07/g, "")).trim();
	const activeLines = activeComp.render(60).map(stripOsc);
	assert(activeLines.some((l) => l.startsWith("\uec21 Thinking.")), "streaming hidden thinking renders \\uec21 Thinking.(. / .. / ...)");
	assert(activeThinkingRunIndex(fakeThinkingMsg, true) === 0, "active thinking run is detected while streaming");
	assert(activeThinkingRunIndex({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "done" }] }, true) === null, "thinking stops animating once answer text begins");

	activeComp.updateContent(fakeThinkingMsg as any, false);
	const doneLines = activeComp.render(60).map(stripOsc);
	assert(
		doneLines.some((l) => l.startsWith("\uec21 Thought for ")),
		"a finished hidden thinking run settles on \uec21 Thought for Ns, not Thinking...",
	);
	clearThinkingTicker();

});
