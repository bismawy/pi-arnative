/**
 * Unified and side-by-side (Split) word-level diff renderer for the `edit` tool box.
 */
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { EDIT_DIFF_KEY, choiceSetting } from "./preset-store.ts";
import { clearRenderCache } from "./features/render-cache.ts";

const SPLIT_DIFF_MIN_WIDTH = 50;
const INTRA_LINE_MAX_TOKENS = 200;

export type DiffTheme = {
	fg(color: string, text: string): string;
	inverse?(text: string): string;
};

export type DiffResult = {
	content?: Array<{ type: string; text?: string }>;
	details?: { diff?: string };
};

export type EditDiffMode = "Split" | "Unified";
export const EDIT_DIFF_CHOICES: readonly EditDiffMode[] = ["Split", "Unified"];
const editDiffSetting = choiceSetting(EDIT_DIFF_KEY, EDIT_DIFF_CHOICES, "Split");
export const EDIT_DIFF_CONFIG_KEY = editDiffSetting.slot;

export const activeEditDiff = (): EditDiffMode => editDiffSetting.get();

export function setEditDiff(mode: EditDiffMode): void {
	editDiffSetting.set(mode);
	clearRenderCache();
}

type DiffSide = { styled: string } | null;

function unifiedDiffLines(diff: string, th: DiffTheme): string[] {
	return diff.split("\n").map((l) =>
		l.startsWith("+") && !l.startsWith("+++")
			? th.fg("toolDiffAdded", l)
			: l.startsWith("-") && !l.startsWith("---")
				? th.fg("toolDiffRemoved", l)
				: th.fg("toolDiffContext", l),
	);
}

function tokenizeDiffLine(s: string): string[] {
	return s.match(/[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]/g) ?? [];
}

/**
 * Highlights changed tokens between paired old/new lines using `inverse`,
 * keeping leading indentation un-highlighted.
 */
function highlightLinePair(oldText: string, newText: string, th: DiffTheme): { left: string; right: string } {
	const a = tokenizeDiffLine(oldText);
	const b = tokenizeDiffLine(newText);
	if (a.length === 0 || b.length === 0 || a.length > INTRA_LINE_MAX_TOKENS || b.length > INTRA_LINE_MAX_TOKENS) {
		return { left: th.fg("toolDiffRemoved", oldText), right: th.fg("toolDiffAdded", newText) };
	}

	const m = a.length;
	const n = b.length;
	const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}

	const inv = (s: string) => (th.inverse ? th.inverse(s) : `\x1b[7m${s}\x1b[27m`);
	let left = "";
	let right = "";
	let i = 0;
	let j = 0;
	let seenNonWsLeft = false;
	let seenNonWsRight = false;

	const emitChanged = (tok: string, color: string, seenNonWs: boolean): [string, boolean] => {
		if (!seenNonWs && /^\s+$/.test(tok)) return [th.fg(color, tok), false];
		return [th.fg(color, inv(tok)), true];
	};

	while (i < m && j < n) {
		if (a[i] === b[j]) {
			const tok = a[i]!;
			if (tok.trim()) {
				seenNonWsLeft = true;
				seenNonWsRight = true;
			}
			left += th.fg("toolDiffRemoved", tok);
			right += th.fg("toolDiffAdded", tok);
			i++;
			j++;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
			const [chunk, seen] = emitChanged(a[i]!, "toolDiffRemoved", seenNonWsLeft);
			left += chunk;
			seenNonWsLeft = seen;
			i++;
		} else {
			const [chunk, seen] = emitChanged(b[j]!, "toolDiffAdded", seenNonWsRight);
			right += chunk;
			seenNonWsRight = seen;
			j++;
		}
	}
	while (i < m) {
		const [chunk, seen] = emitChanged(a[i]!, "toolDiffRemoved", seenNonWsLeft);
		left += chunk;
		seenNonWsLeft = seen;
		i++;
	}
	while (j < n) {
		const [chunk, seen] = emitChanged(b[j]!, "toolDiffAdded", seenNonWsRight);
		right += chunk;
		seenNonWsRight = seen;
		j++;
	}
	return { left, right };
}

function wrapDiffCell(side: DiffSide, width: number): string[] {
	if (!side) return [""];
	const clean = side.styled.replace(/\t/g, "  ");
	return clean === "" ? [""] : wrapTextWithAnsi(clean, width);
}

function renderSplitPair(left: DiffSide, right: DiffSide, leftW: number, rightW: number, sep: string): string[] {
	const leftLines = wrapDiffCell(left, leftW);
	const rightLines = wrapDiffCell(right, rightW);
	const count = Math.max(leftLines.length, rightLines.length);
	const rows: string[] = [];
	for (let i = 0; i < count; i++) {
		const l = leftLines[i] ?? "";
		const r = rightLines[i] ?? "";
		const pad = " ".repeat(Math.max(0, leftW - visibleWidth(l)));
		rows.push(`${l}${pad}${sep}${r}`);
	}
	return rows;
}

function fallbackLines(r: DiffResult, th: DiffTheme): string[] {
	const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
	return text ? text.split("\n").map((l) => th.fg("toolOutput", l)) : [];
}

/**
 * Formats an `edit` diff side-by-side (Before | After) when the box inner width
 * is at least {@link SPLIT_DIFF_MIN_WIDTH}, falling back to unified diff on
 * narrow terminals or when `details.diff` is absent.
 */
export function formatEditDiff(r: DiffResult, th: DiffTheme, inner: number, mode: EditDiffMode = activeEditDiff()): string[] {
	const diff: string = r.details?.diff ?? "";
	if (!diff) return fallbackLines(r, th);
	if (mode === "Unified" || inner < SPLIT_DIFF_MIN_WIDTH) return unifiedDiffLines(diff, th);

	const sep = th.fg("dim", " │ ");
	const leftW = Math.floor((inner - 3) / 2);
	const rightW = inner - 3 - leftW;
	const out: string[] = [
		`${th.fg("dim", "Before")}${" ".repeat(Math.max(0, leftW - 6))}${sep}${th.fg("dim", "After")}`,
		th.fg("dim", `${"─".repeat(leftW)}─┼─${"─".repeat(rightW)}`),
	];

	let dels: string[] = [];
	let adds: string[] = [];
	const flushChanges = () => {
		const count = Math.max(dels.length, adds.length);
		for (let i = 0; i < count; i++) {
			const d = dels[i];
			const a = adds[i];
			if (d !== undefined && a !== undefined) {
				const { left, right } = highlightLinePair(d, a, th);
				out.push(...renderSplitPair({ styled: left }, { styled: right }, leftW, rightW, sep));
			} else {
				const left: DiffSide = d !== undefined ? { styled: th.fg("toolDiffRemoved", d) } : null;
				const right: DiffSide = a !== undefined ? { styled: th.fg("toolDiffAdded", a) } : null;
				out.push(...renderSplitPair(left, right, leftW, rightW, sep));
			}
		}
		dels = [];
		adds = [];
	};

	for (const line of diff.split("\n")) {
		if (line.startsWith("-") && !line.startsWith("---")) {
			dels.push(line.slice(1));
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			adds.push(line.slice(1));
		} else if (line.startsWith(" ")) {
			flushChanges();
			const side: DiffSide = { styled: th.fg("toolDiffContext", line.slice(1)) };
			out.push(...renderSplitPair(side, side, leftW, rightW, sep));
		} else {
			flushChanges();
			out.push(th.fg("toolDiffContext", line));
		}
	}
	flushChanges();
	return out;
}
