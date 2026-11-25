import test from "node:test";
import { assert } from "../helpers/check.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { textSpans, inSpans, boxRow, BRAND, screenTitle, renderScreen, renderBoxRows, renderBoxLines, type BoxTheme } from "../../lib/box.ts";

test("lib/box.ts self-check", async () => {
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
	// A legend that styles itself (the models picker accents its picked count) renders
	// verbatim: no dim wrap that would mute the accent and leak a reset into the tail.
	const styled = renderScreen(th, 60, { title: "t", description: "d", legend: "<accent>34/44 picked</accent><dim> · keys</dim>" }, []);
	assert(styled[styled.length - 2]!.includes("<accent>34/44 picked</accent>"), "a pre-styled legend renders verbatim");
	// The header copy is longer than a narrow terminal: the wall must win over the text.
	const longCopy = "Selection previews live — arnative themes only (all themes: /settings → Theme).";
	for (const w of [40, 50, 56, 60]) {
		const narrow = renderScreen(th, w, { title: screenTitle("Themes"), description: longCopy, legend: "[Esc] Back" }, []);
		assert(narrow.every((l) => visibleWidth(l) === w), `a long description keeps every line at width ${w}`);
		assert(
			narrow.filter((l) => l.startsWith("│")).every((l) => l.endsWith("│")),
			`a long description keeps the right wall at width ${w}`,
		);
	}
	// Click target on a piece of text: cells, not characters, and nothing when clipped.
	const line = renderBoxRows(th, 40, ["Todos (3/7) [click to expand]"], undefined, undefined).lines[1]!;
	const spans = textSpans([line], "[click to expand]");
	assert(spans.length === 1 && spans[0]!.row === 0, "textSpans finds the hint on its row");
	assert(spans[0]!.start === visibleWidth("│ Todos (3/7) "), `span starts at the hint, got ${spans[0]!.start}`);
	assert(inSpans(spans, 0, spans[0]!.start) && inSpans(spans, 0, spans[0]!.end), "span covers the first and last cell");
	assert(!inSpans(spans, 0, spans[0]!.start - 1) && !inSpans(spans, 1, spans[0]!.start), "span excludes the cell before and other rows");
	assert(textSpans([boxRow("Todos (3/7) [click to exp…", 24, (t) => t)], "[click to expand]").length === 0, "a clipped hint is not clickable");
	// Wide characters before the hint shift cells, not characters.
	const wide = textSpans([boxRow("日本 [x]", 24, (t) => t)], "[x]");
	assert(wide[0]!.start === visibleWidth("│ 日本 "), `a wide glyph shifts by cells, got ${wide[0]!.start}`);
});
