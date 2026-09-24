/**
 * Tool output minimal ala Codex CLI / Claude Code: satu baris judul (⏺),
 * satu baris ringkasan (⎿) saat collapsed, expand (ctrl+e / klik) untuk
 * judul penuh + output. Eksekusi murni delegasi (spread tool bawaan) - hanya
 * render yang ditimpa, perilaku tool tidak berubah. Termasuk bash (dulu
 * progress.ts, frame garis dihapus, digabung ke sini). Diff edit berwarna
 * toolDiff* dari tema. Lebar baris selalu dihitung via visibleWidth aktual
 * (dulu estimasi prefixLen hardcoded -> overflow ke kanan).
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
import { Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };
type TResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: any };

const cwd = process.cwd();
const DURATION_MAP = new Map<string, number>();

const shortPath = (p: string): string => {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

const textOf = (r: TResult): string =>
	r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();

const countLines = (s: string): number => (s ? s.split("\n").filter(Boolean).length : 0);

const outBody = (s: string, theme: Theme): string =>
	s.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n");

const errLine = (r: TResult, theme: Theme): string =>
	theme.fg("error", textOf(r).split("\n")[0] || "Error");

// Judul smart berbatas kata: maksimal `maxWords` kata, elipsis bila terpotong.
// Judul lengkap tampil saat expand. Kata panjang utuh dipotong aman oleh Text.
export function smartTitle(cmd: string, maxWords = 6): string {
	const words = cmd.replace(/\r?\n/g, " ").trim().split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return words.join(" ");
	return `${words.slice(0, maxWords).join(" ")}…`;
}

// Satu jalur render untuk semua tool: call 1 baris judul, result `⎿ ringkasan`
// saat collapsed, `⎿ ringkasan + body` saat expanded. Tanpa ini tiap tool
// mengulang logika yang sama (duplikasi). renderShell: "self" = tanpa box
// default pi -> tampilan setipis Claude Code.
function minimal(
	pi: ExtensionAPI,
	tool: object,
	call: (args: any, theme: Theme, expanded: boolean) => string,
	done: (result: TResult, theme: Theme, isError: boolean, context: { isError?: boolean; toolCallId?: string }) => string,
	full?: (result: TResult, theme: Theme) => string,
): void {
	pi.registerTool({
		...tool,
		renderShell: "self",
		renderCall(args: any, theme: Theme, context: { expanded?: boolean }) {
			return new Text(`⏺ ${call(args, theme, Boolean(context?.expanded))}`, 0, 0);
		},
		renderResult(
			result: TResult,
			{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			context: { isError?: boolean },
		) {
			if (isPartial) return new Text("⎿ …", 0, 0);
			const text = textOf(result);
			const isError = Boolean(context?.isError || result.isError || text.startsWith("Error"));
			const head = done(result, theme, isError, context);
			if (!expanded) return new Text(`⎿ ${head}`, 0, 0);
			const body = full ? full(result, theme) : text ? outBody(text, theme) : "";
			return new Text(body ? `⎿ ${head}\n${body}` : `⎿ ${head}`, 0, 0);
		},
	} as any);
}

// Self-check: `node extensions/tools.ts` (butuh node_modules ter-resolve).
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
	assert(smartTitle("word1 superverylongwordthatoverflows tail") === "word1 superverylongwordthatoverflows tail", "3 kata utuh");
	console.log("smartTitle OK");
}

export default function (pi: ExtensionAPI) {
	// read: `read path[:range]` → `N lines`
	minimal(
		pi,
		createReadTool(cwd),
		(a, th) => {
			const range =
				a.offset || a.limit
					? th.fg("warning", `:${a.offset ?? 1}${a.limit ? `-${(a.offset ?? 1) + a.limit - 1}` : ""}`)
					: "";
			return `${th.fg("toolTitle", th.bold("read"))} ${th.fg("accent", shortPath(a.path ?? ""))}${range}`;
		},
		(r, th, isErr) => {
			if (isErr) return errLine(r, th);
			const img = r.content.some((c) => c.type === "image");
			let s = th.fg("muted", img ? "image" : `${countLines(textOf(r))} lines`);
			const t = r.details?.truncation;
			if (t?.truncated) s += th.fg("warning", ` (truncated from ${t.totalLines})`);
			return s;
		},
	);

	// grep: `grep /pattern/ in path (glob)` → `→ N matches`
	minimal(
		pi,
		createGrepTool(cwd),
		(a, th) =>
			`${th.fg("toolTitle", th.bold("grep"))} ${th.fg("accent", `/${a.pattern ?? ""}/`)} ${th.fg("toolOutput", `in ${shortPath(a.path ?? ".")}${a.glob ? ` (${a.glob})` : ""}${a.limit ? ` limit ${a.limit}` : ""}`)}`,
		(r, th, isErr) =>
			isErr ? errLine(r, th) : th.fg("muted", `→ ${countLines(textOf(r))} matches`),
	);

	// find: `find pattern in path` → `→ N files`
	minimal(
		pi,
		createFindTool(cwd),
		(a, th) =>
			`${th.fg("toolTitle", th.bold("find"))} ${th.fg("accent", a.pattern ?? "")} ${th.fg("toolOutput", `in ${shortPath(a.path ?? ".")}${a.limit ? ` (limit ${a.limit})` : ""}`)}`,
		(r, th, isErr) =>
			isErr ? errLine(r, th) : th.fg("muted", `→ ${countLines(textOf(r))} files`),
	);

	// write: `write path (N lines)` → `✓ written`
	minimal(
		pi,
		createWriteTool(cwd),
		(a, th) =>
			`${th.fg("toolTitle", th.bold("write"))} ${th.fg("accent", shortPath(a.path ?? ""))} ${th.fg("muted", `(${countLines(a.content ?? "")} lines)`)}`,
		(r, th, isErr) => (isErr ? errLine(r, th) : th.fg("success", "✓ written")),
	);

	// edit: `edit path` → `+N / -M` (statistik diff); expand = diff berwarna toolDiff*
	minimal(
		pi,
		createEditTool(cwd),
		(a, th) => `${th.fg("toolTitle", th.bold("edit"))} ${th.fg("accent", shortPath(a.path ?? ""))}`,
		(r, th, isErr) => {
			if (isErr) return errLine(r, th);
			const diff: string = r.details?.diff ?? "";
			let add = 0;
			let del = 0;
			for (const l of diff.split("\n")) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) del++;
			}
			return diff
				? `${th.fg("toolDiffAdded", `+${add}`)} ${th.fg("dim", "/")} ${th.fg("toolDiffRemoved", `-${del}`)}`
				: th.fg("success", "✓");
		},
		(r, th) => {
			const diff: string = r.details?.diff ?? "";
			if (!diff) return outBody(textOf(r), th);
			return diff
				.split("\n")
				.map((l) =>
					l.startsWith("+") && !l.startsWith("+++")
						? th.fg("toolDiffAdded", l)
						: l.startsWith("-") && !l.startsWith("---")
							? th.fg("toolDiffRemoved", l)
							: th.fg("toolDiffContext", l),
				)
				.join("\n");
		},
	);

	// bash: `⏺ $ <6 kata pertama>…` (judul penuh saat expand) → `0.4s`
	// (angka saja, tanpa kata "Took"); expand = judul penuh + output.
	// Durasi diukur di execute (perilaku identik progress.ts lama).
	const originalBash = createBashTool(cwd);
	minimal(
		pi,
		{
			...originalBash,
			async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
				const start = performance.now();
				try {
					const res = await originalBash.execute(toolCallId, params, signal, onUpdate, ctx);
					DURATION_MAP.set(toolCallId, Math.round(performance.now() - start));
					return res;
				} catch (err) {
					DURATION_MAP.set(toolCallId, Math.round(performance.now() - start));
					throw err;
				}
			},
		},
		(a, th, expanded) => {
			const cmd = (a.command ?? "").replace(/\r?\n/g, " ").trim();
			const title = expanded ? cmd : smartTitle(cmd);
			return `${th.fg("toolTitle", th.bold("$"))} ${th.fg("accent", title || "...")}`;
		},
		(r, th, isErr, ctx) => {
			// durasi inline: cukup angka "0.4s" (lebih minimal dari "Took 0.4s")
			const ms = ctx.toolCallId ? DURATION_MAP.get(ctx.toolCallId) : undefined;
			const secs = `${ms !== undefined && ms >= 0 ? (ms / 1000).toFixed(1) : "0.1"}s`;
			return isErr ? `${th.fg("error", `x ${secs}`)} ${errLine(r, th)}` : th.fg("muted", secs);
		},
		(r, th) => outBody(textOf(r), th),
	);
}
