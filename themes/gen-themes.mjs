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
import { parseOklch, oklchToRgb } from "../lib/color.ts";
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
 * Soft tier of a color: clone at L 0.82 with a fifth of the GAMUT-CLAMPED chroma, hue
 * kept. `lib/ansi.ts` softens the resolved token with this same recipe at runtime, so a
 * `*Soft` var declared here and the extension's derived value agree. Grey-collapse is
 * avoided because the hue is carried, not dropped.
 *
 * The chroma keeps five decimals (not the usual three): the soft tier multiplies it by
 * 0.18, so a coarser round-trip shifts the last hex digit and the `declare == derive`
 * guard in ui-render-tweaks.ts fails.
 */
function soften(value) {
	const o = parseOklch(value);
	assert(o !== null, `cannot soften a non-oklch color: ${value}`);
	const { chroma } = oklchToRgb(0.82, o.C * 0.18, o.H);
	return `oklch(82% ${+chroma.toFixed(5)} ${Math.round(hue(o.H))})`;
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
		accent: "oklch(81.1% 0.1455 217.709375)",
		chroma: 0.13,
		canvasL: 0.27,
		neutralHue: 232,
		neutralChroma: 0.012,
		primary: "oklch(82% 0.14 218)",
		secondary: "oklch(78% 0.11 282)",
		hues: { heading: 75, label: 282 },
	},
	"arnative-sun": {
		accent: "oklch(82.4% 0.1408 70.170730)",
		chroma: 0.14,
		canvasL: 0.27,
		neutralHue: 70,
		neutralChroma: 0.012,
		primary: "oklch(84% 0.15 70)",
		secondary: "oklch(78% 0.12 35)",
		hues: { heading: 60, label: 330 },
	},
	"arnative-zinc": {
		accent: "oklch(71.2% 0.0129 286.066504)",
		chroma: 0.02,
		canvasL: 0.26,
		neutralHue: 285,
		neutralChroma: 0.005,
		primary: "oklch(86% 0.015 285)",
		secondary: "oklch(72% 0.025 240)",
		hues: { heading: 285, label: 285 },
	},
	"arnative-violet": {
		accent: "oklch(70.9% 0.1592 293.541199)",
		chroma: 0.14,
		canvasL: 0.27,
		neutralHue: 295,
		neutralChroma: 0.012,
		primary: "oklch(82% 0.15 294)",
		secondary: "oklch(78% 0.11 215)",
		hues: { heading: 295, label: 330 },
	},
	"arnative-emerald": {
		accent: "oklch(84.5% 0.1299 164.978166)",
		chroma: 0.12,
		canvasL: 0.27,
		neutralHue: 165,
		neutralChroma: 0.012,
		primary: "oklch(84% 0.13 165)",
		secondary: "oklch(78% 0.10 195)",
		hues: { heading: 165, label: 200 },
	},
	"arnative-matrix": {
		accent: "oklch(86.9% 0.2776 144.466116)",
		chroma: 0.22,
		canvasL: 0.24,
		neutralHue: 145,
		neutralChroma: 0.02,
		primary: "oklch(88% 0.24 145)",
		secondary: "oklch(76% 0.16 165)",
		surfaceMsg: "oklch(24% 0.035 145)",
		hues: {
			heading: 145, link: 145, label: 145,
			keyword: 145, func: 145, variable: 145, string: 145, number: 145, type: 145,
		},
	},
	"arnative-cyberpunk": {
		accent: "oklch(76% 0.22 355)",
		chroma: 0.2,
		canvasL: 0.24,
		neutralHue: 275,
		neutralChroma: 0.02,
		primary: "oklch(88% 0.18 95)",
		secondary: "oklch(82% 0.16 200)",
		surfaceMsg: "oklch(24% 0.035 200)",
		borderAccent: "secondary",
		headingColor: "primary",
		codeColor: "secondary",
		bulletColor: "primary",
		keywordColor: "secondary",
		hues: {
			heading: 95, link: 200, label: 200, code: 200, bullet: 95, border: 200, selected: 200, searchMatch: 95,
			keyword: 200, func: 95, variable: 355, string: 140, number: 45, type: 200,
		},
	},
	"arnative-synthwave": {
		accent: "oklch(80% 0.18 50)",
		chroma: 0.17,
		canvasL: 0.24,
		neutralHue: 300,
		neutralChroma: 0.015,
		primary: "oklch(78% 0.19 339)",
		secondary: "oklch(82% 0.16 185)",
		surfaceMsg: "oklch(24% 0.03 300)",
		borderAccent: "secondary",
		codeColor: "secondary",
		bulletColor: "primary",
		hues: {
			heading: 50, link: 185, label: 185, code: 185, bullet: 339, border: 185, selected: 185, searchMatch: 50,
			keyword: 185, func: 50, variable: 339, string: 45, number: 339, type: 290,
		},
	},
	"arnative-gruvbox": {
		accent: "oklch(76% 0.15 45)",
		chroma: 0.14,
		canvasL: 0.24,
		neutralHue: 70,
		neutralChroma: 0.015,
		primary: "oklch(84% 0.14 83)",
		secondary: "oklch(78% 0.10 175)",
		borderAccent: "secondary",
		headingColor: "primary",
		codeColor: "secondary",
		bulletColor: "accent",
		hues: {
			heading: 83, link: 175, label: 175, code: 175, bullet: 45, border: 83, selected: 83, searchMatch: 83,
			keyword: 45, func: 83, variable: 175, string: 145, number: 45, type: 83,
		},
	},
	"arnative-nord": {
		accent: "oklch(74% 0.09 310)",
		chroma: 0.07,
		canvasL: 0.3,
		neutralHue: 240,
		neutralChroma: 0.01,
		primary: "oklch(78% 0.08 217)",
		secondary: "oklch(82% 0.09 195)",
		borderAccent: "secondary",
		codeColor: "secondary",
		bulletColor: "primary",
		hues: {
			heading: 75, link: 195, label: 195, code: 195, bullet: 217, border: 217, selected: 217, searchMatch: 75,
			keyword: 217, func: 195, variable: 217, string: 145, number: 310, type: 195,
		},
	},
	"arnative-dracula": {
		accent: "oklch(76% 0.18 330)",
		chroma: 0.14,
		canvasL: 0.29,
		neutralHue: 285,
		neutralChroma: 0.012,
		primary: "oklch(78% 0.15 295)",
		secondary: "oklch(82% 0.13 190)",
		borderAccent: "secondary",
		codeColor: "secondary",
		bulletColor: "accent",
		hues: {
			heading: 85, link: 190, label: 190, code: 190, bullet: 330, border: 295, selected: 295, searchMatch: 85,
			keyword: 330, func: 140, variable: 190, string: 85, number: 295, type: 190,
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
		accentSoft: soften(accentVal),
		accentBorder: accentBorderVal,
		success: oklch(0.78, Math.min(c, 0.15), sem("success")),
		error: oklch(0.76, Math.min(c, 0.15), sem("error")),
		warning: oklch(0.86, Math.min(c, 0.14), sem("warning")),
		surfaceMsg: spec.surfaceMsg ?? oklch(base, nc * 0.5, nh),
	};

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
		mdHr: "fgFaint",
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

		thinkingOff: oklch(THINKING.off, nc, nh),
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
	const content = render(name, derive({ ...spec, name }));
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