import test from "node:test";
import { assert } from "../helpers/check.ts";
import {
	DEFAULT_SPINNER_PRESET,
	SPINNER_PRESETS,
	SPINNER_PRESET_DEFS,
	activeSpinnerPreset,
	setSpinnerPreset,
	setWorkingUi,
	paintLiveIndicator,
	applySpinnerPreset,
	animationRows,
	animationRowText,
	PREVIEW_TICK_MS,
	animationRowNote,
	__test,
} from "../../lib/spinner.ts";
import { getRuntime } from "../../lib/runtime.ts";

const { SPINNER_PRESET_CONFIG_KEY } = __test;

test("lib/spinner.ts animations self-check", async () => {
	await (async () => {
	// The rows describe exactly the presets, and every row carries its own note.
	const rows = animationRows();
	assert(rows.length === SPINNER_PRESETS.length, "one row per preset");
	assert(
		rows.every((r) => r.note.length > 0),
		"every row has a note",
	);
	assert(animationRowText("Diamond Glow").includes("\u2b25"), "the row text previews the frames");

	// The picker's animated note shows exactly one live frame, padded to the widest one so the
	// row does not shift. `animationRowNote` takes `now`, so the assertion does not race a clock.
	assert(animationRowNote("Diamond Glow", 0).endsWith("\u2b25"), "the live note shows frame 0");
	assert(animationRowNote("Diamond Glow", 200).endsWith("\u25c8"), "the live note advances with the clock");
	assert(animationRowNote("Pacman", 0).endsWith("\u15e7 + \u2212 \u00d7"), "a wide frame is shown whole");
	assert(
		animationRowNote("Pacman", 0).length === animationRowNote("Pacman", 600).length,
		"every frame pads to the same width, so the note never shifts",
	);
	assert(PREVIEW_TICK_MS <= 80, "the preview ticks at least as fast as the quickest preset");

	// Installing a preset goes through pi's indicator API; `Pi (system)` passes nothing.
	const calls: Array<Record<string, unknown> | undefined> = [];
	const ui = { setWorkingIndicator: (options?: Record<string, unknown>) => calls.push(options) };
	(globalThis as Record<symbol, unknown>)[SPINNER_PRESET_CONFIG_KEY] = "Diamond Glow";
	applySpinnerPreset(ui, null);
	assert(JSON.stringify(calls[0]?.frames) === JSON.stringify(SPINNER_PRESET_DEFS["Diamond Glow"].frames), "frames installed");
	assert(calls[0]?.intervalMs === 200, "interval installed");
	(globalThis as Record<symbol, unknown>)[SPINNER_PRESET_CONFIG_KEY] = "Pi (system)";
	applySpinnerPreset(ui, null);
	assert(calls.at(-1) === undefined, "Pi (system) passes no options -> pi restores its own spinner");

	// A stored value that names no preset falls back instead of breaking the load.
	(globalThis as Record<symbol, unknown>)[SPINNER_PRESET_CONFIG_KEY] = "Nope";
	assert(activeSpinnerPreset() === DEFAULT_SPINNER_PRESET, "an unknown stored preset falls back to the default");
	delete (globalThis as Record<symbol, unknown>)[SPINNER_PRESET_CONFIG_KEY];

	// The painter seam: without a published editor there is nothing to paint, and that must
	// be a no-op rather than a throw (the editor registers after the first session_start).
	getRuntime().editor = null;
	paintLiveIndicator((t) => t);

	// Picking a preset must apply it NOW, not on the next session — and it must work when the
	// picker calls a DIFFERENT module instance than the one that ran `session_start`. pi loads
	// every manifest entry through its own loader while `arnative.ts` imports this module too,
	// so there are two copies with separate module scope; only `globalThis` is shared. Keeping
	// the surfaces on globalThis is what this pins, and a same-instance test would not catch it
	// (the original bug passed such a test: the row moved, the spinner did not).
	const pickCalls: Array<Record<string, unknown> | undefined> = [];
	const pickUi = { setWorkingIndicator: (options?: Record<string, unknown>) => pickCalls.push(options) };
	// Instance A records the ui on globalThis (as footer's session_start does).
	setWorkingUi(pickUi);
	applySpinnerPreset(pickUi, { fg: (_c: string, t: string) => t });
	pickCalls.length = 0;
	// Instance B — a second copy of the module — does the pick.
	const instanceB = await import(`../../lib/spinner.ts?second=${Date.now()}`);
	instanceB.setSpinnerPreset("Claudeon");
	assert(pickCalls.length === 1, "a second module instance installs through the shared ui");
	assert(pickCalls[0]?.frames?.[0] === "\u00b7", "the chosen preset's frames are installed, not the old ones");
	assert(pickCalls[0]?.intervalMs === 120, "and its cadence (120ms)");

	// Pi (system) still hands the slot back through the same path.
	pickCalls.length = 0;
	instanceB.setSpinnerPreset("Pi (system)");
	assert(pickCalls[0] === undefined, "choosing Pi (system) restores pi's own spinner at once");

	// With one, both the verbatim flag and the painter are set — this is what keeps the
	// colour on a custom frame.
	const indicator = { renderIndicatorVerbatim: true, spinnerColorFn: undefined as unknown, updateDisplay: () => {} };
	let painted = 0;
	const editor = { workingStatusIndicator: { ...indicator, updateDisplay: () => painted++ } };
	getRuntime().editor = editor;
	paintLiveIndicator((t) => `<a>${t}`);
	assert(editor.workingStatusIndicator.renderIndicatorVerbatim === false, "verbatim cleared, else pi skips the painter");
	assert(painted === 1, "the live indicator repaints at once");
	getRuntime().editor = null;

	console.log("animations.ts self-check OK");
	})();
});
