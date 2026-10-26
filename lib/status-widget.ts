/**
 * Rows pinned above the chat column (pi's `aboveEditor` widget slot). One shape for every
 * status line: the arnative mark, one space, then the text in the theme's `dim` token.
 *
 * pi renders a plain string array as unstyled `Text`, so `setWidget(key, ["…"])` ignores the
 * theme and the line lands in the default foreground. The patch in
 * `extensions/ui-render-tweaks.ts` turns every such array into a component factory, which
 * receives the live theme; this module holds the formatting that patch renders.
 *
 * A row that already carries ANSI (another extension painted it) keeps its own colour: only
 * the unstyled rows are painted `dim`, so an error row stays red instead of being re-tinted.
 *
 * Lives outside `extensions/*.ts` so pi never loads it as an extension.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { assert, isMain } from "./check.ts";

/** The mark that leads a block of rows above the chat column. */
export const STATUS_ICON = "\ueb1b";

/** pi's own cap on a string-array widget (`InteractiveMode.MAX_WIDGET_LINES`). */
export const MAX_STATUS_ROWS = 10;

type FgTheme = { fg?(color: string, text: string): string } | null;

/** `dim(text)`, or the plain text when the theme is absent or rejects the token. */
function dim(th: FgTheme, text: string): string {
	try {
		return th?.fg ? th.fg("dim", text) : text;
	} catch {
		return text;
	}
}

/** Aligned under the mark; a long block is capped exactly like pi's own array widget, and
 *  every row is cut to `width` (a component owns its width, pi does not wrap it for us). */
export function statusRows(th: FgTheme, rows: string[], width = Number.POSITIVE_INFINITY): string[] {
	const lines = rows
		.slice(0, MAX_STATUS_ROWS)
		.map((row, i) => {
			const prefix = i === 0 ? ` ${STATUS_ICON} ` : "   ";
			return row.includes("\x1b") ? dim(th, prefix) + row : dim(th, prefix + row);
		});
	if (rows.length > MAX_STATUS_ROWS) lines.push(dim(th, "   ... (widget truncated)"));
	return Number.isFinite(width) ? lines.map((line) => truncateToWidth(line, width, "")) : lines;
}

if (isMain(import.meta.url)) {
	const tag = (color: string, text: string) => `<${color}>${text}</${color}>`;
	assert(
		JSON.stringify(statusRows({ fg: tag }, ["model-heal: healed"])) === JSON.stringify(["<dim> \ueb1b model-heal: healed</dim>"]),
		"one space before the mark, one after, one dim span for the whole row",
	);
	assert(JSON.stringify(statusRows(null, ["plain"])) === JSON.stringify([" \ueb1b plain"]), "no theme renders the plain line");
	assert(
		JSON.stringify(statusRows({ fg: () => { throw new Error("unknown token"); } }, ["safe"])) === JSON.stringify([" \ueb1b safe"]),
		"a theme that rejects the token does not crash the render",
	);
	assert(
		JSON.stringify(statusRows({ fg: tag }, ["one", "\x1b[31mtwo\x1b[39m"])) ===
			JSON.stringify(["<dim> \ueb1b one</dim>", "<dim>   </dim>\x1b[31mtwo\x1b[39m"]),
		"an already-painted row keeps its own colour, continuation rows align under the text",
	);
	const long = statusRows({ fg: tag }, new Array(20).fill("x"));
	assert(long.length === MAX_STATUS_ROWS + 1 && long.at(-1)!.includes("widget truncated"), "a long block is capped like pi's own");
	assert(statusRows(null, []).length === 0, "an empty block renders nothing");
	// A component owns its width: a line wider than the terminal must be cut, not wrapped.
	const wide = statusRows({ fg: tag }, ["x".repeat(200)], 20);
	assert(wide.length === 1 && visibleWidth(wide[0]!) === 20, "rows are cut to the render width");
	console.log("status-widget.ts self-check OK");
}
