import test from "node:test";
import { assert } from "../helpers/check.ts";
import { Key } from "@earendil-works/pi-tui";
import { IS_WINDOWS_LIKE, SHORTCUT_NEXT_TAB, SHORTCUT_RELOAD, SHORTCUT_TOGGLE_FOOTER, matchesBack, RESET_USAGE, UNDO_USAGE, LEGEND_MOVE, LEGEND_LIVE, LEGEND_READ_ONLY, legendUsage, __test } from "../../lib/shortcuts.ts";

const { MOVE, CHOOSE, BACK, CANCEL, legend } = __test;

test("lib/shortcuts.ts self-check", async () => {
	assert(SHORTCUT_RELOAD.keys[0] === Key.ctrlAlt("r"), "ctrl+alt+r is registered on every platform");
	assert(
		SHORTCUT_RELOAD.keys.includes(Key.alt("r")) === IS_WINDOWS_LIKE,
		"alt+r is registered only where Ctrl+Alt is aliased away",
	);
	assert(
		SHORTCUT_RELOAD.label.toLowerCase().replace(/option/, "alt") === SHORTCUT_RELOAD.keys[SHORTCUT_RELOAD.keys.length - 1],
		`label derives from the native key id (${SHORTCUT_RELOAD.label})`,
	);
	assert(SHORTCUT_RELOAD.matches("\x1b\x12"), "legacy ESC + 0x12 matches ctrl+alt+r");
	assert(SHORTCUT_RELOAD.matches("\x1b[114;7u"), "Kitty CSI-u matches ctrl+alt+r");
	assert(SHORTCUT_RELOAD.matches("\x1br") === IS_WINDOWS_LIKE, "ESC + r matches only where alt+r is registered");
	assert(
		SHORTCUT_RELOAD.matches("\x1b[114;3u") === IS_WINDOWS_LIKE,
		"Kitty CSI-u alt+r fires exactly where alt+r is registered",
	);
	assert(!SHORTCUT_RELOAD.matches("\x12"), "bare control char does not match ctrl+alt+r");
	assert(!SHORTCUT_RELOAD.matches("r"), "bare letter does not match ctrl+alt+r");
	assert(!SHORTCUT_NEXT_TAB.matches("\x1br"), "alt+r does not match the next-tab shortcut");
	assert(SHORTCUT_TOGGLE_FOOTER.keys[0] === Key.ctrlAlt("m"), "ctrl+alt+m is registered on every platform");
	assert(
		SHORTCUT_TOGGLE_FOOTER.keys.includes(Key.alt("m")) === IS_WINDOWS_LIKE,
		"alt+m is registered only where Ctrl+Alt is aliased away",
	);
	assert(!SHORTCUT_TOGGLE_FOOTER.matches("\x1b\x12"), "ctrl+alt+r does not match the footer toggle");
	assert(matchesBack("\x1b[D"), "← (CSI) matches the back key");
	assert(matchesBack("\x1bOD"), "← (SS3, application cursor mode) matches the back key");
	assert(!matchesBack("\x1b[C"), "→ is not the back key");
	assert(!matchesBack("\x1b"), "Esc is not the back key: Esc closes, ← steps back");
	assert(!matchesBack("h"), "a bare letter is not the back key");
	// The legends are built from the same keys the handlers match, so a key cannot be
	// advertised on one screen and handled on none.
	assert(LEGEND_MOVE === "[↑↓] Move  [Enter] Select  [Esc] Back", `submenu legend pinned, got ${LEGEND_MOVE}`);
	assert(LEGEND_READ_ONLY === "[↑↓] Move  [Esc] Close", `read-only legend pinned, got ${LEGEND_READ_ONLY}`);
	assert(
		LEGEND_LIVE === `[↑↓] Preview  [Enter] Select  [${CANCEL.label}] Back`,
		`live legend pinned, got ${LEGEND_LIVE}`,
	);
	assert(MOVE.matches("\x1b[A") && MOVE.matches("\x1b[B"), "the ↑↓ key matches both arrows");
	assert(CHOOSE.matches("\r"), "[Enter] matches carriage return");
	assert(BACK.matches("\x1b[D"), "← is still the back key, even when the footer names only Esc");
	assert(CANCEL.matches("\x1b"), "[Esc] matches escape");
	assert(!CANCEL.matches("\x1b[D"), "[Esc] is not the ← byte sequence");
	assert(legendUsage(120).includes("[Esc] Back"), "a wide usage legend advertises Esc Back");
	assert(legendUsage(140).includes("[Space/Click] Show/Hide"), "a wide usage legend advertises Space and the mouse");
	assert(legendUsage(120).includes("[v] View"), "a wide usage legend advertises the view key the dashboard handles");
	assert(legendUsage(120, { next: "Project" }).includes("[v] Next: Project"), "the legend names the view the key would show");
	assert(legendUsage(20) === "[Esc] Back", "a narrow usage legend degrades to the one key that still fits");
	assert(!legendUsage(20).includes("[v]"), "the narrow usage legend drops the view key with the rest");
	assert(legendUsage(160, { reset: true }).includes("[R] Reset"), "a reset-capable dashboard advertises R Reset");
	assert(!legendUsage(160).includes("Reset"), "the read-only dashboard does not advertise a key it lacks");
	assert(RESET_USAGE.matches("R") && !RESET_USAGE.matches("r"), "a capital R is shift+r, not r");
	assert(UNDO_USAGE.matches("U") && !UNDO_USAGE.matches("u"), "a capital U is shift+u, not u");
});
