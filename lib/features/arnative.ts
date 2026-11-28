/**
 * Arnative settings menu (/arnative <menu>): no argument opens the picker, each menu is a
 * subcommand with autocomplete. Themes/Headers/Footers preview live — a move applies the
 * value, Enter keeps it, Esc restores the one it opened with; Usage opens the dashboard.
 * Screens share one chrome and one title shape ({@link renderScreen}); a box border takes
 * the session's thinking slot (`lib/ansi.ts`), so it belongs to the active model.
 */
import { bindSetModel, openProviders } from "../provider.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type AutocompleteItem } from "@earendil-works/pi-tui";
import { screenTitle } from "../box.ts";
import { announce } from "../status-widget.ts";
import { markedLabels } from "../format.ts";
import {
	PREVIEW_TICK_MS,
	SPINNER_GRADIENT_KEY,
	SPINNER_PRESET_KEY,
	SPINNER_PRESETS,
	activeSpinnerGradient,
	activeSpinnerPreset,
	animationRowNote,
	animationRows,
	animationsPickerText,
	setSpinnerGradient,
	setSpinnerPreset,
	type SpinnerPreset,
} from "../spinner.ts";
import { CHATBOX_DIALOG_KEY, CHATBOX_PRESET_KEY, CHATBOX_PROMPT_KEY, EDIT_DIFF_KEY, FOOTER_COST_KEY, FOOTER_PRESET_KEY, HEADER_PRESET_KEY, BUDGET_DAY_KEY, BUDGET_ENFORCE_KEY, BUDGET_MONTH_KEY, PAYLOAD_LIMIT_KEY, RENDER_CACHE_KEY, ensureChoices } from "../preset-store.ts";
import { EDIT_DIFF_CHOICES, activeEditDiff, setEditDiff, type EditDiffMode } from "./tools.ts";
import { CHATBOX_PRESETS, CHATBOX_PROMPTS, DEFAULT_CHATBOX_DIALOG, FOOTER_PRESETS, activeChatboxDialog, activeChatboxPreset, activeChatboxPrompt, activeFooterCost, activeFooterPreset, nextChatboxDialog, nextChatboxPrompt, setChatboxDialog, setChatboxPreset, setChatboxPrompt, setFooterCost, setFooterPreset, type ChatboxPreset } from "./footer.ts";
import { activeBudgetDay, activeBudgetEnforce, activeBudgetMonth, openBudget } from "./budget.ts";
import { HEADER_PRESETS, activeHeaderPreset, setHeaderPreset } from "./headers.ts";
import {
	AUTO_COMPACT_CHOICES,
	AUTO_COMPACT_KEY,
	PAYLOAD_LIMIT_PRESETS,
	activeAutoCompact,
	activePayloadLimit,
	ceilingsForMb,
	envByteWallOverride,
	parsePayloadLimit,
	payloadLimitMb,
	savedPayloadLimit,
	setAutoCompact,
	setPayloadLimit,
	type AutoCompactChoice,
	type PayloadLimitPreset,
} from "./auto-compact.ts";
import { cancelManualHeal, healNow } from "./model-heal.ts";
import { MODEL_HEAL_CHOICES, MODEL_HEAL_KEY, activeModelHeal, setModelHeal, type ModelHealChoice } from "../model-heal.ts";
import {
	RENDER_CACHE_CHOICES,
	activeRenderCache,
	setRenderCache,
	type RenderCacheChoice,
} from "./render-cache.ts";
import { INPUT_LEGEND, InputPicker, LIST_LEGEND_LIVE, LIST_LEGEND_MOVE, LIST_LEGEND_ROOT, ListPicker, nameRows, rowText, type ListPickerText, type ListRow } from "../list-picker.ts";
import { openUsage } from "./usage.ts";
import { SHORTCUT_OPEN_ARNATIVE } from "../shortcuts.ts";

export type MenuGroup = "Appearance" | "Display" | "Models & Context" | "Spend";

export interface MenuCategory {
	label: MenuGroup;
	description: string;
}

export const MENU_CATEGORIES: readonly MenuCategory[] = [
	{ label: "Appearance", description: "themes, headers, footers, chatbox" },
	{ label: "Display", description: "animations, diffs, render cache" },
	{ label: "Models & Context", description: "custom providers, model heal, auto-compact, payload limit" },
	{ label: "Spend", description: "usage dashboard, budget caps" },
];

export interface ArnativeMenu {
	value: string;
	label: string;
	description: string;
	group: MenuGroup;
	/** Returns `true` when the screen asked to step back to the menu (`←`). */
	open: (ctx: ExtensionCommandContext) => Promise<boolean | void>;
}

/** Menu rows: `Label · description` (same rhythm as /jev-eye's menu). */
export function menuRows(menus: { label: string; description: string }[]): ListRow[] {
	return menus.map((m) => ({ label: m.label, note: m.description }));
}

/** Items belonging to a single root category in display order. */
export function categoryMenus(group: MenuGroup, menus: readonly ArnativeMenu[] = MENUS): ArnativeMenu[] {
	return menus.filter((m) => m.group === group);
}

/** Title of the settings menu, derived from `screenTitle` so the format lives in one place. */
export const MENU_TITLE = screenTitle("Settings");
/** One-line description under the menu title. */
export const MENU_DESC = "Themes, headers, footers, chatbox, animations, auto-compact, render, payload, providers, usage, budget";

const THEMES_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Themes"),
	description: "Selection previews live — arnative themes only (all themes: /settings → Theme).",
	legend: LIST_LEGEND_LIVE,
};

interface LivePickerSpec<T extends string> {
	choices: readonly T[];
	rows?: ListRow[];
	opened: T | undefined;
	text: ListPickerText | (() => ListPickerText);
	apply: (value: T) => void;
	current: () => T | undefined;
	label: string;
	headlessLabels?: string[];
	onSelectHeadless?: (value: T) => void;
	onDone?: () => void;
	onRevert?: () => void;
	onBack?: () => void;
	cancel?: boolean;
	press?: (keyData: string, requestRender: () => void) => void;
	toggleGradient?: (requestRender: () => void) => void;
	summary?: (theme: { fg(c: string, t: string): string }) => string[];
	note?: (label: string) => string | undefined;
	tickMs?: number;
}

/** Shared live-preview picker: ↑↓ previews immediately, Enter keeps, Esc/← reverts. */
async function openLivePicker<T extends string>(ctx: ExtensionCommandContext, spec: LivePickerSpec<T>): Promise<boolean | void> {
	const getText = typeof spec.text === "function" ? spec.text : () => spec.text as ListPickerText;
	if (ctx.mode !== "tui") {
		const labels = spec.headlessLabels ?? markedLabels(spec.choices, spec.opened);
		const pick = await ctx.ui.select(getText().title, labels);
		if (pick === undefined) return;
		const chosen = spec.choices[labels.indexOf(pick)]!;
		if (spec.onSelectHeadless) spec.onSelectHeadless(chosen);
		else {
			spec.apply(chosen);
			ctx.ui.notify(`[arnative] ${spec.label}: ${chosen}`, "info");
		}
		return;
	}
	const goBack = await ctx.ui.custom<boolean>((tui, theme, _kb, done) =>
		new ListPicker(
			theme,
			spec.rows ?? nameRows(spec.choices),
			spec.opened,
			{
				preview: (name) => spec.apply(name as T),
				revert: () => {
					if (spec.onRevert) spec.onRevert();
					else if (spec.opened !== undefined) spec.apply(spec.opened);
				},
				done: () => {
					if (spec.onDone) spec.onDone();
					else announce(ctx.ui, `${spec.label}: ${spec.current()}.`);
					done(false);
				},
				...(spec.cancel ? { cancel: () => done(false) } : {}),
				back: () => {
					if (spec.onBack) spec.onBack();
					else if (spec.opened !== undefined && spec.current() !== spec.opened) spec.apply(spec.opened);
					done(true);
				},
				...(spec.press ? { press: (k) => spec.press!(k, () => tui.requestRender()) } : {}),
				...(spec.toggleGradient ? { toggleGradient: () => spec.toggleGradient!(() => tui.requestRender()) } : {}),
				...(spec.summary ? { summary: () => spec.summary!(theme) } : {}),
				...(spec.note ? { note: spec.note } : {}),
				...(typeof spec.text === "function" ? { legend: () => getText().legend } : {}),
				...(spec.tickMs !== undefined ? { tickMs: spec.tickMs } : {}),
				requestRender: () => tui.requestRender(),
			},
			getText(),
			true,
			ctx.thinkingLevel,
		),
	);
	return goBack === true;
}

/** Shared non-live choice picker: Enter commits the highlighted row, Esc/← leaves untouched. */
async function openChoicePicker<T extends string>(
	ctx: ExtensionCommandContext,
	spec: {
		choices: readonly T[];
		rows: ListRow[];
		opened: T;
		text: ListPickerText;
		onCommit: (index: number, isTui: boolean) => void | Promise<void>;
	},
): Promise<boolean | void> {
	if (ctx.mode !== "tui") {
		const labels = spec.choices.map((c) => (c === spec.opened ? `${c} ✓` : c));
		const pick = await ctx.ui.select(spec.text.title, labels);
		if (pick === undefined) return;
		await spec.onCommit(labels.indexOf(pick), false);
		return;
	}
	let committed: number | undefined;
	const goBack = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		const picker = new ListPicker(
			theme,
			spec.rows,
			spec.opened,
			{
				preview: () => {},
				revert: () => {},
				done: () => {
					committed = picker.index;
					done(false);
				},
				cancel: () => done(false),
				back: () => done(true),
				requestRender: () => tui.requestRender(),
			},
			spec.text,
			false,
			ctx.thinkingLevel,
		);
		return picker;
	});
	if (committed !== undefined) await spec.onCommit(committed, true);
	return goBack === true;
}

const openThemes = async (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	// Only this package's family (`arnative`, `arnative-<variant>`): the picker brands itself
	// arnative, so pi's own themes and the user's belong in /settings → Theme, not here.
	const names = ctx.ui.getAllThemes().map((t) => t.name).filter(isArnativeThemeName);
	if (names.length === 0) {
		ctx.ui.notify("[arnative] No arnative themes found. Reinstall pi-arnative, or pick any theme in /settings → Theme.", "warning");
		return;
	}
	const current = ctx.ui.theme.name;
	return openLivePicker(ctx, {
		choices: names,
		opened: current,
		text: THEMES_PICKER_TEXT,
		label: "Theme",
		current: () => ctx.ui.theme.name,
		apply: (name) => {
			const result = ctx.ui.setTheme(name);
			if (!result.success) ctx.ui.notify(`[arnative] ${result.error ?? `failed to apply ${name}`}`, "error");
		},
		onSelectHeadless: (name) => {
			const result = ctx.ui.setTheme(name);
			ctx.ui.notify(result.success ? `[arnative] Theme: ${name}` : `[arnative] ${result.error ?? "failed"}`, result.success ? "info" : "error");
		},
		onRevert: () => {
			if (current) ctx.ui.setTheme(current);
		},
		onBack: () => {
			if (current && ctx.ui.theme.name !== current) ctx.ui.setTheme(current);
		},
		onDone: () => {
			const applied = ctx.ui.theme.name;
			announce(ctx.ui, applied ? `Theme: ${applied}.` : "Theme changed.");
		},
	});
};

/** The Footers screen copy. The legend states the cost switch's live value, like the
 *  Animations screen does for the gradient — a constant legend would advertise the value
 *  the screen opened with. */
const footersPickerText = (): ListPickerText => ({
	title: screenTitle("Footers"),
	description: "Selection applies live — custom footer or built-in.",
	legend: `[↑↓] Preview  [c] Cost ${activeFooterCost() ? "on" : "off"}  [Enter] Select  [Esc] Back`,
});

const openFooters = (ctx: ExtensionCommandContext): Promise<boolean | void> =>
	openLivePicker(ctx, {
		choices: FOOTER_PRESETS,
		opened: activeFooterPreset(),
		text: footersPickerText,
		label: "Footer",
		current: activeFooterPreset,
		apply: (name) => setFooterPreset(name, ctx),
		press: (keyData, requestRender) => {
			if (!matchesKey(keyData, "c")) return;
			setFooterCost(!activeFooterCost());
			requestRender();
		},
	});

const HEADERS_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Headers"),
	description: "Selection applies live — custom header or built-in.",
	legend: LIST_LEGEND_LIVE,
};

const openHeaders = (ctx: ExtensionCommandContext): Promise<boolean | void> =>
	openLivePicker(ctx, {
		choices: HEADER_PRESETS,
		opened: activeHeaderPreset(),
		text: HEADERS_PICKER_TEXT,
		label: "Header",
		current: activeHeaderPreset,
		apply: (name) => setHeaderPreset(name, ctx),
	});

const CHATBOX_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Chatbox"),
	description: "Selection applies when confirmed — rounded arnative box or built-in editor.",
	legend: "[↑↓] Preview  [i] Icon  [D] Dialog  [Enter] Select  [Esc] Back",
};

const CHATBOX_NOTES: Record<ChatboxPreset, string> = {
	"Pi (system)": "built-in top and bottom lines",
	Arnative: "rounded arnative box with prompt & status placement",
};

export const chatboxRows = (): ListRow[] => CHATBOX_PRESETS.map((c) => ({ label: c, note: CHATBOX_NOTES[c] }));

export const chatboxSummary = (theme: { fg(c: string, t: string): string }): string[] => {
	const dim = (s: string) => theme.fg("dim", s);
	const txt = (s: string) => theme.fg("text", s);
	const acc = (s: string) => theme.fg("accent", s);
	const activeIcon = activeChatboxPrompt();
	const icons = CHATBOX_PROMPTS.map((p) => (p === activeIcon ? acc(p) : dim(p))).join("  ");
	const dialog = activeChatboxDialog();
	const dialogTag = dialog === DEFAULT_CHATBOX_DIALOG ? ` ${dim("(default)")}` : "";
	return [
		`${dim("Box   ")}${dim(" · ")}${txt(activeChatboxPreset())}`,
		`${dim("Icon  ")}${dim(" · ")}${icons}`,
		`${dim("Dialog")}${dim(" · ")}${txt(dialog.toLowerCase())}${dialogTag}`,
	];
};

const openChatbox = (ctx: ExtensionCommandContext): Promise<boolean | void> =>
	openLivePicker(ctx, {
		choices: CHATBOX_PRESETS,
		rows: chatboxRows(),
		opened: activeChatboxPreset(),
		text: CHATBOX_PICKER_TEXT,
		label: "Chatbox",
		current: activeChatboxPreset,
		apply: setChatboxPreset,
		summary: chatboxSummary,
		press: (keyData, requestRender) => {
			if (matchesKey(keyData, "i") || keyData === "I") {
				setChatboxPrompt(nextChatboxPrompt());
				requestRender();
				return;
			}
			if (matchesKey(keyData, "d") || keyData === "D") {
				setChatboxDialog(nextChatboxDialog());
				requestRender();
			}
		},
	});

/** Animations picker. Unlike Themes/Headers/Footers the choice has a visible effect only
 *  while a tool runs, so there is nothing to preview live on the screen itself — the row
 *  previews the frames instead, and Enter installs the preset for the next run. */
const openAnimations = (ctx: ExtensionCommandContext): Promise<boolean | void> =>
	openLivePicker(ctx, {
		choices: SPINNER_PRESETS,
		rows: animationRows(),
		opened: activeSpinnerPreset(),
		text: animationsPickerText,
		label: "Animation",
		current: activeSpinnerPreset,
		apply: setSpinnerPreset,
		toggleGradient: (requestRender) => {
			setSpinnerGradient(!activeSpinnerGradient());
			requestRender();
		},
		note: (label) => animationRowNote(label as SpinnerPreset),
		tickMs: PREVIEW_TICK_MS,
	});

const AUTOCOMPACT_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Auto-compact"),
	description: "Smart tiers the trigger by context window; manual budgets fire at one absolute size.",
	legend: LIST_LEGEND_MOVE,
};

/** One note per row: Smart reflects Render cache state, a manual budget its window-independence. */
function autoCompactNotes(): Record<AutoCompactChoice, string> {
	return {
		Off: "never — pi's own compaction stays in charge",
		Smart:
			activeRenderCache() === "On"
				? "90% of window (≥192k) · <192k→pi core"
				: "by window: 1M→20% · 512k→40% · 256k→80% · <192k→pi core",
		"100k": "always above 100k tokens, any window",
		"150k": "always above 150k tokens, any window",
		"200k": "always above 200k tokens, any window",
		"300k": "always above 300k tokens, any window",
		"400k": "always above 400k tokens, any window",
	};
}

/** Rows for the Auto-compact picker: the saved choice ends its row with a green ✓. */
export function autoCompactRows(opened: AutoCompactChoice): ListRow[] {
	const notes = autoCompactNotes();
	return AUTO_COMPACT_CHOICES.map((c) => ({ label: c, note: notes[c], chosen: c === opened }));
}

/** A plain (non-live) picker: the choice is committed by Enter, nothing previews. The
 *  trigger itself lives in `lib/features/auto-compact.ts` and fires on the next settle. */
const openAutoCompact = (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	const opened = activeAutoCompact();
	return openChoicePicker(ctx, {
		choices: AUTO_COMPACT_CHOICES,
		rows: autoCompactRows(opened),
		opened,
		text: AUTOCOMPACT_PICKER_TEXT,
		onCommit: (index, isTui) => {
			const choice = AUTO_COMPACT_CHOICES[index]!;
			setAutoCompact(choice);
			if (isTui) announce(ctx.ui, `Auto-compact: ${choice}.`);
			else {
				ctx.ui.notify(
					`[arnative] Auto-compact: ${choice === "Off" ? "off" : choice === "Smart" ? "smart (tiered by context window)" : `above ${choice} tokens of context`}`,
					"info",
				);
			}
		},
	});
};

const MODEL_HEAL_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Model heal"),
	description: "Keeps models.json correct on its own: session start, model switch, file change, rejected parameter.",
	legend: LIST_LEGEND_MOVE,
};

const MODEL_HEAL_RUN_NOW = "Run now";

const MODEL_HEAL_NOTES: Record<ModelHealChoice, string> = {
	Full: "flags + limits from /models + probed thinking levels",
	Flags: "offline compat flags only, no network",
	Off: "never touch models.json",
};

/** Rows for the Model heal picker: the saved mode ends its row with a green check; the
 *  last row is an action, never a saved choice. */
export function modelHealRows(opened: ModelHealChoice): ListRow[] {
	return [
		...MODEL_HEAL_CHOICES.map((c) => ({ label: c, note: MODEL_HEAL_NOTES[c], chosen: c === opened })),
		{ label: MODEL_HEAL_RUN_NOW, note: "heal every channel now, ignoring the 6h/24h TTLs" },
	];
}

const openModelHeal = (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	const opened = activeModelHeal();
	return openChoicePicker(ctx, {
		choices: [...MODEL_HEAL_CHOICES, MODEL_HEAL_RUN_NOW],
		rows: modelHealRows(opened),
		opened,
		text: MODEL_HEAL_PICKER_TEXT,
		onCommit: async (index, isTui) => {
			if (index === MODEL_HEAL_CHOICES.length) {
				await healNow(ctx);
				return;
			}
			const choice = MODEL_HEAL_CHOICES[index]!;
			setModelHeal(choice);
			if (isTui) announce(ctx.ui, `Model heal: ${choice}.`);
			else ctx.ui.notify(`[arnative] Model heal: ${choice}`, "info");
		},
	});
};

const RENDER_CACHE_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Render cache"),
	description: "Cache settled chat messages and tool boxes so long sessions stay smooth across frames.",
	legend: LIST_LEGEND_MOVE,
};

const RENDER_CACHE_NOTES: Record<RenderCacheChoice, string> = {
	On: "reuse rendered lines for finished messages and tool boxes (default)",
	Off: "render every transcript component directly on each frame",
};

/** Rows for the Render cache picker: the saved choice ends its row with a green ✓. */
export function renderCacheRows(opened: RenderCacheChoice): ListRow[] {
	return RENDER_CACHE_CHOICES.map((c) => ({ label: c, note: RENDER_CACHE_NOTES[c], chosen: c === opened }));
}

const DIFFS_PICKER_TEXT: ListPickerText = {
	title: screenTitle("Diffs"),
	description: "Selection previews live — side-by-side Before │ After or unified +/- diff.",
	legend: LIST_LEGEND_LIVE,
};

const EDIT_DIFF_NOTES: Record<EditDiffMode, string> = {
	Split: "side-by-side Before │ After columns (default)",
	Unified: "single-column +/- diff, easier to copy-paste",
};

/** Rows for `/arnative` → Diffs: Split / Unified. */
export function diffRows(): ListRow[] {
	return EDIT_DIFF_CHOICES.map((c) => ({
		label: c,
		note: EDIT_DIFF_NOTES[c],
	}));
}

const openDiffs = (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	const opened = activeEditDiff();
	return openLivePicker(ctx, {
		choices: EDIT_DIFF_CHOICES,
		rows: diffRows(),
		opened,
		text: DIFFS_PICKER_TEXT,
		label: "Diffs",
		current: activeEditDiff,
		apply: setEditDiff,
		headlessLabels: EDIT_DIFF_CHOICES.map((c) => (c === opened ? `${c} ✓` : c)),
		cancel: true,
	});
};

const openRenderCache = (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	const opened = activeRenderCache();
	return openChoicePicker(ctx, {
		choices: RENDER_CACHE_CHOICES,
		rows: renderCacheRows(opened),
		opened,
		text: RENDER_CACHE_PICKER_TEXT,
		onCommit: (index, isTui) => {
			const choice = RENDER_CACHE_CHOICES[index]!;
			setRenderCache(choice);
			if (isTui) announce(ctx.ui, `Render cache: ${choice}.`);
			else ctx.ui.notify(`[arnative] Render cache: ${choice}`, "info");
		},
	});
};

const PAYLOAD_CUSTOM_LABEL = "Custom";

const PAYLOAD_PRESET_NOTES: Record<PayloadLimitPreset, string> = {
	Off: "disabled — send full history (may hit HTTP 413 on strict proxies)",
	"1 MB": "safe default for standard 1 MB reverse proxies (trims at 900 KB)",
	"4 MB": "small raised proxy limit (trims at 3.5 MB)",
	"8 MB": "medium proxy limit (trims at 7.0 MB)",
	"16 MB": "recommended for 1M-context models on 16 MB proxies (trims at 14.1 MB)",
	"32 MB": "high ceiling for image-heavy sessions (trims at 28.1 MB)",
};

function payloadPickerText(): ListPickerText {
	const envOverride = envByteWallOverride();
	const description = envOverride
		? `Max HTTP request size for remote models (env PI_ARNATIVE_BYTE_WALL_MB=${payloadLimitMb(envOverride)} active now; picking overrides it).`
		: "Max HTTP request size for remote models; older images, thinking, and tool outputs trim above it.";
	return {
		title: screenTitle("Payload limit"),
		description,
		legend: LIST_LEGEND_MOVE,
	};
}

/** Rows for the Payload limit picker: presets plus Custom MB; the active value carries a green ✓. */
export function payloadLimitRows(opened: string): ListRow[] {
	const isPreset = (PAYLOAD_LIMIT_PRESETS as readonly string[]).includes(opened);
	const customNote = isPreset
		? "enter any limit in MB (e.g. 11, 24, 100)"
		: `current: ${opened} — enter any limit in MB (1–1024)`;
	return [
		...PAYLOAD_LIMIT_PRESETS.map((c) => ({ label: c, note: PAYLOAD_PRESET_NOTES[c], chosen: c === opened })),
		{ label: PAYLOAD_CUSTOM_LABEL, note: customNote, chosen: !isPreset },
	];
}

function applyPayloadChoice(ctx: ExtensionCommandContext, choice: string): void {
	const applied = setPayloadLimit(choice);
	const ceilings = applied === "Off" ? null : ceilingsForMb(payloadLimitMb(applied) ?? 1);
	const detail = ceilings ? ` (trims at ${(ceilings.shedTriggerBytes / 1024 / 1024).toFixed(2)} MB)` : " (trimming disabled)";
	announce(ctx.ui, `Payload limit: ${applied}${detail}.`);
}

const openPayloadLimit = async (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	for (;;) {
		const opened = activePayloadLimit();
		const isPreset = (PAYLOAD_LIMIT_PRESETS as readonly string[]).includes(opened);
		const cursor = isPreset ? opened : PAYLOAD_CUSTOM_LABEL;
		const pickerText = payloadPickerText();

		if (ctx.mode !== "tui") {
			const labels = [...PAYLOAD_LIMIT_PRESETS.map((c) => (c === opened ? `${c} ✓` : c)), isPreset ? PAYLOAD_CUSTOM_LABEL : `${PAYLOAD_CUSTOM_LABEL} (${opened}) ✓`];
			const pick = await ctx.ui.select(pickerText.title, labels);
			if (pick === undefined) return;
			const index = labels.indexOf(pick);
			if (index < PAYLOAD_LIMIT_PRESETS.length) {
				applyPayloadChoice(ctx, PAYLOAD_LIMIT_PRESETS[index]!);
				return;
			}
			const currentMb = payloadLimitMb(opened);
			const raw = await ctx.ui.input("Payload limit (MB, 1–1024, or Off)", currentMb ? String(currentMb) : "16");
			if (raw === undefined) return;
			const parsed = parsePayloadLimit(raw);
			if (!parsed) {
				ctx.ui.notify("[arnative] Enter a number between 1 and 1024 MB (e.g. 11 or 16), or Off.", "warning");
				return;
			}
			applyPayloadChoice(ctx, parsed);
			return;
		}

		let pickCustom = false;
		const goBack = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
			const picker = new ListPicker(
				theme,
				payloadLimitRows(opened),
				cursor,
				{
					preview: () => {},
					revert: () => {},
					done: () => {
						if (picker.index === PAYLOAD_LIMIT_PRESETS.length) {
							pickCustom = true;
						} else {
							applyPayloadChoice(ctx, PAYLOAD_LIMIT_PRESETS[picker.index]!);
						}
						done(false);
					},
					cancel: () => done(false),
					back: () => done(true),
					requestRender: () => tui.requestRender(),
				},
				pickerText,
				false,
				ctx.thinkingLevel,
			);
			return picker;
		});
		if (goBack === true) return true;
		if (!pickCustom) return false;

		const currentMb = payloadLimitMb(opened);
		const raw = await ctx.ui.custom<string | null>((tui, theme, _kb, done) =>
			new InputPicker(
				theme,
				{
					title: screenTitle("Payload limit"),
					description: "Enter a number between 1 and 1024 MB (e.g. 11 or 16), or Off.",
					legend: INPUT_LEGEND,
				},
				currentMb ? String(currentMb) : "",
				{
					done: (v) => done(v),
					cancel: () => done(null),
					requestRender: () => tui.requestRender(),
				},
				"16",
				ctx.thinkingLevel,
			),
		);
		if (raw === null) continue;
		const parsed = parsePayloadLimit(raw);
		if (!parsed) {
			ctx.ui.notify("[arnative] Enter a number between 1 and 1024 MB (e.g. 11 or 16), or Off.", "warning");
			continue;
		}
		applyPayloadChoice(ctx, parsed);
		return false;
	}
};

export const MENUS: ArnativeMenu[] = [
	{
		value: "themes",
		label: "Themes",
		description: "arnative themes only (all themes: /settings → Theme)",
		group: "Appearance",
		open: openThemes,
	},
	{
		value: "headers",
		label: "Headers",
		description: "choose the header preset",
		group: "Appearance",
		open: openHeaders,
	},
	{
		value: "footers",
		label: "Footers",
		description: "choose the footer preset",
		group: "Appearance",
		open: openFooters,
	},
	{
		value: "chatbox",
		label: "Chatbox",
		description: "choose the input box preset",
		group: "Appearance",
		open: openChatbox,
	},
	{
		value: "animations",
		label: "Animations",
		description: "choose the working spinner",
		group: "Display",
		open: openAnimations,
	},
	{
		value: "diffs",
		label: "Diffs",
		description: "side-by-side Before/After or unified diff",
		group: "Display",
		open: openDiffs,
	},
	{
		value: "render",
		label: "Render cache",
		description: "cache settled transcript rows across frames (on by default)",
		group: "Display",
		open: openRenderCache,
	},
	{
		value: "providers",
		label: "Providers",
		description: "custom endpoints: endpoint, key, name — the rest is automatic",
		group: "Models & Context",
		open: openProviders,
	},
	{
		value: "heal",
		label: "Model heal",
		description: "auto-fix models.json: compat flags, limits, thinking levels (on by default)",
		group: "Models & Context",
		open: openModelHeal,
	},
	{
		value: "compact",
		label: "Auto-compact",
		description: "smart by window or a fixed token budget (off by default)",
		group: "Models & Context",
		open: openAutoCompact,
	},
	{
		value: "payload",
		label: "Payload limit",
		description: "max HTTP request size for remote proxies (1 MB by default)",
		group: "Models & Context",
		open: openPayloadLimit,
	},
	{
		value: "usage",
		label: "Usage",
		description: "open the token & cost dashboard (same as /usage)",
		group: "Spend",
		open: openUsage,
	},
	{
		value: "budget",
		label: "Budget",
		description: "warn-only spend caps on today / 30d; enforce on blocks the next turn",
		group: "Spend",
		open: openBudget,
	},
];

/** Submenu for one category; returns `true` when the user presses `←` to return to the root menu. */
async function openCategoryMenu(ctx: ExtensionCommandContext, category: MenuCategory, startLabel?: string): Promise<boolean> {
	const items = categoryMenus(category.label);
	const rows = menuRows(items);
	if (ctx.mode !== "tui") {
		const labels = rows.map(rowText);
		const pick = await ctx.ui.select(screenTitle(category.label), labels);
		if (pick === undefined) return false;
		await items[labels.indexOf(pick)]!.open(ctx);
		return false;
	}
	let cursor = startLabel;
	for (;;) {
		const choice = await ctx.ui.custom<{ index?: number; back?: boolean }>((tui, theme, _kb, done) => {
			const picker = new ListPicker(theme, rows, cursor, {
				preview: () => {},
				revert: () => {},
				done: () => done({ index: picker.index }),
				cancel: () => done({ back: false }),
				back: () => done({ back: true }),
				requestRender: () => tui.requestRender(),
			}, { title: screenTitle(category.label), description: category.description[0]!.toUpperCase() + category.description.slice(1), legend: LIST_LEGEND_MOVE }, false, ctx.thinkingLevel);
			return picker;
		});
		if (choice.index === undefined) return choice.back === true;
		const menu = items[choice.index]!;
		cursor = menu.label;
		if ((await menu.open(ctx)) !== true) return false;
	}
}

/** The 4-category settings menu. Selecting a category opens its submenu; `←` steps back
 *  up one level (screen → category → root) and remembers the last row at each level. */
async function openMainMenu(ctx: ExtensionCommandContext, startGroup?: MenuGroup, startItem?: string): Promise<void> {
	const rows = menuRows([...MENU_CATEGORIES]);
	if (ctx.mode !== "tui") {
		// No custom components (RPC/headless): a title-only picker, no description row.
		const labels = rows.map(rowText);
		const pick = await ctx.ui.select(MENU_TITLE, labels);
		if (pick === undefined) return;
		await openCategoryMenu(ctx, MENU_CATEGORIES[labels.indexOf(pick)]!);
		return;
	}
	if (startGroup && startItem) {
		const cat = MENU_CATEGORIES.find((c) => c.label === startGroup);
		if (cat && (await openCategoryMenu(ctx, cat, startItem)) !== true) return;
	}
	let cursor: string | undefined = startGroup;
	for (;;) {
		const index = await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
			const picker = new ListPicker(theme, rows, cursor, {
				preview: () => {},
				revert: () => {},
				done: () => done(picker.index),
				cancel: () => done(null),
				// Nothing is behind the root menu: `←` is not a close shortcut here, so the key
				// is hidden — Esc (and `q`) close, and the legend says so.
				back: false,
				requestRender: () => tui.requestRender(),
			}, { title: MENU_TITLE, description: MENU_DESC, legend: LIST_LEGEND_ROOT }, false, ctx.thinkingLevel);
			return picker;
		});
		if (index === null || index === undefined) return;
		const category = MENU_CATEGORIES[index]!;
		cursor = category.label;
		if ((await openCategoryMenu(ctx, category)) !== true) return;
	}
}

async function arnativeHandler(args: string, ctx: ExtensionCommandContext): Promise<void> {
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
	// A direct subcommand behaves like a menu row: `←` drops into its category on that row,
	// so `/arnative usage` + `←` is not a dead key.
	const menu = MENUS[index]!;
	if ((await menu.open(ctx)) === true) await openMainMenu(ctx, menu.group, menu.label);
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
const DEFAULT_THEME = "arnative";

/** A theme of this package's family: `arnative` itself or an `arnative-<variant>`. The
 *  generator (`themes/gen-themes.mjs`) ships only such names, so the name is the identity —
 *  pi may load them from the package dir or a user copy, and both answer to it. */
export function isArnativeThemeName(name: string): boolean {
	return name === DEFAULT_THEME || name.startsWith(`${DEFAULT_THEME}-`);
}

/** Should the shipped theme be installed? Only when no theme is set at all (pi would fall back
 *  to `system`) and the theme actually loaded, which a headless or filtered load may not do. */
export function shouldApplyDefaultTheme(
	themeSetting: string | undefined,
	themes: readonly { name: string }[],
): boolean {
	return themeSetting === undefined && themes.some((t) => t.name === DEFAULT_THEME);
}

/** Register every slash command this package owns. Exported so the self-check can assert the
 *  set without starting a session. */
export function registerCommands(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand("arnative", {
		description: "Arnative settings menu: themes, headers, footers, chatbox, animations, auto-compact, model heal, render cache, payload limit, providers, usage, budget",
		getArgumentCompletions: arnativeCompletions,
		handler: arnativeHandler,
	});
	// Shortcut for the screen people reach for by name: it goes through the same handler, so
	// `/providers` and `/arnative providers` cannot drift apart.
	pi.registerCommand("providers", {
		description: "Custom endpoints: add, edit or remove a provider (same as /arnative providers)",
		handler: (_args: string, ctx: ExtensionCommandContext) => arnativeHandler("providers", ctx),
	});
}

/** Record the choices in use in `config.json`, defaults included, so the file reads as the
 *  profile instead of a diff against it. Idempotent: only keys that differ get written. */
export function recordProfile(): void {
	ensureChoices({
		[HEADER_PRESET_KEY]: activeHeaderPreset(),
		[FOOTER_PRESET_KEY]: activeFooterPreset(),
		[FOOTER_COST_KEY]: activeFooterCost() ? "on" : "off",
		[CHATBOX_PRESET_KEY]: activeChatboxPreset(),
		[CHATBOX_PROMPT_KEY]: activeChatboxPrompt(),
		[CHATBOX_DIALOG_KEY]: activeChatboxDialog(),
		[SPINNER_PRESET_KEY]: activeSpinnerPreset(),
		[SPINNER_GRADIENT_KEY]: activeSpinnerGradient() ? "on" : "off",
		[EDIT_DIFF_KEY]: activeEditDiff(),
		[AUTO_COMPACT_KEY]: activeAutoCompact(),
		[PAYLOAD_LIMIT_KEY]: savedPayloadLimit(),
		[MODEL_HEAL_KEY]: activeModelHeal(),
		[RENDER_CACHE_KEY]: activeRenderCache(),
		[BUDGET_DAY_KEY]: activeBudgetDay() === undefined ? "" : String(activeBudgetDay()),
		[BUDGET_MONTH_KEY]: activeBudgetMonth() === undefined ? "" : String(activeBudgetMonth()),
		[BUDGET_ENFORCE_KEY]: activeBudgetEnforce() ? "on" : "off",
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Before the theme branch below returns: the profile is recorded once per install, so
		// `config.json` lists every choice even when it never left its default.
		recordProfile();
		// `setTheme` writes the choice into pi's settings, so this runs once per install and the
		// second session already sees an explicit setting.
		if (!shouldApplyDefaultTheme(pi.getSettings()?.theme, ctx.ui.getAllThemes())) return;
		ctx.ui.setTheme(DEFAULT_THEME);
	});
	bindSetModel((model) => pi.setModel(model as never));
	pi.on("session_shutdown", () => cancelManualHeal());
	registerCommands(pi);
	for (const key of SHORTCUT_OPEN_ARNATIVE.keys) {
		pi.registerShortcut(key, {
			description: "Open Arnative settings menu",
			handler: (ctx) => arnativeHandler("", ctx as never),
		});
	}
}

export const __test = {
	footersPickerText,
	HEADERS_PICKER_TEXT,
	CHATBOX_PICKER_TEXT,
};
