/**
 * Dua tambalan kecil pada renderer pi fullscreen:
 * 1. Sembunyikan box "Reloading keybindings, extensions, skills..." bawaan pi
 *    (hardcoded di handleReloadCommand, tak ada auto-hide).
 * 2. Seleksi drag: pi hanya membungkus irisan dengan reverse video (\x1b[7m) —
 *    di terminal/tema tertentu teks jadi tak terbaca. Ganti jadi warna eksplisit
 *    (bg selectedBg + fg text) supaya teks selalu terlihat.
 */
import { UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

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

export default function (pi: ExtensionAPI) {
	// Tema aktif diambil ulang tiap sesi (ctx.ui.theme); render membacanya lazy.
	pi.on("session_start", async (_event, ctx) => {
		activeThemeProxy = ((ctx as unknown as { ui?: { theme?: typeof activeThemeProxy } }).ui?.theme) ?? activeThemeProxy;
	});
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
	console.log("ui-render-tweaks.ts self-check OK");
}
