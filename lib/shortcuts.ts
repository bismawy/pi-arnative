// Platform-correct key ids for the package's single-letter shortcuts (t / n / r).
//
// Windows Terminal >= 1.24 aliases every Ctrl+Alt combo to AltGr (microsoft/terminal
// PR #20052), so the legacy "ESC + control byte" pair (ctrl+alt+r = \x1b\x12) that
// matchesKey() looks for is never emitted — the keystroke dies inside the terminal.
// A WSL pane inherits that same input translation, so it counts as Windows-like too,
// mirroring pi's own useWindowsKeybindings() (not exported from the package root).
// pi falls back to alt+<letter> for this class of problem (app.clipboard.pasteImage ->
// alt+v, app.model.cycleBackward -> alt+p) and every Windows terminal prefixes
// alt+<letter> with ESC (libuv win/tty.c), so do the same here. macOS keeps ctrl+alt
// only: plain Option there composes characters (Option+r = ®) unless "Use Option as
// Meta key" is enabled, while ctrl+alt transmits in every macOS terminal.
import { Key, matchesKey } from "@earendil-works/pi-tui";
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
	console.log("shortcuts.ts self-check OK");
}
