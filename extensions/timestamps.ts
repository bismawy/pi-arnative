/**
 * Chat transcript clock (time only, not a full timestamp):
 * - User: right-aligned in the last column, accent color, no background.
 *   Content is never truncated; if the first line is full the clock moves to the
 *   bubble's TOP padding line.
 * - Assistant: clock only on the final reply (a message with no toolCall), not on
 *   Thinking... or intermediate turns.
 *
 * Also patches the user bubble bg: Markdown text carries \x1b[0m mid-line, so
 * padding after the reset renders dark (a black block).
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { ansiBgOpen } from "../lib/ansi.ts";

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

// User bubble bg open code (no closing reset) -> lib/ansi.ts (single definition).

// Root cause of the "black block" in a full chat: Markdown text carries a mid-line
// \x1b[0m (full reset), so padding AFTER the reset loses the bubble bg and renders
// dark for the rest of the line. Re-apply the bubble bg after every reset and close
// it at end of line so it cannot leak. Same pattern as InputBgEditor below.
export function repairBubbleBg(line: string, bgOpen: string): string {
	if (!bgOpen) return line;
	const patched = line.split("\x1b[0m").join(`\x1b[0m${bgOpen}`).split("\x1b[49m").join(`\x1b[49m${bgOpen}`);
	return patched.endsWith(bgOpen) ? `${patched}\x1b[49m` : patched;
}

/**
 * Paste the clock at the right end of a line, 1 column from the right edge.
 * When `bgOpen` is given (e.g. user chat) the padding and the clock use that bubble
 * background, so there is no black block / clipped box.
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

			// Fix the bubble bg first (reset Markdown lines make padding dark),
			// then paste the clock (which deliberately drops the bg in the badge area).
			const bgOpen = ansiBgOpen(activeThemeProxy, "userMessageBg");
			for (let i = 0; i < lines.length; i++) lines[i] = repairBubbleBg(lines[i], bgOpen);

			const textKey = (this as { text?: string }).text?.trim() ?? "";
			const ts = (this as { _arnativeTimestamp?: number })._arnativeTimestamp ?? USER_TIMESTAMPS_MAP.get(textKey);
			const timeStr = formatClock(ts);
			const badge = formatTimeBadge(timeStr, activeThemeProxy);
			const timeW = visibleWidth(timeStr);

			// First text line sits at index 1 (below the box top padding)
			const contentLine = lines[1];
			const cleanContent = contentLine.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
			const contentW = visibleWidth(cleanContent);
			const minGap = 2;

			if (contentW + minGap + timeW <= width) {
				// Fits on the first text line: paste right-aligned with a 1-space margin
				lines[1] = placeTimeAtRight(contentLine, width, badge, timeW, bgOpen);
			} else {
				// First text line is full: NEVER truncate content!
				// Clock goes to the TOP padding line (always empty, first line of the bubble)
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

			// Clock only on the final reply (a message with no toolCall)
			const hasToolCalls = lastMsg?.content?.some((c) => c.type === "toolCall");
			if (hasToolCalls) return lines;

			// and only when there is real answer text (not thinking only)
			const hasText = lastMsg?.content?.some((c) => c.type === "text" && c.text.trim());
			if (!hasText || lines.length === 0) return lines;

			const timeStr = formatClock(lastMsg?.timestamp);
			const badge = formatTimeBadge(timeStr, activeThemeProxy);
			const timeW = visibleWidth(timeStr);

			// First text line that is neither an OSC zone nor a thinking header
			let targetIdx = -1;
			for (let i = 0; i < lines.length; i++) {
				const cleaned = lines[i].replace(/^(\x1b\]133;[A-Z]\x07)+/, "").trim();
				// Never paste onto the "Thinking..." line
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
	// Record the user message timestamp (read by the UserMessageComponent render above)
	pi.on("message_start", async (event) => {
		if (event.message.role !== "user") return;
		const text = typeof event.message.content === "string"
			? event.message.content
			: event.message.content?.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("") ?? "";
		if (text.trim()) {
			USER_TIMESTAMPS_MAP.set(text.trim(), event.message.timestamp || Date.now());
		}
	});

	// The active theme is re-read per session (ctx.ui.theme); render reads it lazily.
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

	// Clock flush right with a 1-space margin
	const res1 = placeTimeAtRight("Short text", 30, badge, badgeW, "");
	assert(visibleWidth(res1) === 30, "panjang baris pas selebar terminal");
	assert(res1.endsWith(badge + " "), "badge berjarak 1 spasi dari ujung kanan");

	// With the user bubble background
	const bg = "\x1b[48;2;52;53;61m";
	const res2 = placeTimeAtRight(`${bg}Short text`, 30, badge, badgeW, bg);
	assert(res2.includes(badge + " \x1b[49m"), "jam diikuti spasi margin lalu reset bg");
	assert(res2.endsWith("\x1b[49m"), "background ditutup di akhir baris");
	assert(visibleWidth(res2) === 30, "panjang baris tetap pas lebar");

	// bubble bg repair: padding after [0m] must be bg'd, line closed with [49m]
	const dirty = `${bg}Hello\x1b[0m${" ".repeat(5)}\x1b[49m`;
	const clean = repairBubbleBg(dirty, bg);
	assert(clean.includes(`\x1b[0m${bg}`), "bg dipasang ulang setelah reset");
	assert(clean.endsWith("\x1b[49m"), "bg bubble ditutup di akhir baris");
	assert(repairBubbleBg("plain", "") === "plain", "tanpa bgOpen: tanpa perubahan");
	assert(ansiBgOpen(null, "userMessageBg") === "", "tanpa tema: bgOpen kosong");
	assert(
		ansiBgOpen({ bg: (_c, t) => `\x1b[48;2;52;53;61m${t}\x1b[49m` }, "userMessageBg") === "\x1b[48;2;52;53;61m",
		"bgOpen terambil dari probe tema",
	);

	// Long text: sliceByColumn keeps the width intact
	const res3 = placeTimeAtRight("a".repeat(40), 30, badge, badgeW, false);
	assert(visibleWidth(res3) === 30, "teks panjang dipotong pas di targetCol");
	console.log("timestamps.ts self-check OK");
}
