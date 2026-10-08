/**
 * Arnative settings menu (/arnative <menu>) — same shape as /jev-eye:
 * no argument opens the menu picker, each menu is a subcommand with autocomplete.
 * First menu: themes — the theme list from /settings with live preview: moving the
 * selection calls ctx.ui.setTheme() immediately (applies + persists like the
 * /settings picker), Enter keeps it, Esc restores the theme opened with.
 * `headers` uses the same picker over the header presets, swapping
 * the header on every move (ctx.ui.setHeader()) and restoring it on Esc.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type AutocompleteItem, type Component } from "@earendil-works/pi-tui";
import { accentSoftOf } from "../lib/ansi.ts";
import { boxEdge, boxRow } from "../lib/box.ts";
import { assert, isMain } from "../lib/check.ts";
import { markedLabels } from "../lib/format.ts";
import { FOOTER_PRESETS, activeFooterPreset, setFooterPreset, type FooterPreset } from "./footer.ts";
import { HEADER_PRESETS, activeHeaderPreset, setHeaderPreset, type HeaderPreset } from "./section-headers.ts";

export interface ArnativeMenu {
	value: string;
	label: string;
	description: string;
	open: (ctx: ExtensionCommandContext) => Promise<void>;
}

/** Menu picker rows: `Label  ·  description` (same rhythm as /jev-eye's menu). */
export function menuLabels(menus: Pick<ArnativeMenu, "label" | "description">[]): string[] {
	return menus.map((m) => `${m.label}  ·  ${m.description}`);
}

interface ListPickerHooks {
	/** Apply a value on every selection move (live preview). */
	preview: (name: string) => void;
	/** Restore the value the picker opened with (Esc). */
	revert: () => void;
	done: () => void;
	requestRender: () => void;
}

/** Box copy, so one picker serves every menu ("Arnative · Themes", "Arnative · Headers", …). */
export interface ListPickerText {
	title: string;
	subtitle: string;
	footer: string;
}

/** Live-preview picker: ↑↓ previews instantly, Enter keeps, Esc reverts. */
export class ListPicker implements Component {
	private theme: { fg(c: string, t: string): string; bold?(t: string): string };
	private names: string[];
	private hooks: ListPickerHooks;
	private text: ListPickerText;
	private selected: number;
	private applied: string | undefined;
	private readonly opened: string | undefined;

	constructor(
		theme: { fg(c: string, t: string): string; bold?(t: string): string },
		names: string[],
		current: string | undefined,
		hooks: ListPickerHooks,
		text: ListPickerText,
	) {
		this.theme = theme;
		this.names = names;
		this.hooks = hooks;
		this.text = text;
		this.opened = current;
		this.applied = current;
		this.selected = Math.max(0, names.indexOf(current ?? ""));
	}

	invalidate(): void {}
	dispose(): void {}

	private move(delta: number): void {
		const next = Math.min(this.names.length - 1, Math.max(0, this.selected + delta));
		if (next === this.selected) return;
		this.selected = next;
		this.applied = this.names[next];
		this.hooks.preview(this.applied);
		this.hooks.requestRender();
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "q") || matchesKey(keyData, "Q") || matchesKey(keyData, "escape")) {
			if (this.applied !== this.opened) this.hooks.revert();
			this.hooks.done();
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
		if (matchesKey(keyData, "enter")) this.hooks.done();
	}

	render(width: number): string[] {
		const th = this.theme;
		const bold = th.bold ?? ((t: string) => `\x1b[1m${t}\x1b[22m`);
		const soft = accentSoftOf(th);
		const row = (text: string) => boxRow(text, width, soft);
		const out: string[] = [boxEdge("╭", "╮", width, soft)];
		out.push(row(th.fg("accent", bold(this.text.title))));
		out.push(row(th.fg("muted", this.text.subtitle)));
		out.push(row(""));
		for (let i = 0; i < this.names.length; i++) {
			const name = this.names[i]!;
			const isSelected = i === this.selected;
			const mark = name === this.applied ? "● " : "  ";
			const plain = truncateToWidth(`${isSelected ? "▸" : " "} ${mark}${name}`, width - 4);
			// Preset rows end in a parenthetical (`Pi (system)`, `Arnative (Full)`): the suffix reads softer than the name.
			const suffix = /(\(.*\))$/.exec(plain)?.[1] ?? "";
			const head = plain.slice(0, plain.length - suffix.length);
			const tail = suffix ? th.fg("dim", suffix) : "";
			// Same rule as the select dialogs: marker accent, name soft.
			out.push(row(isSelected ? th.fg("accent", head.slice(0, 2 + mark.length)) + soft(head.slice(2 + mark.length)) + tail : th.fg("text", head) + tail));
		}
		out.push(row(""));
		out.push(row(th.fg("dim", this.text.footer)));
		out.push(boxEdge("╰", "╯", width, soft));
		return out.map((l) => truncateToWidth(l, width, ""));
	}
}

const THEMES_PICKER_TEXT: ListPickerText = {
	title: "Arnative · Themes",
	subtitle: "Selection previews live — same list as /settings → Theme.",
	footer: "[↑↓] Preview live  [Enter] Keep  [Esc] Revert",
};

const openThemes = async (ctx: ExtensionCommandContext): Promise<void> => {
	const themes = ctx.ui.getAllThemes();
	if (themes.length === 0) {
		ctx.ui.notify("[arnative] No themes found. Add files to ~/.pi/agent/themes/ and run /reload.", "warning");
		return;
	}
	const names = themes.map((t) => t.name);
	const current = ctx.ui.theme.name;

	if (typeof ctx.ui.custom !== "function") {
		// No custom components (headless/RPC): fall back to the blocking picker.
		const labels = markedLabels(names, current);
		const pick = await ctx.ui.select("Arnative · Themes", labels);
		if (pick === undefined) return;
		const result = ctx.ui.setTheme(names[labels.indexOf(pick)]!);
		ctx.ui.notify(
			result.success ? `[arnative] Theme: ${names[labels.indexOf(pick)]}` : `[arnative] ${result.error ?? "failed"}`,
			result.success ? "info" : "error",
		);
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) =>
		new ListPicker(theme, names, current, {
			preview: (name) => {
				const result = ctx.ui.setTheme(name);
				if (!result.success) ctx.ui.notify(`[arnative] ${result.error ?? `failed to apply ${name}`}`, "error");
			},
			revert: () => {
				if (current) ctx.ui.setTheme(current);
			},
			done,
			requestRender: () => tui.requestRender(),
		}, THEMES_PICKER_TEXT),
	);
};

const FOOTERS_PICKER_TEXT: ListPickerText = {
	title: "Arnative · Footers",
	subtitle: "Selection applies live — custom footer or built-in.",
	footer: "[↑↓] Preview live  [Enter] Keep  [Esc] Revert",
};

const openFooters = async (ctx: ExtensionCommandContext): Promise<void> => {
	const opened = activeFooterPreset();

	if (typeof ctx.ui.custom !== "function") {
		// No custom components (headless/RPC): fall back to the blocking picker.
		const labels = markedLabels(FOOTER_PRESETS, opened);
		const pick = await ctx.ui.select("Arnative · Footers", labels);
		if (pick === undefined) return;
		const name = FOOTER_PRESETS[labels.indexOf(pick)]!;
		setFooterPreset(name, ctx);
		ctx.ui.notify(`[arnative] Footer: ${name}`, "info");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) =>
		new ListPicker(
			theme,
			[...FOOTER_PRESETS],
			opened,
			{
				preview: (name) => setFooterPreset(name as FooterPreset, ctx),
				revert: () => setFooterPreset(opened, ctx),
				done,
				requestRender: () => tui.requestRender(),
			},
			FOOTERS_PICKER_TEXT,
		),
	);
};

const HEADERS_PICKER_TEXT: ListPickerText = {
	title: "Arnative · Headers",
	subtitle: "Selection applies live — custom header or built-in.",
	footer: "[↑↓] Preview live  [Enter] Keep  [Esc] Revert",
};

const openHeaders = async (ctx: ExtensionCommandContext): Promise<void> => {
	const opened = activeHeaderPreset();

	if (typeof ctx.ui.custom !== "function") {
		// No custom components (headless/RPC): fall back to the blocking picker.
		const labels = markedLabels(HEADER_PRESETS, opened);
		const pick = await ctx.ui.select("Arnative · Headers", labels);
		if (pick === undefined) return;
		const name = HEADER_PRESETS[labels.indexOf(pick)]!;
		setHeaderPreset(name, ctx);
		ctx.ui.notify(`[arnative] Header: ${name}`, "info");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) =>
		new ListPicker(
			theme,
			[...HEADER_PRESETS],
			opened,
			{
				preview: (name) => setHeaderPreset(name as HeaderPreset, ctx),
				revert: () => setHeaderPreset(opened, ctx),
				done,
				requestRender: () => tui.requestRender(),
			},
			HEADERS_PICKER_TEXT,
		),
	);
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
];

export async function arnativeHandler(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return;
	const sub = args.trim().toLowerCase();

	if (sub === "") {
		const labels = menuLabels(MENUS);
		const pick = await ctx.ui.select("Arnative · Settings", labels);
		if (pick === undefined) return;
		await MENUS[labels.indexOf(pick)]!.open(ctx);
		return;
	}

	const menu = MENUS.find((m) => m.value === sub);
	if (!menu) {
		ctx.ui.notify(`[arnative] Unknown menu "${sub}". Menus: ${MENUS.map((m) => m.value).join(" | ")}`, "warning");
		return;
	}
	await menu.open(ctx);
}

export function arnativeCompletions(prefix: string): AutocompleteItem[] | null {
	const items: AutocompleteItem[] = MENUS.filter((m) => m.value.startsWith(prefix.trim().toLowerCase())).map((m) => ({
		value: m.value,
		label: m.label,
		description: m.description,
	}));
	return items.length > 0 ? items : null;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("arnative", {
		description: "Arnative settings menu: themes, headers, footers",
		getArgumentCompletions: arnativeCompletions,
		handler: arnativeHandler,
	});
}

// Self-check: `node extensions/arnative.ts`
if (isMain(import.meta.url)) {
	assert(markedLabels(["a", "b"], "b")[1] === "● b", "markedLabels marks the active theme");
	assert(markedLabels(["a", "b"], "b")[0] === "  a", "markedLabels leaves others unmarked");
	assert(markedLabels(["a"], undefined)[0] === "  a", "markedLabels handles no active theme");
	const labels = menuLabels(MENUS);
	assert(labels.length === MENUS.length, "menuLabels one row per menu");
	assert(labels[0] === "Themes  ·  list & apply themes (the /settings → Theme list)", "menu row format");
	assert(MENUS.every((m) => typeof m.open === "function"), "every menu opens");
	assert(MENUS.some((m) => m.value === "headers"), "headers menu registered");

	assert(arnativeCompletions("th")!.length === 1, "completions match prefix");
	assert(arnativeCompletions("th")![0]!.value === "themes", "completions value = menu value");
	assert(arnativeCompletions("he")![0]!.value === "headers", "headers menu has completions");
	assert(arnativeCompletions("fo")![0]!.value === "footers", "footers menu has completions");
	assert(MENUS.some((m) => m.value === "footers"), "footers menu registered");
	assert(arnativeCompletions("zz") === null, "completions null when nothing matches");

	// Live-preview picker (shared by Themes and Headers): move = preview, Enter = keep, Esc = revert.
	const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const pickerText: ListPickerText = { title: "Arnative · Themes", subtitle: "sub", footer: "[Esc] Revert" };
	const previews: string[] = [];
	let reverted = 0;
	let done = 0;
	const picker = new ListPicker(fakeTheme, ["arnative", "arnative-nord"], "arnative", {
		preview: (n) => previews.push(n),
		revert: () => reverted++,
		done: () => done++,
		requestRender: () => {},
	}, pickerText);
	const lines = picker.render(50);
	assert(lines[0]!.startsWith("╭") && lines[lines.length - 1]!.startsWith("╰"), "picker framed");
	assert(lines.every((l) => visibleWidth(l) === 50), "picker lines fit width 50");
	assert(lines.some((l) => l.includes("Arnative · Themes")), "picker renders the configured title");
	assert(lines.some((l) => l.includes("● arnative")), "applied value marked");
	picker.handleInput("\x1b[B"); // down
	assert(previews.length === 1 && previews[0] === "arnative-nord", "move previews immediately");
	assert(picker.render(50).some((l) => l.includes("● arnative-nord")), "mark follows the preview");
	picker.handleInput("\r"); // enter
	assert(done === 1 && reverted === 0, "Enter keeps (no revert)");
	picker.handleInput("\x1b[B");
	picker.handleInput("\x1b"); // escape
	assert(reverted === 1 && done === 2, "Esc reverts after preview");

	// Headers reuses the same picker with its own copy and presets.
	assert(HEADER_PRESETS[0] === "Pi (system)", "built-in header preset is listed first");
	const headerPicker = new ListPicker(fakeTheme, [...HEADER_PRESETS], "Arnative (Full)", { preview: () => {}, revert: () => {}, done: () => {}, requestRender: () => {} }, HEADERS_PICKER_TEXT);
	const headerLines = headerPicker.render(50);
	assert(headerLines.some((l) => l.includes("Arnative · Headers")), "headers picker title");
	assert(headerLines.some((l) => l.includes("● Arnative (Full)")), "headers picker marks the active preset");
	assert(headerLines.some((l) => l.includes("  Pi (system)")), "headers picker lists the built-in preset");

	// Footers reuses the same picker too.
	assert(FOOTER_PRESETS[0] === "Pi (system)", "built-in footer preset is listed first");
	const footerPicker = new ListPicker(fakeTheme, [...FOOTER_PRESETS], "Pi (system)", { preview: () => {}, revert: () => {}, done: () => {}, requestRender: () => {} }, FOOTERS_PICKER_TEXT);
	const footerLines = footerPicker.render(50);
	assert(footerLines.some((l) => l.includes("Arnative · Footers")), "footers picker title");
	assert(footerLines.some((l) => l.includes("● Pi (system)")), "footers picker marks the active preset");
	assert(footerLines.some((l) => l.includes("Arnative (Minimal)")), "footers picker lists the minimal preset");
	assert(footerLines.filter((l) => l.includes("Arnative (")).length === 2, "both arnative footer presets are selectable");

	console.log("arnative.ts self-check OK");
}
