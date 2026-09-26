/**
 * Empat tambalan kecil pada renderer pi fullscreen (semua di lapisan render, tanpa
 * mengubah data sesi):
 * 1. Sembunyikan box "Reloading keybindings, extensions, skills..." bawaan pi
 *    (hardcoded di handleReloadCommand, tak ada auto-hide).
 * 2. Seleksi drag: pi hanya membungkus irisan dengan reverse video (\x1b[7m) —
 *    di terminal/tema tertentu teks jadi tak terbaca. Ganti jadi warna eksplisit
 *    (bg selectedBg + fg text) supaya teks selalu terlihat.
 * 3. Pesan compaction: bawaan pi = label + baris kosong + teks (3 baris). Kita
 *    rapatkan jadi satu baris `[compaction] Compacted from N tokens (ctrl+o to expand)`.
 * 4. Pesan custom `pi-jev-eye-review`: bawaan pi menambah label `[pi-jev-eye-review]` +
 *    baris kosong di dalam kotak ungu; renderer kita tampilkan isi apa adanya.
 * 5. Pil `↓ Jump to latest message` (fullscreen): bg `selectedBg` (kelabu) -> aksen,
 *    teks dibuat gelap (kanvas tema) supaya kontras tetap tinggi (9.6:1).
 */
import {
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	initTheme,
	InteractiveMode,
	keyText,
	Theme,
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	MouseRegion,
	Spacer,
	Text,
	TuiAltScreen,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { readdirSync, readFileSync } from "node:fs";
import { renderBoxLines } from "../lib/box.ts";
import { ansiBgOpen } from "../lib/ansi.ts";
export { ansiBgOpen };

let activeThemeProxy: { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null = null;

// Sembunyikan box "Reloading keybindings, extensions, skills..." bawaan pi
// (hardcoded di handleReloadCommand, tak ada auto-hide). Patch render Container
// via rantai prototype (Container tak diekspor); drop seluruh box saat match.
export function shouldHideReloadBox(lines: readonly string[]): boolean {
	return lines.some((l) => l.includes("Reloading keybindings"));
}
const RELOAD_BOX_KEY = Symbol.for("pi-arnative.reloadBoxHidden");
if (UserMessageComponent?.prototype && !(globalThis as Record<symbol, boolean>)[RELOAD_BOX_KEY]) {
	(globalThis as Record<symbol, boolean>)[RELOAD_BOX_KEY] = true;
	const containerProto = Object.getPrototypeOf(UserMessageComponent.prototype) as { render?: (width: number) => string[] };
	if (typeof containerProto?.render === "function") {
		const origContainerRender = containerProto.render;
		containerProto.render = function (width: number): string[] {
			const lines = origContainerRender.call(this, width);
			return shouldHideReloadBox(lines) ? [] : lines;
		};
	}
}

// Kode pembuka bg (tanpa reset penutup) -> lib/ansi.ts (satu definisi).

// Seleksi teks drag-select di pi fullscreen: pi hanya membungkus irisan dengan
// reverse video (\x1b[7m) — di terminal/tema tertentu teks jadi tak terbaca.
// Ganti jadi warna eksplisit (bg selectedBg + fg text) supaya teks selalu terlihat.
const SELECTION_COLOR_KEY = Symbol.for("pi-arnative.selectionColorsPatched");

export function recolorSelection(highlighted: string, fgOpen: string, bgOpen: string): string {
	return highlighted.split("\x1b[7m").join(fgOpen + bgOpen).split("\x1b[27m").join("\x1b[39m\x1b[49m");
}

export function ansiFgOpen(th: { fg?(c: string, t: string): string } | null, color = "text"): string {
	if (!th?.fg) return "";
	try {
		const probe = th.fg(color, "");
		const reset = "\x1b[39m";
		return probe.endsWith(reset) ? probe.slice(0, -reset.length) : probe;
	} catch {
		return "";
	}
}

// Pil `↓ Jump to latest message` (fullscreen): pi mewarnainya bg `selectedBg`
// (kelabu). Diganti bg aksen + teks kanvas tergelap (kontras 9.6:1, WCAG AA).
// Catatan: pi hanya punya 7 token latar (selectedBg/userMessageBg/customMessageBg/
// toolPendingBg/toolSuccessBg/toolErrorBg/searchMatchBg) — `accent` token teks,
// jadi arah escape SGR-nya ditukar. `bg("accent")` pasti melempar "Unknown theme
// background color" dan dulu ditelan catch -> pil tak berubah.
const PILL_KEY = Symbol.for("pi-arnative.accentPill");
const PILL_MARK = "↓ Jump to latest message";
const PILL_INK = "toolPendingBg";

const asBg = (seq: string) => seq.replace(/\x1b\[38;/g, "\x1b[48;");
const asFg = (seq: string) => seq.replace(/\x1b\[48;/g, "\x1b[38;");

export function accentPill(
	text: string,
	th: { fg?(c: string, t: string): string; bg?(c: string, t: string): string } | null,
): string {
	if (!text.includes(PILL_MARK) || !th?.fg || !th?.bg) return text;
	const accentBg = asBg(ansiFgOpen(th, "accent"));
	const inkFg = asFg(ansiBgOpen(th, PILL_INK));
	if (!accentBg || !inkFg) return text; // token tak ada di tema -> biarkan bawaan pi
	return `${accentBg}${inkFg}${text.replace(/\x1b\[[0-9;]*m/g, "")}\x1b[39m\x1b[49m`;
}

// TuiAltScreen membuat pil lewat callback instance `scrollToEndIndicator` (field
// per-instance, jadi tak bisa ditambal di prototype-nya). Sisipkan callback kita
// hanya selama composite berlangsung, lalu kembalikan aslinya.
export function withAccentPill<T>(
	host: { scrollToEndIndicator?: (() => string) | undefined },
	fn: () => T,
	th: { fg?(c: string, t: string): string; bg?(c: string, t: string): string } | null,
): T {
	const orig = host.scrollToEndIndicator;
	if (typeof orig !== "function") return fn();
	host.scrollToEndIndicator = () => accentPill(orig(), th);
	try {
		return fn();
	} finally {
		host.scrollToEndIndicator = orig;
	}
}

if (TuiAltScreen?.prototype && !(globalThis as Record<symbol, boolean>)[SELECTION_COLOR_KEY]) {
	(globalThis as Record<symbol, boolean>)[SELECTION_COLOR_KEY] = true;
	const origHighlight = TuiAltScreen.prototype.applySelectionHighlight;
	if (typeof origHighlight === "function") {
		TuiAltScreen.prototype.applySelectionHighlight = function (text: string): string {
			const highlighted = origHighlight.call(this, text);
			const fgOpen = ansiFgOpen(activeThemeProxy);
			const bgOpen = ansiBgOpen(activeThemeProxy, "selectedBg");
			return fgOpen && bgOpen ? recolorSelection(highlighted, fgOpen, bgOpen) : highlighted;
		};
	}
}

if (TuiAltScreen?.prototype && !(globalThis as Record<symbol, boolean>)[PILL_KEY]) {
	(globalThis as Record<symbol, boolean>)[PILL_KEY] = true;
	const proto = TuiAltScreen.prototype as unknown as {
		compositeScrollToEndIndicator?: (screen: string[], layout: unknown, width: number) => string[];
	};
	const origComposite = proto.compositeScrollToEndIndicator;
	if (typeof origComposite === "function") {
		proto.compositeScrollToEndIndicator = function (
			this: { scrollToEndIndicator?: (() => string) | undefined },
			screen: string[],
			layout: unknown,
			width: number,
		) {
			return withAccentPill(this, () => origComposite.call(this, screen, layout, width), activeThemeProxy);
		};
	}
}

export default function uiRenderTweaks(pi: ExtensionAPI) {
	// Tema aktif diambil ulang tiap sesi (ctx.ui.theme); render membacanya lazy.
	pi.on("session_start", async (_event, ctx) => {
		activeThemeProxy = ((ctx as unknown as { ui?: { theme?: typeof activeThemeProxy } }).ui?.theme) ?? activeThemeProxy;
	});

	// 4. Pesan kontrak `pi-jev-eye-review`: gunakan kotak border kustom kita.
	// Default collapsed: [pi-jev-eye] Reviewed turn contract. [click to expand]
	// Saat di-klik: isi kontrak penuh muncul di dalam kotak.
	pi.registerMessageRenderer("pi-jev-eye-review", (message, { expanded }, th) => {
		const raw = customMessageText(message.content);
		return new JevReviewBoxComponent(raw, Boolean(expanded), th);
	});
}

// Notifikasi "Package Updates Available": pi membungkus teksnya dengan
// DynamicBorder (garis penuh, bukan kotak). Diganti jadi kotak arnative
// (╭─╮ │ ╰─╯) lewat patch prototype InteractiveMode; warna kuning (warning)
// pada judul & bingkai tetap, isi teks sama seperti bawaan pi.
export class PackageUpdateBoxComponent implements Component {
	private packages: string[];
	private th: { fg(c: string, t: string): string };

	constructor(packages: string[], th: { fg(c: string, t: string): string }) {
		this.packages = packages;
		this.th = th;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.th;
		const rows = [
			th.fg("warning", "\x1b[1m\uf449  Package Updates Available\x1b[22m"),
			`${th.fg("muted", "Package updates are available. Run ")}${th.fg("accent", "pi update --extensions")}`,
			th.fg("muted", "Packages:"),
			...this.packages.map((pkg) => `- ${pkg}`),
		];
		return renderBoxLines(th, width, rows, undefined, "warning");
	}
}

const PACKAGE_BOX_KEY = Symbol.for("pi-arnative.packageUpdateBox");
if (InteractiveMode?.prototype && !(globalThis as Record<symbol, boolean>)[PACKAGE_BOX_KEY]) {
	(globalThis as Record<symbol, boolean>)[PACKAGE_BOX_KEY] = true;
	const proto = InteractiveMode.prototype as unknown as {
		showPackageUpdateNotification(packages: string[]): void;
	};
	proto.showPackageUpdateNotification = function (packages: string[]) {
		const self = this as unknown as {
			chatContainer: { addChild(c: unknown): void };
			ui: { requestRender(): void };
		};
		self.chatContainer.addChild(new Spacer(1));
		self.chatContainer.addChild(new PackageUpdateBoxComponent(packages, activeThemeProxy ?? Theme));
		self.ui.requestRender();
	};
}

// Helper border box ala arnative -> lib/box.ts (satu definisi untuk semua kotak)

export class JevReviewBoxComponent implements Component {
	private text: string;
	private th: { fg(c: string, t: string): string; bg?(c: string, t: string): string };
	public isExpanded: boolean;

	constructor(text: string, isExpanded: boolean, th: { fg(c: string, t: string): string; bg?(c: string, t: string): string }) {
		this.text = text;
		this.isExpanded = isExpanded;
		this.th = th;
	}

	render(width: number): string[] {
		const tag = this.th.fg("customMessageLabel", "\x1b[1m[pi-jev-eye]\x1b[22m");
		if (!this.isExpanded) {
			const title = this.th.fg("customMessageText", "Reviewed turn contract.");
			const hint = this.th.fg("dim", "[click to expand]");
			return renderBoxLines(this.th, width, [`${tag} ${title} ${hint}`]);
		}
		// Expanded: tampilkan seluruh baris isi
		const lines = this.text.split("\n");
		const formattedRows = lines.map((line, idx) => {
			if (idx === 0 && line.startsWith("[pi-jev-eye]")) {
				const rest = line.slice("[pi-jev-eye]".length).trim();
				return `${tag} ${this.th.fg("customMessageText", rest)}`;
			}
			return this.th.fg("customMessageText", line);
		});
		return renderBoxLines(this.th, width, formattedRows);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click" && event.button === "left") {
			this.isExpanded = !this.isExpanded;
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {}
}

// 3. Pesan compaction: satu baris, bukan tiga (label, spacer, teks).
// Tema aktif dipakai supaya warna identik dengan kotak bawaan pi; sebelum sesi
// jalan (proxy belum ada) biarkan renderer bawaan yang bekerja.
export function compactionLine(th: { fg(c: string, t: string): string }, tokenStr: string): string {
	const label = th.fg("customMessageLabel", "\x1b[1m[compaction]\x1b[22m");
	return `${label} ${th.fg("customMessageText", `Compacted from ${tokenStr} tokens (`)}${th.fg("dim", expandKey())}${th.fg(
		"customMessageText",
		" to expand)",
	)}`;
}

// Teks tombol ikut keybinding aktif; di luar sesi pi keyText() kosong.
function expandKey(): string {
	try {
		return keyText("app.tools.expand") || "ctrl+o";
	} catch {
		return "ctrl+o";
	}
}

// Isi pesan custom: string apa adanya, atau gabungan blok teks (blok gambar dibuang).
export function customMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((c) => (c as { type?: string })?.type === "text")
			.map((c) => (c as { text?: string }).text ?? "")
			.join("\n");
	return "";
}

const COMPACTION_KEY = Symbol.for("pi-arnative.compactionOneLine");
if (CompactionSummaryMessageComponent?.prototype && !(globalThis as Record<symbol, boolean>)[COMPACTION_KEY]) {
	(globalThis as Record<symbol, boolean>)[COMPACTION_KEY] = true;
	const proto = CompactionSummaryMessageComponent.prototype as any;
	const origUpdateDisplay = proto.updateDisplay;
	proto.updateDisplay = function (): void {
		const th = activeThemeProxy;
		if (!th) return origUpdateDisplay.call(this);
		const message = this.message as { tokensBefore?: number; summary?: string } | undefined;
		const tokenStr = Number(message?.tokensBefore ?? 0).toLocaleString();
		this.clear();
		const content = new Container();
		if (this.expanded) {
			content.addChild(new Text(th.fg("customMessageLabel", "\x1b[1m[compaction]\x1b[22m"), 0, 0));
			content.addChild(new Spacer(1));
			content.addChild(
				new Markdown(
					`**Compacted from ${tokenStr} tokens**\n\n${message?.summary ?? ""}`,
					0,
					0,
					this.markdownTheme ?? getMarkdownTheme(),
					{ color: (t: string) => th.fg("customMessageText", t) },
				),
			);
		} else {
			content.addChild(new Text(compactionLine(th, tokenStr), 0, 0));
		}
		this.addChild(
			new MouseRegion(content, (event: any) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	};
}

// Self-check: `node extensions/ui-render-tweaks.ts`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"));
if (isMain) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};
	// Box reload bawaan pi tersembunyi penuh (bukan baris demi baris)
	assert(shouldHideReloadBox(["╭──╮", "│ Reloading keybindings, extensions, skills... │"]) === true, "box reload terdeteksi");
	assert(shouldHideReloadBox(["hello", "world"]) === false, "baris biasa lolos");

	// Seleksi: reverse video diganti warna eksplisit (bg selectedBg + fg text)
	assert(
		recolorSelection("\x1b[7mhi\x1b[27m", "<F>", "<B>") === "<F><B>hi\x1b[39m\x1b[49m",
		"recolorSelection: buka dgn fg+bg, tutup dgn reset fg+bg",
	);
	assert(recolorSelection("plain", "<F>", "<B>") === "plain", "tanpa reverse video: tak berubah");
	assert(ansiFgOpen(null) === "", "tanpa tema: fgOpen kosong");
	assert(ansiFgOpen({ fg: (_c, t) => `\x1b[38;2;1;2;3m${t}\x1b[39m` }) === "\x1b[38;2;1;2;3m", "fgOpen terambil dari probe tema");
	assert(ansiBgOpen({ bg: (_c, t) => `\x1b[48;2;9;9;9m${t}\x1b[49m` }, "selectedBg") === "\x1b[48;2;9;9;9m", "bgOpen selectedBg terambil");

	// Pil "Jump to latest message": bg aksen + teks kanvas (bukan selectedBg kelabu).
	// Pakai Theme ASLI: stub permisif dulu meloloskan `bg("accent")` yang di pi melempar.
	const temaJson = JSON.parse(readFileSync(new URL("../themes/arnative.json", import.meta.url), "utf8")) as {
		vars: Record<string, string>;
		colors: Record<string, string>;
	};
	const hex = (tok: string) => temaJson.vars[temaJson.colors[tok] ?? tok];
	// Theme bawaan menambal fallback (scrollbarTrack<-muted, thinkingMax<-thinkingXhigh),
	// jadi peta fg harus lengkap; ambil seluruh palet seperti loader pi.
	const fgPalet = Object.fromEntries(Object.entries(temaJson.colors).map(([k, v]) => [k, temaJson.vars[v] ?? v]));
	const thPil = new Theme(fgPalet, { toolPendingBg: hex("toolPendingBg"), selectedBg: hex("selectedBg") }, "truecolor");
	const pilAsli = thPil.bg("selectedBg", thPil.fg("text", " ↓ Jump to latest message · End "));
	const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
	assert(
		accentPill(pilAsli, thPil) ===
			`\x1b[48;2;${rgb(hex("accent"))}m\x1b[38;2;${rgb(hex("toolPendingBg"))}m ↓ Jump to latest message · End \x1b[39m\x1b[49m`,
		"pil: bg aksen + teks kanvas, ANSI lama dibuang",
	);
	let ditolak = false;
	try {
		thPil.bg("accent", "x");
	} catch {
		ditolak = true;
	}
	assert(ditolak, "pi memang menolak bg('accent') -> arah SGR harus ditukar");
	assert(accentPill("teks lain", thPil) === "teks lain", "pil: teks non-pil tak disentuh");
	assert(accentPill(pilAsli, null) === pilAsli, "pil: tanpa tema -> apa adanya");

	// Varian tema: semua themes/*.json wajib valid — name = nama berkas, warna wajib lengkap,
	// hex valid, dan kontras diukur vs kanvas tema itu sendiri (userMessageBg):
	// konten >= 3.0, teks sekunder >= 2.0, ramp thinking 1.3-4.0, pil aksen >= 4.5 — ambang
	// yang sudah lolos di base `arnative` (bukan angka karangan).
	const dirTema = new URL("../themes/", import.meta.url);
	const wajib = Object.keys(temaJson.colors);
	// Kunci yang bukan teks (latar/garis/scrollbar) — tak dinilai kontras teks.
	const bukanTeks = new Set([
		"selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
		"searchMatchBg", "border", "borderAccent", "borderMuted", "mdCodeBlockBorder", "mdQuoteBorder",
		"scrollbarTrack", "scrollbarThumb",
	]);
	const sekunder = new Set(["muted", "dim", "mdQuote", "mdHr", "mdLinkUrl", "toolOutput", "toolDiffContext", "thinkingText", "syntaxComment"]);
	// Ramp thinking: makin tinggi makin terbaca; thinkingMax = accent (dinilai di jalur pil).
	const ramp: Record<string, number> = {
		thinkingOff: 1.3, thinkingMinimal: 1.3, thinkingLow: 2.0,
		thinkingMedium: 2.7, thinkingHigh: 3.6, thinkingXhigh: 4.0,
	};
	const luminansi = (h: string) => {
		const ch = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) =>
			c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
		);
		return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
	};
	const kontras = (a: string, b: string) => {
		const [x, y] = [luminansi(a), luminansi(b)].sort((m, n) => n - m);
		return (x! + 0.05) / (y! + 0.05);
	};
	for (const f of readdirSync(dirTema).filter((n) => n.endsWith(".json")).sort()) {
		const d = JSON.parse(readFileSync(new URL(f, dirTema), "utf8")) as {
			name: string;
			vars: Record<string, string>;
			colors: Record<string, string>;
		};
		assert(d.name === f.replace(/\.json$/, ""), `tema ${f}: name = nama berkas`);
		const kurang = wajib.filter((k) => !(k in d.colors));
		assert(kurang.length === 0, `tema ${f}: warna wajib lengkap (kurang ${kurang.join(",")})`);
		// Nilai colors hanya boleh: hex, indeks 256, kosong, atau NAMA VAR yang benar-benar
		// ada — menulis nama warna (mis. "muted") bikin pi menolak tema tanpa jelas sebabnya.
		for (const [tok, nilai] of Object.entries(d.colors)) {
			if (typeof nilai !== "string") continue;
			if (nilai === "" || /^#[0-9a-f]{6}$/i.test(nilai) || nilai in d.vars) continue;
			assert(false, `tema ${f}: colors.${tok} = "${nilai}" bukan hex/var`);
		}
		const hex = (tok: string) => d.vars[d.colors[tok] ?? tok] ?? d.colors[tok];
		for (const tok of ["accent", "text", "selectedBg", "toolPendingBg"]) {
			assert(/^#[0-9a-f]{6}$/i.test(hex(tok)), `tema ${f}: ${tok} hex (${hex(tok)})`);
		}
		// Pil aksen: bg aksen + teks berwarna toolPendingBg.
		assert(kontras(hex("accent"), hex("toolPendingBg")) >= 4.5, `tema ${f}: kontras accent vs toolPendingBg >= 4.5`);
		assert(/^#[0-9a-f]{6}$/i.test(d.vars.softCyan ?? ""), `tema ${f}: vars.softCyan (tint) hex`);
		const kanvas = hex("userMessageBg");
		for (const tok of Object.keys(d.colors)) {
			if (bukanTeks.has(tok) || tok === "thinkingMax") continue;
			const warna = hex(tok);
			if (!/^#[0-9a-f]{6}$/i.test(warna)) continue; // indeks 256 warna: biarkan pi yang menilai
			const batas = ramp[tok] ?? (sekunder.has(tok) ? 2.0 : 3.0);
			const c = kontras(warna, kanvas);
			assert(c >= batas, `tema ${f}: kontras ${tok} vs kanvas ${c.toFixed(2)} < ${batas}`);
		}
		// Teks isi kotak tool harus terbaca di latar sukses MAUPUN error, dan pesan error
		// di kotak error — tiga pasangan yang dulu lolos (3.48-4.46) tanpa terdeteksi.
		for (const [fg, bg] of [
			["toolOutput", "toolSuccessBg"], ["toolOutput", "toolErrorBg"],
			["error", "toolErrorBg"], ["toolDiffRemoved", "toolErrorBg"],
		] as const) {
			const c = kontras(hex(fg), hex(bg));
			assert(c >= 4.5, `tema ${f}: kontras ${fg} di ${bg} ${c.toFixed(2)} < 4.5`);
		}
		// Kotak error tidak boleh lebih berat dari kotak sukses (luminansi latar sepadan).
		const [lErr, lOk] = [luminansi(hex("toolErrorBg")), luminansi(hex("toolSuccessBg"))];
		assert(Math.abs(lErr - lOk) / Math.max(lErr, lOk) <= 0.25, `tema ${f}: bobot toolErrorBg vs toolSuccessBg (${lErr.toFixed(3)} vs ${lOk.toFixed(3)})`);
		// Thumb & highlight cari harus bisa dibedakan dari track/seleksi (dulu nilainya identik).
		assert(hex("scrollbarThumb") !== hex("scrollbarTrack"), `tema ${f}: scrollbarThumb masih sama dengan scrollbarTrack`);
		assert(hex("searchMatchBg") !== hex("selectedBg"), `tema ${f}: searchMatchBg masih sama dengan selectedBg`);
	}
	const thKosong = new Theme(
		{ muted: "#808080", text: "#d4d4d4", thinkingXhigh: "#20caee" },
		{ selectedBg: "#3a3a4a" },
		"truecolor",
	);
	assert(accentPill(pilAsli, thKosong) === pilAsli, "pil: token absen -> apa adanya");
	const hostPil: { scrollToEndIndicator?: () => string } = { scrollToEndIndicator: () => pilAsli };
	const dalamPil = withAccentPill(hostPil, () => hostPil.scrollToEndIndicator?.(), thPil);
	assert(dalamPil.includes("\x1b[48;2;0;215;255m"), "pil: callback instance disisipi bg aksen");
	assert(hostPil.scrollToEndIndicator?.() === pilAsli, "pil: callback asli dipulihkan setelah render");

	// compaction: tiga baris bawaan pi -> satu baris
	assert(
		compactionLine({ fg: (_c, t) => t }, "112,247").replace(/\x1b\[[0-9;]*m/g, "") ===
			"[compaction] Compacted from 112,247 tokens (ctrl+o to expand)",
		"compaction: label + teks + petunjuk expand dalam satu baris (tanpa baris kosong)",
	);

	// pesan custom: isi apa adanya, tanpa label/garis tambahan
	assert(
		customMessageText("[pi-jev-eye] Reviewed turn contract:\n- Bahasa ikut user") ===
			"[pi-jev-eye] Reviewed turn contract:\n- Bahasa ikut user",
		"isi pesan custom utuh",
	);
	assert(
		customMessageText([
			{ type: "text", text: "a" },
			{ type: "image", data: "x" },
			{ type: "text", text: "b" },
		]) === "a\nb",
		"blok non-teks dibuang",
	);

	// Integrasi: jalankan factory seperti pi, lalu panggil updateDisplay/ renderer asli
	const fakePi = {
		handlers: [] as any[],
		renderers: {} as Record<string, any>,
		on(_e: string, h: any) {
			this.handlers.push(h);
			return () => {};
		},
		registerMessageRenderer(t: string, r: any) {
			this.renderers[t] = r;
		},
	};
	initTheme(); // markdown + tema internal pi (di sesi nyata sudah aktif)
	uiRenderTweaks(fakePi as any);
	await fakePi.handlers[0]({}, { ui: { theme: { fg: (_c: string, t: string) => t } } });

	const kids: any[] = [];
	const fake = {
		expanded: false,
		message: { tokensBefore: 112247, summary: "**Ringkasan** panjang\n\n- satu" },
		clear() {
			kids.length = 0;
		},
		addChild(c: any) {
			kids.push(c);
		},
	};
	CompactionSummaryMessageComponent.prototype.updateDisplay.call(fake as any);
	const collapsed = kids[0].render(120);
	assert(
		collapsed.length === 1 && collapsed[0].trimEnd().endsWith("Compacted from 112,247 tokens (ctrl+o to expand)"),
		"compaction collapsed: tepat satu baris",
	);

	fake.expanded = true;
	CompactionSummaryMessageComponent.prototype.updateDisplay.call(fake as any);
	const expanded = kids[0].render(120);
	assert(
		expanded.length > 1 && expanded.some((l: string) => l.includes("[compaction]")) && expanded.join(" ").includes("Ringkasan"),
		"compaction expanded: label + ringkasan markdown tetap ada",
	);

	const contractCollapsed = fakePi.renderers["pi-jev-eye-review"](
		{ customType: "pi-jev-eye-review", content: "[pi-jev-eye] Reviewed turn contract:\n- Bahasa ikut user" },
		{ expanded: false, outputPad: 1 },
		{ fg: (_c: string, t: string) => t },
	);
	const cLines = contractCollapsed.render(120).map((l: string) => l.trimEnd());
	assert(
		cLines[0].startsWith("╭") && cLines[cLines.length - 1].startsWith("╰") && cLines[1].includes("[click to expand]"),
		"pesan kontrak collapsed: kotak border dengan teks [click to expand]",
	);

	// Notifikasi pembaruan paket: kotak arnative, isi & warna kuning tetap
	const upd = new PackageUpdateBoxComponent(["github.com/bismawy/pi-arnative", "pkg-dua"], {
		fg: (c: string, t: string) => (c === "warning" ? `\x1b[33m${t}\x1b[39m` : t),
	}).render(60);
	assert(upd[0]!.includes("\x1b[33m") && upd[0]!.includes("╭"), "kotak pembaruan: bingkai bulat + warna warning");
	assert(upd[upd.length - 1]!.includes("╰"), "kotak pembaruan: bingkai bawah");
	assert(upd[1]!.includes("Package Updates Available"), "judul pembaruan di dalam kotak");
	assert(upd[1]!.includes("\uf449"), "ikon \uf449 pada judul pembaruan");
	assert(upd.some((l: string) => l.includes("- github.com/bismawy/pi-arnative")), "daftar paket di dalam kotak");
	assert(upd.every((l: string) => visibleWidth(l) === 60), "kotak pembaruan selebar 60");

	// Test invalidate and handleMouse click toggle
	contractCollapsed.invalidate();
	const mouseRes = contractCollapsed.handleMouse({ type: "click", button: "left" });
	assert(mouseRes?.handled === true, "klik kiri handled");
	assert(contractCollapsed.isExpanded === true, "klik kiri toggle expanded");
	const toggledLines = contractCollapsed.render(120).map((l: string) => l.trimEnd());
	assert(toggledLines.some((l: string) => l.includes("Bahasa ikut user")), "setelah klik: isi lengkap tampil");

	const contractExpanded = fakePi.renderers["pi-jev-eye-review"](
		{ customType: "pi-jev-eye-review", content: "[pi-jev-eye] Reviewed turn contract:\n- Bahasa ikut user" },
		{ expanded: true, outputPad: 1 },
		{ fg: (_c: string, t: string) => t },
	);
	const expLines = contractExpanded.render(120).map((l: string) => l.trimEnd());
	assert(
		expLines[0].startsWith("╭") && expLines[expLines.length - 1].startsWith("╰") && expLines.some((l: string) => l.includes("Bahasa ikut user")),
		"pesan kontrak expanded: kotak border dengan isi lengkap",
	);
	console.log("ui-render-tweaks.ts self-check OK");
}
