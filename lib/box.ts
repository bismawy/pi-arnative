/**
 * Single arnative box border (dim, round ends). Used by tools.ts, ui-render-tweaks.ts
 * and usage.ts — edit here, all follow. Lives outside `extensions/*.ts` so pi
 * never loads it as an extension.
 */
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { assert, isMain } from "./check.ts";

export type BoxTheme = { fg(color: string, text: string): string; bg?(color: string, text: string): string };
export type Dim = (s: string) => string;

export const boxEdge = (l: string, r: string, width: number, dim: Dim): string =>
	dim(`${l}${"─".repeat(Math.max(0, width - 2))}${r}`);

/** Content row: │ <text> │, exactly `width` wide. */
export const boxRow = (content: string, width: number, dim: Dim): string => {
	const pad = Math.max(0, width - visibleWidth(content) - 4);
	return `${dim("│")} ${content}${" ".repeat(pad)} ${dim("│")}`;
};

const applyBg = (line: string, width: number, bgFn: (text: string) => string): string => {
	const pad = Math.max(0, width - visibleWidth(line));
	return bgFn(line + " ".repeat(pad));
};

/** Wrap `rows` (plain or ANSI-colored) into a box. `bgType` = theme bg name (no-op when the theme has no `bg`); `borderColor` = border color. */
export function renderBoxLines(theme: BoxTheme, width: number, rows: string[], bgType?: string, borderColor = "dim"): string[] {
	const dim = (s: string) => theme.fg(borderColor, s);
	const inner = Math.max(8, width - 4);
	const lines = [boxEdge("╭", "╮", width, dim)];
	for (const row of rows) {
		for (const line of wrapTextWithAnsi(row, inner)) lines.push(boxRow(line, width, dim));
	}
	lines.push(boxEdge("╰", "╯", width, dim));
	if (bgType && theme.bg) {
		try {
			return lines.map((l) => applyBg(l, width, (s) => theme.bg!(bgType, s)));
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
	console.log("lib/box.ts OK");
}
