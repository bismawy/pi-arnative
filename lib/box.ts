/**
 * Single arnative box border (dim, round ends). Used by tools.ts, ui-render-tweaks.ts
 * and usage.ts — edit here, all follow. Lives outside `extensions/*.ts` so pi
 * never loads it as an extension.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripAnsi, thinkingColorOf } from "./ansi.ts";

/** A clickable span inside rendered lines: 0-based cell columns, inclusive. */
export interface TextSpan {
	row: number;
	start: number;
	end: number;
}

/**
 * Where `text` sits in each rendered line, in cell columns. A mouse handler needs this to
 * make one piece of a box clickable and leave the rest to pi: a press the handler does not
 * take stays with the text selection, so a box can be clicked and copied at once.
 * A line that shows the text in part (narrow width) yields no span, so a clipped label is
 * never half-clickable.
 */
export function textSpans(lines: readonly string[], text: string): TextSpan[] {
	if (!text) return [];
	const width = visibleWidth(text) - 1;
	const spans: TextSpan[] = [];
	lines.forEach((line, row) => {
		const plain = stripAnsi(line);
		const at = plain.indexOf(text);
		if (at >= 0) {
			const start = visibleWidth(plain.slice(0, at));
			spans.push({ row, start, end: start + width });
		}
	});
	return spans;
}

/** Whether the 0-based cell `x` on `row` lands inside one of `spans`. */
export const inSpans = (spans: readonly TextSpan[], row: number, x: number): boolean =>
	spans.some((span) => span.row === row && x >= span.start && x <= span.end);

/** Delay before holding a scroll affordance starts repeating, so a normal click scrolls once. */
export const HOLD_DELAY_MS = 250;
/** Repeat interval while holding a scroll affordance. */
export const HOLD_REPEAT_MS = 90;

export interface HoldRepeat {
	start(step: () => boolean): void;
	stop(): void;
}

/** Shared press-and-hold auto-repeat timer for scrollable TUI boxes. */
export function createHoldRepeat(delayMs = HOLD_DELAY_MS, repeatMs = HOLD_REPEAT_MS): HoldRepeat {
	let delay: ReturnType<typeof setTimeout> | undefined;
	let repeat: ReturnType<typeof setInterval> | undefined;
	let token = 0;

	const stop = (): void => {
		token++;
		if (delay) {
			clearTimeout(delay);
			delay = undefined;
		}
		if (repeat) {
			clearInterval(repeat);
			repeat = undefined;
		}
	};

	const start = (step: () => boolean): void => {
		stop();
		const run = token;
		delay = setTimeout(() => {
			delay = undefined;
			if (run !== token) return;
			if (!step()) {
				stop();
				return;
			}
			if (run !== token) return;
			repeat = setInterval(() => {
				if (run !== token || !step()) stop();
			}, repeatMs);
		}, delayMs);
	};

	return { start, stop };
}

export type BoxTheme = { fg(color: string, text: string): string; bg?(color: string, text: string): string; bold?(text: string): string };
type Dim = (s: string) => string;

export const boxEdge = (l: string, r: string, width: number, dim: Dim): string =>
	dim(`${l}${"─".repeat(Math.max(0, width - 2))}${r}`);

/** Content row: │ <text> │, exactly `width` wide. Content is truncated to preserve border. */
export const boxRow = (content: string, width: number, dim: Dim): string => {
	// Minimum 4 columns required for borders and padding (skill arnative-pi §6 rule 5).
	if (width < 4) return "";
	const fitted = truncateToWidth(content, width - 4, "");
	const pad = Math.max(0, width - visibleWidth(fitted) - 4);
	return `${dim("│")} ${fitted}${" ".repeat(pad)} ${dim("│")}`;
};

const applyBg = (line: string, width: number, bgFn: (text: string) => string): string => {
	const pad = Math.max(0, width - visibleWidth(line));
	return bgFn(line + " ".repeat(pad));
};

/** What every arnative screen says about itself. `title` follows `<setting> - <extension>`
 *  (see {@link screenTitle}); `description` is the one-liner under it. */
export interface ScreenText {
	title: string;
	description: string;
	/** Keybind legend, drawn as the last row above the bottom edge. Plain text is dimmed
	 *  by the frame; a legend that already carries ANSI styling renders verbatim. */
	legend: string;
}

/** `Arnative⠙` — the braille mark that brands every arnative screen. */
export const BRAND = "\u2819";

/** The one title shape for an arnative screen: `<setting> - <extension>⠙`. */
export function screenTitle(setting: string, extension = `Arnative${BRAND}`): string {
	return `${setting} - ${extension}`;
}

/** The chrome every arnative screen shares: frame, title in `accent`+bold, description in
 *  `muted`, blank, the screen's `body`, blank, legend in `dim`. One function so the screens
 *  cannot drift apart; `body` rows arrive already painted and truncated. */
export function renderScreen(
	theme: BoxTheme | null,
	width: number,
	text: ScreenText,
	body: string[],
	/** Border painter. Defaults to the thinking slot (skill arnative-pi §6 rule 1: the frame
	 *  follows the session's thinking level); pass the real level so the box tracks the model. */
	border: Dim = thinkingColorOf(theme, undefined),
): string[] {
	const fg = (color: string, s: string) => (theme ? theme.fg(color, s) : s);
	const bold = theme?.bold?.bind(theme) ?? ((s: string) => s);
	const row = (content: string) => boxRow(content, width, border);
	return [
		boxEdge("╭", "╮", width, border),
		row(fg("accent", bold(text.title))),
		row(fg("muted", text.description)),
		row(""),
		...body.map(row),
		row(""),
		row(text.legend.includes("\u001b[") ? text.legend : fg("dim", text.legend)),
		boxEdge("╰", "╯", width, border),
	].map((l) => truncateToWidth(l, width, ""));
}

/** Border paint: a theme token name, or a painter for a tier that has no token (the thinking
 *  slots, which `thinkingColorOf` resolves). */
export type BoxBorder = string | ((text: string) => string);

/** `renderBoxLines` plus where each input row landed: `starts[i]` is the first line index of
 *  `rows[i]`. A caller that hit-tests a row (the task list's scroll counters) needs this,
 *  because a row long enough to wrap occupies more than one line. */
export function renderBoxRows(
	theme: BoxTheme | null,
	width: number,
	rows: string[],
	bgType?: string,
	border: BoxBorder = "dim",
): { lines: string[]; starts: number[] } {
	const dim = typeof border === "string" ? (s: string) => (theme ? theme.fg(border, s) : s) : border;
	const inner = Math.max(8, width - 4);
	const lines = [boxEdge("╭", "╮", width, dim)];
	const starts: number[] = [];
	for (const row of rows) {
		starts.push(lines.length);
		for (const line of wrapTextWithAnsi(row, inner)) lines.push(boxRow(line, width, dim));
	}
	lines.push(boxEdge("╰", "╯", width, dim));
	const paint = (input: string[]) => {
		if (!bgType || !theme?.bg) return input;
		try {
			return input.map((l) => applyBg(l, width, (s) => theme!.bg!(bgType, s)));
		} catch {
			return input;
		}
	};
	return { lines: paint(lines), starts };
}

/** The box around `rows`. `bgType` = theme bg name (no-op when the theme has no `bg`);
 *  `borderColor` = border color.
 *  `theme` may be null: a box is patched in at module load, before `session_start`
 *  delivers the active theme. An uncolored box for that first frame beats a null
 *  deref that kills the process. */
export function renderBoxLines(theme: BoxTheme | null, width: number, rows: string[], bgType?: string, border: BoxBorder = "dim"): string[] {
	return renderBoxRows(theme, width, rows, bgType, border).lines;
}
