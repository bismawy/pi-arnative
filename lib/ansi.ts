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

// Self-check: `node lib/ansi.ts`
if (isMain(import.meta.url)) {
	assert(ansiBgOpen(null, "selectedBg") === "", "no theme: empty");
	assert(ansiBgOpen({ bg: (_c, t) => `\x1b[48;2;9;9;9m${t}\x1b[49m` }, "selectedBg") === "\x1b[48;2;9;9;9m", "bg probe without reset");
	assert(stripAnsi("\x1b[2mA\x1b[22m") === "A", "stripAnsi removes SGR colors");
	assert(stripAnsi("x\x1b[K") === "x", "stripAnsi removes non-SGR CSI too");
	assert(themeOf({ ui: { theme: "T" } }) === "T", "themeOf reads ctx.ui.theme");
	assert(themeOf(null) === null, "themeOf tolerates a missing ctx");
	console.log("lib/ansi.ts OK");
}
