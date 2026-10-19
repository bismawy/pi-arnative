/**
 * Animations — the working-indicator preset, owned outside the footer because it is not a
 * footer concern: pi's loader spins in the boxed editor's top border and in the in-place
 * status row whether or not an arnative footer is installed.
 *
 * `/arnative` → **Animations** picks a preset; this module installs it, repaints the live
 * spinner on the spot, and hands the slot back to pi for `Pi (system)`. The frames, their
 * cadence and their painter live in `lib/spinner.ts`; the picker UI lives here.
 *
 * The Loader's colour hooks are not reachable through pi's public indicator options, so this
 * module reaches the live editor the footer publishes under `EDITOR_KEY`. That is the one
 * coupling between the two, and it is a published symbol, not an import.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadChoice, saveChoice } from "../lib/preset-store.ts";
import {
	DEFAULT_SPINNER_PRESET,
	SPINNER_GRADIENT_KEY,
	SPINNER_PRESETS,
	SPINNER_PRESET_DEFS,
	SPINNER_PRESET_KEY,
	previewFrameAt,
	previewFrames,
	spinnerPainter,
	type SpinnerPreset,
} from "../lib/spinner.ts";
import { assert, isMain } from "../lib/check.ts";
import { ROW_DIVIDER } from "../lib/format.ts";

/** The arnative editor instance, published by `footer.ts` so the live spinner is reachable. */
export const EDITOR_KEY = Symbol.for("pi-arnative.editor");
const SPINNER_PRESET_CONFIG_KEY = Symbol.for("pi-arnative.spinnerPreset");
const SPINNER_GRADIENT_CONFIG_KEY = Symbol.for("pi-arnative.spinnerGradient");

/** The `setWorkingMessage`/`setWorkingIndicator` surface of `ctx.ui`. */
type WorkingUi = { setWorkingIndicator?: (options?: unknown) => void } | null | undefined;

/** The live theme, for the accent presets. A gradient preset ignores it. */
type ThemeLike = { fg?(color: string, text: string): string } | null;

// Active UI and theme are kept on globalThis so choices apply across reloads and multi-instance loads.
const UI_KEY = Symbol.for("pi-arnative.workingUi");
const THEME_KEY = Symbol.for("pi-arnative.workingTheme");

/** Record the session's `ctx.ui`, so a later preset pick can install through it. */
function workingUi(ui: WorkingUi): void {
	(globalThis as Record<symbol, unknown>)[UI_KEY] = ui ?? undefined;
}

/** The `ctx.ui` recorded at `session_start`, or null before one ran. */
function activeWorkingUi(): WorkingUi {
	return ((globalThis as Record<symbol, unknown>)[UI_KEY] as WorkingUi) ?? null;
}

/** Record the session's theme, so accent presets follow it instead of a stale colour. */
function workingTheme(theme: ThemeLike): void {
	(globalThis as Record<symbol, unknown>)[THEME_KEY] = theme ?? undefined;
}

/** The theme recorded at `session_start`; a gradient preset ignores it. */
function activeWorkingTheme(): ThemeLike {
	return ((globalThis as Record<symbol, unknown>)[THEME_KEY] as ThemeLike) ?? null;
}

export function activeSpinnerPreset(): SpinnerPreset {
	const stored =
		(globalThis as Record<symbol, unknown>)[SPINNER_PRESET_CONFIG_KEY] ??
		loadChoice(SPINNER_PRESET_KEY, SPINNER_PRESETS);
	return SPINNER_PRESETS.includes(stored as SpinnerPreset) ? (stored as SpinnerPreset) : DEFAULT_SPINNER_PRESET;
}

/** Is the `accent` → gradient override on? Stored as `"on"`/`"off"` so an absent key reads as
 *  off through the same allow-list path every other choice uses. */
export function activeSpinnerGradient(): boolean {
	const stored =
		(globalThis as Record<symbol, unknown>)[SPINNER_GRADIENT_CONFIG_KEY] ??
		loadChoice(SPINNER_GRADIENT_KEY, ["on", "off"] as const);
	return stored === "on";
}

/** Flip the gradient override, persist it, and repaint the live spinner at once. */
export function setSpinnerGradient(on: boolean): void {
	(globalThis as Record<symbol, unknown>)[SPINNER_GRADIENT_CONFIG_KEY] = on ? "on" : "off";
	saveChoice(SPINNER_GRADIENT_KEY, on ? "on" : "off");
	applySpinnerPreset(activeWorkingUi(), activeWorkingTheme());
}

/**
 * Publish the choice for this process, write it to `arnative-config.json`, and install it on
 * the running session right away — the picker previews by moving the cursor, so a choice that
 * only took effect on the next `session_start` would look like the selection did nothing.
 */
export function setSpinnerPreset(preset: SpinnerPreset): void {
	(globalThis as Record<symbol, unknown>)[SPINNER_PRESET_CONFIG_KEY] = preset;
	saveChoice(SPINNER_PRESET_KEY, preset);
	applySpinnerPreset(activeWorkingUi(), activeWorkingTheme());
}

/** Updates custom painter on live workingStatusIndicator if available. */
export function paintLiveIndicator(painter: (text: string) => string): void {
	const editor = (globalThis as Record<symbol, any>)[EDITOR_KEY];
	const indicator = editor?.workingStatusIndicator;
	if (!indicator) return;
	indicator.renderIndicatorVerbatim = false;
	indicator.spinnerColorFn = painter;
	indicator.updateDisplay?.();
}

/** Applies preset to working indicator or restores system default for 'Pi (system)'. */
export function applySpinnerPreset(ui: WorkingUi, theme: ThemeLike): void {
	const preset = activeSpinnerPreset();
	const def = SPINNER_PRESET_DEFS[preset];
	const painter = spinnerPainter(preset, theme, activeSpinnerGradient());
	try {
		if (def.frames.length === 0) ui?.setWorkingIndicator?.();
		else ui?.setWorkingIndicator?.({ frames: [...def.frames], intervalMs: def.intervalMs });
	} catch {
		// older host without the API -> pi's own frames stay
	}
	paintLiveIndicator(painter);
}

/** Picker copy. The description states the one seam: a preset applies to the next spinner.
 *  The legend is built per call because its `[g]` row states the current mode — a constant
 *  would keep saying `off` after the user turned it on. */
export function animationsPickerText(): { title: string; description: string; legend: string } {
	return {
		title: "Animations - Arnative\u2819",
		description: "The working spinner — applies on the next tool call.",
		legend: `[↑↓] Preview  [g] Gradient ${activeSpinnerGradient() ? "on" : "off"}  [Enter] Select  [Esc] Close`,
	};
}

/** One row per preset: the name, then its note and the frames it actually cycles. The
 *  frames belong in the note — a user picking an animation wants to see the glyphs, and this
 *  is the screen where that is decided. */
export function animationRows(): Array<{ label: string; note: string }> {
	return SPINNER_PRESETS.map((preset) => ({
		label: preset,
		note: `${SPINNER_PRESET_DEFS[preset].note}  ${previewFrames(preset)}`,
	}));
}

/** The row as one flat string, for the headless fallback and the self-check. */
export function animationRowText(preset: SpinnerPreset): string {
	return `${preset}${ROW_DIVIDER}${SPINNER_PRESET_DEFS[preset].note}  ${previewFrames(preset)}`;
}

/** Repaint cadence for the picker's animated row. Fast enough to read as motion at every
 *  preset's own interval (the slowest is 200ms, the fastest 80ms), cheap because the row only
 *  redraws one line. */
export const PREVIEW_TICK_MS = 80;

/** Note for one row with the frame that is live *now*, padded to the widest frame so the
 *  text after it does not shift as the glyph changes. */
export function animationRowNote(preset: SpinnerPreset, now = Date.now()): string {
	const { text, width } = previewFrameAt(preset, now);
	const pad = " ".repeat(Math.max(0, width - [...text].length));
	return `${SPINNER_PRESET_DEFS[preset].note}  ${text}${pad}`;
}

/** Register the extension: keep the installed preset in step with the session's theme. */
export default function registerAnimations(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// A preset is installed per session so it survives `/reload` and a theme switch
		// repaints the accent presets without re-selecting anything. Publish the surfaces first:
		// `/arnative` → Animations re-applies through them the moment a row is chosen.
		workingUi(ctx.ui);
		workingTheme((ctx.ui as unknown as { theme?: ThemeLike })?.theme ?? null);
		applySpinnerPreset(activeWorkingUi(), activeWorkingTheme());
	});
}

// Self-check: `node extensions/animations.ts`. Async because the cross-instance assertion
// imports a second copy of this module.
if (isMain(import.meta.url)) {
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
	delete (globalThis as Record<symbol, unknown>)[EDITOR_KEY];
	paintLiveIndicator((t) => t);

	// Picking a preset must apply it NOW, not on the next session — and it must work when the
	// picker calls a DIFFERENT module instance than the one that ran `session_start`. pi loads
	// every manifest entry through its own loader while `arnative.ts` imports this module too,
	// so there are two copies with separate module scope; only `globalThis` is shared. Keeping
	// the surfaces on globalThis is what this pins, and a same-instance test would not catch it
	// (the original bug passed such a test: the row moved, the spinner did not).
	const pickCalls: Array<Record<string, unknown> | undefined> = [];
	const pickUi = { setWorkingIndicator: (options?: Record<string, unknown>) => pickCalls.push(options) };
	const handlers: Array<(e: unknown, c: unknown) => unknown> = [];
	registerAnimations({ on: (_n: string, fn: (e: unknown, c: unknown) => unknown) => handlers.push(fn) } as never);
	// Instance A runs session_start and records the ui on globalThis.
	handlers[0]!({}, { ui: pickUi, theme: { fg: (_c: string, t: string) => t } });
	pickCalls.length = 0;
	// Instance B — a second copy of the module, like the one `arnative.ts` holds — does the pick.
	const instanceB = await import(`./animations.ts?second=${Date.now()}`);
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
	(globalThis as Record<symbol, any>)[EDITOR_KEY] = editor;
	paintLiveIndicator((t) => `<a>${t}`);
	assert(editor.workingStatusIndicator.renderIndicatorVerbatim === false, "verbatim cleared, else pi skips the painter");
	assert(painted === 1, "the live indicator repaints at once");
	delete (globalThis as Record<symbol, any>)[EDITOR_KEY];

	console.log("animations.ts self-check OK");
	})();
}