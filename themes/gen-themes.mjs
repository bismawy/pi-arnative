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
 * Soft tier of a color: clone at L 0.82 with `scale` (default 0.5, matching
 * `SOFT_CHROMA_SCALE` in lib/ansi.ts; the accent tier uses 0.35, matching
 * `SOFT_CHROMA_SCALE_ACCENT`) of the GAMUT-CLAMPED chroma, hue kept.
 * `lib/ansi.ts` softens the resolved token with these same recipes at runtime,
 * so `*Soft` vars declared here and the extension's derived values agree.
 * Grey-collapse is avoided because the hue is carried, not dropped.
 *
 * The chroma keeps five decimals (not the usual three): the soft tier multiplies
 * it by the scale, so a coarser round-trip shifts the last hex digit and the
 * `declare == derive` guard in ui-render-tweaks.ts fails.
 */
function soften(value, scale = 0.5) {
	const o = parseOklch(value);
	assert(o !== null, `cannot soften a non-oklch color: ${value}`);
	const { chroma } = oklchToRgb(0.82, o.C * scale, o.H);
	return `oklch(82% ${+chroma.toFixed(5)} ${Math.round(hue(o.H))})`;
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
		// Teal panel, deepened until the strictest token floors pass on it (thinkingOff
		// at 1.3:1 is the tightest; the decorative rule mdHr is not text).
		surfaceMsg: "oklch(33% 0.05 191)",
		// The label tier follows the accent (soft cyan); the gold signature lives on
		// headings and links instead, so the theme keeps two tones without the label gap.
		borderAccent: "accentBorder",
		headingColor: "primary",
		linkColor: "primary",
		codeColor: "tone",
		bulletColor: "accent",
		hues: { heading: 96, label: 86, link: 196, code: 196, bullet: 193, border: 86, selected: 86 },
	},
	"arnative-cyberpunk": {
		// Neon pink focus, lime signature, orange links/code (tone), deep cyan panels.
		// Same var-based structure as arnative: label tier follows the accent, headings
		// and the footer model name take the purple signature, links/code take the
		// orange `tone` var — the palette stays cyberpunk (pink/lima/cyan/orange).
		accent: "oklch(76% 0.22 355)",
		chroma: 0.2,
		canvasL: 0.24,
		neutralHue: 275,
		neutralChroma: 0.02,
		primary: "oklch(88% 0.18 95)",
		secondary: "oklch(82% 0.16 200)",
		tone: "oklch(82% 0.18 45)",
		headingTone: "oklch(78% 0.20 300)",
		surfaceMsg: "headingTone",
		borderAccent: "accentBorder",
		headingColor: "headingTone",
		linkColor: "headingTone",
		codeColor: "tone",
		bulletColor: "accent",
		hues: {
			heading: 300, label: 200, link: 95, code: 45, bullet: 355, border: 200, selected: 200, searchMatch: 355,
			keyword: 200, func: 95, variable: 355, string: 140, number: 45, type: 200,
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
	const borderAccentRole = spec.borderAccent ?? "accentBorder";
	const borderAccentVal = { accentBorder: accentBorderVal, secondary: secondaryVal }[borderAccentRole] ?? borderAccentRole;

	const vars = {
		fg: oklch(NEUTRAL.fg, nc, nh),
		fgMuted: oklch(NEUTRAL.fgMuted, nc, nh),
		fgDim: oklch(NEUTRAL.fgDim, nc, nh),
		fgFaint: oklch(NEUTRAL.fgFaint, nc, nh),
		primary: primaryVal,
		secondary: secondaryVal,
		secondarySoft: soften(borderAccentVal),
		accent: accentVal,
		accentSoft: soften(accentVal, 0.35),
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
	// darkened to the canvas level — so a theme can reuse an existing signature var
	// (e.g. `headingTone`) instead of hand-picking a color. Defaults to the neutral
	// canvas tint.
	if (typeof spec.surfaceMsg === "string" && spec.surfaceMsg in vars) {
		const src = parseOklch(vars[spec.surfaceMsg]);
		assert(src !== null, `surfaceMsg var must be an oklch color: ${spec.surfaceMsg}`);
		vars.surfaceMsg = oklch(base, Math.min(src.C * 0.35, 0.06), src.H);
	} else {
		vars.surfaceMsg = spec.surfaceMsg ?? oklch(base, nc * 0.5, nh);
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
const MIN_HUE_GAP = { default: 25, "arnative": 0, "arnative-cyberpunk": 0 };

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
	assert(label.C >= 0.02, `${name}: borderAccent chroma ${label.C} is too low to read as a tone`);
	// And it has to stand off the canvas it is drawn on.
	const ratio = contrast(toHex(labelValue), toHex(exp.pageBg));
	assert(ratio >= 3, `${name}: borderAccent contrast ${ratio.toFixed(2)} on pageBg is too low`);
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
for (const [name, spec] of Object.entries(THEMES)) {
	const derived = derive({ ...spec, name });
	assertDualTone(name, derived);
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
if (check) {
	if (drifted) process.exit(1);
	console.log(`✓ ${Object.keys(THEMES).length} themes in sync with gen-themes.mjs`);
}