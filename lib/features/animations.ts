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
import { choiceSetting, flagSetting } from "../preset-store.ts";
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
} from "../spinner.ts";
import { ROW_DIVIDER } from "../format.ts";
import { getRuntime } from "../runtime.ts";

const spinnerPresetSetting = choiceSetting(SPINNER_PRESET_KEY, SPINNER_PRESETS, DEFAULT_SPINNER_PRESET);
const spinnerGradientSetting = flagSetting(SPINNER_GRADIENT_KEY);
const SPINNER_PRESET_CONFIG_KEY = spinnerPresetSetting.slot;
const SPINNER_GRADIENT_CONFIG_KEY = spinnerGradientSetting.slot;

/** The `setWorkingMessage`/`setWorkingIndicator` surface of `ctx.ui`. */
type WorkingUi = { setWorkingIndicator?: (options?: unknown) => void } | null | undefined;

/** The live theme, for the accent presets. A gradient preset ignores it. */
type ThemeLike = { fg?(color: string, text: string): string } | null;

/** Record the session's `ctx.ui`, so a later preset pick can install through it. */
function workingUi(ui: WorkingUi): void {
	getRuntime().workingUi = ui ?? null;
}

/** The `ctx.ui` recorded at `session_start`, or null before one ran. */
function activeWorkingUi(): WorkingUi {
	return (getRuntime().workingUi as WorkingUi) ?? null;
}

/** Record the session's theme, so accent presets follow it instead of a stale colour. */
function workingTheme(theme: ThemeLike): void {
	getRuntime().workingTheme = theme ?? null;
}

/** The theme recorded at `session_start`; a gradient preset ignores it. */
function activeWorkingTheme(): ThemeLike {
	return (getRuntime().workingTheme as ThemeLike) ?? null;
}

export const activeSpinnerPreset = (): SpinnerPreset => spinnerPresetSetting.get();

/** Is the `accent` → gradient override on? */
export const activeSpinnerGradient = (): boolean => spinnerGradientSetting.get();

/** Flip the gradient override, persist it, and repaint the live spinner at once. */
export function setSpinnerGradient(on: boolean): void {
	spinnerGradientSetting.set(on);
	applySpinnerPreset(activeWorkingUi(), activeWorkingTheme());
}

/** Publish the choice for this process, write it to config, and install it on the running session. */
export function setSpinnerPreset(preset: SpinnerPreset): void {
	spinnerPresetSetting.set(preset);
	applySpinnerPreset(activeWorkingUi(), activeWorkingTheme());
}

/** Updates custom painter on live workingStatusIndicator if available. */
export function paintLiveIndicator(painter: (text: string) => string): void {
	const editor = getRuntime().editor as { workingStatusIndicator?: { renderIndicatorVerbatim?: boolean; theme?: { fg: (color: string, text: string) => string } } } | null;
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
		legend: `[↑↓] Preview  [g] Gradient ${activeSpinnerGradient() ? "on" : "off"}  [Enter] Select  [Esc] Back`,
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

export const __test = {
	SPINNER_PRESET_CONFIG_KEY,
};
