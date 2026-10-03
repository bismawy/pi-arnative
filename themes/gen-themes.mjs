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
import { hexToOklch, oklchToRgb } from "../lib/color.ts";
import { assert } from "../lib/check.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA =
	"https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

// --- color helpers ---------------------------------------------------------

const hue = (x) => ((x % 360) + 360) % 360;
const round3 = (x) => +x.toFixed(3);

/** Format OKLCH after gamut-reducing chroma, so the written value renders as-is. */
function oklch(L, C, H) {
	const { chroma } = oklchToRgb(L, C, H);
	return `oklch(${+(L * 100).toFixed(1)}% ${round3(chroma)} ${Math.round(hue(H))})`;
}

// --- shared ramps ----------------------------------------------------------

const NEUTRAL = { fg: 0.88, fgMuted: 0.72, fgDim: 0.61, fgFaint: 0.49 };
const THINKING = { off: 0.4, minimal: 0.47, low: 0.55, medium: 0.63, high: 0.71, xhigh: 0.79 };
const SEMANTIC = { success: 145, error: 25, warning: 85 };
const SYNTAX_OFFSET = { keyword: 0, func: 45, variable: -45, string: 120, number: 180, type: 90 };

/** Default hue for a role used outside `syntax*` (heading/link/label). */
const ACCENT_OFFSET = { heading: 0, link: 0, label: 60 };

// --- theme parameters ------------------------------------------------------

/**
 * `accent` seeds only the hue; `chroma` is the normalized accent chroma.
 * `hues` overrides the derived hue per role (keyword/func/… /heading/link/label)
 * to keep the strong palettes recognisable.
 */
const THEMES = {
	arnative: {
		accent: "#00d7ff",
		chroma: 0.13,
		canvasL: 0.27,
		neutralHue: 232,
		neutralChroma: 0.012,
		hues: { heading: 75, label: 282 },
	},
	"arnative-sun": {
		accent: "#ffb454",
		chroma: 0.14,
		canvasL: 0.27,
		neutralHue: 70,
		neutralChroma: 0.012,
		hues: { heading: 60, label: 330 },
	},
	"arnative-zinc": {
		accent: "#a1a1aa",
		chroma: 0.02,
		canvasL: 0.26,
		neutralHue: 285,
		neutralChroma: 0.005,
		hues: { heading: 285, label: 285 },
	},
	"arnative-violet": {
		accent: "#a78bfa",
		chroma: 0.14,
		canvasL: 0.27,
		neutralHue: 295,
		neutralChroma: 0.012,
		hues: { heading: 295, label: 330 },
	},
	"arnative-emerald": {
		accent: "#6ee7b7",
		chroma: 0.12,
		canvasL: 0.27,
		neutralHue: 165,
		neutralChroma: 0.012,
		hues: { heading: 165, label: 200 },
	},
	"arnative-matrix": {
		accent: "#00ff41",
		chroma: 0.22,
		canvasL: 0.15,
		neutralHue: 145,
		neutralChroma: 0.02,
		hues: {
			heading: 145, link: 145, label: 145,
			keyword: 145, func: 145, variable: 145, string: 145, number: 145, type: 145,
		},
	},
	"arnative-cyberpunk": {
		accent: "#ff2e97",
		chroma: 0.2,
		canvasL: 0.16,
		neutralHue: 275,
		neutralChroma: 0.02,
		hues: {
			heading: 60, link: 190, label: 190,
			keyword: 190, func: 60, variable: 320, string: 320, number: 30, type: 150,
		},
	},
	"arnative-synthwave": {
		accent: "#ff7edb",
		chroma: 0.17,
		canvasL: 0.22,
		neutralHue: 300,
		neutralChroma: 0.015,
		hues: {
			heading: 55, link: 180, label: 180,
			keyword: 55, func: 180, variable: 280, string: 30, number: 350, type: 320,
		},
	},
	"arnative-gruvbox": {
		accent: "#fabd2f",
		chroma: 0.14,
		canvasL: 0.24,
		neutralHue: 70,
		neutralChroma: 0.015,
		hues: {
			heading: 45, link: 200, label: 330,
			keyword: 25, func: 70, variable: 200, string: 70, number: 330, type: 45,
		},
	},
	"arnative-nord": {
		accent: "#88c0d0",
		chroma: 0.07,
		canvasL: 0.3,
		neutralHue: 240,
		neutralChroma: 0.01,
		hues: {
			heading: 40, link: 195, label: 310,
			keyword: 220, func: 195, variable: 220, string: 95, number: 310, type: 195,
		},
	},
	"arnative-dracula": {
		accent: "#bd93f9",
		chroma: 0.14,
		canvasL: 0.29,
		neutralHue: 285,
		neutralChroma: 0.012,
		hues: {
			heading: 60, link: 190, label: 330,
			keyword: 330, func: 135, variable: 190, string: 60, number: 265, type: 190,
		},
	},
};

// --- role order (matches the pi theme schema) ------------------------------

const ROLE_ORDER = [
	"accent", "accentSoft", "border", "borderAccent", "borderMuted", "success", "error", "warning",
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
	const h = hexToOklch(spec.accent).H;
	const c = spec.chroma;
	const nh = spec.neutralHue;
	const nc = spec.neutralChroma;
	const base = spec.canvasL;
	const H = { ...SYNTAX_OFFSET, ...ACCENT_OFFSET, ...(spec.hues ?? {}) };
	const roleHue = (role) => hue(H[role]);
	const sem = (role) => hue(SEMANTIC[role]);

	const vars = {
		fg: oklch(NEUTRAL.fg, nc, nh),
		fgMuted: oklch(NEUTRAL.fgMuted, nc, nh),
		fgDim: oklch(NEUTRAL.fgDim, nc, nh),
		fgFaint: oklch(NEUTRAL.fgFaint, nc, nh),
		accent: oklch(0.78, c, h),
		accentSoft: oklch(0.82, c * 0.18, h),
		accentBorder: oklch(0.82, c * 0.6, h),
		success: oklch(0.78, Math.min(c, 0.15), sem("success")),
		error: oklch(0.76, Math.min(c, 0.15), sem("error")),
		warning: oklch(0.86, Math.min(c, 0.14), sem("warning")),
		surfaceMsg: oklch(base, nc * 0.5, nh),
	};

	const accentLiteral = oklch(0.8, c * 0.7, h);
	const roles = {
		accent: "accent",
		accentSoft: "accentSoft",
		border: oklch(0.55, c * 0.35, h),
		borderAccent: "accentBorder",
		borderMuted: "fgFaint",
		success: "success",
		error: "error",
		warning: "warning",
		muted: "fgMuted",
		dim: "fgDim",
		text: "fg",
		thinkingText: "fgMuted",

		selectedBg: oklch(base + 0.07, c * 0.25, h),
		scrollbarTrack: "fgFaint",
		scrollbarThumb: "accentSoft",
		searchMatchBg: oklch(base + 0.14, c * 0.45, h),
		searchMatchText: "fg",
		userMessageBg: "surfaceMsg",
		userMessageText: "fg",
		customMessageBg: oklch(base + 0.01, c * 0.4, roleHue("label")),
		customMessageText: "fg",
		customMessageLabel: oklch(0.78, c * 0.7, roleHue("label")),

		toolPendingBg: oklch(base - 0.02, c * 0.3, h),
		toolSuccessBg: oklch(base - 0.03, c * 0.4, sem("success")),
		toolErrorBg: oklch(base - 0.03, c * 0.4, sem("error")),
		toolTitle: "fg",
		toolOutput: "fgMuted",

		mdHeading: oklch(0.88, c * 0.6, roleHue("heading")),
		mdLink: oklch(0.8, c * 0.7, roleHue("link")),
		mdLinkUrl: "fgDim",
		mdCode: accentLiteral,
		mdCodeBlock: "success",
		mdCodeBlockBorder: "fgMuted",
		mdQuote: "fgMuted",
		mdQuoteBorder: "fgMuted",
		mdHr: "fgFaint",
		mdListBullet: accentLiteral,

		toolDiffAdded: "success",
		toolDiffRemoved: "error",
		toolDiffContext: "fgMuted",

		syntaxComment: "fgDim",
		syntaxKeyword: accentLiteral,
		syntaxFunction: oklch(0.86, c * 0.8, roleHue("func")),
		syntaxVariable: oklch(0.84, c * 0.55, roleHue("variable")),
		syntaxString: oklch(0.82, c * 0.7, roleHue("string")),
		syntaxNumber: oklch(0.8, c * 0.7, roleHue("number")),
		syntaxType: oklch(0.8, c * 0.8, roleHue("type")),
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
		infoBg: oklch(base + 0.05, c * 0.25, h),
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
		const { r, g, b } = oklchToRgb(...parseOklch(value));
		const rgb = `${r},${g},${b}`;
		if (seen.has(rgb)) throw new Error(`vars ${seen.get(rgb)} and ${name} resolve to the same color`);
		seen.set(rgb, name);
	}

	return { vars, roles, exp };
}

function parseOklch(value) {
	const m = /\(([\d.]+)% ([\d.]+) ([\d.]+)\)/.exec(value);
	return [Number(m[1]) / 100, Number(m[2]), Number(m[3])];
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