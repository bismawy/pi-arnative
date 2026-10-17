/**
 * Arnative settings menu (/arnative <menu>): no argument opens the picker, each menu is a
 * subcommand with autocomplete. Themes/Headers/Footers preview live — a move applies the
 * value, Enter keeps it, Esc restores the one it opened with; Usage opens the dashboard.
 * Screens share one chrome and one title shape ({@link renderScreen}); a box border takes
 * the session's thinking slot (`lib/ansi.ts`), so it belongs to the active model.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type AutocompleteItem, type Component } from "@earendil-works/pi-tui";
import { softSecondaryOf, stripAnsi, thinkingColorOf } from "../lib/ansi.ts";
import { renderScreen, screenTitle, type ScreenText } from "../lib/box.ts";
import { assert, isMain } from "../lib/check.ts";
import { markedLabels } from "../lib/format.ts";
import { LEGEND_LIVE, LEGEND_MOVE, matchesBack } from "../lib/shortcuts.ts";
import { SPINNER_PRESETS, type SpinnerPreset } from "../lib/spinner.ts";
import {
	activeSpinnerGradient,
	animationsPickerText,
	activeSpinnerPreset,
	animationRowNote,
	animationRows,
	PREVIEW_TICK_MS,
	setSpinnerGradient,
	setSpinnerPreset,
} from "./animations.ts";
import { FOOTER_PRESETS, activeFooterPreset, setFooterPreset, type FooterPreset } from "./footer.ts";
import { HEADER_PRESETS, activeHeaderPreset, setHeaderPreset, type HeaderPreset } from "./section-headers.ts";
import { openUsage } from "./usage.ts";

export interface ArnativeMenu {
	value: string;
	label: string;
	description: string;
	/** Returns `true` when the screen asked to step back to the menu (`←`). */
	open: (ctx: ExtensionCommandContext) => Promise<boolean | void>;
}

/** One picker row: `Label · Note`. `note` is absent on the preset lists (themes, headers,
 *  footers), which are bare names. */
export interface ListRow {
	label: string;
	note?: string;
}

/** Divider between row label and note, padded to align across rows. */
export const ROW_DIVIDER = " · ";

/** Menu rows: `Label · description` (same rhythm as /jev-eye's menu). */
export function menuRows(menus: Pick<ArnativeMenu, "label" | "description">[]): ListRow[] {
	return menus.map((m) => ({ label: m.label, note: m.description }));
}

// Legends come from the `KeySet`s the handlers match, so a key cannot be advertised on a
// screen that does not handle it; the root menu has nothing behind it and omits `←`.
export const LIST_LEGEND_MOVE = LEGEND_MOVE;
export const LIST_LEGEND_LIVE = LEGEND_LIVE;

/** One row as a flat string — the headless/RPC `ctx.ui.select` fallback, which has no columns. */
export function rowText(row: ListRow): string {
	return row.note ? `${row.label} · ${row.note}` : row.label;
}

/** Bare names (preset lists) as rows; the cursor's `→` marks the live value. */
const nameRows = (names: readonly string[]): ListRow[] => names.map((label) => ({ label }));

/** Title of the settings menu, derived from `screenTitle` so the format lives in one place. */
export const MENU_TITLE = screenTitle("Settings");
/** One-line description under the menu title. */
export const MENU_DESC = "Themes, headers, footers, animations, usage";

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
	 *  Distinct from `cancel`/Esc, which closes or reverts the screen it is on. */
	back?: () => void;
	/** `g`: toggle a screen-level switch (Animations → gradient). Only a screen that passes
	 *  this hook reacts to the key, so `g` stays a plain letter everywhere else. */
	toggleGradient?: () => void;
	/** Note re-read on every render, so a row can animate (Animations → a moving frame). */
	note?: (label: string) => string | undefined;
	/** Repaint cadence for an animated note; the frame itself is read from the clock. */
	tickMs?: number;
	/** Note re-read on every render, so a row can animate (Animations → a moving frame).
	 *  Returning undefined keeps the row's static note. */
	note?: (label: string) => string | undefined;
	/** Repaint cadence for an animated note. The frame itself is read from the clock, so a
	 *  missed repaint costs one frame and never desynchronises the animation. */
	tickMs?: number;
	/** Legend re-read on every render, for a key row that states live state
	 *  (`[g] Gradient on`). A constant legend would keep advertising the value it opened with. */
	legend?: () => string;
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
		this.tick = hooks.tickMs ? setInterval(() => hooks.requestRender(), hooks.tickMs) : undefined;
	}

	invalidate(): void {}
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
			if (this.hooks.back) {
				this.hooks.back();
				return;
			}
			// No parent (the root menu): ← behaves like Esc — close, reverting a live preview.
			if (this.applied !== this.opened) this.hooks.revert();
			(this.hooks.cancel ?? this.hooks.done)();
			return;
		}
		if (matchesKey(keyData, "q") || matchesKey(keyData, "Q") || matchesKey(keyData, "escape")) {
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
		if (this.hooks.toggleGradient && matchesKey(keyData, "g")) this.hooks.toggleGradient();
	}

	render(width: number): string[] {
		const th = this.theme;
		const bold = th.bold ?? ((t: string) => `\x1b[1m${t}\x1b[22m`);
		const soft = softSecondaryOf(th);
		const edge = (text: string) => this.edge(text);
		const column = Math.max(0, ...this.rows.map((r) => visibleWidth(r.label)));
		const body: string[] = [];
		for (let i = 0; i < this.rows.length; i++) {
			const item = this.rows[i]!;
			const isSelected = i === this.selected;
			const paint = isSelected ? (s: string) => soft(bold(s)) : (s: string) => th.fg(item.note ? "text" : "muted", s);
			const pad = " ".repeat(Math.max(0, column - visibleWidth(item.label)));
			const noteText = this.hooks.note?.(item.label) ?? item.note;
			const note = noteText ? `${th.fg("dim", ROW_DIVIDER)}${th.fg("dim", noteText)}` : "";
			// Extract parenthetical suffix to render softly
			const suffix = /(\(.*\))$/.exec(item.label)?.[1] ?? "";
			const head = suffix ? item.label.slice(0, item.label.length - suffix.length) : item.label;
			const tail = suffix ? th.fg("dim", suffix) : "";
			const content = `${isSelected ? th.fg("accent", "→ ") : "  "}${paint(head)}${tail}${pad}${note}`;
			body.push(truncateToWidth(content, width - 4, ""));
		}
		return renderScreen(th, width, this.hooks.legend ? { ...this.text, legend: this.hooks.legend() } : this.text, body, edge);
	}
}

const THEMES_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Themes"),
	description: "Selection previews live — same list as /settings → Theme.",
	legend: LIST_LEGEND_LIVE,
};

const openThemes = async (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	const themes = ctx.ui.getAllThemes();
	if (themes.length === 0) {
		ctx.ui.notify("[arnative] No themes found. Add files to ~/.pi/agent/themes/ and run /reload.", "warning");
		return;
	}
	const names = themes.map((t) => t.name);
	const current = ctx.ui.theme.name;

	if (ctx.mode !== "tui") {
		// No custom components (RPC/headless): fall back to the blocking picker.
		const labels = markedLabels(names, current);
		const pick = await ctx.ui.select(THEMES_PICKER_TEXT.title, labels);
		if (pick === undefined) return;
		const result = ctx.ui.setTheme(names[labels.indexOf(pick)]!);
		ctx.ui.notify(
			result.success ? `[arnative] Theme: ${names[labels.indexOf(pick)]}` : `[arnative] ${result.error ?? "failed"}`,
			result.success ? "info" : "error",
		);
		return;
	}

	const goBack = await ctx.ui.custom<boolean>((tui, theme, _kb, done) =>
		new ListPicker(theme, nameRows(names), current, {
			preview: (name) => {
				const result = ctx.ui.setTheme(name);
				if (!result.success) ctx.ui.notify(`[arnative] ${result.error ?? `failed to apply ${name}`}`, "error");
			},
			revert: () => {
				if (current) ctx.ui.setTheme(current);
			},
			done: () => done(false),
			back: () => {
				// Back drops the live preview, then reports upward so the menu reopens.
				// Guarded like `revert`: `theme.name` is optional, and `setTheme(undefined)`
				// would reach pi's unguarded loader path.
				if (current && ctx.ui.theme.name !== current) ctx.ui.setTheme(current);
				done(true);
			},
			requestRender: () => tui.requestRender(),
		}, THEMES_PICKER_TEXT, true, ctx.thinkingLevel),
	);
	return goBack === true;
};

const FOOTERS_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Footers"),
	description: "Selection applies live — custom footer or built-in.",
	legend: LIST_LEGEND_LIVE,
};

const openFooters = async (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	const opened = activeFooterPreset();

	if (ctx.mode !== "tui") {
		// No custom components (RPC/headless): fall back to the blocking picker.
		const labels = markedLabels(FOOTER_PRESETS, opened);
		const pick = await ctx.ui.select(FOOTERS_PICKER_TEXT.title, labels);
		if (pick === undefined) return;
		const name = FOOTER_PRESETS[labels.indexOf(pick)]!;
		setFooterPreset(name, ctx);
		ctx.ui.notify(`[arnative] Footer: ${name}`, "info");
		return;
	}

	const goBack = await ctx.ui.custom<boolean>((tui, theme, _kb, done) =>
		new ListPicker(
			theme,
			nameRows(FOOTER_PRESETS),
			opened,
			{
				preview: (name) => setFooterPreset(name as FooterPreset, ctx),
				revert: () => setFooterPreset(opened, ctx),
				done: () => done(false),
				back: () => {
					// Back drops the live preview, then reports upward so the menu reopens.
					if (activeFooterPreset() !== opened) setFooterPreset(opened, ctx);
					done(true);
				},
				requestRender: () => tui.requestRender(),
			},
			FOOTERS_PICKER_TEXT,
			true,
			ctx.thinkingLevel,
		),
	);
	return goBack === true;
};

const HEADERS_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Headers"),
	description: "Selection applies live — custom header or built-in.",
	legend: LIST_LEGEND_LIVE,
};

const openHeaders = async (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	const opened = activeHeaderPreset();

	if (ctx.mode !== "tui") {
		// No custom components (RPC/headless): fall back to the blocking picker.
		const labels = markedLabels(HEADER_PRESETS, opened);
		const pick = await ctx.ui.select(HEADERS_PICKER_TEXT.title, labels);
		if (pick === undefined) return;
		const name = HEADER_PRESETS[labels.indexOf(pick)]!;
		setHeaderPreset(name, ctx);
		ctx.ui.notify(`[arnative] Header: ${name}`, "info");
		return;
	}

	const goBack = await ctx.ui.custom<boolean>((tui, theme, _kb, done) =>
		new ListPicker(
			theme,
			nameRows(HEADER_PRESETS),
			opened,
			{
				preview: (name) => setHeaderPreset(name as HeaderPreset, ctx),
				revert: () => setHeaderPreset(opened, ctx),
				done: () => done(false),
				back: () => {
					// Back drops the live preview, then reports upward so the menu reopens.
					if (activeHeaderPreset() !== opened) setHeaderPreset(opened, ctx);
					done(true);
				},
				requestRender: () => tui.requestRender(),
			},
			HEADERS_PICKER_TEXT,
			true,
			ctx.thinkingLevel,
		),
	);
	return goBack === true;
};

/** Animations picker. Unlike Themes/Headers/Footers the choice has a visible effect only
 *  while a tool runs, so there is nothing to preview live on the screen itself — the row
 *  previews the frames instead, and Enter installs the preset for the next run. */
const openAnimations = async (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	const opened = activeSpinnerPreset();
	// Each row spells its frames out (`Diamond Glow · diamond closing, 0.8s  ⬥ ◈ ◆ ◇`), so the
	// preview is what the user picks by; the rows come from animations.ts, one source.
	const rows: ListRow[] = animationRows();

	if (ctx.mode !== "tui") {
		// No custom components (RPC/headless): fall back to the blocking picker. The gradient
		// switch has no row here, so it is reported rather than silently unreachable.
		const labels = markedLabels(SPINNER_PRESETS, opened);
		const pick = await ctx.ui.select(animationsPickerText().title, labels);
		if (pick === undefined) return;
		setSpinnerPreset(SPINNER_PRESETS[labels.indexOf(pick)]!);
		ctx.ui.notify(`[arnative] Animation: ${SPINNER_PRESETS[labels.indexOf(pick)]}`, "info");
		return;
	}

	const goBack = await ctx.ui.custom<boolean>((tui, theme, _kb, done) =>
		new ListPicker(
			theme,
			rows,
			opened,
			{
				preview: (name) => setSpinnerPreset(name as SpinnerPreset),
				revert: () => setSpinnerPreset(opened),
				done: () => done(false),
				back: () => {
					// Back restores the preset it opened with, then reports upward.
					if (activeSpinnerPreset() !== opened) setSpinnerPreset(opened);
					done(true);
				},
				// `[g]` is a switch, not a preview: it is a command the user asked for and the legend
				// states its state, so Esc and `←` leave it on. Only the preset preview reverts.
				toggleGradient: () => {
					setSpinnerGradient(!activeSpinnerGradient());
					tui.requestRender();
				},
				legend: () => animationsPickerText().legend,
				// The row animates: its note is re-read each tick and the frame comes from the
				// clock, so the picker shows motion instead of a static glyph list.
				note: (label) => animationRowNote(label as SpinnerPreset),
				tickMs: PREVIEW_TICK_MS,
				requestRender: () => tui.requestRender(),
			},
			animationsPickerText(),
			true,
			ctx.thinkingLevel,
		),
	);
	return goBack === true;
};

export const MENUS: ArnativeMenu[] = [
	{
		value: "themes",
		label: "Themes",
		description: "list & apply themes (the /settings → Theme list)",
		open: openThemes,
	},
	{
		value: "headers",
		label: "Headers",
		description: "choose the header preset",
		open: openHeaders,
	},
	{
		value: "footers",
		label: "Footers",
		description: "choose the footer preset",
		open: openFooters,
	},
	{
		value: "animations",
		label: "Animations",
		description: "choose the working spinner",
		open: openAnimations,
	},
	{
		value: "usage",
		label: "Usage",
		description: "open the token & cost dashboard (same as /usage)",
		open: openUsage,
	},
];

/** The settings menu and the loop that gives `←` its meaning: a screen returning `true`
 *  reopens this menu, anything else ends navigation. `startLabel` is the row to open on,
 *  so a screen left with `←` (or a direct subcommand) resumes where the user was. */
async function openMainMenu(ctx: ExtensionCommandContext, startLabel?: string): Promise<void> {
	const rows = menuRows(MENUS);
	if (ctx.mode !== "tui") {
		// No custom components (RPC/headless): a title-only picker, no description row.
		const labels = rows.map(rowText);
		const pick = await ctx.ui.select(MENU_TITLE, labels);
		if (pick === undefined) return;
		await MENUS[labels.indexOf(pick)]!.open(ctx);
		return;
	}
	// Same picker as the submenus, so the description row under the title is rendered by
	// one component instead of two dialogs that could drift apart.
	let cursor = startLabel;
	for (;;) {
		const index = await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
			const picker = new ListPicker(theme, rows, cursor, {
				preview: () => {},
				revert: () => {},
				done: () => done(picker.index),
				cancel: () => done(null),
				requestRender: () => tui.requestRender(),
			}, { title: MENU_TITLE, description: MENU_DESC, legend: LIST_LEGEND_MOVE }, false, ctx.thinkingLevel);
			return picker;
		});
		if (index === null || index === undefined) return;
		cursor = rows[index]!.label;
		const wantsBack = await MENUS[index]!.open(ctx);
		if (wantsBack !== true) return;
	}
}

export async function arnativeHandler(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return;
	const sub = args.trim().toLowerCase();

	if (sub === "") {
		await openMainMenu(ctx);
		return;
	}

	const index = MENUS.findIndex((m) => m.value === sub);
	if (index === -1) {
		ctx.ui.notify(`[arnative] Unknown menu "${sub}". Menus: ${MENUS.map((m) => m.value).join(" | ")}`, "warning");
		return;
	}
	// A direct subcommand behaves like a menu row: `←` drops into the menu on that row,
	// so `/arnative usage` + `←` is not a dead key.
	if ((await MENUS[index]!.open(ctx)) === true) await openMainMenu(ctx, MENUS[index]!.label);
}

export function arnativeCompletions(prefix: string): AutocompleteItem[] | null {
	const items: AutocompleteItem[] = MENUS.filter((m) => m.value.startsWith(prefix.trim().toLowerCase())).map((m) => ({
		value: m.value,
		label: m.label,
		description: m.description,
	}));
	return items.length > 0 ? items : null;
}

/** The theme this package ships. Applied only when pi has no theme setting of its own, so a
 *  fresh install lands on Arnative without ever overriding a choice someone made. */
export const DEFAULT_THEME = "arnative";

/** Should the shipped theme be installed? Only when no theme is set at all (pi would fall back
 *  to `system`) and the theme actually loaded, which a headless or filtered load may not do. */
export function shouldApplyDefaultTheme(
	themeSetting: string | undefined,
	themes: readonly { name: string }[],
): boolean {
	return themeSetting === undefined && themes.some((t) => t.name === DEFAULT_THEME);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// `setTheme` writes the choice into pi's settings, so this runs once per install and the
		// second session already sees an explicit setting.
		if (!shouldApplyDefaultTheme(pi.getSettings()?.theme, ctx.ui.getAllThemes())) return;
		ctx.ui.setTheme(DEFAULT_THEME);
	});
	pi.registerCommand("arnative", {
		description: "Arnative settings menu: themes, headers, footers, usage",
		getArgumentCompletions: arnativeCompletions,
		handler: arnativeHandler,
	});
}

// Self-check: `node extensions/arnative.ts`
if (isMain(import.meta.url)) {
	assert(markedLabels(["a", "b"], "b")[1] === "● b", "markedLabels marks the active theme");
	assert(markedLabels(["a", "b"], "b")[0] === "  a", "markedLabels leaves others unmarked");
	assert(markedLabels(["a"], undefined)[0] === "  a", "markedLabels handles no active theme");
	const labels = menuRows(MENUS);
	assert(labels.length === MENUS.length, "menuRows one row per menu");
	assert(rowText(labels[0]!) === "Themes · list & apply themes (the /settings → Theme list)", "menu row text format");
	assert(labels[0]!.label === "Themes" && labels[0]!.note === "list & apply themes (the /settings → Theme list)", "menu row keeps label and note apart");
	assert(MENU_TITLE === "Settings - Arnative\u2819", `the menu title is the pinned string, got ${MENU_TITLE}`);
	assert(MENU_DESC === "Themes, headers, footers, animations, usage", `the menu description is the pinned string, got ${MENU_DESC}`);
	// Every menu row is reachable and the description names them all, so a new screen cannot
	// be added to MENUS and forgotten in the copy a user reads first.
	assert(MENUS.length === 5, "five settings screens");
	for (const label of ["Themes", "Headers", "Footers", "Animations", "Usage"]) {
		assert(MENUS.some((m) => m.label === label), `MENUS carries the ${label} screen`);
	}
	assert(/^Settings - Arnative/.test(MENU_TITLE), "title follows `<setting> - <extension>`");
	assert(MENU_TITLE.indexOf("\u2819") > 0 && !/\ufffd/.test(MENU_TITLE), "title carries the Braille glyph, not a blank/replacement cell");
	assert(MENUS.every((m) => typeof m.open === "function"), "every menu opens");
	assert(MENUS.some((m) => m.value === "headers"), "headers menu registered");

	assert(arnativeCompletions("th")!.length === 1, "completions match prefix");
	assert(arnativeCompletions("th")![0]!.value === "themes", "completions value = menu value");
	assert(arnativeCompletions("he")![0]!.value === "headers", "headers menu has completions");
	assert(arnativeCompletions("fo")![0]!.value === "footers", "footers menu has completions");
	assert(MENUS.some((m) => m.value === "footers"), "footers menu registered");
	// Usage is reachable from /arnative even though it is a dashboard, not a setting.
	assert(MENUS.some((m) => m.value === "usage"), "usage menu registered");
	assert(arnativeCompletions("us")![0]!.value === "usage", "usage menu has completions");
	assert(typeof MENUS.find((m) => m.value === "usage")!.open === "function", "the usage row opens the dashboard");

	// The shipped theme is applied only when pi has no theme setting of its own.
	assert(shouldApplyDefaultTheme(undefined, [{ name: "arnative" }]), "an unset theme installs Arnative");
	assert(!shouldApplyDefaultTheme("arnative", [{ name: "arnative" }]), "an explicit Arnative setting is left alone");
	assert(!shouldApplyDefaultTheme("gruvbox", [{ name: "arnative" }]), "a chosen theme is never overridden");
	assert(!shouldApplyDefaultTheme(undefined, [{ name: "dark" }]), "no install when the theme did not load");
	assert(arnativeCompletions("zz") === null, "completions null when nothing matches");

	// Live-preview picker (shared by Themes and Headers): move = preview, Enter = keep, Esc = revert.
	const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const pickerText: ListPickerText = { title: screenTitle("Themes"), description: "sub", legend: "[Esc] Revert" };
	const previews: string[] = [];
	let reverted = 0;
	let done = 0;
	const picker = new ListPicker(fakeTheme, nameRows(["arnative", "arnative-nord"]), "arnative", {
		preview: (n) => previews.push(n),
		revert: () => reverted++,
		done: () => done++,
		requestRender: () => {},
	}, pickerText);
	const lines = picker.render(50);
	assert(lines[0]!.startsWith("╭") && lines[lines.length - 1]!.startsWith("╰"), "picker framed");
	assert(lines.every((l) => visibleWidth(l) === 50), "picker lines fit width 50");
	assert(lines.some((l) => l.includes(screenTitle("Themes"))), "picker renders the configured title");
	assert(lines.some((l) => l.includes("→ arnative")), "the cursor marks the live value");
	assert(!lines.some((l) => l.includes("●")), "no redundant ● column next to the → cursor");
	picker.handleInput("\x1b[B"); // down
	assert(previews.length === 1 && previews[0] === "arnative-nord", "move previews immediately");
	assert(picker.render(50).some((l) => l.includes("→ arnative-nord")), "the cursor follows the preview");
	picker.handleInput("\r"); // enter
	assert(done === 1 && reverted === 0, "Enter keeps (no revert)");
	picker.handleInput("\x1b[B");
	picker.handleInput("\x1b"); // escape
	assert(reverted === 1 && done === 2, "Esc reverts after preview");

	// `←` reports upward instead of closing on a screen with a parent, reverting the live
	// preview first; the root menu has nothing behind it and omits the key.
	assert(LIST_LEGEND_MOVE === "[↑↓] Move  [Enter] Open  [Esc] Close", "menu legend pinned, and free of a dead back key");
	assert(!LIST_LEGEND_MOVE.includes("←"), "the root menu does not advertise ←");
	assert(LIST_LEGEND_LIVE === "[↑↓] Preview  [Enter] Select  [←] Back  [Esc] Revert", "live legend pinned");
	let backs = 0;
	let backReverts = 0;
	const childPicker = new ListPicker(fakeTheme, nameRows(["a", "b"]), "a", {
		preview: () => {},
		revert: () => backReverts++,
		done: () => {},
		back: () => backs++,
		requestRender: () => {},
	}, pickerText);
	childPicker.handleInput("\x1b[D"); // ←
	assert(backs === 1 && backReverts === 0, "← reports back to the parent and leaves the revert to it");
	// The root menu has no parent, so ← must still leave the screen — never a dead key.
	let rootCancels = 0;
	const rootPicker = new ListPicker(fakeTheme, nameRows(["a"]), undefined, {
		preview: () => {},
		revert: () => {},
		done: () => {},
		cancel: () => rootCancels++,
		requestRender: () => {},
	}, pickerText, false);
	rootPicker.handleInput("\x1b[D");
	assert(rootCancels === 1, "← closes the root menu, which has no parent");

	// The main menu reuses the picker with preview/revert as no-ops: moving changes no
	// setting, only Enter opens a row. `reverted` proves it.
	let menuReverts = 0;
	let menuCancelled = false;
	const mainPicker = new ListPicker(fakeTheme, labels, undefined, {
		preview: () => {},
		revert: () => { menuReverts++; },
		done: () => {},
		cancel: () => { menuCancelled = true; },
		requestRender: () => {},
	}, { title: MENU_TITLE, description: MENU_DESC, legend: LIST_LEGEND_MOVE }, false);
	const menuLines = mainPicker.render(60);
	assert(menuLines.some((l) => l.includes(MENU_TITLE)), "the main menu renders its title");
	assert(menuLines.some((l) => l.includes(MENU_DESC)), "the main menu renders the description under the title");
	assert(menuLines.findIndex((l) => l.includes(MENU_TITLE)) < menuLines.findIndex((l) => l.includes(MENU_DESC)), "description sits below the title");
	assert(menuLines.every((l) => visibleWidth(l) === 60), "main menu lines fit the width");
	// The pinned /arnative layout: `→ Themes  ·  note`, every `·` in one column (skill rule 10).
	const plainMenu = menuLines.map(stripAnsi);
	const row0 = menuLines.map(stripAnsi).find((l) => l.includes("→ Themes"))!;
	// The row is `│ → <label padded to the widest label><divider><note>`: assert the shape,
	// not a literal run of spaces, so adding a wider screen cannot break the layout test.
	const widest = Math.max(...MENUS.map((m) => m.label.length));
	assert(
		row0.startsWith(`│ → ${"Themes".padEnd(widest)}${ROW_DIVIDER}list & apply themes`),
		`menu row layout, got ${JSON.stringify(row0)}`,
	);
	assert(plainMenu.filter((l) => l.includes(ROW_DIVIDER)).every((l) => l.indexOf(ROW_DIVIDER) === row0.indexOf(ROW_DIVIDER)), "every divider sits in one column");
	assert(
		plainMenu.some((l) => l.startsWith(`│   ${"Headers".padEnd(widest)}${ROW_DIVIDER}`)),
		"unselected rows indent to the marker column",
	);

	// A menu opened with a `current` row starts there. The handler passes the row it last
	// used, so a submenu reopened by `←` lands back on that row instead of jumping to the
	// top of the list — the cursor is the user's place, not the component's business.
	const resumed = new ListPicker(fakeTheme, labels, "Usage", {
		preview: () => {},
		revert: () => {},
		done: () => {},
		requestRender: () => {},
	}, { title: MENU_TITLE, description: MENU_DESC, legend: LIST_LEGEND_MOVE }, false);
	const resumedRows = resumed.render(60).map(stripAnsi);
	assert(resumedRows.some((l) => l.startsWith("│ → Usage")), "the menu reopens on the row it was left on");
	assert(!resumedRows.some((l) => l.startsWith("│ → Themes")), "and not on the first row");

	// The box border follows the session's thinking level (theme `thinking*` slot), so the
	// menu reads as belonging to the active model.
	const tagged = { fg: (c: string, t: string) => `<${c}>${t}</>`, bold: (t: string) => `<bold>${t}</bold>` };
	const thinkingPicker = new ListPicker(tagged, labels, undefined, {
		preview: () => {},
		revert: () => {},
		done: () => {},
		requestRender: () => {},
	}, { title: MENU_TITLE, description: MENU_DESC, legend: "f" }, false, "high");
	const taggedLines = thinkingPicker.render(200);
	assert(taggedLines[0]!.includes("<thinkingHigh>"), "the menu border uses the session's thinking slot");
	assert(taggedLines[taggedLines.length - 1]!.includes("<thinkingHigh>"), "the bottom border uses the thinking slot too");
	assert(!taggedLines[0]!.includes("<accentSoft>"), "the border is not accentSoft any more");
	// Every frame part must use the same painter: mixing soft walls with thinking rails made
	// the frame two-toned (accentSoft `│` walls, thinking `╭─╮` rails).
	const walls = taggedLines.filter((l) => l.startsWith("<thinkingHigh>│"));
	assert(walls.length >= 5, `every wall is painted by the thinking painter, got ${walls.length}`);
	assert(
		!taggedLines.some((l) => l.startsWith("<accentSoft>│") || l.startsWith("<accentSoft>╭") || l.startsWith("<accentSoft>╰")),
		"no frame glyph is left on accentSoft",
	);
	// The chosen row's label takes the `accentSoft` token (bold), never a hand-written colour; the
	// `→` marker stays on `accent` so the cursor is still findable when the theme has no accentSoft.
	assert(
		taggedLines.some((l) => l.includes("<accent>→ </><accentSoft><bold>")),
		"the chosen label is the accentSoft token in bold",
	);
	assert(taggedLines.some((l) => l.includes("<accent>→ ")), "the → marker keeps the accent voice");
	const offPicker = new ListPicker(tagged, labels, undefined, {
		preview: () => {},
		revert: () => {},
		done: () => {},
		requestRender: () => {},
	}, { title: MENU_TITLE, description: MENU_DESC, legend: "f" }, false, undefined);
	assert(offPicker.render(200)[0]!.includes("<thinkingOff>"), "a missing level paints thinkingOff");
	mainPicker.handleInput("\x1b[B");
	assert(mainPicker.index === 1, "the selection is readable for the caller to open");
	mainPicker.handleInput("\x1b[B");
	assert(mainPicker.index === 2, "index tracks further moves");
	assert(menuReverts === 0, "moving never reverts: the menu changes no setting");
	// Esc closes the menu (cancel), it does not go through the keep path.
	mainPicker.handleInput("\x1b");
	assert(menuCancelled, "Esc cancels the main menu");
	assert(menuReverts === 0, "cancel does not revert either");

	// Headers reuses the same picker with its own copy and presets.
	assert(HEADER_PRESETS[0] === "Pi (system)", "built-in header preset is listed first");
	const headerPicker = new ListPicker(fakeTheme, nameRows(HEADER_PRESETS), "Arnative (Full)", { preview: () => {}, revert: () => {}, done: () => {}, requestRender: () => {} }, HEADERS_PICKER_TEXT);
	const headerLines = headerPicker.render(50);
	assert(headerLines.some((l) => l.includes(screenTitle("Headers"))), "headers picker title");
	assert(headerLines.some((l) => l.includes("→ Arnative (Full)")), "headers picker cursors the active preset");
	assert(headerLines.some((l) => l.includes("  Pi (system)")), "headers picker lists the built-in preset");

	// Footers reuses the same picker too.
	assert(FOOTER_PRESETS[0] === "Pi (system)", "built-in footer preset is listed first");
	const footerPicker = new ListPicker(fakeTheme, nameRows(FOOTER_PRESETS), "Pi (system)", { preview: () => {}, revert: () => {}, done: () => {}, requestRender: () => {} }, FOOTERS_PICKER_TEXT);
	const footerLines = footerPicker.render(50);
	assert(footerLines.some((l) => l.includes(screenTitle("Footers"))), "footers picker title");
	assert(footerLines.some((l) => l.includes("→ Pi (system)")), "footers picker cursors the active preset");
	assert(footerLines.some((l) => l.includes("Arnative (Minimal)")), "footers picker lists the minimal preset");
	assert(footerLines.filter((l) => l.includes("Arnative (")).length === 2, "both arnative footer presets are selectable");

	// Animations picker: "Pi (system)" carries a note AND renders "(system)" in dim
	const animPicker = new ListPicker(
		{ fg: (c, t) => `<${c}>${t}</${c}>`, bold: (t) => `<bold>${t}</bold>` },
		animationRows(),
		"Pi (system)",
		{ preview: () => {}, revert: () => {}, done: () => {}, requestRender: () => {} },
		animationsPickerText(),
	);
	const animLines = animPicker.render(120);
	assert(animLines.some((l) => l.includes("Pi ") && l.includes("<dim>(system)</dim>")), "animations picker dims (system)");

	// `g` reaches only a screen that passes the hook, and its legend follows the toggle.
	const quiet = (): void => undefined;
	let gradientOn = false;
	const gradientPicker = new ListPicker(
		fakeTheme,
		animationRows(),
		"Pi (system)",
		{
			preview: quiet,
			revert: quiet,
			done: quiet,
			requestRender: quiet,
			toggleGradient: () => {
				gradientOn = !gradientOn;
			},
			legend: () => `[g] Gradient ${gradientOn ? "on" : "off"}`,
		},
		animationsPickerText(),
	);
	gradientPicker.handleInput("g");
	assert(gradientOn, "g reaches the screen's own toggle");
	assert(gradientPicker.render(120).some((l) => l.includes("[g] Gradient on")), "the legend follows the toggle");
	assert(gradientPicker.index === 0, "g is not a row key: the cursor stays put");
	mainPicker.handleInput("g");
	assert(gradientOn, "a screen without the hook ignores g");

	console.log("arnative.ts self-check OK");
}
