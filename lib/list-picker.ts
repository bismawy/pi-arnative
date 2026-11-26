/**
 * The live-preview picker shared by every arnative screen (`/arnative` and friends):
 * ↑↓ previews instantly, Enter keeps, Esc reverts — plus a multi-select mode (`marked`
 * rows, Space toggles) for the Providers model list. Lives in its own module so screens
 * can import it without importing the settings menu back (no import cycle).
 */
import { Input, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { softOf, thinkingColorOf } from "./ansi.ts";
import { renderScreen, type ScreenText } from "./box.ts";
import { ROW_DIVIDER } from "./format.ts";
import { LEGEND_LIVE, LEGEND_MOVE, LEGEND_ROOT, matchesBack } from "./shortcuts.ts";

// Legends come from the `KeySet`s the handlers match, so a key cannot be advertised on a
// screen that does not handle it; the root menu has nothing behind it and omits `←`.
export const LIST_LEGEND_ROOT = LEGEND_ROOT;
export const LIST_LEGEND_MOVE = LEGEND_MOVE;
export const LIST_LEGEND_LIVE = LEGEND_LIVE;
/** A text field: Enter keeps the value, Esc leaves it untouched. */
export const INPUT_LEGEND = "[Enter] Save  [Esc] Back";

/** One picker row: `Label · Note`. `note` is absent on the preset lists (themes, headers,
 *  footers), which are bare names. */
export interface ListRow {
	label: string;
	note?: string;
	/** The saved value among the choices, marked with a green ✓ at the end of the row. */
	chosen?: boolean;
}

/** One row as a flat string — the headless/RPC `ctx.ui.select` fallback, which has no columns. */
export function rowText(row: ListRow): string {
	return row.note ? `${row.label} · ${row.note}` : row.label;
}

/** Bare names (preset lists) as rows; the cursor's `❯` marks the live value. */
export const nameRows = (names: readonly string[]): ListRow[] => names.map((label) => ({ label }));

interface ListPickerHooks {
	/** Apply a value on every selection move (live preview). */
	preview: (name: string) => void;
	/** Restore the value the picker opened with (Esc). */
	revert: () => void;
	done: () => void;
	requestRender: () => void;
	/** Esc, when it must be told apart from Enter (a menu selects, it does not revert). */
	cancel?: () => void;
	/** `←`: leave this screen for its parent (the menu, or the chat when there is none).
	 *  Distinct from `cancel`/Esc, which closes or reverts the screen it is on. Pass
	 *  `false` to hide the key entirely — a fill screen must not lose its work to a
	 *  stray `←`; Esc stays the only way out and the legend says so. */
	back?: (() => void) | false;
	/** `g`: toggle a screen-level switch (Animations → gradient). Only a screen that passes
	 *  this hook reacts to the key, so `g` stays a plain letter everywhere else. */
	toggleGradient?: () => void;
	/** Note re-read on every render, so a row can animate (Animations → a moving frame).
	 *  Returning undefined keeps the row's static note. */
	note?: (label: string) => string | undefined;
	/** Space: toggle the row under the cursor (a multi-select screen). Only a screen that
	 *  passes this hook reacts to Space, so every other screen keeps its meaning. */
	toggle?: () => void;
	/** Row check state for a multi-select screen; rows then render `[x]`/`[ ]` in front of
	 *  the label. A screen without this hook renders no checkbox column at all. */
	marked?: (label: string) => boolean;
	/** Every key the picker does not handle, forwarded to the screen (a letter switch like
	 *  `[a]` on the model list). The screen matches and acts; the picker only routes. */
	press?: (keyData: string) => void;
	/** Repaint cadence for an animated note. The frame itself is read from the clock, so a
	 *  missed repaint costs one frame and never desynchronises the animation. */
	tickMs?: number;
	/** Legend re-read on every render, for a key row that states live state
	 *  (`[g] Gradient on`). A constant legend would keep advertising the value it opened with. */
	legend?: () => string;
	/** Description re-read on every render, so the line under the title can follow screen
	 *  state (the model list shows the API flavor `a` switched to). */
	description?: () => string;
	/** Optional status block rendered above the row list (separated by a blank line). */
	summary?: (width: number) => string[];
	// What the rows are ("models"): shows a filter line under the description, the way
	// vision-watcher filters its model list. Slash focuses it, Enter keeps it, Esc clears it.
	search?: string;
}

/** Box copy, so one picker serves every menu ("Themes - Arnative⠙", "Headers - Arnative⠙", …).
 *  The same shape every arnative screen uses — see {@link renderScreen}. */
export type ListPickerText = ScreenText;

/** Live-preview picker: ↑↓ previews instantly, Enter keeps, Esc reverts. A caller whose
 *  preview does nothing (`livePreview: false`) gets a plain menu: no revert on Esc, and
 *  Esc is reported through `cancel` so "chose nothing" stays distinguishable from Enter. */
export class ListPicker implements Component {
	private theme: { fg(c: string, t: string): string; bold?(t: string): string };
	private rows: ListRow[];
	private hooks: ListPickerHooks;
	private text: ListPickerText;
	private selected: number;
	private applied: string | undefined;
	private readonly livePreview: boolean;
	private readonly opened: string | undefined;
	private readonly tick: ReturnType<typeof setInterval> | undefined;
	/** Border painter, from the session's thinking level — the box follows the model. */
	private readonly edge: (s: string) => string;
	/** Rows shown before the list scrolls (a relay catalog can be far longer than the screen). */
	private readonly maxRows: number | undefined;
	private readonly field: Input | undefined;
	private typing = false;
	private get placeholder(): string {
		return "Type to filter " + (this.hooks?.search ?? "") + "...";
	}

	constructor(
		theme: { fg(c: string, t: string): string; bold?(t: string): string },
		rows: ListRow[],
		current: string | undefined,
		hooks: ListPickerHooks,
		text: ListPickerText,
		/** False for a menu: the selection is applied only on Enter, never while moving. */
		livePreview = true,
		/** The session's thinking level; colors the box border (theme `thinking*` slot). */
		thinkingLevel?: string,
		/** Visible rows before scrolling; undefined shows every row. */
		maxRows?: number,
	) {
		this.theme = theme;
		this.rows = rows;
		this.hooks = hooks;
		this.text = text;
		this.livePreview = livePreview;
		this.opened = current;
		this.applied = current;
		this.selected = Math.max(0, rows.findIndex((r) => r.label === current));
		this.edge = thinkingColorOf(theme, thinkingLevel);
		this.maxRows = maxRows;
		// The live field: accent prompt and a cursor, shown only while typing (render draws the idle line).
		this.field = hooks.search ? new Input({ prompt: theme.fg("accent", "> "), placeholder: this.placeholder, placeholderStyle: (t) => theme.fg("muted", t) }) : undefined;
		this.tick = hooks.tickMs ? setInterval(() => hooks.requestRender(), hooks.tickMs) : undefined;
	}

	/** Component contract: renders are computed per call, so there is no cached output to drop. */
	invalidate(): void {
		/* intentionally no state */
	}
	dispose(): void {
		if (this.tick) clearInterval(this.tick);
	}

	/** Selected row, for callers that need the choice after `done()` resolves. */
	get index(): number {
		return this.shown[this.selected] ?? -1;
	}

	// Rows the search query matches, as indexes into rows. The match is fuzzy (the query's
	// characters in order, gaps allowed, spaces ignored), so "river flash" and "riverflash"
	// both find river/.../DeepSeek-V4.1-Flash.
	private get shown(): number[] {
		const q = this.query.toLowerCase().replace(/\s+/g, "");
		const fits = (label: string): boolean => {
			let at = 0;
			for (const ch of label.toLowerCase()) if (ch === q[at]) at++;
			return at === q.length;
		};
		return this.rows.flatMap((r, i) => (fits(r.label) ? [i] : []));
	}

	private get query(): string {
		return this.field?.getValue() ?? "";
	}

	private setQuery(query: string): void {
		this.field?.setValue(query);
		this.selected = 0;
		this.hooks.requestRender();
	}

	// True when the key belongs to the search field. Slash switches typing on and off. While
	// typing every key is text (Space and digits too) and the arrows edit the field, so
	// Enter, slash or Esc ends typing and keeps the filter; every command then acts on the
	// matching rows. Esc one more time is the screen's Back.
	private searchKey(keyData: string): boolean {
		const field = this.field;
		if (!field) return false;
		const setTyping = (on: boolean): true => {
			this.typing = on;
			field.focused = on;
			this.hooks.requestRender();
			return true;
		};
		if (!this.typing) return keyData === "/" && setTyping(true);
		if (keyData === "/" || matchesKey(keyData, "enter") || matchesKey(keyData, "escape")) return setTyping(false);
		if (matchesKey(keyData, "up") || matchesKey(keyData, "down")) return false;
		const before = this.query;
		field.handleInput(keyData);
		if (this.query !== before) this.selected = 0;
		this.hooks.requestRender();
		return true;
	}

	/** Esc/←: `back` owns an uncommitted preview's revert, so it is not duplicated here. */
	private leave(): void {
		if (this.hooks.back) {
			this.hooks.back();
			return;
		}
		if (this.applied !== this.opened) this.hooks.revert();
		(this.hooks.cancel ?? this.hooks.done)();
	}

	private move(delta: number): void {
		const shown = this.shown;
		if (shown.length === 0) return;
		// Wrap at both ends, matching the /jev-eye picker: the top row steps up to the
		// last row and the last row steps down to the top, so a held key never sticks.
		const next = (this.selected + delta + shown.length) % shown.length;
		if (next === this.selected) return;
		this.selected = next;
		if (!this.livePreview) {
			this.hooks.requestRender();
			return;
		}
		this.applied = this.rows[shown[next]!]!.label;
		this.hooks.preview(this.applied);
		this.hooks.requestRender();
	}

	handleInput(keyData: string): void {
		if (this.searchKey(keyData)) return;
		// Esc steps out one level: a screen with a parent reopens it, and the root closes.
		// ← is the same key for muscle memory, but a fill screen (`back: false`) hides it.
		if (matchesKey(keyData, "escape")) {
			this.leave();
			return;
		}
		if (matchesBack(keyData)) {
			if (this.hooks.back === false) return;
			this.leave();
			return;
		}
		if (keyData === "Q" || matchesKey(keyData, "q")) {
			if (this.applied !== this.opened) this.hooks.revert();
			(this.hooks.cancel ?? this.hooks.done)();
			return;
		}
		if (matchesKey(keyData, "up") || matchesKey(keyData, "k")) {
			this.move(-1);
			return;
		}
		if (matchesKey(keyData, "down") || matchesKey(keyData, "j")) {
			this.move(1);
			return;
		}
		if (matchesKey(keyData, "enter")) {
			this.hooks.done();
			return;
		}
		if (this.hooks.toggle && matchesKey(keyData, "space")) this.hooks.toggle();
		if (this.hooks.toggleGradient && matchesKey(keyData, "g")) this.hooks.toggleGradient();
		if (this.hooks.press) this.hooks.press(keyData);
	}

	render(width: number): string[] {
		const th = this.theme;
		const bold = th.bold ?? ((t: string) => `\x1b[1m${t}\x1b[22m`);
		const soft = softOf(th);
		const edge = (text: string) => this.edge(text);
		const column = Math.max(0, ...this.rows.map((r) => visibleWidth(r.label)));
		const body: string[] = [];
		// A long list scrolls a window centered on the cursor, so the box keeps one height.
		const shown = this.shown;
		const max = this.maxRows ?? shown.length;
		const windowStart = shown.length <= max ? 0 : Math.min(Math.max(0, this.selected - Math.floor(max / 2)), shown.length - max);
		const windowEnd = Math.min(shown.length, windowStart + max);
		for (let i = windowStart; i < windowEnd; i++) {
			const item = this.rows[shown[i]!]!;
			const isSelected = i === this.selected;
			const paint = isSelected ? (s: string) => soft(bold(s)) : (s: string) => th.fg("text", s);
			const pad = " ".repeat(Math.max(0, column - visibleWidth(item.label)));
			const noteText = this.hooks.note?.(item.label) ?? item.note;
			const note = noteText ? `${th.fg("dim", ROW_DIVIDER)}${th.fg("dim", noteText)}` : "";
			const chosen = item.chosen ? th.fg("success", " ✓") : "";
			// A checked state marker is chrome like the cursor: `[x]` accent, `[ ]` dim.
			const mark = this.hooks.marked
				? this.hooks.marked(item.label)
					? th.fg("accent", "[x] ")
					: th.fg("dim", "[ ] ")
				: "";
			// Extract parenthetical suffix to render softly
			const suffix = /(\(.*\))$/.exec(item.label)?.[1] ?? "";
			const head = suffix ? item.label.slice(0, item.label.length - suffix.length) : item.label;
			const tail = suffix ? th.fg("dim", suffix) : "";
			const content = `${isSelected ? th.fg("accent", "❯ ") : "  "}${mark}${paint(head)}${tail}${pad}${note}${chosen}`;
			body.push(truncateToWidth(content, width - 4, ""));
		}
		// Hidden rows are announced, never silently cut (an empty line is still a row).
		if (windowStart > 0) body.unshift(truncateToWidth(th.fg("dim", `↑ ${windowStart} more`), width - 4, ""));
		if (windowEnd < shown.length) body.push(truncateToWidth(th.fg("dim", `↓ ${shown.length - windowEnd} more`), width - 4, ""));
		if (this.field) {
			// Idle, pi-tui's Input would still paint its fake cursor, so the off state is drawn here:
			// a disabled prompt (the editor's idle border colour) over the kept query or the placeholder.
			const idle = th.fg("borderMuted", "> ") + (this.query ? th.fg("text", this.query) : th.fg("dim", this.placeholder));
			const line = this.typing ? this.field.render(Math.max(1, width - 4)) : [truncateToWidth(idle, width - 4, "")];
			body.unshift(...line, "");
		}
		const summary = this.hooks.summary?.(Math.max(1, width - 4));
		if (summary && summary.length > 0) body.unshift(...summary.map((line) => truncateToWidth(line, width - 4, "")), "");
		return renderScreen(
			th,
			width,
			{
				...this.text,
				legend: this.hooks.legend ? this.hooks.legend() : this.text.legend,
				description: this.hooks.description ? this.hooks.description() : this.text.description,
			},
			body,
			edge,
		);
	}
}

export interface InputPickerHooks {
	/** Enter: submit the field's value. */
	done: (value: string) => void;
	/** Esc or ctrl+c: leave without a value. */
	cancel: () => void;
	requestRender: () => void;
}

/** An arnative-styled text field: the pi-tui `Input` editor — arrows, word motions,
 *  paste, undo — inside the same rounded box every other arnative screen uses, so a
 *  wizard prompt does not drop the user into a foreign full-width dialog. */
export class InputPicker implements Component, Focusable {
	private readonly input: Input;
	private readonly theme: { fg(c: string, t: string): string; bold?(t: string): string };
	private readonly text: ScreenText;
	private readonly hooks: InputPickerHooks;
	/** Border painter, from the session's thinking level — the box follows the model. */
	private readonly edge: (s: string) => string;
	/** Set by the TUI; forwarded so the editor draws its cursor. */
	focused = false;

	constructor(
		theme: { fg(c: string, t: string): string; bold?(t: string): string },
		text: ScreenText,
		initial: string,
		hooks: InputPickerHooks,
		/** Dim example shown while the field is empty. */
		placeholder?: string,
		thinkingLevel?: string,
	) {
		this.theme = theme;
		this.text = text;
		this.hooks = hooks;
		this.edge = thinkingColorOf(theme, thinkingLevel);
		this.input = new Input({
			prompt: "> ",
			placeholder,
			placeholderStyle: (t: string) => theme.fg("dim", t),
		});
		this.input.setValue(initial);
	}

	/** The field's current text — what Enter would submit. */
	getValue(): string {
		return this.input.getValue();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter")) {
			this.hooks.done(this.input.getValue());
			return;
		}
		if (matchesKey(data, "escape") || data === "\x03") {
			this.hooks.cancel();
			return;
		}
		this.input.handleInput(data);
		this.hooks.requestRender();
	}

	render(width: number): string[] {
		this.input.focused = this.focused;
		const body = this.input.render(Math.max(8, width - 4));
		return renderScreen(this.theme, width, this.text, body, this.edge);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		/* the editor holds nothing that outlives the screen */
	}
}
