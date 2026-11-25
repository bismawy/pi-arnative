import test from "node:test";
import { assert } from "../helpers/check.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SPINNER_PRESETS, DEFAULT_SPINNER_PRESET, SPINNER_PRESET_DEFS, googleGradientRgb, GRADIENT_CYCLE_MS, spinnerPainter, previewFrames, previewFrameAt } from "../../lib/spinner.ts";

test("lib/spinner.ts self-check", async () => {
	for (const p of SPINNER_PRESETS) {
		const def = SPINNER_PRESET_DEFS[p];
		assert(def.note.length > 0, `${p} carries a picker note`);
		for (const frame of def.frames) {
			assert(!/[\ufffd\ue000-\uf8ff]/.test(frame), `${p}: frame ${frame} is not a blank private-use cell`);
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

});
