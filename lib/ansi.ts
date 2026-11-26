
import { getRuntime } from "./runtime.ts";

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

/** Per-theme cache of whether each `fg` token exists. Pi's `Theme.fg` throws for an unknown
 *  token, and the footer probes optional slots (`toolDiffAdded`, `warning`, ...) on every
 *  frame — one throw per frame per missing token. The answer never changes for a theme
 *  instance, so both hits and misses are cached once. */
const fgTokenSupport = new WeakMap<object, Map<string, boolean>>();

/** Painter for `color` when the theme defines it, else `fallback`. Probed once per theme. */
export function fgOr(
	th: { fg?(color: string, text: string): string } | null | undefined,
	color: string,
	fallback: (text: string) => string,
): (text: string) => string {
	const fg = th?.fg?.bind(th);
	if (!fg || !th) return fallback;
	let known = fgTokenSupport.get(th);
	if (!known) {
		known = new Map();
		fgTokenSupport.set(th, known);
	}
	let ok = known.get(color);
	if (ok === undefined) {
		try {
			fg(color, "");
			ok = true;
		} catch {
			ok = false;
		}
		known.set(color, ok);
	}
	return ok ? (text) => fg(color, text) : fallback;
}

/** The active pi theme out of an event ctx (`ctx.ui.theme`), null when absent. */
export function themeOf<T>(ctx: unknown): T | null {
	return (ctx as { ui?: { theme?: T } } | null | undefined)?.ui?.theme ?? null;
}

// Shared active-theme slot on RuntimeState so `/reload` keeps the live theme.
export function getActiveTheme<T>(): T | null {
	return (getRuntime().activeTheme as T | null) ?? null;
}
export function setActiveTheme<T>(th: T | null): void {
	getRuntime().activeTheme = (th as object | null) ?? null;
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

export const __test = {
	thinkingColorSlot,
};
