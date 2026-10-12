/**
 * Working-indicator presets for `/arnative` → **Animations** and their painters.
 * Single source of truth for frames, cadence, and colours.
 */
import { assert, isMain } from "./check.ts";

export const SPINNER_PRESETS = [
	"Pi (system)",
	"Diamond Glow",
	"Diamond Pulse",
	"Circle Pulse",
	"Circle Wave",
	"Shade Wave",
	"Braille Column",
	"Braille Level",
	"Kanji Count",
	"Suzhou Tally",
	"Gemini",
	"Claude",
] as const;
export type SpinnerPreset = (typeof SPINNER_PRESETS)[number];
export const DEFAULT_SPINNER_PRESET: SpinnerPreset = "Diamond Glow";

/** Persistence key in `arnative-config.json` (see `lib/preset-store.ts`). */
export const SPINNER_PRESET_KEY = "spinnerPreset";

interface Preset {
	/** Animation frames. Empty leaves pi's indicator alone. */
	frames: readonly string[];
	/** Frame delay in ms. `0` keeps pi's interval. */
	intervalMs: number;
	/** How the frame is painted. */
	paint: "accent" | "gradient" | "claude";
	/** Shown in the picker row after `·`. */
	note: string;
}

/** Claude Code mark animation frames, adapting to Ghostty and non-macOS font fallbacks. */
function defaultClaudeCharacters(): readonly string[] {
	if (process.env.TERM === "xterm-ghostty") {
		return ["\u00b7", "\u2722", "\u2733", "\u2736", "\u273b", "*"];
	}
	return process.platform === "darwin"
		? ["\u00b7", "\u2722", "\u2733", "\u2736", "\u273b", "\u273d"]
		: ["\u00b7", "\u2722", "*", "\u2736", "\u273b", "\u273d"];
}

const CLAUDE_BASE_FRAMES = defaultClaudeCharacters();
const CLAUDE_PING_PONG_FRAMES = [...CLAUDE_BASE_FRAMES, ...[...CLAUDE_BASE_FRAMES].reverse()] as const;

/**
 * `Pi (system)` exists to hand the slot back: empty frames and a zero interval mean the
 * extension installs nothing, so pi's own Braille spinner and colour are untouched. It is
 * also the only way to get the default Braille dots once a preset is stored.
 */
export const SPINNER_PRESET_DEFS: Record<SpinnerPreset, Preset> = {
	"Pi (system)": {
		frames: [],
		intervalMs: 0,
		paint: "accent",
		note: "pi's own Braille spinner",
	},
	// The diamond closing from outlined to filled and back; 200ms × 4 is one turn per 0.8s,
	// the rate pi's Braille default turns at (80ms × 10).
	"Diamond Glow": {
		frames: ["\u2b25", "\u25c8", "\u25c6", "\u25c7"],
		intervalMs: 200,
		paint: "accent",
		note: "diamond closing, 0.8s",
	},
	// Three-diamond travelling pulse: a filled diamond moving across hollow ones.
	"Diamond Pulse": {
		frames: ["\u25c6\u25c7\u25c7", "\u25c7\u25c6\u25c7", "\u25c7\u25c7\u25c6"],
		intervalMs: 200,
		paint: "accent",
		note: "travelling diamond pulse",
	},
	// Three-circle fill ladder: filled dots filling from left to right (● ◌ ◌ → ● ● ◌ → ● ● ●).
	"Circle Pulse": {
		frames: ["\u25cf \u25cc \u25cc", "\u25cf \u25cf \u25cc", "\u25cf \u25cf \u25cf"],
		intervalMs: 200,
		paint: "accent",
		note: "filling circles, one to three",
	},
	// Three-circle travelling wave: a filled dot moving across hollow dots (● ◌ ◌ → ◌ ● ◌ → ◌ ◌ ●).
	"Circle Wave": {
		frames: ["\u25cf \u25cc \u25cc", "\u25cc \u25cf \u25cc", "\u25cc \u25cc \u25cf"],
		intervalMs: 200,
		paint: "accent",
		note: "travelling circle wave",
	},
	// Three-block travelling shade wave from light to dark shading.
	"Shade Wave": {
		frames: ["\u2591\u2592\u2593", "\u2593\u2591\u2592", "\u2592\u2593\u2591"],
		intervalMs: 200,
		paint: "accent",
		note: "travelling block shade wave",
	},
	// Braille stepping dots: rotating/tumbling dot pairs (⠖ ⠲ ⠴ ⠦).
	"Braille Column": {
		frames: ["\u2816", "\u2832", "\u2834", "\u2826"],
		intervalMs: 160,
		paint: "accent",
		note: "stepping braille dot pattern",
	},
	// Braille fill levels: rising horizontal dot lines from bottom to top (⣀ ⣤ ⣶ ⣿).
	"Braille Level": {
		frames: ["\u28c0", "\u28e4", "\u28f6", "\u28ff", "\u28f6", "\u28e4"],
		intervalMs: 140,
		paint: "accent",
		note: "rising braille dot level fill",
	},
	// Kanji stroke count: one, two, three lines (一 二 三).
	"Kanji Count": {
		frames: ["\u4e00", "\u4e8c", "\u4e09"],
		intervalMs: 200,
		paint: "accent",
		note: "kanji numerals, one to three",
	},
	// Suzhou numerals (tally marks): vertical bars one to three (〡 〢 〣).
	"Suzhou Tally": {
		frames: ["\u3021", "\u3022", "\u3023"],
		intervalMs: 200,
		paint: "accent",
		note: "vertical tally bars, one to three",
	},
	// Gemini CLI's spinner is the `dots` entry from the `cli-spinners` package, the same
	// Braille set pi ships; what makes it Gemini is the Google brand gradient sweeping the
	// glyph on a 4s cycle (GeminiSpinner.tsx paints `CliSpinner` through `tinygradient`).
	Gemini: {
		frames: ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"],
		intervalMs: 80,
		paint: "gradient",
		note: "pi's Braille + Google gradient",
	},
	// Claude Code's mark animation: ping-pong loop of dingbats swelling and contracting,
	// matching upstream SpinnerAnimationRow (120ms per frame).
	Claude: {
		frames: CLAUDE_PING_PONG_FRAMES,
		intervalMs: 120,
		paint: "claude",
		note: "Claude Code's pulsing marks, 120ms",
	},
};

/** Google brand gradient midpoints (sRGB), seamless 4s loop. */
const GOOGLE_BRAND: ReadonlyArray<readonly [number, number, number]> = [
	[168, 130, 234], // purple
	[66, 133, 244], // blue
	[52, 168, 172], // cyan
	[52, 168, 83], // green
	[251, 188, 4], // yellow
	[234, 67, 53], // red
	[168, 130, 234], // back to purple
];

/** Claude Code's own spinner colour: the 256-colour grey-orange index it brands around. */
const CLAUDE_RGB: readonly [number, number, number] = [215, 119, 87];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The brand gradient at `t` in [0, 1), as sRGB. Wraps, so any t is valid. */
export function googleGradientRgb(t: number): [number, number, number] {
	const wrapped = t - Math.floor(t);
	const spans = GOOGLE_BRAND.length - 1;
	const scaled = wrapped * spans;
	const i = Math.min(Math.floor(scaled), spans - 1);
	const f = scaled - i;
	const a = GOOGLE_BRAND[i]!;
	const b = GOOGLE_BRAND[i + 1]!;
	return [Math.round(lerp(a[0], b[0], f)), Math.round(lerp(a[1], b[1], f)), Math.round(lerp(a[2], b[2], f))];
}

/** Truecolor SGR for one glyph. pi's own `fg` cannot take a raw RGB, so the escape is ours. */
const fgRgb = ([r, g, b]: readonly [number, number, number]): string => `\x1b[38;2;${r};${g};${b}m`;

/** Painter for a preset's spinner; gradient and claude use fixed branding, accent uses theme. */
export function spinnerPainter(
	preset: SpinnerPreset,
	theme: { fg?(color: string, text: string): string } | null,
): (text: string) => string {
	const def = SPINNER_PRESET_DEFS[preset];
	if (def.paint === "gradient") {
		return (text) => `${fgRgb(googleGradientRgb(Date.now() / 4000))}${text}\x1b[0m`;
	}
	if (def.paint === "claude") {
		return (text) => `${fgRgb(CLAUDE_RGB)}${text}\x1b[0m`;
	}
	const fg = theme?.fg?.bind(theme);
	if (!fg) return (text) => text;
	return (text) => fg("accent", text);
}

/** Frames for the picker preview row, e.g. `⬥ ◈ ◆ ◇`. `Pi (system)` reports its own set. */
export function previewFrames(preset: SpinnerPreset): string {
	const def = SPINNER_PRESET_DEFS[preset];
	const frames = def.frames.length > 0 ? def.frames : SPINNER_PRESET_DEFS.Gemini.frames;
	return frames.join(" ");
}


// Self-check: `node lib/spinner.ts`
if (isMain(import.meta.url)) {
	for (const p of SPINNER_PRESETS) {
		const def = SPINNER_PRESET_DEFS[p];
		assert(def.note.length > 0, `${p} carries a picker note`);
		for (const frame of def.frames) {
			assert(!/\ufffd|\ue000-\uf8ff/.test(frame), `${p}: frame ${frame} is not a blank private-use cell`);
		}
		if (def.frames.length > 0) {
			assert(def.intervalMs > 0, `${p} with frames must set an interval`);
			assert(new Set(def.frames).size > 1, `${p} must animate, not repeat one frame`);
		}
	}

	// `Pi (system)` is the escape hatch: it must install nothing at all.
	assert(SPINNER_PRESET_DEFS["Pi (system)"].frames.length === 0, "Pi (system) leaves pi's frames alone");
	assert(SPINNER_PRESET_DEFS["Pi (system)"].intervalMs === 0, "Pi (system) leaves pi's interval alone");

	// Gemini's Braille is the one sanctioned exception: Braille Patterns is a block every
	// terminal font covers (it is pi's own default set, so a terminal that shows pi at all has
	// it), and the ten cells share one face because U+2800-U+28FF is a single contiguous run.
	const braille = /^[\u2800-\u28ff]+$/;
	assert(SPINNER_PRESET_DEFS.Gemini.frames.every((f) => braille.test(f)), "Gemini frames are Braille cells");
	assert(SPINNER_PRESET_DEFS.Gemini.frames.length === 10, "Gemini uses the ten-frame dots spinner");
	assert(
		SPINNER_PRESET_DEFS.Gemini.intervalMs === 80,
		"Gemini keeps the cli-spinners cadence (80ms)",
	);

	// Diamond Glow uses the Geometric Shapes block; `⬥ ◈ ◆ ◇` all live in one contiguous run
	// and are hosted by the terminal face on the platforms this package targets.
	for (const f of SPINNER_PRESET_DEFS["Diamond Glow"].frames) {
		assert(/^[\u25a0-\u25ff\u2b00-\u2bff]$/.test(f), `Diamond Glow frame ${f} is a geometric shape`);
	}

	// Claude preset: upstream dingbats in ping-pong order, matching Claude Code.
	const claude = SPINNER_PRESET_DEFS.Claude.frames;
	assert(claude[0] === "\u00b7", "Claude starts on the interpunct");
	assert(claude.length === 12, "Claude uses a 12-frame ping-pong loop");
	assert(SPINNER_PRESET_DEFS.Claude.intervalMs === 120, "Claude matches upstream 120ms cadence");
	assert(claude.join("") === [...claude].reverse().join(""), "Claude's ping-pong frames are a palindrome");
	for (const f of claude) assert(f !== " " && f.length === 1, `Claude frame ${JSON.stringify(f)} is one glyph`);

	// The gradient closes: t=1 must equal t=0, or the 4s sweep would jump at the seam.
	assert(
		googleGradientRgb(0).join() === googleGradientRgb(1).join(),
		"the Google gradient wraps without a seam",
	);
	assert(googleGradientRgb(0.9999).join() !== googleGradientRgb(0.5).join(), "the gradient actually moves");
	assert(googleGradientRgb(-0.25).join() === googleGradientRgb(0.75).join(), "a negative t wraps like a positive one");
	for (const rgb of [googleGradientRgb(0), googleGradientRgb(0.37), googleGradientRgb(0.91)]) {
		assert(rgb.every((c) => Number.isInteger(c) && c >= 0 && c <= 255), `gradient stays in sRGB: ${rgb.join()}`);
	}

	// The accent painter must go through the theme, not a hardcoded colour.
	assert(
		spinnerPainter("Diamond Glow", { fg: (c, t) => `<${c}>${t}` })("x") === "<accent>x",
		"accent presets paint through the theme token",
	);
	assert(spinnerPainter("Diamond Glow", null)("x") === "x", "no theme -> identity painter, never a crash");
	const grad = spinnerPainter("Gemini", null)("x");
	assert(grad.startsWith("\x1b[38;2;") && grad.endsWith("x\x1b[0m"), "the gradient painter emits truecolor + reset");
	assert(spinnerPainter("Claude", null)("x").startsWith("\x1b[38;2;215;119;87m"), "Claude uses its own mark colour");

	assert(previewFrames("Diamond Glow").split(" ").length === 4, "the picker preview shows every Diamond frame");
	assert(previewFrames("Pi (system)").length > 0, "Pi (system) still previews pi's Braille set");

	console.log("spinner.ts self-check OK");
}