import { assert, isMain } from "./check.ts";

/** Theme bg open-code, stripped of its trailing \x1b[49m reset. */
export function ansiBgOpen(th: { bg?(color: string, text: string): string } | null, color: string): string {
	if (!th?.bg) return "";
	try {
		const probe = th.bg(color, "");
		const reset = "\x1b[49m";
		return probe.endsWith(reset) ? probe.slice(0, -reset.length) : probe;
	} catch {
		return "";
	}
}

// --- shared ANSI + theme helpers (single definition, all files use these) ---
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Drop every ANSI CSI sequence (colors and cursor moves), not just SGR colors. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** The active pi theme out of an event ctx (`ctx.ui.theme`), null when absent. */
export function themeOf<T>(ctx: unknown): T | null {
	return (ctx as { ui?: { theme?: T } } | null | undefined)?.ui?.theme ?? null;
}

// Shared active-theme slot. `/reload` re-imports an extension's modules, so two copies
// can coexist: one carries the session_start handler, the other owns a stacked UI patch.
// globalThis gives both the same theme, so the patched copy paints instead of drawing
// uncolored (or, before the null-guard fix, crashing). Set from `session_start`.
const THEME_PROXY_KEY = Symbol.for("pi-arnative.activeThemeProxy");
export function getActiveTheme<T>(): T | null {
	return (globalThis as Record<symbol, T>)[THEME_PROXY_KEY] ?? null;
}
export function setActiveTheme<T>(th: T | null): void {
	if (th) (globalThis as Record<symbol, T>)[THEME_PROXY_KEY] = th;
	else delete (globalThis as Record<symbol, T>)[THEME_PROXY_KEY];
}

/**
 * Soft tiers of a resolved theme color: clone at a lightness with a share of the
 * chroma and the hue kept. The generator's `soften()` (themes/gen-themes.mjs)
 * applies the identical recipes, so declared `vars.*Soft` values and these
 * derived ones agree. The accent tier approaches white (0.94 lightness, low
 * chroma): it reads as a pale, near-white tint, clearly distinct from the accent,
 * while footer labels stay a visible second color.
 */
const SOFT_L = 0.90;
const SOFT_CHROMA_SCALE = 0.35;
const SOFT_L_ACCENT = 0.90;
const SOFT_CHROMA_SCALE_ACCENT = 0.35;
function softenColor(c: { c?: number; h?: number }, scale = SOFT_CHROMA_SCALE, l = SOFT_L): { kind: "oklch"; l: number; c: number; h: number } {
	return { kind: "oklch", l, c: (c.c ?? 0) * scale, h: c.h ?? 0 };
}

/**
 * Painter for arnative's soft accent (`accentSoft`).
 *
 * Pi <=1.1.0 let a theme declare extra tokens in `colors`, so `accentSoft` was
 * addressable directly. 1.2.0 validates `colors` with `additionalProperties: false`
 * and rejects the whole theme if it carries one, so the token now lives only in
 * `vars` and `fg("accentSoft")` throws. The soft accent stays available through the
 * resolved `accent` color (both 1.1.0 and 1.2.0 expose `theme.colors`): its hue and
 * chroma are softened to the generator's `*Soft` recipe, which keeps the two-tone look
 * instead of collapsing to grey. Falls back to `muted`, then `accent`, on older themes.
 */
export function softOf(th: {
	fg?(c: string, t: string): string;
	style?(t: string, o: { fg: unknown }): string;
	colors?: Record<string, { kind?: string; c?: number; h?: number }>;
} | null): (s: string) => string {
	const fg = th?.fg?.bind(th);
	if (!fg) return (s) => s;
	try {
		fg("accentSoft", "");
		return (s) => fg("accentSoft", s);
	} catch {
		// 1.2.0+ rejects `accentSoft`: derive the soft tint from the resolved accent.
	}
	const accent = th?.colors?.accent;
	const style = th?.style?.bind(th);
	if (accent?.kind === "oklch" && style) {
		const soft = softenColor(accent, SOFT_CHROMA_SCALE_ACCENT, SOFT_L_ACCENT);
		return (s) => style(s, { fg: soft });
	}
	return (s) => fg("muted", s);
}

/**
 * Painter for the soft *label* tier (`secondarySoft`): the footer's cwd, branch, clock
 * and status text.
 *
 * The two-tone footer puts icons on `accent` and their text on the border-accent tier.
 * `secondarySoft` is declared only in `vars`, so it cannot be read back with `fg()`;
 * it is derived instead from `borderAccent`, the official token that tier maps to. The
 * generator softens that same value, so declared and derived agree. Falls back to
 * `softOf` (the accent tier) when the theme exposes no resolvable `borderAccent`.
 */
export function softSecondaryOf(th: {
	fg?(c: string, t: string): string;
	style?(t: string, o: { fg: unknown }): string;
	colors?: Record<string, { kind?: string; c?: number; h?: number }>;
} | null): (s: string) => string {
	const border = th?.colors?.borderAccent;
	const style = th?.style?.bind(th);
	if (border?.kind === "oklch" && style) {
		const soft = softenColor(border);
		return (s) => style(s, { fg: soft });
	}
	return softOf(th);
}

/** pi defines one theme slot per thinking level (`thinkingOff`…`thinkingMax`), so a box
 *  can follow the model instead of a hardcoded palette — switching theme keeps the
 *  meaning of the color. Shared by `usage.ts` and `arnative.ts`. */
const THINKING_SLOTS: Record<string, string> = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

function thinkingColorSlot(level: string | undefined): string {
	return THINKING_SLOTS[(level ?? "off").toLowerCase()] ?? "thinkingOff";
}

/** Painter for a thinking level, probed once; falls back to `dim` when the theme lacks
 *  the slot, so a non-arnative theme draws a plain border instead of throwing. */
export function thinkingColorOf(
	th: { fg?(c: string, t: string): string } | null,
	level: string | undefined,
): (s: string) => string {
	const fg = th?.fg?.bind(th);
	if (!fg) return (s) => s;
	const slot = thinkingColorSlot(level);
	try {
		fg(slot, "");
		return (s) => fg(slot, s);
	} catch {
		return (s) => fg("dim", s);
	}
}

// Self-check: `node lib/ansi.ts`
if (isMain(import.meta.url)) {
	assert(ansiBgOpen(null, "selectedBg") === "", "no theme: empty");
	assert(ansiBgOpen({ bg: (_c, t) => `\x1b[48;2;9;9;9m${t}\x1b[49m` }, "selectedBg") === "\x1b[48;2;9;9;9m", "bg probe without reset");
	assert(stripAnsi("\x1b[2mA\x1b[22m") === "A", "stripAnsi removes SGR colors");
	assert(stripAnsi("x\x1b[K") === "x", "stripAnsi removes non-SGR CSI too");
	assert(themeOf({ ui: { theme: "T" } }) === "T", "themeOf reads ctx.ui.theme");
	assert(themeOf(null) === null, "themeOf tolerates a missing ctx");

	setActiveTheme({ fg: (c, t) => `<${c}>${t}</${c}>` });
	assert(getActiveTheme<object>() !== null, "active theme round-trips through globalThis");
	setActiveTheme(null);
	assert(getActiveTheme<object>() === null, "clearing the active theme leaves no stale slot");

	const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
	assert(softOf(tag)("x") === "<accentSoft>x</accentSoft>", "softOf uses accentSoft when the theme defines it");
	const noSoft = {
		fg: (c: string, t: string) => {
			if (c === "accentSoft") throw new Error("Unknown theme color: accentSoft");
			return `<${c}>${t}</${c}>`;
		},
	};
	assert(softOf(noSoft)("x") === "<muted>x</muted>", "softOf falls back to muted without the token or colors");
	assert(softOf(null)("x") === "x", "softOf without a theme is identity");
	// Pi 1.2.0: accentSoft is rejected, so the soft tint is derived from `colors.accent`.
	const modern = {
		fg: (c: string, t: string) => {
			throw new Error(`Unknown theme color: ${c}`);
		},
		style: (t: string, o: { fg: unknown }) => `<soft:${JSON.stringify(o.fg)}>${t}</soft>`,
		colors: { accent: { kind: "oklch", c: 0.2, h: 355 }, borderAccent: { kind: "oklch", c: 0.1, h: 200 } },
	};
	const modernOut = softOf(modern)("x");
	assert(
		Math.abs(JSON.parse(modernOut.match(/<soft:(.*)>x<\/soft>/)[1]!).c - 0.07) < 1e-9 &&
			modernOut.includes('"l":0.9'),
		"softOf derives the soft tint from accent (l=0.9, c=accent*0.35)",
	);
	assert(modernOut.includes("x"), "softOf keeps the text");
	// The label tier softens `borderAccent`, NOT `accent`: that is what keeps footer text
	// on the blue tier instead of inheriting the pink accent hue.
	const labelOut = softSecondaryOf(modern)("x");
	assert(
		Math.abs(JSON.parse(labelOut.match(/<soft:(.*)>x<\/soft>/)[1]!).c - 0.035) < 1e-9 &&
			labelOut.includes('"l":0.9') &&
			labelOut.includes('"h":200'),
		"softSecondaryOf softens borderAccent (l=0.9, c=borderAccent*0.35, same hue)",
	);
	assert(labelOut !== modernOut, "the soft label tier differs from the soft accent tier");
	assert(softSecondaryOf({ fg: () => "", style: (t) => `<x>${t}</x>`, colors: {} })("x") === softOf({ fg: () => "", style: (t) => `<x>${t}</x>`, colors: {} })("x"), "softSecondaryOf falls back to softOf without a borderAccent");

	assert(thinkingColorSlot("off") === "thinkingOff", "thinking off maps to thinkingOff");
	assert(thinkingColorSlot(undefined) === "thinkingOff", "missing level falls back to thinkingOff");
	assert(thinkingColorSlot("HIGH") === "thinkingHigh", "matching is case-insensitive");
	assert(thinkingColorSlot("xhigh") === "thinkingXhigh", "xhigh has its own slot");
	assert(thinkingColorSlot("max") === "thinkingMax", "max maps to thinkingMax");
	assert(thinkingColorSlot("nonsense") === "thinkingOff", "an unknown level degrades to thinkingOff");
	assert(thinkingColorOf(tag, "high")("x") === "<thinkingHigh>x</thinkingHigh>", "thinkingColorOf paints the level's slot");
	assert(thinkingColorOf(tag, undefined)("x") === "<thinkingOff>x</thinkingOff>", "thinkingColorOf defaults to thinkingOff");
	assert(thinkingColorOf(null, "high")("x") === "x", "thinkingColorOf without a theme is identity");
	const noThinking = {
		fg: (c: string, t: string) => {
			if (c.startsWith("thinking")) throw new Error(`Unknown theme color: ${c}`);
			return `<${c}>${t}</${c}>`;
		},
	};
	assert(thinkingColorOf(noThinking, "max")("x") === "<dim>x</dim>", "thinkingColorOf falls back to dim without the slot");
	console.log("lib/ansi.ts OK");
}
