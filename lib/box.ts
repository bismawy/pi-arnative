/**
 * Satu definisi border box ala kolom chat arnative (dim, ujung bulat ╭─╮ │ ╰─╯).
 * Dipakai tools.ts (kotak tool call), ui-render-tweaks.ts (Jev review box),
 * usage.ts (modal /usage) - ubah di sini, semua ikut.
 * File ini BUKAN extension: diletakkan di luar `extensions/*.ts` supaya pi
 * tidak memuatnya sebagai extension.
 */
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type BoxTheme = { fg(color: string, text: string): string; bg?(color: string, text: string): string };
export type Dim = (s: string) => string;

export const boxEdge = (l: string, r: string, width: number, dim: Dim): string =>
	dim(`${l}${"─".repeat(Math.max(0, width - 2))}${r}`);

/** Baris isi: │ <teks> │, lebarnya pas `width`. */
export const boxRow = (content: string, width: number, dim: Dim): string => {
	const pad = Math.max(0, width - visibleWidth(content) - 4);
	return `${dim("│")} ${content}${" ".repeat(pad)} ${dim("│")}`;
};

const applyBg = (line: string, width: number, bgFn: (text: string) => string): string => {
	const pad = Math.max(0, width - visibleWidth(line));
	return bgFn(line + " ".repeat(pad));
};

/**
 * Bungkus `rows` ( teks polos / sudah ber-warna ANSI ) jadi kotak.
 * Baris panjang di-wrap; `bgType` = nama warna bg tema (optional, diam kalau
 * tema tak punya `bg`); `borderColor` = warna garis bingkai.
 */
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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"))) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};
	const th: BoxTheme = { fg: (_c, t) => t };
	const plain = renderBoxLines(th, 24, ["halo", "dunia yang panjang sekali"]);
	assert(plain[0]!.startsWith("╭") && plain[plain.length - 1]!.startsWith("╰"), "bingkai atas/bawah utuh");
	assert(plain.every((l) => visibleWidth(l) === 24), "semua baris selebar 24");
	assert(plain[1] === "│ halo                 │", "baris isi dipad rata");
	assert(renderBoxLines(th, 24, ["x".repeat(40)]).length === 4, "baris panjang di-wrap");
	assert(renderBoxLines(th, 20, ["hi"], "customMessageBg").length === 3, "bg diabaikan saat tema tanpa bg");
	console.log("lib/box.ts OK");
}
