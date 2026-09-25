/**
 * Header seksi daftar loaded-resources di /new: "<ikon> Nama [jumlah]".
 * Ikon = warna aksen, nama = tint, [jumlah] = dim.
 * Hanya 4 seksi (Context, Skills, Extensions, Themes); Prompts sengaja tak disentuh.
 *
 * Intercept ExpandableText lewat Container.prototype.addChild (class-nya tak
 * diekspor pi). Semua jalur gagal = teks asli dikembalikan utuh (fail-safe),
 * jadi baris header tidak mungkin kosong.
 */
import { UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

let activeThemeProxy: { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null = null;

// Header seksi /new: "<ikon> Nama [jumlah]" — ikon aksen, nama tint, [N] dim.
// Intercept ExpandableText lewat Container.prototype.addChild (class-nya tak
// diekspor). Semua jalur gagal = teks asli dikembalikan utuh (fail-safe), jadi
// baris header tidak mungkin kosong.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SECTION_ICONS: Record<string, string> = {
	Context: "\udb84\uddd7",
	Skills: "\uec21",
	Extensions: "\ueea8",
	Themes: "\uee72",
};

type Themeish = { fg?(color: string, text: string): string; bg?(color: string, text: string): string } | null;

// Ambil warna pertama yang benar-benar dipakai tema (tema lain mungkin tak
// mendefinisikan `tint`); gagal semua = teks tanpa warna, bukan teks kosong.
export function fgFirst(th: Themeish, names: string[], text: string): string {
	if (!th?.fg) return text;
	for (const name of names) {
		try {
			const out = th.fg(name, text);
			// pi membungkus: `${ansi}${text}\x1b[39m` -> teks asli harus ada di dalamnya
			if (typeof out === "string" && out.includes(text)) return out;
		} catch {
			// coba nama warna berikutnya
		}
	}
	return text;
}

export function sectionNameOf(text: string): string | null {
	const nl = text.indexOf("\n");
	const first = (nl === -1 ? text : text.slice(0, nl)).replace(ANSI_RE, "").trim();
	const m = /^\[([A-Za-z]+)\]$/.exec(first);
	return m ? m[1] : null;
}

// Body collapsed = "  a, b, c" (satu baris, koma); body expanded satu item per
// baris. Dua-duanya dihitung sama supaya angka tak berubah saat di-toggle.
export function sectionItemCount(body: string): number {
	const plain = body.replace(ANSI_RE, "").trim();
	return plain ? plain.split(/\n|, /).filter((s) => s.trim() !== "").length : 0;
}

export function rewriteSectionHeader(text: string, count: number, th: Themeish): string {
	const name = sectionNameOf(text);
	const icon = name ? SECTION_ICONS[name] : undefined;
	if (!name || !icon) return text;
	const label = [
		fgFirst(th, ["accent", "tint"], icon),
		fgFirst(th, ["tint", "text"], name),
		fgFirst(th, ["dim"], `[${count}]`),
	].join(" ");
	const nl = text.indexOf("\n");
	const next = nl === -1 ? label : label + text.slice(nl);
	return next.includes(name) && next.trim() !== "" ? next : text;
}

const SECTION_HEADER_KEY = Symbol.for("pi-arnative.sectionHeadersRewritten");
if (UserMessageComponent?.prototype && !(globalThis as Record<symbol, boolean>)[SECTION_HEADER_KEY]) {
	(globalThis as Record<symbol, boolean>)[SECTION_HEADER_KEY] = true;
	const containerProto = Object.getPrototypeOf(UserMessageComponent.prototype) as {
		addChild?: (child: unknown) => unknown;
	};
	if (typeof containerProto?.addChild === "function") {
		const origAddChild = containerProto.addChild;
		containerProto.addChild = function (child: any): unknown {
			try {
				const isSection = child && typeof child.getCollapsedText === "function"
					&& typeof child.getExpandedText === "function" && typeof child.setText === "function"
					&& SECTION_ICONS[sectionNameOf(String(child.getCollapsedText())) ?? ""] !== undefined;
				if (isSection) {
					const origCollapsed = child.getCollapsedText.bind(child) as () => string;
					const origExpanded = child.getExpandedText.bind(child) as () => string;
					const count = sectionItemCount(origCollapsed().split("\n").slice(1).join("\n"));
					const theme = () => activeThemeProxy as Themeish;
					child.getCollapsedText = () => rewriteSectionHeader(origCollapsed(), count, theme());
					child.getExpandedText = () => rewriteSectionHeader(origExpanded(), count, theme());
					child.setText(rewriteSectionHeader(String(child.text ?? ""), count, theme()));
				}
			} catch {
				// gagal rewrite tak boleh menggagalkan addChild bawaan
			}
			return origAddChild.call(this, child);
		};
	}
}

export default function (pi: ExtensionAPI) {
	// Tema aktif diambil ulang tiap sesi (ctx.ui.theme); render membacanya lazy.
	pi.on("session_start", async (_event, ctx) => {
		activeThemeProxy = ((ctx as unknown as { ui?: { theme?: typeof activeThemeProxy } }).ui?.theme) ?? activeThemeProxy;
	});
}

// Self-check: `node extensions/section-headers.ts`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"));
if (isMain) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};
	assert(sectionNameOf("\x1b[33m[Skills]\x1b[39m\n  a, b") === "Skills", "header [Skills] terdeteksi");
	assert(sectionNameOf("pi v0.87.1") === null, "teks non-seksi tak terdeteksi");
	assert(sectionItemCount("\x1b[2m  a, b, c\x1b[22m") === 3, "body collapsed (koma) = 3");
	assert(sectionItemCount("  a\n  b\n  c") === 3, "body expanded (baris) = 3");
	assert(sectionItemCount("") === 0, "body kosong = 0");
	assert(SECTION_ICONS.Prompts === undefined, "Prompts sengaja tak disentuh");
	const fakeTheme = { fg: (c: string, t: string) => `<${c}:${t}>` };
	const hdr = rewriteSectionHeader("\x1b[33m[Skills]\x1b[39m\n  a, b", 2, fakeTheme);
	assert(hdr.split("\n")[0] === "<accent:\uec21> <tint:Skills> <dim:[2]>", "ikon=aksen, nama=tint, [jumlah]=dim");
	assert(hdr.split("\n")[1] === "  a, b", "body dipertahankan");
	assert(rewriteSectionHeader("[Context]\n  a", 1, null) === "\udb84\uddd7 Context [1]\n  a", "tanpa tema: teks tanpa warna");
	assert(rewriteSectionHeader("[Prompts]\n  a", 1, null) === "[Prompts]\n  a", "Prompts dikembalikan apa adanya");
	assert(rewriteSectionHeader("pi v0.87.1", 1, fakeTheme) === "pi v0.87.1", "teks non-seksi tak berubah");
	assert(rewriteSectionHeader("[Themes]\n  x", 1, { fg: () => "" }) === "\uee72 Themes [1]\n  x", "tema rusak: label tetap utuh (fail-safe)");
	assert(fgFirst({ fg: () => "" }, ["tint", "text"], "z") === "z", "fg gagal: teks dikembalikan polos");
	console.log("section-headers.ts self-check OK");
}
