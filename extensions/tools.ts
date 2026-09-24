/**
 * Tool output minimal ala Codex CLI / Claude Code, tiap tool call dalam kotak:
 *   ┌──────────────────────────────┐
 *   │ 󰔟 $ cmd smart…               │  running
 *   └──────────────────────────────┘
 *   ┌──────────────────────────────┐
 *   │ ✓ $ cmd smart…               │  final, collapsed
 *   │ 󱞩 0.1s baris-pertama-output  │
 *   └──────────────────────────────┘
 * Klik / ctrl+e = judul penuh + output lengkap (edit = diff toolDiff*).
 * Warna: nama tool aksen, path/link tint, sisanya default; garis kotak dim.
 * Ikon 󰔟/✓/x = status progress. Eksekusi murni delegasi (spread tool bawaan).
 * Lebar selalu via visibleWidth aktual (bug prefixLen hardcoded sudah mati).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type Theme = { fg(color: string, text: string): string };
type TResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: any };
type TCtx = { isError?: boolean; toolCallId?: string; args?: any; expanded?: boolean };

const cwd = process.cwd();
// Durasi + flag "sudah selesai" per tool call: renderCall kosong setelah final
// (kotak final digambar renderResult) -> tepat satu kotak, tanpa duplikasi.
const TIMINGS = new Map<string, { ms: number; done: boolean }>();

class Lines {
	private get: (width: number) => string[];
	constructor(get: (width: number) => string[]) {
		this.get = get;
	}
	render(width: number): string[] {
		return this.get(width);
	}
	invalidate(): void {}
}
const EMPTY = new Lines(() => []);

const shortPath = (p: string): string => {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

const textOf = (r: TResult): string =>
	r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();

const firstLine = (s: string): string => s.split("\n").find((l) => l.trim()) ?? "";

// slot "tint" hanya di tema arnative; tema lain jatuh ke aksen (probe per render)
const tintOf = (theme: Theme): ((s: string) => string) => {
	try {
		theme.fg("tint", "");
		return (s) => theme.fg("tint", s);
	} catch {
		return (s) => theme.fg("accent", s);
	}
};

// Judul smart berbatas kata: maksimal `maxWords` kata + elipsis; penuh saat expand.
export function smartTitle(cmd: string, maxWords = 6): string {
	const words = cmd.replace(/\r?\n/g, " ").trim().split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return words.join(" ");
	return `${words.slice(0, maxWords).join(" ")}…`;
}

const boxEdge = (l: string, r: string, width: number, dim: (s: string) => string): string =>
	dim(`${l}${"─".repeat(Math.max(0, width - 2))}${r}`);

const boxRow = (content: string, width: number, dim: (s: string) => string): string => {
	const pad = Math.max(0, width - visibleWidth(content) - 4);
	return `${dim("│")} ${content}${" ".repeat(pad)} ${dim("│")}`;
};

function box(theme: Theme, width: number, rows: string[]): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const inner = Math.max(8, width - 4);
	const lines = [boxEdge("┌", "┐", width, dim)];
	for (const row of rows) {
		for (const line of wrapTextWithAnsi(row, inner)) lines.push(boxRow(line, width, dim));
	}
	lines.push(boxEdge("└", "┘", width, dim));
	return lines;
}

// Satu jalur render untuk semua tool (tanpa duplikasi per tool).
// renderCall = kotak running (󰔟) sebelum execute selesai; renderResult = kotak
// final (✓/x + 󱞩 durasi baris-pertama-output); isPartial saling kosong.
function minimal(
	pi: ExtensionAPI,
	tool: { execute: (...a: any[]) => Promise<any> } & Record<string, unknown>,
	name: (th: Theme, tint: (s: string) => string) => string,
	call: (a: any, th: Theme, tint: (s: string) => string, expanded: boolean) => string,
	res: (r: TResult, th: Theme, dur: string, isErr: boolean) => string,
	full?: (r: TResult, th: Theme) => string[],
): void {
	pi.registerTool({
		...tool,
		renderShell: "self",
		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			const start = performance.now();
			try {
				return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
			} finally {
				TIMINGS.set(toolCallId, { ms: Math.round(performance.now() - start), done: true });
			}
		},
		renderCall(args: any, theme: Theme, context: TCtx) {
			if (TIMINGS.get(context.toolCallId ?? "")?.done) return EMPTY;
			return new Lines((width) => {
				const tint = tintOf(theme);
				const row = `${theme.fg("warning", "󰔟")} ${name(theme, tint)} ${call(args, theme, tint, false)}`;
				return box(theme, width, [truncateToWidth(row, Math.max(8, width - 4), "…")]);
			});
		},
		renderResult(
			result: TResult,
			{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			context: TCtx,
		) {
			if (isPartial) return EMPTY;
			const text = textOf(result);
			const isErr = Boolean(context.isError || result.isError || text.startsWith("Error"));
			const t = context.toolCallId ? TIMINGS.get(context.toolCallId) : undefined;
			const dur = `${t ? (t.ms / 1000).toFixed(1) : "0.1"}s`;
			const icon = isErr ? theme.fg("error", "x") : theme.fg("success", "✓");
			return new Lines((width) => {
				const tint = tintOf(theme);
				const inner = Math.max(8, width - 4);
				const fit = (s: string) => (expanded ? s : truncateToWidth(s, inner, "…"));
				const rows = [
					fit(`${icon} ${name(theme, tint)} ${call(context.args ?? {}, theme, tint, expanded)}`),
					fit(`󱞩 ${res(result, theme, dur, isErr)}`),
				];
				if (expanded && full) rows.push(...full(result, theme));
				return box(theme, width, rows);
			});
		},
	} as any);
}

// baris hasil seragam: `󱞩 0.1s baris-pertama-output` (kosong -> durasi saja)
const resText = (r: TResult, dur: string): string => {
	const f = firstLine(textOf(r));
	return f ? `${dur} ${f}` : dur;
};

// output penuh saat expand, warna default
const fullText = (r: TResult): string[] => (textOf(r) ? textOf(r).split("\n") : []);

export default function (pi: ExtensionAPI) {
	// bash: `󰔟 $ <6 kata>…` / `✓ $ <judul penuh saat expand>`
	minimal(
		pi,
		createBashTool(cwd),
		(th) => th.fg("accent", "$"),
		(a, _th, _tint, expanded) => {
			const cmd = (a.command ?? "").replace(/\r?\n/g, " ").trim();
			return expanded ? cmd : smartTitle(cmd);
		},
		(r, _th, dur) => resText(r, dur),
		fullText,
	);

	// read: `read path[:range]`
	minimal(
		pi,
		createReadTool(cwd),
		(th) => th.fg("accent", "read"),
		(a, _th, tint) => {
			const range =
				a.offset || a.limit ? `:${a.offset ?? 1}${a.limit ? `-${(a.offset ?? 1) + a.limit - 1}` : ""}` : "";
			return `${tint(shortPath(a.path ?? ""))}${range}`;
		},
		(r, _th, dur) => resText(r, dur),
		fullText,
	);

	// grep: `grep /pattern/ in path (glob)`
	minimal(
		pi,
		createGrepTool(cwd),
		(th) => th.fg("accent", "grep"),
		(a, _th, tint) =>
			`/${a.pattern ?? ""}/ in ${tint(shortPath(a.path ?? "."))}${a.glob ? ` (${a.glob})` : ""}`,
		(r, _th, dur) => resText(r, dur),
		fullText,
	);

	// find: `find pattern in path`
	minimal(
		pi,
		createFindTool(cwd),
		(th) => th.fg("accent", "find"),
		(a, _th, tint) => `${a.pattern ?? ""} in ${tint(shortPath(a.path ?? "."))}`,
		(r, _th, dur) => resText(r, dur),
		fullText,
	);

	// write: `write path`
	minimal(
		pi,
		createWriteTool(cwd),
		(th) => th.fg("accent", "write"),
		(a, _th, tint) => tint(shortPath(a.path ?? "")),
		(r, _th, dur) => resText(r, dur),
		fullText,
	);

	// edit: `edit path`, baris hasil `󱞩 0.1s +N / -M`, expand = diff toolDiff*
	minimal(
		pi,
		createEditTool(cwd),
		(th) => th.fg("accent", "edit"),
		(a, _th, tint) => tint(shortPath(a.path ?? "")),
		(r, th, dur, isErr) => {
			if (isErr) return resText(r, dur);
			const diff: string = r.details?.diff ?? "";
			let add = 0;
			let del = 0;
			for (const l of diff.split("\n")) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) del++;
			}
			return `${dur} ${th.fg("toolDiffAdded", `+${add}`)} / ${th.fg("toolDiffRemoved", `-${del}`)}`;
		},
		(r, th) => {
			const diff: string = r.details?.diff ?? "";
			if (!diff) return fullText(r);
			return diff.split("\n").map((l) =>
				l.startsWith("+") && !l.startsWith("+++")
					? th.fg("toolDiffAdded", l)
					: l.startsWith("-") && !l.startsWith("---")
						? th.fg("toolDiffRemoved", l)
						: th.fg("toolDiffContext", l),
			);
		},
	);
}

// Self-check: `node extensions/tools.ts`.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"));
if (isMain) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};
	assert(smartTitle("echo hi") === "echo hi", "teks pendek utuh");
	assert(smartTitle("ls a b c d e f g h") === "ls a b c d e…", "potong di batas 6 kata");
	assert(smartTitle("ls\n  a   b") === "ls a b", "normalisasi whitespace/baris baru");
	assert(smartTitle("a b c d e f g") === "a b c d e f…", "7 kata -> 6 kata + elipsis");
	assert(smartTitle("a b c d e f") === "a b c d e f", "6 kata utuh");
	// regresi bug overflow: baris kotak tepat selebar terminal
	assert(visibleWidth(boxRow("hello", 20, (s) => s)) === 20, "boxRow pas lebar penuh");
	assert(
		visibleWidth(boxRow(truncateToWidth("abcdefghij klmnop qrst", 16, "…"), 20, (s) => s)) === 20,
		"baris terpotong tetap pas",
	);
	console.log("smartTitle + boxRow OK");
}
