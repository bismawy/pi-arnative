// Platform-aware single-letter shortcuts. Windows/WSL uses Alt+<char> to avoid AltGr
// aliasing; macOS displays Option; other platforms use Ctrl+Alt.
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

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
/** Open the /arnative settings menu. Alt+a on Windows/WSL, Ctrl+alt+a elsewhere. */
export const SHORTCUT_OPEN_ARNATIVE = build("a");
/** Scroll the expanded task list: `j` down, `k` up, one task per press. */
export const SHORTCUT_SCROLL_TODOS_DOWN = build("j");
export const SHORTCUT_SCROLL_TODOS_UP = build("k");

/** The `←` byte matcher. Esc is the advertised way out of a screen (Back, or Close at the
 *  root); `←` stays as an alias so muscle memory keeps working, but no footer names it. */
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
/** The usage dashboard window switch: Tab forward, Shift+Tab back. */
const RANGE = keySet("Tab", "tab");
/** Upper case on purpose: the lower case keys already navigate, so a plain r cannot
 *  start a destructive flow by accident. Both footers name the capital letter. */
export const RESET_USAGE = keySet("R", "shift+r");
/** The undo of a reset, offered only while a reset is the last thing that happened. */
export const UNDO_USAGE = keySet("U", "shift+u");

const legend = (...pairs: [string, string][]): string => pairs.map(([key, action]) => `[${key}] ${action}`).join("  ");

/** Root `/arnative` menu: nothing behind it, so Esc closes. */
export const LEGEND_ROOT = legend([MOVE.label, "Move"], [CHOOSE.label, "Select"], [CANCEL.label, "Close"]);
/** Move-and-open list inside a submenu (the provider list, the provider actions): Esc steps
 *  back to the screen above, exactly like ←. */
export const LEGEND_MOVE = legend([MOVE.label, "Move"], [CHOOSE.label, "Select"], [CANCEL.label, "Back"]);
/** Live-preview list: moving applies, Enter keeps, Esc drops the preview and steps out. */
export const LEGEND_LIVE = legend([MOVE.label, "Preview"], [CHOOSE.label, "Select"], [CANCEL.label, "Back"]);
/** A list you only read (the `/todos` recap): moving changes nothing, so there is no Open. */
export const LEGEND_READ_ONLY = legend([MOVE.label, "Move"], [CANCEL.label, "Close"]);
/** The usage dashboard. `reset` adds the key that deletes history, so a screen without
 *  that key never advertises it; `undo` appears only while a reset can be undone. `v` cycles
 *  the Provider → Project → Prices views, handled on every view; `next` names the view that
 *  key would show, so the legend states the destination instead of the generic word View. */
export function legendUsage(width: number, opts: { reset?: boolean; undo?: boolean; next?: string } = {}): string {
	const pairs: [string, string][] = [[MOVE.label, "Move"], [RANGE.label, "Range"], ["Space/Click", "Show/Hide"], ["v", opts.next ? `Next: ${opts.next}` : "View"]];
	if (opts.reset) pairs.push([CANCEL.label, "Back"], [RESET_USAGE.label, "Reset"]);
	if (opts.undo) pairs.push([UNDO_USAGE.label, "Undo"]);
	if (!opts.reset) pairs.push([CANCEL.label, "Back"]);
	const full = legend(...pairs);
	return width >= visibleWidth(full) ? full : legend([CANCEL.label, "Back"]);
}

export const __test = {
	MOVE,
	CHOOSE,
	BACK,
	CANCEL,
	legend,
};
