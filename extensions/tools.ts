/**
 * Tool output minimal ala Codex CLI / Claude Code, tiap tool call dalam kotak:
 *   ┌──────────────────────────────┐
 *   │ 󰔟 $ cmd smart…               │  running (ikon status, hilang saat selesai)
 *   └──────────────────────────────┘
 *   ┌──────────────────────────────┐
 *   │ ✓ $ cmd smart…               │  final, collapsed
 *   │ 󱞩 0.1s baris-pertama-output  │
 *   └──────────────────────────────┘
 * Klik / ctrl+e = judul penuh + detail (output = dim; edit = diff toolDiff*).
 * Warna: nama tool aksen, path/folder & link (URL) tint, sisanya default;
 * garis kotak + 󱞩 dim. Eksekusi murni delegasi (spread tool bawaan).
 * Status "sudah ada hasil" disimpan di context.state dan dibaca saat render()
 * (bukan saat renderCall dipanggil) -> aman untuk reload/restore sesi lama,
 * tanpa kotak 󰔟 tertinggal setelah selesai.
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
type TCtx = { isError?: boolean; toolCallId?: string; args?: any; state?: Record<string, unknown> };

const cwd = process.cwd();
const TIMINGS = new Map<string, number>(); // durasi ms per tool call (sekali jalan)

export class Lines {
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

// Filter path folder / link URL -> tint; sisanya default.
export const LINK_RE = /(?:https?:\/\/[^\s"'`)}\]]+|(?:~|\.{1,2})?\/[\w.+@~%/-]+|[\w.+@~-]+(?:\/[\w.+@~%/-]+)+)/g;
export function paintLinks(text: string, tint: (s: string) => string): string {
	return text.replace(LINK_RE, (m) => tint(m));
}

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

// Prefix baris hasil: 󱞩 + durasi (hila bila tak terukur, mis. restore sesi lama).
export function resHead(theme: Theme, dur: string): string {
	return theme.fg("dim", dur ? `󱞩 ${dur}` : "󱞩");
}

// baris hasil seragam: `󱞩 0.1s baris-pertama-output` (link/path -> tint)
const resText = (r: TResult, theme: Theme, tint: (s: string) => string, dur: string): string => {
	const f = firstLine(textOf(r));
	return f ? `${resHead(theme, dur)} ${paintLinks(f, tint)}` : resHead(theme, dur);
};

// detail saat expand: warna dim saja (kecuali diff edit yang berwarna)
const fullText = (r: TResult, theme: Theme): string[] =>
	textOf(r)
		? textOf(r)
				.split("\n")
				.map((l) => theme.fg("dim", l))
		: [];

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
// renderCall = kotak running (󰔟) saja; renderResult = kotak final (✓/x + 󱞩);
// state.hasResult ditulis renderResult dan dibaca saat render() -> tepat satu
// kotak, juga setelah reload/restore.
function minimal(
	pi: ExtensionAPI,
	tool: { execute: (...a: any[]) => Promise<any> } & Record<string, unknown>,
	name: (th: Theme, tint: (s: string) => string) => string,
	call: (a: any, th: Theme, tint: (s: string) => string, expanded: boolean) => string,
	res: (r: TResult, th: Theme, tint: (s: string) => string, dur: string, isErr: boolean) => string,
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
				TIMINGS.set(toolCallId, Math.round(performance.now() - start));
			}
		},
		renderCall(args: any, theme: Theme, context: TCtx) {
			const st = (context.state ?? {}) as Record<string, unknown>;
			return new Lines((width) => {
				if (st.hasResult) return [];
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
			((context.state ??= {}) as Record<string, unknown>).hasResult = true;
			const text = textOf(result);
			const isErr = Boolean(context.isError || result.isError || text.startsWith("Error"));
			const ms = context.toolCallId ? TIMINGS.get(context.toolCallId) : undefined;
			const dur = ms !== undefined ? `${(ms / 1000).toFixed(1)}s` : "";
			const icon = isErr ? theme.fg("error", "x") : theme.fg("success", "✓");
			return new Lines((width) => {
				const tint = tintOf(theme);
				const inner = Math.max(8, width - 4);
				const fit = (s: string) => (expanded ? s : truncateToWidth(s, inner, "…"));
				const rows = [
					fit(`${icon} ${name(theme, tint)} ${call(context.args ?? {}, theme, tint, expanded)}`),
					fit(res(result, theme, tint, dur, isErr)),
				];
				if (expanded && full) rows.push(...full(result, theme));
				return box(theme, width, rows);
			});
		},
	} as any);
}

export default function (pi: ExtensionAPI) {
	// bash: `󰔟 $ <6 kata>…` / `✓ $ <judul penuh saat expand>`
	minimal(
		pi,
		createBashTool(cwd),
		(th) => th.fg("accent", "$"),
		(a, _th, tint, expanded) => {
			const cmd = (a.command ?? "").replace(/\r?\n/g, " ").trim();
			return paintLinks(expanded ? cmd : smartTitle(cmd), tint);
		},
		(r, th, tint, dur) => resText(r, th, tint, dur),
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
		(r, th, tint, dur) => resText(r, th, tint, dur),
		fullText,
	);

	// grep: `grep /pattern/ in path (glob)`
	minimal(
		pi,
		createGrepTool(cwd),
		(th) => th.fg("accent", "grep"),
		(a, _th, tint) =>
			`/${a.pattern ?? ""}/ in ${tint(shortPath(a.path ?? "."))}${a.glob ? ` (${a.glob})` : ""}`,
		(r, th, tint, dur) => resText(r, th, tint, dur),
		fullText,
	);

	// find: `find pattern in path`
	minimal(
		pi,
		createFindTool(cwd),
		(th) => th.fg("accent", "find"),
		(a, _th, tint) => `${a.pattern ?? ""} in ${tint(shortPath(a.path ?? "."))}`,
		(r, th, tint, dur) => resText(r, th, tint, dur),
		fullText,
	);

	// write: `write path`
	minimal(
		pi,
		createWriteTool(cwd),
		(th) => th.fg("accent", "write"),
		(a, _th, tint) => tint(shortPath(a.path ?? "")),
		(r, th, tint, dur) => resText(r, th, tint, dur),
		fullText,
	);

	// edit: `edit path`, baris hasil `󱞩 0.1s +N / -M`, expand = diff toolDiff*
	minimal(
		pi,
		createEditTool(cwd),
		(th) => th.fg("accent", "edit"),
		(a, _th, tint) => tint(shortPath(a.path ?? "")),
		(r, th, _tint, dur, isErr) => {
			if (isErr) return resText(r, th, (s) => s, dur);
			const diff: string = r.details?.diff ?? "";
			let add = 0;
			let del = 0;
			for (const l of diff.split("\n")) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) del++;
			}
			return `${resHead(th, dur)} ${th.fg("toolDiffAdded", `+${add}`)} / ${th.fg("toolDiffRemoved", `-${del}`)}`;
		},
		(r, th) => {
			const diff: string = r.details?.diff ?? "";
			if (!diff) return fullText(r, th);
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
	const mark = (s: string) => `<${s}>`;
	const th: Theme = { fg: (_c, s) => s };

	assert(smartTitle("echo hi") === "echo hi", "teks pendek utuh");
	assert(smartTitle("ls a b c d e f g h") === "ls a b c d e…", "potong di batas 6 kata");
	assert(smartTitle("a b c d e f g") === "a b c d e f…", "7 kata -> 6 kata + elipsis");
	assert(smartTitle("a b c d e f") === "a b c d e f", "6 kata utuh");

	assert(paintLinks("cd /run/media/x && echo hi", mark) === "cd </run/media/x> && echo hi", "filter path absolut");
	assert(paintLinks("git clone https://github.com/a/b", mark) === "git clone <https://github.com/a/b>", "filter link URL");
	assert(paintLinks("ls extensions/tools.ts", mark) === "ls <extensions/tools.ts>", "filter path relatif");
	assert(paintLinks("echo plain 2>&1", mark) === "echo plain 2>&1", "teks polos tak tersentuh");

	assert(resHead(th, "") === "󱞩", "tanpa durasi: ikon saja");
	assert(resHead(th, "0.4s") === "󱞩 0.4s", "dengan durasi");

	// regresi bug overflow + bug 󰔟 tertinggal
	assert(visibleWidth(boxRow("hello", 20, (s) => s)) === 20, "boxRow pas lebar penuh");
	const st: Record<string, unknown> = {};
	const comp = new Lines(() => (st.hasResult ? [] : ["row"]));
	assert(comp.render(10).length === 1, "running: kotak 󰔟 tampil");
	st.hasResult = true;
	assert(comp.render(10).length === 0, "final: kotak running hilang (restore-safe)");
	console.log("OK");
}
