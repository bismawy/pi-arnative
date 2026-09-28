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
import { ansiBgOpen, stripAnsi, themeOf } from "../lib/ansi.ts";
import { assert, isMain } from "../lib/check.ts";

// Shared across reloads: /reload re-imports this module (moduleCache: false), but the
// prototype patches below survive on the class, so the patched closure and the newly
// registered handlers must read the SAME map and theme. Module-local state would leave
// the closure on stale data — and a captured ctx even on an invalidated one (pi throws
// "stale after session replacement or reload" inside the render pass -> uncaughtException).
type ThemeProxy = { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null;
const TS_STATE_KEY = Symbol.for("pi-arnative.chatTimestampState");
const tsState = ((globalThis as Record<symbol, unknown>)[TS_STATE_KEY] ??= {
	patched: false,
	map: new Map<string, number>(),
	theme: null as ThemeProxy,
}) as { patched: boolean; map: Map<string, number>; theme: ThemeProxy };
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

if (!tsState.patched) {
	tsState.patched = true;

	if (UserMessageComponent?.prototype?.render) {
		const origRender = UserMessageComponent.prototype.render;
		UserMessageComponent.prototype.render = function (width: number): string[] {
			const lines = origRender.call(this, width);
			if (lines.length < 2) return lines;

			// Fix the bubble bg first (reset Markdown lines make padding dark),
			// then paste the clock (which deliberately drops the bg in the badge area).
			const bgOpen = ansiBgOpen(tsState.theme, "userMessageBg");
			for (let i = 0; i < lines.length; i++) lines[i] = repairBubbleBg(lines[i], bgOpen);

			const textKey = (this as { text?: string }).text?.trim() ?? "";
			const ts = USER_TIMESTAMPS_MAP.get(textKey);
			// No known timestamp -> no clock (a "now" clock would be a lie on old messages).
			if (!ts) return lines;
			const timeStr = formatClock(ts);
			const badge = formatTimeBadge(timeStr, tsState.theme);
			const timeW = visibleWidth(timeStr);

			// First text line sits at index 1 (below the box top padding)
			const contentLine = lines[1];
			const cleanContent = stripAnsi(contentLine).trimEnd();
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
			const badge = formatTimeBadge(timeStr, tsState.theme);
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

				const cleanText = stripAnsi(rest).trimEnd();
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
		const text = userTextOf(event.message).trim();
		if (text) {
			USER_TIMESTAMPS_MAP.set(text, event.message.timestamp || Date.now());
		}
	});

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

// Self-check: `node extensions/timestamps.ts`
if (isMain(import.meta.url)) {
	const badge = "\x1b[36m17:09\x1b[39m";
	const badgeW = 5;

	// Clock flush right with a 1-space margin
	const res1 = placeTimeAtRight("Short text", 30, badge, badgeW, "");
	assert(visibleWidth(res1) === 30, "line length matches the terminal width");
	assert(res1.endsWith(badge + " "), "badge sits 1 space from the right edge");

	// With the user bubble background
	const bg = "\x1b[48;2;52;53;61m";
	const res2 = placeTimeAtRight(`${bg}Short text`, 30, badge, badgeW, bg);
	assert(res2.includes(badge + " \x1b[49m"), "hours, margin space, then bg reset");
	assert(res2.endsWith("\x1b[49m"), "background closed at end of line");
	assert(visibleWidth(res2) === 30, "line length still matches the width");

	// bubble bg repair: padding after [0m] must be bg'd, line closed with [49m]
	const dirty = `${bg}Hello\x1b[0m${" ".repeat(5)}\x1b[49m`;
	const clean = repairBubbleBg(dirty, bg);
	assert(clean.includes(`\x1b[0m${bg}`), "bg re-applied after the reset");
	assert(clean.endsWith("\x1b[49m"), "bubble bg closed at end of line");
	assert(repairBubbleBg("plain", "") === "plain", "no bgOpen: unchanged");
	assert(ansiBgOpen(null, "userMessageBg") === "", "no theme: empty bgOpen");
	assert(
		ansiBgOpen({ bg: (_c, t) => `\x1b[48;2;52;53;61m${t}\x1b[49m` }, "userMessageBg") === "\x1b[48;2;52;53;61m",
		"bgOpen taken from the theme probe",
	);

	// Long text: sliceByColumn keeps the width intact (bg branch: badge area carries the bubble bg)
	const bgOpenTest = "\x1b[48;2;52;53;61m";
	const res3 = placeTimeAtRight("a".repeat(40), 30, badge, badgeW, bgOpenTest);
	assert(visibleWidth(res3) === 30, "long text sliced exactly at targetCol");
	assert(res3.includes(bgOpenTest), "bg branch: bubble bg applied in the badge area");

	// History prefill: old user messages get their real clock on restore
	assert(userTextOf({ content: "plain" }) === "plain", "userTextOf string content");
	assert(userTextOf({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }) === "ab", "userTextOf text parts joined");
	prefillUserTimestamps([
		{ type: "message", timestamp: "2026-01-02T03:04:05.000Z", message: { role: "user", content: "old question", timestamp: 1000 } },
		{ type: "message", timestamp: "not-a-date", message: { role: "user", content: [{ type: "text", text: "old reply" }] } },
	]);
	assert(USER_TIMESTAMPS_MAP.get("old question") === 1000, "prefill stores the message timestamp");
	assert((USER_TIMESTAMPS_MAP.get("old reply") ?? 0) > 0, "prefill falls back to the entry timestamp");

	// Reload invariant: /reload re-imports the module while the prototype patch below keeps
	// running, so the fresh handlers MUST write into the same map/theme the patched render reads.
	const reloaded = (await import(`${import.meta.url}?reload=1`)) as typeof import("./timestamps.ts");
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const theme = { fg: (_c: string, t: string) => t };
	reloaded.default({ on: (ev: string, h: never) => void (handlers[ev] = h) } as never);
	await handlers.session_start(
		{},
		{
			sessionManager: {
				getBranch: () => [{ timestamp: "", message: { role: "user", content: "after reload", timestamp: 4242 } }],
			},
			ui: { theme },
		},
	);
	assert(USER_TIMESTAMPS_MAP.get("after reload") === 4242, "reloaded module prefills the shared map read by the patched render");
	assert(tsState.theme === theme, "reloaded module shares the theme read by the patched render");
	console.log("timestamps.ts self-check OK");
}
