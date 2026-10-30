// Platform-aware single-letter shortcuts. Windows/WSL uses Alt+<char> to avoid AltGr
// aliasing; macOS displays Option; other platforms use Ctrl+Alt.
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { assert, isMain } from "./check.ts";

/** Windows Terminal's AltGr aliasing hits native Windows and WSL panes alike. */
export const IS_WINDOWS_LIKE =
	process.platform === "win32" ||
	(process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP));

type Shortcut = {
	/** Key ids for pi.registerShortcut; the last one is the platform-native key. */
	keys: string[];
	/** Cheatsheet label: `Alt+t` on Windows-like, `Ctrl+alt+t` elsewhere, `Ctrl+option+t` on macOS. */
	label: string;
	/** Matcher for editors that own their input loop (footer.ts). */
	matches: (data: string) => boolean;
};

// Built once, at module scope: `matches` runs on the per-keystroke input path.
function build(letter: string): Shortcut {
	const keys = IS_WINDOWS_LIKE ? [Key.ctrlAlt(letter), Key.alt(letter)] : [Key.ctrlAlt(letter)];
	const native = keys[keys.length - 1]!;
	const named = process.platform === "darwin" ? native.replace(/alt/g, "option") : native;
	return {
		keys,
		label: named.charAt(0).toUpperCase() + named.slice(1),
		matches: (data) => keys.some((key) => matchesKey(data, key)),
	};
}

export const SHORTCUT_NEXT_TAB = build("t");
export const SHORTCUT_NEW_SESSION = build("n");
export const SHORTCUT_RELOAD = build("r");
/** Expand/collapse the minimal footer. Ctrl+alt+m on macOS/Linux, alt+m on Windows/WSL
 *  (same platform split as the shortcuts above). */
export const SHORTCUT_TOGGLE_FOOTER = build("m");
/** Expand/collapse the task list widget. Same platform split: Alt+o on Windows/WSL. */
export const SHORTCUT_TOGGLE_TODOS = build("o");
/** Scroll the expanded task list: `j` down, `k` up, one task per press. */
export const SHORTCUT_SCROLL_TODOS_DOWN = build("j");
export const SHORTCUT_SCROLL_TODOS_UP = build("k");

/** The one "go back" key: `←` leaves a screen for its parent, while Esc closes or reverts
 *  it. Defined here so no screen can advertise a key another screen does not handle. */
export const BACK_KEY_LABEL = "←";
export function matchesBack(data: string): boolean {
	return matchesKey(data, "left");
}

/** A key a screen advertises: its label plus the matcher the handler acts on. A legend
 *  built from these cannot drift from the handler — the same `matches` decides both. */
export interface KeySet {
	label: string;
	matches: (data: string) => boolean;
}

const keySet = (label: string, ...keyIds: string[]): KeySet => ({
	label,
	matches: (data) => keyIds.some((keyId) => matchesKey(data, keyId)),
});

/** One label for the pair — the handler moves on either arrow. */
const MOVE = keySet("↑↓", "up", "down");
const CHOOSE = keySet("Enter", "enter");
const BACK = keySet(BACK_KEY_LABEL, "left");
const CANCEL = keySet("Esc", "escape");
const QUIT = keySet("q/Esc", "q", "escape");

const legend = (...pairs: [string, string][]): string => pairs.map(([key, action]) => `[${key}] ${action}`).join("  ");

/** Root `/arnative` menu: nothing behind it, so `←` is not advertised — Esc closes. */
export const LEGEND_ROOT = legend([MOVE.label, "Move"], [CHOOSE.label, "Open"], [CANCEL.label, "Close"]);
/** Move-and-open list inside a submenu (the provider list, the provider actions):
 *  `←` steps back to the screen above. */
export const LEGEND_MOVE = legend([MOVE.label, "Move"], [CHOOSE.label, "Open"], [BACK.label, "Back"], [CANCEL.label, "Close"]);
/** Live-preview list: moving applies, Enter keeps, `←` steps out, Esc reverts. */
export const LEGEND_LIVE = legend([MOVE.label, "Preview"], [CHOOSE.label, "Select"], [BACK.label, "Back"], [CANCEL.label, "Revert"]);
/** A list you only read (the `/todos` recap): moving changes nothing, so there is no Open. */
export const LEGEND_READ_ONLY = legend([MOVE.label, "Move"], [CANCEL.label, "Close"]);
/** The read-only usage dashboard. The full legend needs the room, so a narrow box degrades. */
export function legendUsage(width: number): string {
	const full = legend([MOVE.label, "Move"], ["Click", "Open/close"], [BACK.label, "Back"], [QUIT.label, "Exit"]);
	return width >= visibleWidth(full) ? full : legend([QUIT.label, "Exit"]);
}

if (isMain(import.meta.url)) {
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
	assert(LEGEND_MOVE === "[↑↓] Move  [Enter] Open  [←] Back  [Esc] Close", `root menu legend pinned, got ${LEGEND_MOVE}`);
	assert(LEGEND_MOVE.includes("[←] Back"), "the root menu advertises ← Back");
	assert(LEGEND_READ_ONLY === "[↑↓] Move  [Esc] Close", `read-only legend pinned, got ${LEGEND_READ_ONLY}`);
	assert(
		LEGEND_LIVE === `[↑↓] Preview  [Enter] Select  [${BACK_KEY_LABEL}] Back  [Esc] Revert`,
		`live legend pinned, got ${LEGEND_LIVE}`,
	);
	assert(MOVE.matches("\x1b[A") && MOVE.matches("\x1b[B"), "the ↑↓ key matches both arrows");
	assert(CHOOSE.matches("\r"), "[Enter] matches carriage return");
	assert(BACK.matches("\x1b[D"), "[←] in the legend is the same key matchesBack accepts");
	assert(CANCEL.matches("\x1b"), "[Esc] matches escape");
	assert(!CANCEL.matches("\x1b[D"), "[Esc] is not the back key");
	assert(legendUsage(120).includes(`[${BACK_KEY_LABEL}] Back`), "a wide usage legend advertises back");
	assert(legendUsage(120).includes("[Click] Open/close"), "a wide usage legend advertises the mouse");
	assert(legendUsage(20) === "[q/Esc] Exit", "a narrow usage legend degrades to the one key that still fits");
	console.log("shortcuts.ts self-check OK");
}
