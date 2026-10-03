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

/** Painter for the `accentSoft` token, which only arnative themes define; other themes fall back to accent (probed once). */
export function accentSoftOf(th: { fg?(c: string, t: string): string } | null): (s: string) => string {
	const fg = th?.fg?.bind(th);
	if (!fg) return (s) => s;
	try {
		fg("accentSoft", "");
		return (s) => fg("accentSoft", s);
	} catch {
		return (s) => fg("accent", s);
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

	const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
	assert(accentSoftOf(tag)("x") === "<accentSoft>x</accentSoft>", "accentSoftOf uses accentSoft when the theme defines it");
	const noSoft = {
		fg: (c: string, t: string) => {
			if (c === "accentSoft") throw new Error("Unknown theme color: accentSoft");
			return `<${c}>${t}</${c}>`;
		},
	};
	assert(accentSoftOf(noSoft)("x") === "<accent>x</accent>", "accentSoftOf falls back to accent without the token");
	assert(accentSoftOf(null)("x") === "x", "accentSoftOf without a theme is identity");
	console.log("lib/ansi.ts OK");
}
