#!/usr/bin/env node
/**
 * Theme generator — the single source of truth for every `themes/*.json`.
 *
 * Each theme is a handful of parameters (accent hue, chroma, canvas lightness,
 * neutral tint) plus optional hue overrides for the strong palettes. The
 * renderer derives every color from a shared OKLCH ramp, so lightness and
 * saturation stay consistent across themes and no two roles collapse to the
 * same value by accident.
 *
 * Usage: node themes/gen-themes.mjs [--check]
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contrast, hexToOklch, parseOklch, oklchToRgb, toHex } from "../lib/color.ts";
import { assert } from "../lib/check.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// Pi 1.2.0 moved the published schema to pi.dev; older releases validated this
// reference only as a string, so the new URL is safe on both.
const SCHEMA = "https://pi.dev/schemas/theme.schema.json";

// --- color helpers ---------------------------------------------------------

const hue = (x) => ((x % 360) + 360) % 360;
const round3 = (x) => +x.toFixed(3);

/** Format OKLCH after gamut-reducing chroma, so the written value renders as-is. */
function oklch(L, C, H) {
	const { chroma } = oklchToRgb(L, C, H);
	return `oklch(${+(L * 100).toFixed(1)}% ${round3(chroma)} ${Math.round(hue(H))})`;
}

/**
 * Soft tier of a color: clone at lightness `l` (default 0.82) with `scale`
 * (default 0.5, matching `SOFT_CHROMA_SCALE` in lib/ansi.ts; the accent tier
 * uses 0.15 at 0.94 lightness — a near-white tint — matching
 * `SOFT_CHROMA_SCALE_ACCENT` and `SOFT_L_ACCENT`) of the GAMUT-CLAMPED
 * chroma, hue kept. `lib/ansi.ts` softens the resolved token with these same
 * recipes at runtime, so `*Soft` vars declared here and the extension's derived
 * values agree. Grey-collapse is avoided because the hue is carried, not dropped.
 *
 * The chroma keeps five decimals (not the usual three): the soft tier multiplies
 * it by the scale, so a coarser round-trip shifts the last hex digit and the
 * `declare == derive` guard in ui-render-tweaks.ts fails.
 */
function soften(value, scale = 0.35, l = 0.90) {
	const o = parseOklch(value);
	assert(o !== null, `cannot soften a non-oklch color: ${value}`);
	const { chroma } = oklchToRgb(l, o.C * scale, o.H);
	return `oklch(${+(l * 100).toFixed(1)}% ${+chroma.toFixed(5)} ${Math.round(hue(o.H))})`;
}

/** Normalize a spec color to an oklch literal: hex is converted, oklch passes through. */
function colorLiteral(value) {
	const s = String(value).trim();
	if (s.startsWith("#")) {
		const o = hexToOklch(s);
		return oklch(o.L, o.C, o.H);
	}
	return s;
}

// --- shared ramps ----------------------------------------------------------

const NEUTRAL = { fg: 0.88, fgMuted: 0.72, fgDim: 0.61, fgFaint: 0.49 };
const THINKING = { off: 0.4, minimal: 0.47, low: 0.55, medium: 0.63, high: 0.71, xhigh: 0.79 };
const SEMANTIC = { success: 145, error: 25, warning: 85 };
const SYNTAX_OFFSET = { keyword: 0, func: 45, variable: -45, string: 120, number: 180, type: 90 };

/** Default hue for a role used outside `syntax*` (heading/link/label/code/bullet/border). */
const ACCENT_OFFSET = {
	heading: 0,
	link: 0,
	label: 60,
	code: 0,
	bullet: 0,
	border: 0,
	selected: 0,
	searchMatch: 0,
};

// --- theme parameters ------------------------------------------------------

/**
 * `accent` is the seed/focus color (OKLCH, hue + reference lightness/chroma);
 * `primary` and `secondary` define the theme's core signature and dual-tone balance;
 * `chroma` is the normalized accent chroma.
 * `hues` overrides the derived hue per role (keyword/func/… /heading/link/label/code/…)
 * to keep rich multi-colored palettes (cyberpunk, synthwave, dracula, etc.) authentic.
 */
const THEMES = {
	arnative: {
		// Cyan & gold: strong-cyan focus, bright-gold signature (primary), school-bus
		// yellow labels, icy-aqua links/code (tone), deep teal message panels.
		accent: "oklch(77% 0.13 193)",
		chroma: 0.13,
		canvasL: 0.27,
		neutralHue: 205,
		neutralChroma: 0.012,
		primary: "oklch(88.8% 0.181 96)",
		secondary: "oklch(84.2% 0.172 86)",
		tone: "oklch(95.1% 0.073 196)",
		// Teal panel, deepened to L:19% for stealth dark contrast.
		surfaceMsg: "oklch(19% 0.04 191)",
		// The label tier follows the accent (soft cyan); the gold signature lives on
		// headings and links instead, so the theme keeps two tones without the label gap.
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "primary",
		codeColor: "tone",
		bulletColor: "accent",
		hues: { heading: 96, label: 96, link: 196, code: 196, bullet: 193, border: 86, selected: 86 },
	},
	"arnative-cyberpunk": {
		// Neon fuchsia focus (#ea00d9, accent), electric cyan headings & model (#0abdc6, primary),
		// deep purple secondary (#711c91, secondary), and deep violet panels.
		accent: "oklch(76% 0.22 332)",
		chroma: 0.22,
		canvasL: 0.24,
		neutralHue: 275,
		neutralChroma: 0.02,
		primary: "oklch(72.7% 0.123 201)",
		secondary: "oklch(42.4% 0.183 314)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "primary",
		codeColor: "accent",
		bulletColor: "accent",
		hues: {
			heading: 201, label: 201, link: 201, code: 332, bullet: 332, border: 201, selected: 201, searchMatch: 332,
			keyword: 332, func: 201, variable: 332, string: 140, number: 45, type: 201,
		},
	},
	"arnative-crimson": {
		// Garnet red focus (#941b0c, accent), fiery burnt orange headings (#bc3908 adjusted to L:58%, primary),
		// golden amber secondary (#f6aa1c, secondary), and deep red-brown panels (#361715, surfaceMsg).
		accent: "oklch(74% 0.16 31)",
		chroma: 0.16,
		canvasL: 0.24,
		neutralHue: 31,
		neutralChroma: 0.015,
		primary: "oklch(58% 0.175 37)",
		secondary: "oklch(79.2% 0.161 75)",
		tone: "oklch(82% 0.14 70)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 37, label: 37, link: 70, code: 70, bullet: 31, border: 75, selected: 75, searchMatch: 31,
			keyword: 31, func: 75, variable: 31, string: 145, number: 75, type: 70,
		},
	},
	"arnative-matrix": {
		// Medium-jungle green focus (#009a22, accent), bright phosphor-green headings & model (#00ff2b, primary),
		// lime green secondary (#36ba01, secondary), and jet-black teal panels (#0a2e36, surfaceMsg).
		// AccentSoft provides the bright, soft matrix pastel green for footer labels.
		accent: "oklch(74% 0.191 144)",
		chroma: 0.19,
		canvasL: 0.24,
		neutralHue: 215,
		neutralChroma: 0.015,
		primary: "oklch(86.7% 0.287 143)",
		secondary: "oklch(69% 0.223 140)",
		tone: "oklch(82% 0.12 175)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "primary",
		hues: {
			heading: 143, label: 143, link: 175, code: 175, bullet: 143, border: 140, selected: 140, searchMatch: 144,
			keyword: 144, func: 143, variable: 175, string: 144, number: 85, type: 175,
		},
	},
	"arnative-neutral": {
		// Grey-olive focus (#8a817c, accent), powder-blush warm headings (#e0afa0, primary),
		// silver grey links/code & secondary (#bcb8b1, secondary), and deep warm-taupe panels.
		accent: "oklch(76% 0.035 51)",
		chroma: 0.035,
		canvasL: 0.24,
		neutralHue: 58,
		neutralChroma: 0.008,
		primary: "oklch(79.5% 0.061 38)",
		secondary: "oklch(78.4% 0.011 82)",
		tone: "oklch(82% 0.015 82)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 38, label: 38, link: 82, code: 82, bullet: 51, border: 82, selected: 82, searchMatch: 51,
			keyword: 51, func: 38, variable: 82, string: 97, number: 51, type: 82,
		},
	},
	"arnative-zinc": {
		// Zinc: ash grey focus (#b8bdb5, accent), cool steel headings & model (#889696, primary),
		// dust grey footer labels & secondary (#d2d4c8, secondary), and deep slate-zinc panels.
		accent: "oklch(79.2% 0.035 133)",
		chroma: 0.035,
		canvasL: 0.25,
		neutralHue: 120,
		neutralChroma: 0.008,
		primary: "oklch(66.2% 0.016 197)",
		secondary: "oklch(86.5% 0.016 114)",
		tone: "oklch(80% 0.03 197)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 197, label: 197, link: 197, code: 197, bullet: 133, border: 114, selected: 114, searchMatch: 133,
			keyword: 133, func: 197, variable: 114, string: 114, number: 114, type: 197,
		},
	},
	"arnative-nord": {
		// Nord polar night: dark slate canvas, polar navy focus (#3c455c adapted to L:76%, accent),
		// frosted blue-grey headings & model (#697d97, primary), slate-purple footer labels (#777696, secondary),
		// and deep slate-blue panels.
		accent: "oklch(76% 0.06 268)",
		chroma: 0.06,
		canvasL: 0.26,
		neutralHue: 255,
		neutralChroma: 0.012,
		primary: "oklch(58.3% 0.047 255)",
		secondary: "oklch(57.8% 0.049 286)",
		tone: "oklch(80% 0.05 194)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 255, label: 255, link: 194, code: 194, bullet: 268, border: 286, selected: 286, searchMatch: 268,
			keyword: 268, func: 255, variable: 286, string: 131, number: 286, type: 194,
		},
	},
	"arnative-dracula": {
		// Dracula: night canvas #282a36 with #44475a panels, pink focus #ff80bf (accent),
		// purple headings & model name #9580ff (primary), bright yellow footer labels #ffff80 (secondary),
		// cyan links and code #8be9fd (tone).
		accent: "oklch(76.2% 0.168 351)",
		chroma: 0.17,
		canvasL: 0.28,
		neutralHue: 278,
		neutralChroma: 0.012,
		primary: "oklch(67.8% 0.181 288)",
		secondary: "oklch(97.5% 0.149 109)",
		tone: "oklch(86% 0.09 213)",
		surfaceMsg: "primary",
		borderAccent: "secondary",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 288, label: 288, link: 213, code: 213, bullet: 351, border: 109, selected: 109, searchMatch: 351,
			keyword: 351, func: 142, variable: 288, string: 109, number: 109, type: 213,
		},
	},
	"arnative-gruvbox": {
		// Gruvbox dark: warm canvas #282828 with #3c3836 panels, yellow focus #eebd35 (accent),
		// red headings & model #d83328 (derived from #cc241d, primary), blue-grey footer labels #458588 (secondary),
		// aqua links and code #83a598 (tone).
		accent: "oklch(82% 0.153 88)",
		chroma: 0.15,
		canvasL: 0.25,
		neutralHue: 60,
		neutralChroma: 0.008,
		primary: "oklch(58% 0.203 29)",
		secondary: "oklch(57.6% 0.066 199)",
		tone: "oklch(78% 0.045 170)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 29, label: 29, link: 170, code: 170, bullet: 88, border: 199, selected: 199, searchMatch: 88,
			keyword: 29, func: 111, variable: 88, string: 83, number: 29, type: 199,
		},
	},
	"arnative-magical": {
		// Magical: vivid lavender focus (#b892ff, accent), pastel rose/pink headings & model (#ff90b3, primary),
		// deep vivid purple secondary (#6e44ff, secondary), and deep rose-wine panels.
		accent: "oklch(73.9% 0.157 299)",
		chroma: 0.16,
		canvasL: 0.24,
		neutralHue: 300,
		neutralChroma: 0.015,
		primary: "oklch(78.1% 0.139 1)",
		secondary: "oklch(55.5% 0.257 285)",
		tone: "oklch(84% 0.10 320)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 1, label: 1, link: 320, code: 320, bullet: 299, border: 285, selected: 285, searchMatch: 299,
			keyword: 285, func: 1, variable: 299, string: 140, number: 285, type: 320,
		},
	},
	"arnative-lemonade": {
		// Lemonade: soft sage focus (#aac0aa, accent), warm peach-orange headings & model (#f4b886, primary),
		// bright lime-lemon secondary (#cbe896, secondary), and deep peach-wood panels.
		accent: "oklch(79% 0.06 148)",
		chroma: 0.06,
		canvasL: 0.24,
		neutralHue: 61,
		neutralChroma: 0.012,
		primary: "oklch(82.6% 0.095 61)",
		secondary: "oklch(89.1% 0.11 124)",
		tone: "oklch(85% 0.08 124)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 61, label: 61, link: 124, code: 124, bullet: 148, border: 124, selected: 124, searchMatch: 148,
			keyword: 148, func: 61, variable: 124, string: 124, number: 61, type: 124,
		},
	},
	"arnative-blossom": {
		// Blossom: crimson rose focus (#dd2d4a, accent), blossom pink headings & model (#f26a8d, primary),
		// soft petal pink secondary (#ffc2d1, secondary), and deep rose-wine panels.
		accent: "oklch(74% 0.18 18)",
		chroma: 0.18,
		canvasL: 0.24,
		neutralHue: 6,
		neutralChroma: 0.015,
		primary: "oklch(69.9% 0.17 6)",
		secondary: "oklch(87.3% 0.072 2)",
		tone: "oklch(84% 0.10 350)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 6, label: 6, link: 350, code: 350, bullet: 18, border: 2, selected: 2, searchMatch: 18,
			keyword: 18, func: 6, variable: 18, string: 140, number: 2, type: 350,
		},
	},
	"arnative-garden": {
		// Garden: warm earth-gold focus (#dda15e, accent), olive-moss headings & model (#6c7844 adapted from #606c38, primary),
		// terracotta secondary (#bc6c25, secondary), and deep forest-earth panels.
		accent: "oklch(75.3% 0.11 68)",
		chroma: 0.11,
		canvasL: 0.24,
		neutralHue: 68,
		neutralChroma: 0.012,
		primary: "oklch(55% 0.076 120)",
		secondary: "oklch(60.9% 0.13 57)",
		tone: "oklch(80% 0.06 120)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 120, label: 120, link: 120, code: 120, bullet: 68, border: 57, selected: 57, searchMatch: 68,
			keyword: 68, func: 120, variable: 57, string: 140, number: 57, type: 120,
		},
	},
	"arnative-earthy": {
		// Earthy: warm tan focus (#a68a64, accent), sage-moss headings & model (#6e7653 adapted from #656d4a, primary),
		// clay brown secondary (#7f5539, secondary), and deep forest-earth panels.
		accent: "oklch(76% 0.063 75)",
		chroma: 0.065,
		canvasL: 0.24,
		neutralHue: 75,
		neutralChroma: 0.012,
		primary: "oklch(55% 0.053 119)",
		secondary: "oklch(48.9% 0.07 54)",
		tone: "oklch(78% 0.04 119)",
		surfaceMsg: "primary",
		borderAccent: "accentSoft",
		headingColor: "primary",
		linkColor: "tone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 119, label: 119, link: 119, code: 119, bullet: 75, border: 54, selected: 54, searchMatch: 75,
			keyword: 75, func: 119, variable: 54, string: 140, number: 54, type: 119,
		},
	},
};

// --- role order (matches the pi theme schema) ------------------------------
//
// Only tokens pi's schema declares may appear as keys here: since 1.2.0 the
// `colors` object is validated with `additionalProperties: false`, and an extra
// key rejects the whole theme at startup. Arnative's own colors (`accentSoft`,
// `primary`, `secondary`, …) live in `vars` and are referenced from these roles.
const ROLE_ORDER = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
	"muted", "dim", "text", "thinkingText",
	"selectedBg", "scrollbarTrack", "scrollbarThumb", "searchMatchBg", "searchMatchText",
	"userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel",
	"toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote",
	"mdQuoteBorder", "mdHr", "mdListBullet",
	"toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
	"syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
	"thinkingXhigh", "thinkingMax", "bashMode",
];

// --- derivation ------------------------------------------------------------

function derive(spec) {
	const seed = parseOklch(spec.accent);
	assert(seed !== null, `theme accent must be an oklch color: ${spec.accent}`);
	const h = seed.H;
	const c = spec.chroma;
	const nh = spec.neutralHue;
	const nc = spec.neutralChroma;
	const base = spec.canvasL;
	const H = { ...SYNTAX_OFFSET, ...ACCENT_OFFSET, ...(spec.hues ?? {}) };
	const roleHue = (role) => hue(H[role]);
	const sem = (role) => hue(SEMANTIC[role]);

	const primarySeed = spec.primary ? parseOklch(spec.primary) : null;
	const secondarySeed = spec.secondary ? parseOklch(spec.secondary) : null;
	const primaryVal = primarySeed ? oklch(primarySeed.L, primarySeed.C, primarySeed.H) : oklch(0.82, c, h);
	const secondaryVal = secondarySeed ? oklch(secondarySeed.L, secondarySeed.C, secondarySeed.H) : oklch(0.78, Math.min(c * 0.8, 0.12), roleHue("label"));

	// Soft counterpart of the border-accent tier — the footer's label, clock and status
	// colour. Softened from the SAME value the `borderAccent` token resolves to, because
	// that token is what extensions read back at runtime (`softSecondaryOf` in
	// lib/ansi.ts). One source keeps the declared value and the runtime one identical.
	const accentBorderVal = oklch(0.82, c * 0.6, h);
	const accentVal = oklch(0.78, c, h);
	const accentSoftVal = soften(accentVal);
	const borderAccentRole = spec.borderAccent ?? "accentSoft";
	const borderAccentVal = { accentBorder: accentBorderVal, accentSoft: accentSoftVal, secondary: secondaryVal }[borderAccentRole] ?? borderAccentRole;

	const vars = {
		fg: oklch(NEUTRAL.fg, nc, nh),
		fgMuted: oklch(NEUTRAL.fgMuted, nc, nh),
		fgDim: oklch(NEUTRAL.fgDim, nc, nh),
		fgFaint: oklch(NEUTRAL.fgFaint, nc, nh),
		primary: primaryVal,
		secondary: secondaryVal,
		secondarySoft: soften(secondaryVal),
		accent: accentVal,
		accentSoft: accentSoftVal,
		accentBorder: accentBorderVal,
		success: oklch(0.78, Math.min(c, 0.15), sem("success")),
		error: oklch(0.76, Math.min(c, 0.15), sem("error")),
		warning: oklch(0.86, Math.min(c, 0.14), sem("warning")),
	};
	// Optional third signature tone (a color of its own, reused by roles via its var).
	if (spec.tone) vars.tone = colorLiteral(spec.tone);
	// Optional heading/model signature tone (e.g. cyberpunk's purple), also a var.
	if (spec.headingTone) vars.headingTone = colorLiteral(spec.headingTone);

	// The message panel: a literal/hex override, or the name of a var whose hue is
	// darkened to a stealth dark level (L:19%) — so a theme can reuse an existing signature var
	// instead of hand-picking a color. Defaults to the neutral canvas tint.
	if (typeof spec.surfaceMsg === "string" && spec.surfaceMsg in vars) {
		const src = parseOklch(vars[spec.surfaceMsg]);
		assert(src !== null, `surfaceMsg var must be an oklch color: ${spec.surfaceMsg}`);
		vars.surfaceMsg = oklch(0.19, Math.min(src.C * 0.35, 0.05), src.H);
	} else {
		vars.surfaceMsg = spec.surfaceMsg ?? oklch(0.19, nc * 0.5, nh);
	}

	const accentLiteral = oklch(0.8, Math.min(c * 0.7, 0.14), h);
	const roles = {
		accent: "accent",
		border: oklch(0.55, Math.min(c * 0.35, 0.08), roleHue("border")),
		borderAccent: spec.borderAccent ?? "accentBorder",
		borderMuted: "fgFaint",
		success: "success",
		error: "error",
		warning: "warning",
		muted: "fgMuted",
		dim: "fgDim",
		text: "fg",
		thinkingText: "fgMuted",

		selectedBg: oklch(base + 0.07, Math.min(c * 0.25, 0.06), roleHue("selected")),
		scrollbarTrack: "fgFaint",
		scrollbarThumb: "accentSoft",
		searchMatchBg: oklch(base + 0.14, Math.min(c * 0.45, 0.10), roleHue("searchMatch")),
		searchMatchText: "fg",
		userMessageBg: "surfaceMsg",
		userMessageText: "fg",
		customMessageBg: oklch(base + 0.01, Math.min(c * 0.4, 0.05), roleHue("label")),
		customMessageText: "fg",
		customMessageLabel: spec.labelColor ?? oklch(0.78, Math.min(c * 0.7, 0.14), roleHue("label")),

		toolPendingBg: oklch(base - 0.02, Math.min(c * 0.3, 0.05), h),
		toolSuccessBg: oklch(base - 0.03, Math.min(c * 0.4, 0.06), sem("success")),
		toolErrorBg: oklch(base - 0.03, Math.min(c * 0.4, 0.06), sem("error")),
		toolTitle: "fg",
		toolOutput: "fgMuted",

		mdHeading: spec.headingColor ?? oklch(0.88, Math.min(c * 0.6, 0.14), roleHue("heading")),
		mdLink: spec.linkColor ?? oklch(0.8, Math.min(c * 0.7, 0.14), roleHue("link")),
		mdLinkUrl: "fgDim",
		mdCode: spec.codeColor ?? accentLiteral,
		mdCodeBlock: "success",
		mdCodeBlockBorder: "fgMuted",
		mdQuote: "fgMuted",
		mdQuoteBorder: "fgMuted",
		mdHr: spec.hrColor ?? "fgFaint",
		mdListBullet: spec.bulletColor ?? accentLiteral,

		toolDiffAdded: "success",
		toolDiffRemoved: "error",
		toolDiffContext: "fgMuted",

		syntaxComment: "fgDim",
		syntaxKeyword: spec.keywordColor ?? accentLiteral,
		syntaxFunction: oklch(0.86, Math.min(c * 0.8, 0.16), roleHue("func")),
		syntaxVariable: oklch(0.84, Math.min(c * 0.55, 0.14), roleHue("variable")),
		syntaxString: oklch(0.82, Math.min(c * 0.7, 0.16), roleHue("string")),
		syntaxNumber: oklch(0.8, Math.min(c * 0.7, 0.15), roleHue("number")),
		syntaxType: oklch(0.8, Math.min(c * 0.8, 0.16), roleHue("type")),
		syntaxOperator: "fg",
		syntaxPunctuation: "fgMuted",

		thinkingOff: oklch(spec.thinkingOff ?? THINKING.off, nc, nh),
		thinkingMinimal: oklch(THINKING.minimal, c * 0.25, h),
		thinkingLow: oklch(THINKING.low, c * 0.4, h),
		thinkingMedium: oklch(THINKING.medium, c * 0.6, h),
		thinkingHigh: oklch(THINKING.high, c * 0.8, h),
		thinkingXhigh: oklch(THINKING.xhigh, c, h),
		thinkingMax: "accent",

		bashMode: "success",
	};

	const exp = {
		pageBg: oklch(base - 0.06, nc, nh),
		cardBg: oklch(base - 0.03, nc, nh),
		infoBg: oklch(base + 0.05, Math.min(c * 0.25, 0.06), h),
	};

	// Roles must match ROLE_ORDER exactly and each value must be a var name or a literal.
	const missing = ROLE_ORDER.filter((n) => !(n in roles));
	const extra = Object.keys(roles).filter((n) => !ROLE_ORDER.includes(n));
	assert(missing.length === 0 && extra.length === 0, `roles vs ROLE_ORDER: missing [${missing}] extra [${extra}]`);
	for (const [name, value] of Object.entries(roles)) {
		assert(/^oklch\(/.test(value) || value in vars, `role ${name} is neither a var nor an oklch literal: ${value}`);
	}

	// Distinct vars must stay visually distinct (roles may alias on purpose).
	const seen = new Map();
	for (const [name, value] of Object.entries(vars)) {
		const v = parseOklch(value);
		assert(v !== null, `var ${name} is not an oklch color: ${value}`);
		const { r, g, b } = oklchToRgb(v.L, v.C, v.H);
		const rgb = `${r},${g},${b}`;
		if (seen.has(rgb)) throw new Error(`vars ${seen.get(rgb)} and ${name} resolve to the same color`);
		seen.set(rgb, name);
	}

	return { vars, roles, exp };
}

// --- dual-tone guard -------------------------------------------------------

/** Hues between two colours, 0..180. */
const hueGap = (a, b) => {
	const d = Math.abs(hue(a) - hue(b)) % 360;
	return d > 180 ? 360 - d : d;
};

/** How far the label tier must sit from the accent. Every theme draws the footer, the
 *  selected row and the detail line on `borderAccent`; when that shares the accent's hue
 *  the whole UI reads as one colour, which is how six themes ended up mono-tone. */
const MIN_HUE_GAP = { default: 25, "arnative": 0, "arnative-cyberpunk": 0, "arnative-crimson": 0, "arnative-matrix": 0, "arnative-neutral": 0, "arnative-gruvbox": 0, "arnative-nord": 0, "arnative-zinc": 0, "arnative-magical": 0, "arnative-lemonade": 0, "arnative-blossom": 0, "arnative-garden": 0, "arnative-earthy": 0 };

function assertDualTone(name, { vars, roles, exp }) {
	const accent = parseOklch(vars.accent);
	const labelValue = roles.borderAccent in vars ? vars[roles.borderAccent] : roles.borderAccent;
	const label = parseOklch(String(labelValue));
	assert(accent !== null && label !== null, `${name}: accent and borderAccent must both be oklch`);
	const min = MIN_HUE_GAP[name] ?? MIN_HUE_GAP.default;
	const gap = hueGap(accent.H, label.H);
	assert(
		gap >= min,
		`${name}: accent ${Math.round(accent.H)} and borderAccent ${Math.round(label.H)} are ${gap.toFixed(0)}° apart, need ${min}°`,
	);
	// A label tier without chroma is grey text, not a second tone.
	const minChroma = name === "arnative-neutral" || name === "arnative-zinc" ? 0.01 : 0.02;
	assert(label.C >= minChroma, `${name}: borderAccent chroma ${label.C} is too low to read as a tone`);
	// And it has to stand off the canvas it is drawn on.
	const ratio = contrast(toHex(labelValue), toHex(exp.pageBg));
	assert(ratio >= 3, `${name}: borderAccent contrast ${ratio.toFixed(2)} on pageBg is too low`);
}

// --- cross-theme distinctness ----------------------------------------------

/** Two themes may not share a signature colour: the picker previews one at a time, so a
 *  repeated accent or footer tier makes two palettes look like the same theme. */
function assertDistinctThemes(themes) {
	const seen = new Map();
	for (const [name, { vars, roles }] of themes) {
		const label = roles.borderAccent in vars ? vars[roles.borderAccent] : roles.borderAccent;
		for (const [tier, value] of [
			["accent", vars.accent],
			["borderAccent", label],
		]) {
			const hex = toHex(value);
			const other = seen.get(hex);
			assert(other === undefined, `${name}.${tier} ${hex} repeats ${other}`);
			seen.set(hex, `${name}.${tier}`);
		}
	}
}

// --- rendering -------------------------------------------------------------

function render(name, { vars, roles, exp }) {
	const lines = [
		"{",
		`\t"$schema": ${JSON.stringify(SCHEMA)},`,
		`\t"name": ${JSON.stringify(name)},`,
		`\t"appearance": "dark",`,
		`\t"vars": {`,
	];
	const entries = Object.entries(vars);
	entries.forEach(([k, v], i) => lines.push(`\t\t${JSON.stringify(k)}: ${JSON.stringify(v)}${i < entries.length - 1 ? "," : ""}`));
	lines.push("\t},", `\t"colors": {`);
	const roleEntries = ROLE_ORDER.map((r) => [r, roles[r]]);
	const blank = new Set(["thinkingText", "toolOutput", "mdListBullet", "syntaxPunctuation"]);
	roleEntries.forEach(([k, v], i) => {
		if (blank.has(k) && i > 0) lines.push("");
		lines.push(`\t\t${JSON.stringify(k)}: ${JSON.stringify(v)}${i < roleEntries.length - 1 ? "," : ""}`);
	});
	lines.push("\t},", `\t"export": {`);
	const expEntries = Object.entries(exp);
	expEntries.forEach(([k, v], i) => lines.push(`\t\t${JSON.stringify(k)}: ${JSON.stringify(v)}${i < expEntries.length - 1 ? "," : ""}`));
	lines.push("\t}", "}");
	return lines.join("\n") + "\n";
}

// --- main ------------------------------------------------------------------

const check = process.argv.includes("--check");
let drifted = 0;
const built = new Map();
for (const [name, spec] of Object.entries(THEMES)) {
	const derived = derive({ ...spec, name });
	assertDualTone(name, derived);
	built.set(name, derived);
	const content = render(name, derived);
	const file = join(HERE, `${name}.json`);
	if (check) {
		const current = await readFile(file, "utf8").catch(() => "");
		if (current !== content) {
			console.error(`✗ ${name}.json is stale — run: node themes/gen-themes.mjs`);
			drifted++;
		}
	} else {
		await writeFile(file, content);
		console.log(`✓ ${name}.json`);
	}
}
assertDistinctThemes(built);
if (check) {
	if (drifted) process.exit(1);
	console.log(`✓ ${Object.keys(THEMES).length} themes in sync with gen-themes.mjs`);
}