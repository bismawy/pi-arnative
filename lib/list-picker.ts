/**
 * The live-preview picker shared by every arnative screen (`/arnative` and friends):
 * ↑↓ previews instantly, Enter keeps, Esc reverts — plus a multi-select mode (`marked`
 * rows, Space toggles) for the Providers model list. Lives in its own module so screens
 * can import it without importing the settings menu back (no import cycle).
 */
import { Input, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { softSecondaryOf, thinkingColorOf } from "../lib/ansi.ts";
import { renderScreen, screenTitle, type ScreenText } from "../lib/box.ts";
import { assert, isMain } from "../lib/check.ts";
import { ROW_DIVIDER } from "../lib/format.ts";
import { LEGEND_LIVE, LEGEND_MOVE, LEGEND_ROOT, matchesBack } from "../lib/shortcuts.ts";

// Legends come from the `KeySet`s the handlers match, so a key cannot be advertised on a
// screen that does not handle it; the root menu has nothing behind it and omits `←`.
export const LIST_LEGEND_ROOT = LEGEND_ROOT;
export const LIST_LEGEND_MOVE = LEGEND_MOVE;
export const LIST_LEGEND_LIVE = LEGEND_LIVE;
/** A text field: Enter keeps the value, Esc leaves it untouched. */
export const INPUT_LEGEND = "[Enter] Save  [Esc] Cancel";

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

/** Bare names (preset lists) as rows; the cursor's `→` marks the live value. */
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
		return this.selected;
	}

	private move(delta: number): void {
		const next = Math.min(this.rows.length - 1, Math.max(0, this.selected + delta));
		if (next === this.selected) return;
		this.selected = next;
		if (!this.livePreview) {
			this.hooks.requestRender();
			return;
		}
		this.applied = this.rows[next]!.label;
		this.hooks.preview(this.applied);
		this.hooks.requestRender();
	}

	handleInput(keyData: string): void {
		if (matchesBack(keyData)) {
			// Leave for the parent without touching the preview: `back` owns the revert of an
			// uncommitted preview, because "cancel" here means "close", not "undo".
			if (this.hooks.back === false) return;
			if (this.hooks.back) {
				this.hooks.back();
				return;
			}
			// No parent (the root menu): ← behaves like Esc — close, reverting a live preview.
			if (this.applied !== this.opened) this.hooks.revert();
			(this.hooks.cancel ?? this.hooks.done)();
			return;
		}
		if (keyData === "Q" || matchesKey(keyData, "q") || matchesKey(keyData, "escape")) {
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
		const soft = softSecondaryOf(th);
		const edge = (text: string) => this.edge(text);
		const column = Math.max(0, ...this.rows.map((r) => visibleWidth(r.label)));
		const body: string[] = [];
		// A long list scrolls a window centered on the cursor, so the box keeps one height.
		const max = this.maxRows ?? this.rows.length;
		const windowStart = this.rows.length <= max ? 0 : Math.min(Math.max(0, this.selected - Math.floor(max / 2)), this.rows.length - max);
		const windowEnd = Math.min(this.rows.length, windowStart + max);
		for (let i = windowStart; i < windowEnd; i++) {
			const item = this.rows[i]!;
			const isSelected = i === this.selected;
			const paint = isSelected ? (s: string) => soft(bold(s)) : (s: string) => th.fg(item.note ? "text" : "muted", s);
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
			const content = `${isSelected ? th.fg("accent", "→ ") : "  "}${mark}${paint(head)}${tail}${pad}${note}${chosen}`;
			body.push(truncateToWidth(content, width - 4, ""));
		}
		// Hidden rows are announced, never silently cut (an empty line is still a row).
		if (windowStart > 0) body.unshift(truncateToWidth(th.fg("dim", `↑ ${windowStart} more`), width - 4, ""));
		if (windowEnd < this.rows.length) body.push(truncateToWidth(th.fg("dim", `↓ ${this.rows.length - windowEnd} more`), width - 4, ""));
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

// Self-check: `node lib/list-picker.ts`
if (isMain(import.meta.url)) {
	assert(LIST_LEGEND_ROOT === "[↑↓] Move  [Enter] Open  [Esc] Close", "root legend pinned, no ← behind the root menu");
	assert(LIST_LEGEND_MOVE === "[↑↓] Move  [Enter] Open  [←] Back  [Esc] Close", "move legend pinned, ← advertised where a back target exists");
	assert(LIST_LEGEND_LIVE === "[↑↓] Preview  [Enter] Select  [←] Back  [Esc] Revert", "live legend pinned");
	const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const quiet = (): void => undefined;
	const picker = new ListPicker(fakeTheme, nameRows(["a", "b"]), "a", { preview: quiet, revert: quiet, done: quiet, requestRender: quiet }, { title: screenTitle("Test"), description: "d", legend: "l" }, false);
	const lines = picker.render(50);
	assert(lines[0]!.startsWith("╭") && lines[lines.length - 1]!.startsWith("╰"), "picker framed");
	assert(lines.every((l) => visibleWidth(l) === 50), "picker lines fit width 50");
	assert(lines.some((l) => l.includes("→ a")), "the cursor marks the selection");

	// The chosen marker: ✓ ends the saved row only, colored by the theme's success slot.
	const chosenPicker = new ListPicker(
		fakeTheme,
		[{ label: "a" }, { label: "b", note: "nb", chosen: true }],
		"b",
		{ preview: quiet, revert: quiet, done: quiet, requestRender: quiet },
		{ title: screenTitle("Test"), description: "d", legend: "l" },
		false,
	);
	const chosenLines = chosenPicker.render(50);
	assert(chosenLines.some((l) => l.includes("nb ✓")), "a chosen row ends with the ✓ marker");
	assert(chosenLines.every((l) => !l.includes("a ✓")), "unchosen rows carry no marker");

	// `←` behavior is owned by the screen: a parent gets the back call, `false` swallows
	// the key (a fill screen keeps its work), and a root menu closes like Esc.
	const keyLeft = "\x1b[D";
	let backCalls = 0;
	let closedByBack = false;
	const backPicker = new ListPicker(fakeTheme, nameRows(["a"]), "a", { preview: quiet, revert: quiet, done: quiet, cancel: quiet, requestRender: quiet, back: () => { backCalls++; } }, { title: screenTitle("Test"), description: "d", legend: "l" }, false);
	backPicker.handleInput(keyLeft);
	assert(backCalls === 1 && closedByBack === false, "a parent screen receives ← as back");
	let closed = "none";
	const noBackPicker = new ListPicker(fakeTheme, nameRows(["a"]), "a", { preview: quiet, revert: quiet, done: () => { closed = "done"; }, cancel: () => { closed = "cancel"; }, requestRender: quiet }, { title: screenTitle("Test"), description: "d", legend: "l" }, false);
	noBackPicker.handleInput(keyLeft);
	assert(closed === "cancel", "a root menu closes on ← like Esc");
	let fillClosed = "none";
	const fillPicker = new ListPicker(fakeTheme, nameRows(["a"]), "a", { preview: quiet, revert: quiet, done: () => { fillClosed = "done"; }, cancel: () => { fillClosed = "cancel"; }, requestRender: quiet, back: false }, { title: screenTitle("Test"), description: "d", legend: "l" }, false);
	fillPicker.handleInput(keyLeft);
	fillPicker.handleInput("\x1bOD");
	assert(fillClosed === "none", "a fill screen swallows ← entirely");

	// A long list scrolls: 10 rows visible, the cursor always inside the window, and one
	// frame height whether the cursor sits at the top or the bottom.
	const many = nameRows(Array.from({ length: 25 }, (_, i) => `m${i}`));
	const scrolled = new ListPicker(fakeTheme, many, "m0", { preview: quiet, revert: quiet, done: quiet, requestRender: quiet }, { title: screenTitle("Test"), description: "d", legend: "l" }, false, undefined, 10);
	const countItems = (ls: string[]): number => ls.filter((l) => /m\d/.test(l)).length;
	let frame = scrolled.render(50);
	assert(countItems(frame) === 10, "a scrolled list shows exactly 10 model rows");
	assert(frame.some((l) => l.includes("↓ 15 more")) && !frame.some((l) => l.includes("↑")), "the top of the list announces only what is below");
	for (let i = 0; i < 14; i++) scrolled.handleInput("\x1b[B");
	frame = scrolled.render(50);
	assert(countItems(frame) === 10, "still 10 rows after scrolling");
	assert(frame.some((l) => l.includes("↑ 9 more")) && frame.some((l) => l.includes("↓ 6 more")), "both ends announce their hidden rows");
	assert(frame.some((l) => l.includes("→ m14")), "the cursor row stays visible");
	scrolled.handleInput("\x1b[B");
	const frameNext = scrolled.render(50);
	assert(frameNext.length === frame.length && countItems(frameNext) === 10, "the frame height stays constant while scrolling inside the list");
	for (let i = 0; i < 20; i++) scrolled.handleInput("\x1b[B");
	frame = scrolled.render(50);
	assert(frame.some((l) => l.includes("→ m24")) && frame.some((l) => l.includes("↑ 15 more")) && !frame.some((l) => l.includes("↓")), "the bottom of the list announces only what is above");
	const short = new ListPicker(fakeTheme, nameRows(["a", "b"]), "a", { preview: quiet, revert: quiet, done: quiet, requestRender: quiet }, { title: screenTitle("Test"), description: "d", legend: "l" }, false, undefined, 10);
	assert(!short.render(50).some((l) => l.includes("more")), "a short list shows no scroll indicators");

	// The text field: the pi-tui editor drives, the arnative box frames it.
	let submitted: string | null | undefined;
	let inputCancelled = false;
	const field = new InputPicker(fakeTheme, { title: screenTitle("Provider"), description: "Endpoint API — the base URL", legend: INPUT_LEGEND }, "", {
		done: (v) => { submitted = v; },
		cancel: () => { inputCancelled = true; },
		requestRender: quiet,
	}, "https://api.example.com/v1");
	field.focused = true;
	const fieldLines = field.render(60);
	// CSI and every APC wrapper (`\x1b_…\x07`): pi-tui 0.87 emitted only `_pi:c`, 1.4 adds
	// `_pi:fc`/`_pi:/fc` around the placeholder — a narrow strip left escapes glued to the
	// text and failed the include on CI's newer version.
	const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b_.*?\x07/g, "");
	assert(fieldLines[0]!.startsWith("╭") && fieldLines[1]!.includes("Provider - Arnative"), "the input renders in the arnative box");
	assert(fieldLines.some((l) => plain(l).includes("> https://api.example.com/v1")), "an empty field shows its dim placeholder");
	assert(fieldLines.some((l) => l.includes(INPUT_LEGEND)), "the input legend is pinned");
	for (const ch of "https://x.io") field.handleInput(ch);
	field.handleInput("\x1b[D");
	field.handleInput("io");
	assert(field.getValue() === "https://x.iioo", "typing with a moved cursor edits at the cursor");
	field.handleInput("\r");
	assert(submitted === "https://x.iioo", "Enter submits the value");
	assert(!inputCancelled, "Enter is not a cancel");
	field.handleInput("\x1b");
	assert(inputCancelled, "Esc cancels the field");
	console.log("list-picker.ts self-check OK");
}
