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
import { ansiBgOpen, stripAnsi, themeOf } from "../ansi.ts";
import { markPatched, originalOf } from "../patch.ts";
import { getRuntime, type ChatTimestampState } from "../runtime.ts";

// Shared across reloads via RuntimeState so prototype patches and newly registered
// handlers read the same map and theme proxy.
const tsState: ChatTimestampState = (getRuntime().chatTimestampState ??= {
	map: new Map<string, number>(),
	theme: null,
});
const USER_TIMESTAMPS_MAP = tsState.map;

function userTextOf(message: { content?: unknown }): string {
	const c = message.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((x) => (x as { type?: string })?.type === "text")
			.map((x) => (x as { text?: string }).text ?? "")
			.join("");
	}
	return "";
}

// Restore/reload: history entries never fire message_start, so the map is prefilled
// once from the session branch before the first render lookup. Keyed by trimmed text
// (last write wins) — ponytail: duplicate texts share one clock, key by message id if
// pi ever exposes one at render time.
function prefillUserTimestamps(entries: readonly unknown[]): void {
	for (const e of entries) {
		const entry = e as { message?: { role?: string; content?: unknown; timestamp?: number }; timestamp?: string };
		const m = entry.message;
		if (m?.role !== "user") continue;
		const text = userTextOf(m).trim();
		if (text) USER_TIMESTAMPS_MAP.set(text, m.timestamp || Date.parse(entry.timestamp ?? "") || Date.now());
	}
}
function formatClock(timestamp?: number): string {
	const d = timestamp && timestamp > 0 ? new Date(timestamp) : new Date();
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}

function formatTimeBadge(timeStr: string, th: { fg(color: string, text: string): string } | null): string {
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
//
// The repair is pure per (line, bgOpen) pair, and pi's Markdown cache hands the render
// patch the SAME string references frame after frame — so a Map keyed by the source
// line turns every frame after the first into lookups instead of split/join rebuilds.
// Only the patched render closure calls this, so module-local state is correct even
// across /reload (the closure keeps this module instance alive). Reset when the bg
// code changes (theme switch); past the cap the whole map is dropped, because a
// session's user lines are far below it and correctness never depends on a hit.
const BUBBLE_BG_CACHE_MAX = 8192;
let bubbleBgOpen = "";
let bubbleBgCache = new Map<string, string>();

function insertBgAfterResets(line: string, bgOpen: string): string {
	let out = "";
	let i = 0;
	const n = line.length;
	while (i < n) {
		const c0 = line.indexOf("\x1b[0m", i);
		const c49 = line.indexOf("\x1b[49m", i);
		let pos = -1;
		let tokenLen = 0;
		if (c0 >= 0 && (c49 < 0 || c0 < c49)) {
			pos = c0;
			tokenLen = 4;
		} else if (c49 >= 0) {
			pos = c49;
			tokenLen = 5;
		}
		if (pos < 0) {
			out += line.slice(i);
			break;
		}
		const after = pos + tokenLen;
		out += line.slice(i, after);
		// Leave a trailing \x1b[49m alone (it closes the bubble bg), and avoid duplicating
		// bgOpen when a prior repair already placed it right after the reset.
		const isTrailingClose = tokenLen === 5 && after === n;
		if (!isTrailingClose && !line.startsWith(bgOpen, after)) {
			out += bgOpen;
		}
		i = after;
	}
	return out.endsWith(bgOpen) ? `${out}\x1b[49m` : out;
}

export function repairBubbleBg(line: string, bgOpen: string): string {
	if (!bgOpen || (!line.includes("\x1b[0m") && !line.includes("\x1b[49m"))) return line;
	if (bgOpen !== bubbleBgOpen) {
		bubbleBgOpen = bgOpen;
		bubbleBgCache = new Map();
	}
	const hit = bubbleBgCache.get(line);
	if (hit !== undefined) return hit;
	const result = insertBgAfterResets(line, bgOpen);
	if (bubbleBgCache.size >= BUBBLE_BG_CACHE_MAX) bubbleBgCache.clear();
	bubbleBgCache.set(line, result);
	return result;
}

function resolveUserTimestamp(comp: { text?: string; timestamp?: string | number }): number | undefined {
	if (typeof comp.timestamp === "number" && comp.timestamp > 0) return comp.timestamp;
	if (typeof comp.timestamp === "string" && comp.timestamp) {
		const parsed = Date.parse(comp.timestamp);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	const textKey = comp.text?.trim() ?? "";
	return USER_TIMESTAMPS_MAP.get(textKey);
}

type UserRenderCacheEntry = {
	source: readonly string[];
	width: number;
	bgOpen: string;
	badge: string;
	lines: string[];
};
type AssistantRenderCacheEntry = {
	source: readonly string[];
	width: number;
	badge: string;
	lines: string[];
};
const userRenderCache = new WeakMap<object, UserRenderCacheEntry>();
const assistantRenderCache = new WeakMap<object, AssistantRenderCacheEntry>();

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
	const reset = bgOpen ? "\x1b[49m" : "";
	return `${leftPart}${bgOpen}${pad}${timeBadge} ${reset}`;
}

// Both patches reinstall on every load (lib/patch.ts) so a `/reload` applies them.
// Pi 1.6.0+ Container/Message `render()` returns a shared cached `readonly string[]`, so
// both wrappers copy before modifying and cache their own output per source array identity.
if (UserMessageComponent?.prototype?.render || AssistantMessageComponent?.prototype?.render) {
	if (UserMessageComponent?.prototype?.render) {
		const proto = UserMessageComponent.prototype as any;
		const origRender = originalOf<(this: any, width: number) => readonly string[]>(proto, "render");
		proto.render = markPatched(function (this: any, width: number): readonly string[] {
			const source = origRender.call(this, width);
			if (source.length < 2) return source;

			const bgOpen = ansiBgOpen(tsState.theme, "userMessageBg");
			const ts = resolveUserTimestamp(this as { text?: string; timestamp?: string | number });
			const timeStr = ts ? formatClock(ts) : "";
			const badge = timeStr ? formatTimeBadge(timeStr, tsState.theme) : "";

			const prev = userRenderCache.get(this);
			if (prev && prev.source === source && prev.width === width && prev.bgOpen === bgOpen && prev.badge === badge) {
				return prev.lines;
			}

			// Fix the bubble bg first (reset Markdown lines make padding dark),
			// then paste the clock (which deliberately drops the bg in the badge area).
			const lines = [...source];
			for (let i = 0; i < lines.length; i++) lines[i] = repairBubbleBg(lines[i]!, bgOpen);

			// No known timestamp -> no clock (a "now" clock would be a lie on old messages).
			if (timeStr) {
				const timeW = visibleWidth(timeStr);
				// First text line sits at index 1 (below the box top padding)
				const contentLine = lines[1]!;
				const cleanContent = stripAnsi(contentLine).trimEnd();
				const contentW = visibleWidth(cleanContent);
				const minGap = 2;

				if (contentW + minGap + timeW <= width) {
					// Fits on the first text line: paste right-aligned with a 1-space margin
					lines[1] = placeTimeAtRight(contentLine, width, badge, timeW, bgOpen);
				} else {
					// First text line is full: NEVER truncate content!
					// Clock goes to the TOP padding line (always empty, first line of the bubble)
					const topLine = lines[0]!;
					const oscMatch = topLine.match(/^(\x1b\]133;[A-Z]\x07)+/);
					const prefix = oscMatch ? oscMatch[0] : "";
					const rest = topLine.slice(prefix.length);
					lines[0] = `${prefix}${placeTimeAtRight(rest, width, badge, timeW, bgOpen)}`;
				}
			}

			userRenderCache.set(this, { source, width, bgOpen, badge, lines });
			return lines;
		});
	}

	if (AssistantMessageComponent?.prototype?.render) {
		const proto = AssistantMessageComponent.prototype as any;
		const origRender = originalOf<(this: any, width: number) => readonly string[]>(proto, "render");
		proto.render = markPatched(function (this: any, width: number): readonly string[] {
			const source = origRender.call(this, width);
			const lastMsg = (this as { lastMessage?: AssistantMessage }).lastMessage;

			// Clock only on the final reply (a message with no toolCall)
			const hasToolCalls = lastMsg?.content?.some((c) => c.type === "toolCall");
			if (hasToolCalls) return source;

			// and only when there is real answer text (not thinking only)
			const hasText = lastMsg?.content?.some((c) => c.type === "text" && c.text.trim());
			if (!hasText || source.length === 0) return source;

			const timeStr = formatClock(lastMsg?.timestamp);
			const badge = formatTimeBadge(timeStr, tsState.theme);
			const prev = assistantRenderCache.get(this);
			if (prev && prev.source === source && prev.width === width && prev.badge === badge) {
				return prev.lines;
			}

			const timeW = visibleWidth(timeStr);

			// First text line that is neither an OSC zone nor a thinking header
			let targetIdx = -1;
			for (let i = 0; i < source.length; i++) {
				const plain = stripAnsi(source[i]!.replace(/^(\x1b\]133;[A-Z]\x07)+/, "")).trim();
				// Never paste onto the hidden thinking line: `Thinking...` while it streams, `Thought for 3s` once it ends (plain or with the \uec21 icon)
				if (plain.length > 0 && !/^(?:\uec21\s+)?(?:thinking|thought for)\b/i.test(plain)) {
					targetIdx = i;
					break;
				}
			}

			if (targetIdx !== -1) {
				let prefix = "";
				let rest = source[targetIdx]!;
				const oscMatch = rest.match(/^(\x1b\]133;[A-Z]\x07)+/);
				if (oscMatch) {
					prefix = oscMatch[0];
					rest = rest.slice(prefix.length);
				}

				const cleanText = stripAnsi(rest).trimEnd();
				const textW = visibleWidth(cleanText);
				const minGap = 2;

				if (textW + minGap + timeW <= width) {
					const lines = [...source];
					lines[targetIdx] = `${prefix}${placeTimeAtRight(rest, width, badge, timeW, "")}`;
					assistantRenderCache.set(this, { source, width, badge, lines });
					return lines;
				}
			}
			return source;
		});
	}
}

export default function (pi: ExtensionAPI) {
	// Record the user message timestamp (read by the UserMessageComponent render above)
	pi.on("message_start", async (event) => {
		if (event.message.role !== "user") return;
		const text = userTextOf(event.message).trim();
		if (text) {
			USER_TIMESTAMPS_MAP.set(text, event.message.timestamp || Date.now());
		}
	});

	// The map is cleared per session (it is refilled from the branch right below),
	// so it is bounded by the current session instead of growing for the process lifetime.
	USER_TIMESTAMPS_MAP.clear();
	// The active theme is re-read per session (ctx.ui.theme); render reads it lazily.
	// History for old user messages is read HERE, never at render time: the ctx is only
	// valid inside a handler. A ctx captured in the module throws after session
	// replacement/reload (pi's "stale after session replacement or reload" guard) and
	// that throw would land inside a render pass -> uncaughtException. The session
	// manager already holds the restored history when session_start fires (all reasons:
	// startup/resume/fork/new/reload).
	pi.on("session_start", async (_event, ctx) => {
		tsState.theme = themeOf<ThemeProxy>(ctx) ?? tsState.theme;
		prefillUserTimestamps(ctx.sessionManager.getBranch());
	});
}

export const __test = {
	tsState,
	USER_TIMESTAMPS_MAP,
	userTextOf,
	prefillUserTimestamps,
};
