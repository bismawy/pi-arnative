/**
 * Single arnative box border (dim, round ends). Used by tools.ts, ui-render-tweaks.ts
 * and usage.ts — edit here, all follow. Lives outside `extensions/*.ts` so pi
 * never loads it as an extension.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { thinkingColorOf } from "./ansi.ts";
import { assert, isMain } from "./check.ts";

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
	/** Keybind legend, drawn as the last row above the bottom edge. */
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
		row(fg("dim", text.legend)),
		boxEdge("╰", "╯", width, border),
	].map((l) => truncateToWidth(l, width, ""));
}

/** Wrap `rows` (plain or ANSI-colored) into a box. `bgType` = theme bg name (no-op when the theme has no `bg`); `borderColor` = border color.
 *  `theme` may be null: a box is patched in at module load, before `session_start`
 *  delivers the active theme. An uncolored box for that first frame beats a null
 *  deref that kills the process. */
export function renderBoxLines(theme: BoxTheme | null, width: number, rows: string[], bgType?: string, borderColor = "dim"): string[] {
	const dim = (s: string) => (theme ? theme.fg(borderColor, s) : s);
	const inner = Math.max(8, width - 4);
	const lines = [boxEdge("╭", "╮", width, dim)];
	for (const row of rows) {
		for (const line of wrapTextWithAnsi(row, inner)) lines.push(boxRow(line, width, dim));
	}
	lines.push(boxEdge("╰", "╯", width, dim));
	if (bgType && theme?.bg) {
		try {
			return lines.map((l) => applyBg(l, width, (s) => theme!.bg!(bgType, s)));
		} catch {
			return lines;
		}
	}
	return lines;
}

if (isMain(import.meta.url)) {
	const th: BoxTheme = { fg: (_c, t) => t };
	const plain = renderBoxLines(th, 24, ["hello", "a rather long world"]);
	assert(plain[0]!.startsWith("╭") && plain[plain.length - 1]!.startsWith("╰"), "top/bottom frame intact");
	assert(plain.every((l) => visibleWidth(l) === 24), "every line is 24 wide");
	assert(plain[1] === "│ hello                │", "content line padded flush");
	assert(renderBoxLines(th, 24, ["x".repeat(40)]).length === 4, "long line wrapped");
	assert(renderBoxLines(th, 20, ["hi"], "customMessageBg").length === 3, "bg ignored when the theme has no bg");
	// A row wider than the box must lose its own tail, never its right wall: `boxRow` used to
	// pad only, so the wall overflowed `width` and the caller's `truncateToWidth` cut the wall.
	const overlong = boxRow("x".repeat(60), 20, (s) => s);
	assert(visibleWidth(overlong) === 20, `an overlong row is still exactly the width, got ${visibleWidth(overlong)}`);
	assert(overlong.endsWith("│"), `an overlong row keeps its right wall, got ${JSON.stringify(overlong)}`);
	assert(!overlong.includes("x".repeat(17)), "an overlong row truncates its own content");
	const nullTheme = renderBoxLines(null, 24, ["hello"], "customMessageBg");
	assert(nullTheme.every((l) => visibleWidth(l) === 24), "null theme renders an uncolored box instead of throwing");
	assert(nullTheme[0]!.startsWith("╭") && nullTheme[1] === "│ hello                │", "null-theme frame and padding intact");
	// Rule 5: too narrow for `│ │`, a row is empty rather than 4 columns wide — pi may hand a
	// component the width of a sidebar, and a 4-wide row would overflow it.
	for (const w of [1, 2, 3]) assert(boxRow("hello", w, (s) => s) === "", `a row narrower than four columns is empty at width ${w}`);

	// The shared screen chrome: one sequence for every arnative screen.
	assert(screenTitle("Settings") === `Settings - Arnative${BRAND}`, "screenTitle pins the <setting> - <extension> shape");
	assert(screenTitle("Usage") === "Usage - Arnative\u2819", "the brand is the braille mark, not a Nerd Font glyph");
	const screen = renderScreen(th, 60, { title: "Usage - Arnative\u2819", description: "Token & cost", legend: "[Esc] Close" }, ["a row", ""]);
	assert(screen[0]!.startsWith("╭") && screen[screen.length - 1]!.startsWith("╰"), "screen frame intact");
	assert(screen.every((l) => visibleWidth(l) === 60), "every screen line is exactly the width");
	assert(screen[1]!.includes("Usage - Arnative\u2819"), "the title sits on the first row inside the frame");
	assert(screen[2]!.includes("Token & cost"), "the description sits under the title");
	assert(screen[screen.length - 2]!.includes("[Esc] Close"), "the legend is the last row above the bottom edge");
	// No full-width rule inside the frame (skill rule 7): the chrome is the whole chrome.
	assert(!screen.some((l) => /[├┤]/.test(l)), "the shared chrome draws no inner rule");
	const taggedBox = { fg: (c: string, t: string) => `<${c}>${t}</>`, bold: (t: string) => `<bold>${t}</bold>` };
	const taggedScreen = renderScreen(taggedBox, 60, { title: "T", description: "d", legend: "l" }, []);
	assert(taggedScreen[1]!.includes("<accent><bold>T"), "the title is accent + bold");
	assert(taggedScreen[2]!.includes("<muted>d"), "the description is muted");
	assert(taggedScreen[taggedScreen.length - 2]!.includes("<dim>l"), "the legend is dim");
	assert(renderScreen(null, 40, { title: "t", description: "d", legend: "l" }, ["x"]).every((l) => visibleWidth(l) === 40), "a null theme still frames the screen");
	// The header copy is longer than a narrow terminal: the wall must win over the text.
	const longCopy = "Selection previews live — same list as /settings → Theme.";
	for (const w of [40, 50, 56, 60]) {
		const narrow = renderScreen(th, w, { title: screenTitle("Themes"), description: longCopy, legend: "[Esc] Revert" }, []);
		assert(narrow.every((l) => visibleWidth(l) === w), `a long description keeps every line at width ${w}`);
		assert(
			narrow.filter((l) => l.startsWith("│")).every((l) => l.endsWith("│")),
			`a long description keeps the right wall at width ${w}`,
		);
	}
	console.log("lib/box.ts OK");
}
