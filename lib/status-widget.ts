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
import { truncateToWidth } from "@earendil-works/pi-tui";

/** The mark that leads a block of rows above the chat column. */
export const STATUS_ICON = "\ueb1b";

/** pi's own cap on a string-array widget (`InteractiveMode.MAX_WIDGET_LINES`). */
export const MAX_STATUS_ROWS = 10;

// A row that opens with its own Nerd Font glyph (a private-use code point) and a space keeps
// that glyph as its mark in place of STATUS_ICON, such as model-heal's U+F06DE.
function ownMark(row: string): boolean {
	const cp = row.codePointAt(0);
	if (cp === undefined) return false;
	const pua = (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd);
	return pua && row[cp > 0xffff ? 2 : 1] === " ";
}

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
			if (i === 0 && ownMark(row)) return row.includes("\x1b") ? dim(th, " ") + row : dim(th, " " + row);
			const prefix = i === 0 ? ` ${STATUS_ICON} ` : "   ";
			return row.includes("\x1b") ? dim(th, prefix) + row : dim(th, prefix + row);
		});
	if (rows.length > MAX_STATUS_ROWS) lines.push(dim(th, "   ... (widget truncated)"));
	return Number.isFinite(width) ? lines.map((line) => truncateToWidth(line, width, "")) : lines;
}

/**
 * State what the last change did, as a transcript notify (like pi-jev-eye) instead of the
 * widget slot above the editor: the widget covered the prompt, while a scrollback line
 * stays visible without blocking anything. A UI without notify (RPC/headless) is left alone.
 */
export function announce(ui: { notify?(message: string, type?: string): void } | undefined, message: string): void {
	ui?.notify?.("[arnative] " + message, "info");
}

export const __test = {
	dim,
};
