/**
 * Tool output minimal ala Codex CLI / Claude Code, tiap tool call dalam kotak:
 *   ┌────────────────────────────┐
 *   │ 󰔟 $ cmd smart…             │  running (ikon status, hilang saat selesai)
 *   └────────────────────────────┘
 *   ┌────────────────────────────┐
 *   │ ✓ $ cmd smart…      0.1s   │  final, collapsed; durasi rata kanan judul
 *   │ 󱞩 baris-pertama-output     │
 *   └────────────────────────────┘
 * Klik / ctrl+e = judul penuh + detail (output = dim; edit = diff toolDiff*).
 * Ringkasan collapsed: bash/write `󱞩 baris pertama output`; grep/find/read
 * ringkasan angka (→ N matches / → N files / N lines); edit `󱞩 +N / -M`.
 * Saat expand baris ringkasan kosong untuk tool biasa (output sudah tampil
 * penuh) - anti duplikat baris pertama.
 * Durasi: rata kanan baris judul, space-aware (judul dipotong via visibleWidth
 * bila tak muat); kosong bila tak terukur (restore sesi lama - tanpa jejak).
 * Warna: nama tool aksen, path/folder & link (URL) tint, sisanya default;
 * garis kotak + 󱞩 dim. Eksekusi murni delegasi (spread tool bawaan).
 * Status "sudah ada hasil" di context.state, dibaca saat render() -> aman
 * reload/restore, tanpa kotak 󰔟 tertinggal. Gap antar kotak (Spacer bawaan
 * ToolExecutionComponent) dibuang via patch render (pola sama patch footer).
 * Tool pihak lain yang TIDAK punya renderer sendiri (memory_write, scratchpad,
 * MCP, …) dapat perlakuan sama: pi merendernya polos (nama + 10 baris output),
 * kita alihkan ke shell "self" + kotak dengan satu baris ringkasan ber-
 * `[ctrl+o to expand]`; detail lengkap hanya saat expand.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
	keyText,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type Theme = { fg(color: string, text: string): string };
type TResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: any };
type TCtx = { isError?: boolean; toolCallId?: string; args?: any; state?: Record<string, unknown> };
type Res = (r: TResult, th: Theme, tint: (s: string) => string, isErr: boolean, expanded: boolean) => string;

const cwd = process.cwd();
const TIMINGS = new Map<string, number>(); // durasi ms per tool call (sekali jalan)

// Animasi ikon running 󰔟 󱦠 󱦟: frame berputar per 150ms via ticker yang hidup
// HANYA selama ada tool berjalan (idle = tanpa render ulang boros).
const FRAMES = ["󰔟", "󱦠", "󱦟"];
let ACTIVE = 0;
let TICK: ReturnType<typeof setInterval> | null = null;
let requestRenderFn: (() => void) | null = null;

function syncTicker(): void {
	if (ACTIVE > 0 && !TICK) {
		TICK = setInterval(() => requestRenderFn?.(), 150);
	} else if (ACTIVE <= 0 && TICK) {
		clearInterval(TICK);
		TICK = null;
	}
}

export function spinIcon(): string {
	return FRAMES[Math.floor(Date.now() / 150) % FRAMES.length];
}

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

const countLines = (s: string): number => (s ? s.split("\n").filter(Boolean).length : 0);

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

// Prefix baris hasil: 󱞩 dim (tanpa durasi - durasi di ujung kanan judul).
export function resHead(theme: Theme): string {
	return theme.fg("dim", "󱞩");
}

// Baris judul: durasi rata kanan (space-aware, judul dipotong bila tak muat);
// expanded = judul penuh di-wrap. Semua baris <= inner (regresi bug overflow).
export function titleRow(
	theme: Theme,
	icon: string,
	name: string,
	argPart: string,
	inner: number,
	dur: string,
	expanded: boolean,
): string[] {
	const head = `${icon} ${name} ${argPart}`.trim();
	const durStr = dur ? theme.fg("dim", dur) : "";
	if (!durStr) {
		return expanded ? wrapTextWithAnsi(head, inner) : [truncateToWidth(head, inner, "…")];
	}
	const durW = visibleWidth(durStr);
	const avail = Math.max(8, inner - durW);
	const wrapW = Math.max(4, avail - 1); // minimal 1 spasi sebelum durasi
	const lines = expanded ? wrapTextWithAnsi(head, wrapW) : [truncateToWidth(head, wrapW, "…")];
	const pad = Math.max(1, avail - visibleWidth(lines[0]));
	lines[0] = `${lines[0]}${" ".repeat(pad)}${durStr}`;
	return lines;
}

// Ringkasan default: collapsed `󱞩 baris-pertama-output`, expand kosong (output
// sudah tampil penuh di bawah - anti duplikat).
export const resText: Res = (r, th, tint, isErr, expanded) => {
	if (expanded && !isErr) return "";
	const f = firstLine(textOf(r));
	return f ? `${resHead(th)} ${paintLinks(f, tint)}` : resHead(th);
};

// Ringkasan angka: `󱞩 → N matches`; error jatuh ke baris pertama (info penting).
export const numRes =
	(fmt: (n: number) => string): Res =>
	(r, th, tint, isErr, expanded) => {
		if (isErr) return resText(r, th, tint, isErr, false);
		if (expanded) return "";
		return `${resHead(th)} ${fmt(countLines(textOf(r)))}`;
	};

// Heading pertama pada isi tulisan (mis. `## omaga-sync workflow (2026-08-23)`).
const firstHeading = (s: unknown): string =>
	typeof s === "string" ? (s.split("\n").find((l) => /^#{1,6}\s/.test(l.trim()))?.trim() ?? "") : "";

// Ringkasan satu baris untuk tool tanpa renderer sendiri. memory_write dapat
// judul seksi yang baru ditulis (dari args.content) supaya baris hasil menyebut
// APA yang tertulis, bukan cuma "Appended to MEMORY.md".
export function toolSummary(name: string, text: string, args?: any): string {
	const head = firstLine(text);
	const title = name === "memory_write" ? firstHeading(args?.content) : "";
	return title ? `${head}. ${title}` : head;
}

// Petunjuk expand `[ctrl+o to expand]` (teks tombol ikut keybinding aktif).
export function expandHint(th: Theme): string {
	let key = "ctrl+o";
	try {
		key = keyText("app.tools.expand") || key;
	} catch {
		// di luar sesi pi: pakai literal
	}
	return th.fg("dim", `[${key} to expand]`);
}

// detail saat expand: warna dim saja (kecuali diff edit yang berwarna)
const fullText = (r: TResult, th: Theme): string[] =>
	textOf(r)
		? textOf(r)
				.split("\n")
				.map((l) => th.fg("dim", l))
		: [];

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const isBlankLine = (l: string): boolean => l.replace(ANSI_RE, "").trim() === "";

// Buang baris kosong di awal/akhir (Spacer bawaan) - gap antar kotak tool.
export function stripBlankEdges(lines: string[]): string[] {
	let s = 0;
	let e = lines.length;
	while (s < e && isBlankLine(lines[s])) s++;
	while (e > s && isBlankLine(lines[e - 1])) e--;
	return lines.slice(s, e);
}

// Gap antar kotak = Spacer(1) bawaan ToolExecutionComponent (di luar ekstensi).
// Patch render prototype + guard global (pola sama patch FooterComponent).
const GAP_KEY = Symbol.for("pi-arnative.toolGapStripped");
if (ToolExecutionComponent?.prototype?.render && !(globalThis as Record<symbol, boolean>)[GAP_KEY]) {
	(globalThis as Record<symbol, boolean>)[GAP_KEY] = true;
	const origRender = ToolExecutionComponent.prototype.render;
	ToolExecutionComponent.prototype.render = function (width: number): string[] {
		return stripBlankEdges(origRender.call(this, width));
	};
}

// --- Tool tanpa renderer sendiri: kotak yang sama, ringkasan satu baris ---
// Tanpa patch ini pi merender mereka sebagai blok bg polos (nama + potongan
// 10 baris output). Renderer kita dipasang lewat prototype (pola sama gap patch),
// hanya bila tool tidak punya renderCall/renderResult sendiri (tool bawaan kita
// dan pi-web-access dll. tak tersentuh).
const DEFAULT_TOOL_KEY = Symbol.for("pi-arnative.defaultToolBox");
if (ToolExecutionComponent?.prototype?.render && !(globalThis as Record<symbol, boolean>)[DEFAULT_TOOL_KEY]) {
	(globalThis as Record<symbol, boolean>)[DEFAULT_TOOL_KEY] = true;
	const proto = ToolExecutionComponent.prototype as any;
	const origCall = proto.getCallRenderer;
	const origResult = proto.getResultRenderer;
	const origShell = proto.getRenderShell;
	const hasOwnRenderer = (self: any): boolean => Boolean(origCall.call(self) || origResult.call(self));

	proto.getRenderShell = function (): string {
		return hasOwnRenderer(this) ? origShell.call(this) : "self";
	};

	proto.getCallRenderer = function () {
		if (hasOwnRenderer(this)) return origCall.call(this);
		const name: string = this.toolName;
		return (_args: any, th: Theme, ctx: TCtx) =>
			new Lines((width) => {
				if ((ctx.state as Record<string, unknown> | undefined)?.hasResult) return [];
				const inner = Math.max(8, width - 4);
				return box(
					th,
					width,
					titleRow(th, th.fg("warning", spinIcon()), th.fg("accent", name), "", inner, "", false),
				);
			});
	};

	proto.getResultRenderer = function () {
		if (hasOwnRenderer(this)) return origResult.call(this);
		const name: string = this.toolName;
		return (result: TResult, opts: { expanded: boolean; isPartial?: boolean }, th: Theme, ctx: TCtx) => {
			if (opts.isPartial) return EMPTY;
			((ctx.state ??= {}) as Record<string, unknown>).hasResult = true;
			const text = textOf(result);
			return new Lines((width) => {
				const tint = tintOf(th);
				const inner = Math.max(8, width - 4);
				const isErr = Boolean(ctx.isError || result.isError);
				const rows = titleRow(
					th,
					isErr ? th.fg("error", "x") : th.fg("success", "✓"),
					th.fg("accent", name),
					"",
					inner,
					"",
					opts.expanded,
				);
				const summary = toolSummary(name, text, ctx.args);
				const more = countLines(text) > 1;
				const hint = more && !opts.expanded ? ` ${expandHint(th)}` : "";
				rows.push(`${resHead(th)}${summary ? ` ${paintLinks(summary, tint)}` : ""}${hint}`);
				if (opts.expanded) rows.push(...fullText(result, th));
				return box(th, width, rows);
			});
		};
	};
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
// renderCall = kotak running (󰔟); renderResult = kotak final (✓/x + durasi kanan
// judul + 󱞩 ringkasan); state.hasResult ditulis renderResult dan dibaca saat
// render() -> tepat satu kotak, juga setelah reload/restore. res & full
// opsional (default: baris pertama output / detail dim).
function minimal(
	pi: ExtensionAPI,
	tool: { execute: (...a: any[]) => Promise<any> } & Record<string, unknown>,
	name: (th: Theme, tint: (s: string) => string) => string,
	call: (a: any, th: Theme, tint: (s: string) => string, expanded: boolean) => string,
	res: Res = resText,
	full: (r: TResult, th: Theme) => string[] = fullText,
): void {
	pi.registerTool({
		...tool,
		renderShell: "self",
		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			const start = performance.now();
			ACTIVE++;
			syncTicker();
			try {
				return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
			} finally {
				TIMINGS.set(toolCallId, Math.round(performance.now() - start));
				ACTIVE--;
				syncTicker();
			}
		},
		renderCall(args: any, theme: Theme, context: TCtx) {
			const st = (context.state ?? {}) as Record<string, unknown>;
			return new Lines((width) => {
				if (st.hasResult) return [];
				const tint = tintOf(theme);
				const inner = Math.max(8, width - 4);
				const rows = titleRow(
					theme,
					theme.fg("warning", spinIcon()),
					name(theme, tint),
					call(args, theme, tint, false),
					inner,
					"",
					false,
				);
				return box(theme, width, rows);
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
				const rows = titleRow(
					theme,
					icon,
					name(theme, tint),
					call(context.args ?? {}, theme, tint, expanded),
					inner,
					dur,
					expanded,
				);
				const resLine = res(result, theme, tint, isErr, expanded);
				if (resLine) rows.push(resLine);
				if (expanded) rows.push(...full(result, theme));
				return box(theme, width, rows);
			});
		},
	} as any);
}

export default function (pi: ExtensionAPI) {
	// Sumber render ulang untuk animasi ikon + bersih-bungkus ticker saat sesi tutup
	pi.on("session_start", async (_event, ctx) => {
		requestRenderFn = () => {
			try {
				(ctx.ui as { requestRender?: () => void }).requestRender?.();
			} catch {
				// ignore
			}
		};
	});
	pi.on("session_shutdown", async () => {
		if (TICK) {
			clearInterval(TICK);
			TICK = null;
		}
		requestRenderFn = null;
	});

	// bash: `󰔟 $ <6 kata>…` / `✓ $ <judul penuh saat expand>  0.1s`
	minimal(
		pi,
		createBashTool(cwd),
		(th) => th.fg("accent", "$"),
		(a, _th, tint, expanded) => {
			const cmd = (a.command ?? "").replace(/\r?\n/g, " ").trim();
			return paintLinks(expanded ? cmd : smartTitle(cmd), tint);
		},
	);

	// read: `read path[:range]` → `󱞩 N lines`
	minimal(
		pi,
		createReadTool(cwd),
		(th) => th.fg("accent", "read"),
		(a, _th, tint) => {
			const range =
				a.offset || a.limit ? `:${a.offset ?? 1}${a.limit ? `-${(a.offset ?? 1) + a.limit - 1}` : ""}` : "";
			return `${tint(shortPath(a.path ?? ""))}${range}`;
		},
		numRes((n) => `${n} lines`),
	);

	// grep: `grep /pattern/ in path (glob)` → `󱞩 → N matches`
	minimal(
		pi,
		createGrepTool(cwd),
		(th) => th.fg("accent", "grep"),
		(a, _th, tint) =>
			`/${a.pattern ?? ""}/ in ${tint(shortPath(a.path ?? "."))}${a.glob ? ` (${a.glob})` : ""}`,
		numRes((n) => `→ ${n} matches`),
	);

	// find: `find pattern in path` → `󱞩 → N files`
	minimal(
		pi,
		createFindTool(cwd),
		(th) => th.fg("accent", "find"),
		(a, _th, tint) => `${a.pattern ?? ""} in ${tint(shortPath(a.path ?? "."))}`,
		numRes((n) => `→ ${n} files`),
	);

	// write: `write path`, res default (baris pertama output)
	minimal(
		pi,
		createWriteTool(cwd),
		(th) => th.fg("accent", "write"),
		(a, _th, tint) => tint(shortPath(a.path ?? "")),
	);

	// edit: `edit path`, `󱞩 +N / -M`, expand = diff toolDiff*
	minimal(
		pi,
		createEditTool(cwd),
		(th) => th.fg("accent", "edit"),
		(a, _th, tint) => tint(shortPath(a.path ?? "")),
		(r, th, _tint, isErr, expanded) => {
			if (isErr) return resText(r, th, (s) => s, isErr, false);
			const diff: string = r.details?.diff ?? "";
			let add = 0;
			let del = 0;
			for (const l of diff.split("\n")) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) del++;
			}
			return `${resHead(th)} ${th.fg("toolDiffAdded", `+${add}`)} / ${th.fg("toolDiffRemoved", `-${del}`)}`;
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
	const R = { content: [{ type: "text", text: "path:1:match a\npath:2:match b\npath:3:match c" }] };

	assert(smartTitle("echo hi") === "echo hi", "teks pendek utuh");
	assert(smartTitle("ls a b c d e f g h") === "ls a b c d e…", "potong di batas 6 kata");
	assert(smartTitle("a b c d e f g") === "a b c d e f…", "7 kata -> 6 kata + elipsis");
	assert(smartTitle("a b c d e f") === "a b c d e f", "6 kata utuh");

	assert(paintLinks("cd /run/media/x && echo hi", mark) === "cd </run/media/x> && echo hi", "filter path absolut");
	assert(paintLinks("git clone https://github.com/a/b", mark) === "git clone <https://github.com/a/b>", "filter link URL");
	assert(paintLinks("ls extensions/tools.ts", mark) === "ls <extensions/tools.ts>", "filter path relatif");
	assert(paintLinks("echo plain 2>&1", mark) === "echo plain 2>&1", "teks polos tak tersentuh");

	// durasi rata kanan judul, space-aware (regresi bug overflow)
	const t1 = titleRow(th, "✓", "$", "echo hi", 30, "0.1s", false);
	assert(t1.length === 1 && visibleWidth(t1[0]) === 30, "durasi rata kanan pas selebar inner");
	assert(t1[0].endsWith("0.1s"), "durasi di ujung kanan judul");
	const t2 = titleRow(th, "✓", "$", "word ".repeat(40), 30, "0.1s", false);
	assert(t2.length === 1 && visibleWidth(t2[0]) === 30, "collapsed: judul panjang tetap 1 baris pas");
	const t3 = titleRow(th, "✓", "$", "word ".repeat(40), 30, "0.1s", true);
	assert(t3.every((l) => visibleWidth(l) <= 30), "expanded: semua baris <= inner");
	const t4 = titleRow(th, "✓", "$", "echo hi", 30, "", false);
	assert(!t4[0].includes("0.1s"), "tanpa durasi: kosong (restore sesi lama)");

	// anti duplikat ringkasan
	assert(resText(R, th, (s) => s, false, true) === "", "expand: ringkasan kosong");
	assert(resText(R, th, (s) => s, false, false) === "󱞩 path:1:match a", "collapsed: baris pertama tampil");
	assert(numRes((n) => `→ ${n} matches`)(R, th, (s) => s, false, false) === "󱞩 → 3 matches", "grep: N matches");
	assert(
		numRes((n) => `→ ${n} matches`)({ content: [{ type: "text", text: "Error: bad" }] }, th, (s) => s, true, false) ===
			"󱞩 Error: bad",
		"error: jatuh ke baris pertama",
	);

	// gap antar kotak dibuang
	assert(stripBlankEdges(["", "a", "", "b", "  ", ""]).join() === "a,,b", "baris kosong tepi dibuang");
	assert(stripBlankEdges(["", "\x1b[2m\x1b[22m", "x"]).join() === "x", "baris ANSI kosong = blank");
	assert(stripBlankEdges(["a"]).join() === "a", "tanpa blank tetap utuh");

	// tool tanpa renderer sendiri -> kotak yang sama (memory_write dll.)
	const noRenderer = { toolName: "memory_write", toolDefinition: {} };
	const withRenderer = { toolName: "bash", toolDefinition: { renderResult: () => undefined } };
	assert(ToolExecutionComponent.prototype.getRenderShell.call(noRenderer) === "self", "tool polos -> shell self");
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(withRenderer) === "default",
		"tool ber-renderer -> shell aslinya (tak disentuh)",
	);
	assert(
		toolSummary("memory_write", "Appended to MEMORY.md\n\nExisting MEMORY.md preview (1 lines)", {
			content: "## omaga-sync workflow (2026-08-23)\n- Repo: /x",
		}) === "Appended to MEMORY.md. ## omaga-sync workflow (2026-08-23)",
		"memory_write: ringkasan + judul seksi yang baru ditulis",
	);
	assert(
		toolSummary("memory_write", "Appended to daily log: /x/y.md", { content: "- catatan tanpa judul" }) ===
			"Appended to daily log: /x/y.md",
		"memory_write daily: tanpa judul tetap baris pertama",
	);
	assert(toolSummary("todo", "line1\nline2") === "line1", "tool lain: baris pertama saja");

	const ctxState: TCtx = { args: { content: "## Judul\n- x" }, state: {} };
	const resRenderer = ToolExecutionComponent.prototype.getResultRenderer.call(noRenderer) as any;
	const out = resRenderer(
		{ content: [{ type: "text", text: "Appended to MEMORY.md\n\nExisting MEMORY.md preview" }] },
		{ expanded: false, isPartial: false },
		th,
		ctxState,
	).render(60);
	assert(out[0].startsWith("┌") && out[out.length - 1].startsWith("└"), "hasil tool polos dibungkus kotak");
	assert(
		out.some((l: string) => l.includes("Appended to MEMORY.md. ## Judul")),
		"kotak memuat ringkasan + judul",
	);
	assert(out.some((l: string) => l.includes("[ctrl+o to expand]")), "collapsed: ada petunjuk expand");
	assert(
		resRenderer(
			{ content: [{ type: "text", text: "Appended to MEMORY.md\n\nExisting preview" }] },
			{ expanded: true, isPartial: false },
			th,
			ctxState,
		).render(60).length > out.length,
		"expand: detail lengkap ikut tampil",
	);

	// bug 󰔟 tertinggal (restore-safe)
	const st: Record<string, unknown> = {};
	const comp = new Lines(() => (st.hasResult ? [] : ["row"]));
	assert(comp.render(10).length === 1, "running: kotak 󰔟 tampil");
	st.hasResult = true;
	assert(comp.render(10).length === 0, "final: kotak running hilang (restore-safe)");
	assert(FRAMES.includes(spinIcon()), "ikon animasi selalu frame valid");
	ACTIVE = 3;
	syncTicker();
	assert(TICK !== null, "ticker hidup selama ada tool berjalan");
	ACTIVE = 0;
	syncTicker();
	assert(TICK === null, "ticker mati saat idle (tanpa leak timer)");
	console.log("OK");
}
