/**
 * Working-indicator presets for `/arnative` → **Animations** and their painters.
 * Single source of truth for frames, cadence, and colours.
 */
import { assert, isMain } from "./check.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Picker order: the escape hatch first, this package's own spinner second, then the rest
 *  alphabetically. `Pi (system)` and `Arnative` are not sorted in — they are the two rows a
 *  user is most likely to want and they should never move. */
export const SPINNER_PRESETS = [
	"Pi (system)",
	"Arnative",
	"Arrow Orbit",
	"Bagua Trigram",
	"Braille Column",
	"Braille Level",
	"Circle Pulse",
	"Circle Wave",
	"Claudeon",
	"Diamond Glow",
	"Diamond Pulse",
	"Dot Spine",
	"Gemini",
	"Kanji Count",
	"Pacman",
	"Shade Wave",
	"Suzhou Tally",
	"Yin Yang Lines",
] as const;
export type SpinnerPreset = (typeof SPINNER_PRESETS)[number];
export const DEFAULT_SPINNER_PRESET: SpinnerPreset = "Arnative";

/** Persistence key in `arnative-config.json` (see `lib/preset-store.ts`). */
export const SPINNER_PRESET_KEY = "spinnerPreset";
/** Persistence key for the gradient override on `accent` presets. Values: `"on"` / `"off"`. */
export const SPINNER_GRADIENT_KEY = "spinnerGradient";

interface Preset {
	/** Animation frames. Empty leaves pi's indicator alone. */
	frames: readonly string[];
	/** Frame delay in ms. `0` keeps pi's interval. */
	intervalMs: number;
	/** How the frame is painted. */
	paint: "accent" | "gradient" | "claudeon";
	/** Shown in the picker row after `·`. */
	note: string;
}

/** The Claude Code mark, restyled: the four marks Claudeon pulses through.
 *
 *  Only one rule decides the set: every frame must be a glyph the terminal font *itself* carries,
 *  so it advances exactly one cell. A glyph the font lacks is served by a fallback font, and
 *  fallbacks are not monospaced — measured in the terminal face (JetBrainsMono Nerd Font), the
 *  Dingbats marks `✢` `✤` `✻` `✽` `❋` advance **1.48** cells and `U+2733` **2.29**, against a **1.00**
 *  native cell, which walks the label sideways on every tick that uses one. `·` `*` `⋆` `✶` all
 *  advance 1.00 in that face (and in Consolas, Cascadia, Lucida, Courier), so the four-mark swell
 *  `· → * → ⋆ → ✶` is smooth on all of them. A scan of all 86 installed families found none that
 *  covers the Dingbats block at ~1 em, so a fifth mark cannot be added by picking a nicer glyph —
 *  only by finding one the monospace faces already ship. Frames are pinned by codepoint in the
 *  self-check, so a silent swap cannot creep back in. */
const CLAUDE_BASE_FRAMES = ["\u00b7", "\u002a", "\u22c6", "\u2736"] as const;
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
	// A dot body growing outward from a two-cell core: each frame adds one dot cell on both ends
	// (⠂⠐ → ⠺ ⠂⠐ ⠗ → ⠺ ⠪ ⠂⠐ ⠕ ⠗). Every frame is 10 columns so the label stays put; the
	// spacing between the cells is what makes the growth read as a body rather than a row. Named
	// off the `Braille *` prefix so it does not read as a third variant of the two above; the
	// note still says braille, which is what the glyphs are.
	"Dot Spine": {
		frames: ["    \u2802\u2810    ", "  \u283a \u2802\u2810 \u2817  ", "\u283a \u282a \u2802\u2810 \u2815 \u2817"],
		intervalMs: 200,
		paint: "accent",
		note: "braille dot body growing out from the centre, 3 frames",
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
	// Bagua trigrams (three stacked lines): mountain, water, thunder (☶ ☵ ☳). Only three of the
	// eight are used — a spinner is a short loop, not a catalogue — and all three arrive from the
	// same fallback face at the same width, so the row holds its place even though the terminal
	// font itself has none of them.
	"Bagua Trigram": {
		frames: ["\u2636", "\u2635", "\u2633"],
		intervalMs: 200,
		paint: "accent",
		note: "bagua trigrams — mountain, water, thunder",
	},
	// I Ching digrams: two stacked lines that go solid, then break one at a time (⚌ ⚎ ⚍ ⚏).
	// Read as a movement, the broken (yin) line travels downward — both lines whole, the lower
	// one breaks, the break moves up, then both are broken — and the loop restarts. All four
	// glyphs come from one fallback face at one width, so the row is constant even though the
	// terminal font itself has none of them.
	"Yin Yang Lines": {
		frames: ["\u268c", "\u268e", "\u268d", "\u268f"],
		intervalMs: 200,
		paint: "accent",
		note: "I Ching digrams, a broken line travelling through two",
	},
	// A four-arrow ring turning clockwise one position per frame (▴▸▾◂ ▸▾◂▴ ▾◂▴▸ ◂▴▸▾).
	// 200ms × 4 matches Diamond Glow: one full turn per 0.8s.
	"Arrow Orbit": {
		frames: ["\u25b4\u25b8\u25be\u25c2", "\u25b8\u25be\u25c2\u25b4", "\u25be\u25c2\u25b4\u25b8", "\u25c2\u25b4\u25b8\u25be"],
		intervalMs: 200,
		paint: "accent",
		note: "four-arrow ring, turning clockwise",
	},
	// The package's own spinner, and the default: a spark and a braille cell trading places
	// around the centre. The trailing space in two frames is load-bearing: both cells are one
	// column wide, so dropping it would shift the label by a column every second frame.
	"Arnative": {
		frames: [" \u2727\u2819", " \u2727\u28e0", "\u28c4\u2727 ", "\u280b\u2726 "],
		intervalMs: 200,
		paint: "accent",
		note: "spark and dot cell circling, the Arnative mark",
	},
	// Pacman eating his way across the row, one cell per frame, with the trail behind him
	// (`~` = ghost tail, `+ − ×` = the pellets still ahead). Every frame is 7 columns so the
	// label stays put; `ᗧ` is U+15E7, the Canadian Syllabics `ye`, the glyph the pacman CLI
	// spinners use because it reads as an open mouth facing right.
	Pacman: {
		frames: ["\u15e7 + \u2212 \u00d7", "~ \u15e7 \u2212 \u00d7", "~ ~ \u15e7 \u00d7", "~ ~ ~ \u15e7"],
		intervalMs: 200,
		paint: "accent",
		note: "pacman eating the pellets, 4 frames",
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
	// Claudeon: a mark of our own, inspired by Claude Code's pulsing dingbats. The shape is
	// Claude's; the glyphs are not — they are picked to be one cell wide in the terminal font.
	Claudeon: {
		frames: CLAUDE_PING_PONG_FRAMES,
		intervalMs: 120,
		paint: "claudeon",
		note: "inspired by Claude — pulsing marks, 120ms",
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

/** Claude Code's own spinner colour: the grey-orange it brands around. Claudeon keeps it,
 *  because the colour is what makes the mark read as "the Claude-style spinner". */
const CLAUDEON_RGB: readonly [number, number, number] = [215, 119, 87];

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

/**
 * How long one full sweep of the brand gradient takes, in ms.
 *
 * The frame interval decides how many steps the sweep gets, so the step size — what the eye reads
 * as smooth or as stepping — is `cycle / interval`. At 4s a 200ms preset moves up to 65 RGB units
 * per frame, which reads as a strobe rather than a sweep; 20s brings that to 13 (measured:
 * `200ms` 64.9 → 13.2, `80ms` 26.2 → 5.7 max delta). 20s is also slow enough to stay readable on
 * `Pi (system)`, where the same sweep would otherwise finish in one blink.
 */
export const GRADIENT_CYCLE_MS = 20000;

/** The Google sweep, shared by the `gradient` presets and the `accent` override. */
const gradientPainter = (text: string): string => `${fgRgb(googleGradientRgb(Date.now() / GRADIENT_CYCLE_MS))}${text}\x1b[0m`;

/** Painter for a preset's spinner; gradient and claudeon use fixed branding, accent uses theme.
 *
 *  `gradient` is the `/arnative` → Animations `[g]` override. It only reaches presets whose
 *  own paint mode is `accent`: `Gemini` is already the brand sweep, and `Claudeon` carries its
 *  own mark colour, so overriding either would erase what the preset exists to be. */
export function spinnerPainter(
	preset: SpinnerPreset,
	theme: { fg?(color: string, text: string): string } | null,
	gradient = false,
): (text: string) => string {
	const def = SPINNER_PRESET_DEFS[preset];
	if (def.paint === "gradient") return gradientPainter;
	if (def.paint === "claudeon") {
		return (text) => `${fgRgb(CLAUDEON_RGB)}${text}\x1b[0m`;
	}
	if (gradient) return gradientPainter;
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

/** The frame a live preview should show at `now`, and the width to reserve for it.
 *
 *  The picker animates the selected row from the wall clock instead of a stored counter, so a
 *  dropped repaint cannot desynchronise it — the index is a function of `now`. The width is the
 *  widest frame, so the row does not jump as the cell changes. */
export function previewFrameAt(preset: SpinnerPreset, now = Date.now()): { text: string; width: number } {
	const def = SPINNER_PRESET_DEFS[preset];
	const frames = def.frames.length > 0 ? def.frames : SPINNER_PRESET_DEFS.Gemini.frames;
	const intervalMs = def.frames.length > 0 ? def.intervalMs : 80;
	const index = Math.floor(now / intervalMs) % frames.length;
	return { text: frames[index]!, width: Math.max(...frames.map((f) => [...f].length)) };
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

	// Claudeon preset: a mark of our own, inspired by Claude Code's pulsing dingbats. The
	// attribution lives in the preset's note; the type and colour keep the `claudeon` name.
	const claudeon = SPINNER_PRESET_DEFS.Claudeon.frames;
	assert(claudeon[0] === "\u00b7", "Claudeon starts on the interpunct");
	assert(claudeon.length === 8, "Claudeon uses an 8-frame there-and-back loop over 4 base marks");
	assert(SPINNER_PRESET_DEFS.Claudeon.intervalMs === 120, "Claudeon matches upstream 120ms cadence");
	assert(claudeon.join("") === [...claudeon].reverse().join(""), "Claudeon's ping-pong frames are a palindrome");
	assert(
		claudeon.join("") === "\u00b7\u002a\u22c6\u2736\u2736\u22c6\u002a\u00b7",
		"Claudeon's base marks are pinned by codepoint",
	);
	// Every frame must be one column by the Unicode width tables — that catches a fullwidth or
	// CJK mark slipped in. It cannot catch the *real* failure mode (a glyph the terminal font
	// lacks, served ~1.5 cells wide by a fallback font), because that width is a font property
	// and is invisible from here. Those frames are pinned by codepoint above instead, so the set
	// cannot change silently.
	assert(
		claudeon.every((f) => visibleWidth(f) === 1),
		`Claudeon frames must be single-column, got ${claudeon.filter((f) => visibleWidth(f) !== 1).join(" ")}`,
	);

	// Arrow Orbit, Arnative and Pacman each draw several glyphs per frame, so every frame must
	// be the same width or the label jumps sideways each tick. Pinned by codepoint: a font
	// fallback that swaps one arrow/star for a double-width glyph is exactly what this catches.
	const arrow = SPINNER_PRESET_DEFS["Arrow Orbit"].frames;
	assert(arrow.join("|") === "\u25b4\u25b8\u25be\u25c2|\u25b8\u25be\u25c2\u25b4|\u25be\u25c2\u25b4\u25b8|\u25c2\u25b4\u25b8\u25be", "Arrow Orbit turns clockwise one position per frame");
	const spark = SPINNER_PRESET_DEFS.Arnative.frames;
	assert(spark.join("|") === " \u2727\u2819| \u2727\u28e0|\u28c4\u2727 |\u280b\u2726 ", "Arnative frames as specified");
	const pacman = SPINNER_PRESET_DEFS.Pacman.frames;
	assert(
		pacman.join("|") === "\u15e7 + \u2212 \u00d7|~ \u15e7 \u2212 \u00d7|~ ~ \u15e7 \u00d7|~ ~ ~ \u15e7",
		"Pacman eats one cell per frame",
	);
	// The mouth moves one cell right each frame, so the glyph's column is the frame index.
	for (const [i, frame] of pacman.entries()) {
		assert([...frame].indexOf("\u15e7") === i * 2, `Pacman frame ${i} puts the mouth in column ${i * 2}`);
	}
	assert(DEFAULT_SPINNER_PRESET === "Arnative", "a fresh install gets the Arnative spinner");
	// The four I Ching digrams, pinned by codepoint, in the order the operator gave them.
	const yinYang = SPINNER_PRESET_DEFS["Yin Yang Lines"].frames;
	assert(
		yinYang.join("|") === "\u268c|\u268e|\u268d|\u268f",
		"Yin Yang Lines frames as specified (all whole, lower breaks, break rises, both break)",
	);
	assert(new Set(yinYang).size === 4, "Yin Yang Lines shows four distinct digrams");
	// The three bagua trigrams, pinned by codepoint, in the order the operator gave them.
	const bagua = SPINNER_PRESET_DEFS["Bagua Trigram"].frames;
	assert(bagua.join("|") === "\u2636|\u2635|\u2633", "Bagua Trigram frames as specified (mountain, water, thunder)");
	assert(new Set(bagua).size === 3, "Bagua Trigram shows three distinct trigrams");
	const worm = SPINNER_PRESET_DEFS["Dot Spine"].frames;
	assert(
		worm.join("|") === "    \u2802\u2810    |  \u283a \u2802\u2810 \u2817  |\u283a \u282a \u2802\u2810 \u2815 \u2817",
		"Dot Spine frames as specified",
	);
	// The core `⠂⠐` sits at columns 4-5 in every frame and the body grows outward around it, so
	// the centre never drifts; the glyph count grows 2 → 4 → 6.
	for (const frame of worm) assert([...frame].slice(4, 6).join("") === "\u2802\u2810", `Dot Spine keeps its core centred: ${JSON.stringify(frame)}`);
	assert(worm.map((f) => [...f].filter((c) => c !== " ").length).join() === "2,4,6", "Dot Spine adds one cell at each end per frame");
	for (const frames of [arrow, spark, pacman, worm]) {
		const widths = new Set(frames.map((f) => [...f].length));
		assert(widths.size === 1, `every frame of a multi-glyph preset is the same length: ${[...widths].join()}`);
	}

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

	// The `[g]` override reaches accent presets only: the two branded presets keep their identity.
	const override = spinnerPainter("Diamond Glow", { fg: (c, t) => `<${c}>${t}` }, true)("x");
	assert(override.startsWith("\x1b[38;2;") && override.endsWith("x\x1b[0m"), "gradient overrides an accent preset");
	assert(spinnerPainter("Diamond Glow", null, true)("x").startsWith("\x1b[38;2;"), "the override needs no theme");
	assert(
		spinnerPainter("Claudeon", { fg: (c, t) => `<${c}>${t}` }, true)("x").startsWith("\x1b[38;2;215;119;87m"),
		"gradient leaves Claudeon's own mark colour alone",
	);
	// Gemini already sweeps and Claudeon owns its mark colour, so `[g]` must not repaint either.
	assert(
		spinnerPainter("Gemini", null, true) === spinnerPainter("Gemini", null),
		"the flag is ignored on a preset that already sweeps",
	);
	assert(
		spinnerPainter("Claudeon", null, true)("x") === spinnerPainter("Claudeon", null)("x"),
		"the flag is ignored on the preset that carries a mark colour",
	);
	const grad = spinnerPainter("Gemini", null)("x");
	assert(grad.startsWith("\x1b[38;2;") && grad.endsWith("x\x1b[0m"), "the gradient painter emits truecolor + reset");

	// The sweep must be slow enough to read as motion: the frame interval is fixed per preset, so
	// the step size is what the cycle decides. Pin the measured ceiling rather than a taste.
	const stepCeiling = (intervalMs: number): number => {
		const steps = GRADIENT_CYCLE_MS / intervalMs;
		let worst = 0;
		for (let i = 0; i < steps; i++) {
			const a = googleGradientRgb(i / steps);
			const b = googleGradientRgb((i + 1) / steps);
			worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
		}
		return worst;
	};
	assert(stepCeiling(200) <= 15, `the slowest preset steps <= 15 RGB units (got ${stepCeiling(200).toFixed(1)})`);
	assert(stepCeiling(80) <= 8, `the fastest preset steps <= 8 RGB units (got ${stepCeiling(80).toFixed(1)})`);
	assert(spinnerPainter("Claudeon", null)("x").startsWith("\x1b[38;2;215;119;87m"), "Claudeon uses its own mark colour");

	assert(previewFrames("Diamond Glow").split(" ").length === 4, "the picker preview shows every Diamond frame");
	assert(previewFrames("Pi (system)").length > 0, "Pi (system) still previews pi's Braille set");

	// Picker order: the two fixed rows first, then everything else alphabetically. Pinned
	// because a new preset must not land wherever the edit happened to be.
	assert(SPINNER_PRESETS[0] === "Pi (system)" && SPINNER_PRESETS[1] === "Arnative", "the two fixed rows lead the picker");
	const rest = SPINNER_PRESETS.slice(2);
	assert(
		rest.join() === [...rest].sort((a, b) => a.localeCompare(b)).join(),
		`the rest is alphabetical, got ${rest.join()}`,
	);
	assert(new Set(SPINNER_PRESETS).size === SPINNER_PRESETS.length, "every preset name is unique");

	// The live preview reads the clock, so it advances without any stored counter.
	assert(previewFrameAt("Diamond Glow", 0).text === "\u2b25", "the preview starts on frame 0");
	assert(previewFrameAt("Diamond Glow", 200).text === "\u25c8", "the preview advances one frame per interval");
	assert(previewFrameAt("Diamond Glow", 800).text === "\u2b25", "the preview wraps at the end of the loop");
	assert(previewFrameAt("Pacman", 0).width === 7, "the preview reserves the widest frame");

	console.log("spinner.ts self-check OK");
}