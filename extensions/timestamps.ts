/**
 * Jam transkrip chat (jam, bukan timestamp penuh):
 * - User: jam rata kanan di kolom paling kanan, warna aksen, tanpa background.
 *   Konten tidak pernah dipotong; bila baris pertama penuh, jam turun ke baris
 *   padding ATAS bubble.
 * - Assistant: jam hanya pada respons akhir (pesan tanpa toolCall), bukan di
 *   Thinking... atau giliran perantara.
 *
 * Sekaligus menambal bg bubble user: teks Markdown membawa \x1b[0m di tengah
 * baris -> padding setelah reset tampil gelap (block hitam).
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

const USER_TIMESTAMPS_MAP = new Map<string, number>();
let activeThemeProxy: { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null = null;

function formatClock(timestamp?: number): string {
	const d = timestamp && timestamp > 0 ? new Date(timestamp) : new Date();
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}

export function formatTimeBadge(timeStr: string, th: { fg(color: string, text: string): string } | null): string {
	if (th) {
		try {
			return th.fg("accent", timeStr);
		} catch {
			// fallback
		}
	}
	return `\x1b[36m${timeStr}\x1b[39m`;
}

// Kode pembuka bg bubble user (tanpa reset penutup) - probe dari tema aktif.
export function bubbleBgOpen(th: { bg?(c: string, t: string): string } | null, color = "userMessageBg"): string {
	if (!th?.bg) return "";
	try {
		const probe = th.bg(color, "");
		const reset = "\x1b[49m";
		return probe.endsWith(reset) ? probe.slice(0, -reset.length) : probe;
	} catch {
		return "";
	}
}

// Akar "block hitam" saat chat penuh: teks Markdown membawa \x1b[0m (reset semua)
// di dalam baris -> spasi padding SETELAH reset kehilangan bg bubble dan tampil
// gelap selebar sisa baris. Pasang ulang bg bubble setelah tiap reset, tutup bg
// di akhir baris agar tidak bocor. Pola sama InputBgEditor di bawah.
export function repairBubbleBg(line: string, bgOpen: string): string {
	if (!bgOpen) return line;
	const patched = line.split("\x1b[0m").join(`\x1b[0m${bgOpen}`).split("\x1b[49m").join(`\x1b[49m${bgOpen}`);
	return patched.endsWith(bgOpen) ? `${patched}\x1b[49m` : patched;
}

/**
 * Tempel jam di ujung kanan sebuah baris dengan margin 1 kolom dari tepi kanan.
 * Jika `bgOpen` disediakan (misal untuk chat user), area padding dan jam
 * menggunakan background bubble tersebut sehingga tidak ada block hitam/kotak terpotong.
 */
export function placeTimeAtRight(
	line: string,
	width: number,
	timeBadge: string,
	timeW: number,
	bgOpen = "",
): string {
	const margin = 1;
	const targetCol = Math.max(0, width - timeW - margin);
	const leftPart = sliceByColumn(line, 0, targetCol, true);
	const leftW = visibleWidth(leftPart);
	const pad = " ".repeat(Math.max(0, targetCol - leftW));
	const bg = bgOpen ? bgOpen : "";
	const reset = bgOpen ? "\x1b[49m" : "";
	return `${leftPart}${bg}${pad}${timeBadge} ${reset}`;
}

const CHAT_TIMESTAMP_PATCHED = Symbol.for("pi-arnative.chatTimestampPatched");
if (!(globalThis as Record<symbol, boolean>)[CHAT_TIMESTAMP_PATCHED]) {
	(globalThis as Record<symbol, boolean>)[CHAT_TIMESTAMP_PATCHED] = true;

	if (UserMessageComponent?.prototype?.render) {
		const origRender = UserMessageComponent.prototype.render;
		UserMessageComponent.prototype.render = function (width: number): string[] {
			const lines = origRender.call(this, width);
			if (lines.length < 2) return lines;

			// Perbaiki bg bubble dulu (baris Markdown ber-reset bikin padding gelap),
			// baru tempel jam (yang sengaja membuang bg di area badge).
			const bgOpen = bubbleBgOpen(activeThemeProxy);
			for (let i = 0; i < lines.length; i++) lines[i] = repairBubbleBg(lines[i], bgOpen);

			const textKey = (this as { text?: string }).text?.trim() ?? "";
			const ts = (this as { _arnativeTimestamp?: number })._arnativeTimestamp ?? USER_TIMESTAMPS_MAP.get(textKey);
			const timeStr = formatClock(ts);
			const badge = formatTimeBadge(timeStr, activeThemeProxy);
			const timeW = visibleWidth(timeStr);

			// Baris teks pertama ada di index 1 (di bawah top-padding box)
			const contentLine = lines[1];
			const cleanContent = contentLine.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
			const contentW = visibleWidth(cleanContent);
			const minGap = 2;

			if (contentW + minGap + timeW <= width) {
				// Muat di baris teks pertama: tempel rata kanan persis dengan margin 1 spasi
				lines[1] = placeTimeAtRight(contentLine, width, badge, timeW, bgOpen);
			} else {
				// Baris teks pertama penuh: JANGAN potong konten!
				// Jam ke baris padding ATAS (selalu kosong, barisan pertama bubble)
				const topLine = lines[0];
				const oscMatch = topLine.match(/^(\x1b\]133;[A-Z]\x07)+/);
				const prefix = oscMatch ? oscMatch[0] : "";
				const rest = topLine.slice(prefix.length);
				lines[0] = `${prefix}${placeTimeAtRight(rest, width, badge, timeW, bgOpen)}`;
			}
			return lines;
		};
	}

	if (AssistantMessageComponent?.prototype?.render) {
		const origRender = AssistantMessageComponent.prototype.render;
		AssistantMessageComponent.prototype.render = function (width: number): string[] {
			const lines = origRender.call(this, width);
			const lastMsg = (this as { lastMessage?: AssistantMessage }).lastMessage;

			// Jam hanya ditampilkan di respons akhir (pesan yang tidak memiliki toolCall)
			const hasToolCalls = lastMsg?.content?.some((c) => c.type === "toolCall");
			if (hasToolCalls) return lines;

			// Dan hanya jika ada teks jawaban yang nyata (bukan hanya thinking)
			const hasText = lastMsg?.content?.some((c) => c.type === "text" && c.text.trim());
			if (!hasText || lines.length === 0) return lines;

			const timeStr = formatClock(lastMsg?.timestamp);
			const badge = formatTimeBadge(timeStr, activeThemeProxy);
			const timeW = visibleWidth(timeStr);

			// Cari baris teks pertama yang bukan zona OSC dan bukan header thinking
			let targetIdx = -1;
			for (let i = 0; i < lines.length; i++) {
				const cleaned = lines[i].replace(/^(\x1b\]133;[A-Z]\x07)+/, "").trim();
				// Jangan tempel di baris "Thinking..."
				if (cleaned.length > 0 && !/^thinking\b/i.test(cleaned)) {
					targetIdx = i;
					break;
				}
			}

			if (targetIdx !== -1) {
				let prefix = "";
				let rest = lines[targetIdx];
				const oscMatch = rest.match(/^(\x1b\]133;[A-Z]\x07)+/);
				if (oscMatch) {
					prefix = oscMatch[0];
					rest = rest.slice(prefix.length);
				}

				const cleanText = rest.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
				const textW = visibleWidth(cleanText);
				const minGap = 2;

				if (textW + minGap + timeW <= width) {
					lines[targetIdx] = `${prefix}${placeTimeAtRight(rest, width, badge, timeW, "")}`;
				}
			}
			return lines;
		};
	}
}

export default function (pi: ExtensionAPI) {
	// Catat timestamp pesan user (dibaca render UserMessageComponent di atas)
	pi.on("message_start", async (event) => {
		if (event.message.role !== "user") return;
		const text = typeof event.message.content === "string"
			? event.message.content
			: event.message.content?.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("") ?? "";
		if (text.trim()) {
			USER_TIMESTAMPS_MAP.set(text.trim(), event.message.timestamp || Date.now());
		}
	});

	// Tema aktif diambil ulang tiap sesi (ctx.ui.theme); render membacanya lazy.
	pi.on("session_start", async (_event, ctx) => {
		activeThemeProxy = ((ctx as unknown as { ui?: { theme?: typeof activeThemeProxy } }).ui?.theme) ?? activeThemeProxy;
	});
}

// Self-check: `node extensions/timestamps.ts`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"));
if (isMain) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};
	const badge = "\x1b[36m17:09\x1b[39m";
	const badgeW = 5;

	// Penempatan jam persis rata kanan dengan margin 1 spasi
	const res1 = placeTimeAtRight("Short text", 30, badge, badgeW, "");
	assert(visibleWidth(res1) === 30, "panjang baris pas selebar terminal");
	assert(res1.endsWith(badge + " "), "badge berjarak 1 spasi dari ujung kanan");

	// Dengan background bubble user
	const bg = "\x1b[48;2;52;53;61m";
	const res2 = placeTimeAtRight(`${bg}Short text`, 30, badge, badgeW, bg);
	assert(res2.includes(badge + " \x1b[49m"), "jam diikuti spasi margin lalu reset bg");
	assert(res2.endsWith("\x1b[49m"), "background ditutup di akhir baris");
	assert(visibleWidth(res2) === 30, "panjang baris tetap pas lebar");

	// repair bg bubble: spasi setelah [0m] wajib ber-bg, baris ditutup [49m]
	const dirty = `${bg}Hello\x1b[0m${" ".repeat(5)}\x1b[49m`;
	const clean = repairBubbleBg(dirty, bg);
	assert(clean.includes(`\x1b[0m${bg}`), "bg dipasang ulang setelah reset");
	assert(clean.endsWith("\x1b[49m"), "bg bubble ditutup di akhir baris");
	assert(repairBubbleBg("plain", "") === "plain", "tanpa bgOpen: tanpa perubahan");
	assert(bubbleBgOpen(null) === "", "tanpa tema: bgOpen kosong");
	assert(
		bubbleBgOpen({ bg: (_c, t) => `\x1b[48;2;52;53;61m${t}\x1b[49m` }) === "\x1b[48;2;52;53;61m",
		"bgOpen terambil dari probe tema",
	);

	// Teks panjang: sliceByColumn tidak merusak lebar
	const res3 = placeTimeAtRight("a".repeat(40), 30, badge, badgeW, false);
	assert(visibleWidth(res3) === 30, "teks panjang dipotong pas di targetCol");
	console.log("timestamps.ts self-check OK");
}
