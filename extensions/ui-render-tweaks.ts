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
	getMarkdownTheme,
	initTheme,
	keyText,
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Spacer, Text, TuiAltScreen } from "@earendil-works/pi-tui";

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

// Kode pembuka bg (tanpa reset penutup) - probe dari tema aktif.
// Duplikat kecil dari timestamps.ts: tiap file ekstensi berdiri sendiri
// (tanpa import antar-file, agar loader pi tetap sesederhana sekarang).
export function ansiBgOpen(th: { bg?(c: string, t: string): string } | null, color: string): string {
	if (!th?.bg) return "";
	try {
		const probe = th.bg(color, "");
		const reset = "\x1b[49m";
		return probe.endsWith(reset) ? probe.slice(0, -reset.length) : probe;
	} catch {
		return "";
	}
}

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
// (kelabu). Diganti bg aksen; teks memakai kanvas tergelap tema supaya kontras
// 9.6:1 (WCAG AA). Bukan token semantik — pi tak punya token "teks di atas aksen".
const PILL_KEY = Symbol.for("pi-arnative.accentPill");
const PILL_MARK = "↓ Jump to latest message";
const PILL_INK = "toolPendingBg";

export function accentPill(
	text: string,
	th: { fg?(c: string, t: string): string; bg?(c: string, t: string): string } | null,
): string {
	if (!text.includes(PILL_MARK) || !th?.fg || !th?.bg) return text;
	try {
		return th.bg("accent", th.fg(PILL_INK, text.replace(/\x1b\[[0-9;]*m/g, "")));
	} catch {
		return text;
	}
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

	// 4. Pesan kontrak `pi-jev-eye-review`: label ganda + baris kosong + kotak ungu
	// dihapus, isi pesan tampil apa adanya (baris `[pi-jev-eye] ...` sudah ada di
	// dalam isinya sendiri).
	pi.registerMessageRenderer("pi-jev-eye-review", (message, _opts, th) =>
		new Text(customMessageText(message.content), 0, 0, (t) => th.fg("customMessageText", t)),
	);
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
	assert(shouldHideReloadBox(["┌──┐", "│ Reloading keybindings, extensions, skills... │"]) === true, "box reload terdeteksi");
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

	// Pil "Jump to latest message": bg aksen + teks kanvas (bukan selectedBg kelabu)
	const thPil = { fg: (c: string, t: string) => `<F:${c}>${t}`, bg: (c: string, t: string) => `<B:${c}>${t}` };
	const pilAsli = "\x1b[48;5;236m ↓ Jump to latest message · End \x1b[49m";
	assert(
		accentPill(pilAsli, thPil) === `<B:accent><F:${PILL_INK}> ↓ Jump to latest message · End `,
		"pil: bg aksen + teks kanvas, ANSI lama dibuang",
	);
	assert(accentPill("teks lain", thPil) === "teks lain", "pil: teks non-pil tak disentuh");
	assert(accentPill(pilAsli, null) === pilAsli, "pil: tanpa tema -> apa adanya");
	const hostPil: { scrollToEndIndicator?: () => string } = { scrollToEndIndicator: () => pilAsli };
	const dalamPil = withAccentPill(hostPil, () => hostPil.scrollToEndIndicator?.(), thPil);
	assert(dalamPil === `<B:accent><F:${PILL_INK}> ↓ Jump to latest message · End `, "pil: callback instance disisipi");
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

	const contract = fakePi.renderers["pi-jev-eye-review"](
		{ customType: "pi-jev-eye-review", content: "[pi-jev-eye] Reviewed turn contract:\n- Bahasa ikut user" },
		{ expanded: false, outputPad: 1 },
		{ fg: (_c: string, t: string) => t },
	);
	const contractLines = contract.render(120).map((l: string) => l.trimEnd());
	assert(
		contractLines[0] === "[pi-jev-eye] Reviewed turn contract:" && contractLines.length === 2,
		"pesan kontrak: isi apa adanya, tanpa label/baris kosong tambahan",
	);
	console.log("ui-render-tweaks.ts self-check OK");
}
