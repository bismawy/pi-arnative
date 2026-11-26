import test from "node:test";
import { assert } from "../helpers/check.ts";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { ansiBgOpen } from "../../lib/ansi.ts";
import { repairBubbleBg, placeTimeAtRight, __test } from "../../lib/features/timestamps.ts";

const { tsState, USER_TIMESTAMPS_MAP, userTextOf, prefillUserTimestamps } = __test;

test("lib/features/timestamps.ts self-check", async () => {
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

	// bubble bg repair: padding after [0m] must be bg'd, line closed with [49m], and idempotent
	const dirty = `${bg}Hello\x1b[0m${" ".repeat(5)}\x1b[49m`;
	const clean = repairBubbleBg(dirty, bg);
	assert(clean.includes(`\x1b[0m${bg}`), "bg re-applied after the reset");
	assert(clean.endsWith("\x1b[49m"), "bubble bg closed at end of line");
	assert(repairBubbleBg(clean, bg) === clean, "repairBubbleBg is idempotent across repeated frames");
	assert(repairBubbleBg("plain", "") === "plain", "no bgOpen: unchanged");

	// memoized repair: a different bg code resets the cache, so nothing repairs
	// against a stale bubble background after a theme switch
	const dirty2 = `${bg}Second\x1b[0m pad \x1b[49m`;
	const otherBg = "\x1b[48;2;1;2;3m";
	assert(repairBubbleBg(dirty2, otherBg).includes(`\x1b[0m${otherBg}`), "a new bg code repairs against that bg");
	assert(repairBubbleBg(dirty2, bg).includes(`\x1b[0m${bg}`), "and back to the previous bg after another reset");
	assert(repairBubbleBg(dirty2, bg) === repairBubbleBg(dirty2, bg), "repeat repair stays stable");
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
	const reloaded = (await import(`${new URL("../../lib/features/timestamps.ts", import.meta.url).href}?reload=1`)) as typeof import("../../lib/features/timestamps.ts");
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
	assert(!USER_TIMESTAMPS_MAP.has("old question"), "session_start clears the map first (bounded growth, current session only)");
	assert(tsState.theme === theme, "reloaded module shares the theme read by the patched render");
});
