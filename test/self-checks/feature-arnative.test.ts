import test from "node:test";
import { assert } from "../helpers/check.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../lib/ansi.ts";
import { screenTitle } from "../../lib/box.ts";
import { markedLabels, ROW_DIVIDER } from "../../lib/format.ts";
import { animationsPickerText, animationRows } from "../../lib/spinner.ts";
import { CHATBOX_DIALOGS, CHATBOX_PRESETS, DEFAULT_CHATBOX_DIALOG, FOOTER_PRESETS, activeChatboxDialog, activeChatboxPrompt } from "../../lib/features/footer.ts";
import { HEADER_PRESETS } from "../../lib/features/headers.ts";
import { LIST_LEGEND_LIVE, LIST_LEGEND_MOVE, LIST_LEGEND_ROOT, ListPicker, nameRows, rowText, type ListPickerText } from "../../lib/list-picker.ts";
import { MENU_CATEGORIES, menuRows, categoryMenus, MENU_TITLE, MENU_DESC, chatboxRows, chatboxSummary, autoCompactRows, modelHealRows, renderCacheRows, diffRows, toolLayoutRows, payloadLimitRows, MENUS, arnativeCompletions, isArnativeThemeName, shouldApplyDefaultTheme, registerCommands, __test } from "../../lib/features/arnative.ts";

const { footersPickerText, HEADERS_PICKER_TEXT, CHATBOX_PICKER_TEXT } = __test;

test("lib/features/arnative.ts self-check", async () => {
	assert(markedLabels(["a", "b"], "b")[1] === "● b", "markedLabels marks the active theme");
	assert(markedLabels(["a", "b"], "b")[0] === "  a", "markedLabels leaves others unmarked");
	assert(markedLabels(["a"], undefined)[0] === "  a", "markedLabels handles no active theme");
	const labels = menuRows(MENUS);
	assert(labels.length === MENUS.length, "menuRows one row per menu");
	assert(rowText(labels[0]!) === "Themes · arnative themes only (all themes: /settings → Theme)", "menu row text format");
	assert(labels[0]!.label === "Themes" && labels[0]!.note === "arnative themes only (all themes: /settings → Theme)", "menu row keeps label and note apart");
	assert(MENU_TITLE === "Settings - Arnative\u2819", `the menu title is the pinned string, got ${MENU_TITLE}`);
	assert(MENU_DESC === "Themes, headers, footers, chatbox, animations, auto-compact, render, payload, providers, usage, budget", `the menu description is the pinned string, got ${MENU_DESC}`);
	// Every menu row is reachable and the description names them all, so a new screen cannot
	// be added to MENUS and forgotten in the copy a user reads first.
	assert(MENUS.length === 14, "fourteen settings screens");
	{
		const catRows = menuRows([...MENU_CATEGORIES]);
		assert(catRows.map((r) => r.label).join(",") === "Appearance,Display,Models & Context,Spend", "root menu lists the four categories in order");
		const totalGrouped = MENU_CATEGORIES.reduce((n, c) => n + categoryMenus(c.label).length, 0);
		assert(totalGrouped === MENUS.length, "every menu item belongs to one of the four categories");
		const display = categoryMenus("Display");
		assert(display.map((m) => m.value).join(",") === "animations,diffs,tools,render", "Display group lists Animations, Diffs, Tool layout, Render cache in order");
		const modelsCtx = categoryMenus("Models & Context");
		assert(modelsCtx.map((m) => m.value).join(",") === "providers,heal,compact,payload", "Models & Context group lists Providers, Model heal, Auto-compact, Payload limit in order");
		const heal = modelHealRows("Flags");
		assert(heal.map((r) => r.label).join(",") === "Full,Flags,Off,Run now", "Model heal rows: three modes then Run now");
		assert(heal.filter((r) => r.chosen).map((r) => r.label).join(",") === "Flags", "Model heal marks only the saved mode");
		const rc = renderCacheRows("On");
		assert(rc.map((r) => r.label).join(",") === "On,Off", "Render cache rows: On then Off");
		assert(rc.filter((r) => r.chosen).map((r) => r.label).join(",") === "On", "Render cache marks only the saved mode");
		const dRows = diffRows();
		assert(dRows.map((r) => r.label).join(",") === "Split,Unified", "Diffs rows: Split then Unified");
		const tlRows = toolLayoutRows();
		assert(tlRows.map((r) => r.label).join(",") === "Grouped,Classic", "Tool layout rows: Grouped then Classic");
		const pl = payloadLimitRows("16 MB");
		assert(pl.map((r) => r.label).join(",") === "Off,1 MB,4 MB,8 MB,16 MB,32 MB,Custom", "Payload limit rows list presets then Custom");
		assert(pl.filter((r) => r.chosen).map((r) => r.label).join(",") === "16 MB", "Payload limit marks the active preset");
		const plCustom = payloadLimitRows("11 MB");
		assert(plCustom.filter((r) => r.chosen).map((r) => r.label).join(",") === "Custom", "Payload limit marks Custom when a non-preset MB is active");
		assert(plCustom[plCustom.length - 1]!.note!.includes("11 MB"), "Custom row displays the active custom MB");
	}
	for (const label of ["Themes", "Headers", "Footers", "Chatbox", "Animations", "Diffs", "Tool layout", "Auto-compact", "Render cache", "Payload limit", "Providers", "Usage", "Budget"]) {
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
	assert(arnativeCompletions("ch")![0]!.value === "chatbox", "chatbox menu has completions");
	assert(MENUS.some((m) => m.value === "chatbox"), "chatbox menu registered");
	assert(arnativeCompletions("co")![0]!.value === "compact", "compact menu has completions");
	assert(MENUS.some((m) => m.value === "compact"), "compact menu registered");

	// The Auto-compact picker marks the saved choice with a green ✓ at the row's end.
	const acRows = autoCompactRows("Smart");
	assert(acRows[0]!.label === "Off" && acRows[1]!.label === "Smart", "labels stay clean — the marker is not part of the label");
	assert(acRows[1]!.chosen === true && acRows[0]!.chosen !== true, "the ✓ follows the saved choice");
	assert(acRows.every((r) => r.note!.length > 0), "every Auto-compact row carries its note");
	assert(autoCompactRows("Off")[0]!.chosen === true, "the marker moves when the saved choice changes");
	assert(arnativeCompletions("re")![0]!.value === "render", "render cache menu has completions");
	assert(MENUS.some((m) => m.value === "render"), "render cache menu registered");
	assert(arnativeCompletions("pa")![0]!.value === "payload", "payload limit menu has completions");
	assert(MENUS.some((m) => m.value === "payload"), "payload limit menu registered");
	assert(arnativeCompletions("pr")![0]!.value === "providers", "providers menu has completions");
	assert(MENUS.some((m) => m.value === "providers"), "providers menu registered");
	// Every slash command, and the one alias: `/providers` must land on the providers screen.
	{
		const registered = new Map<string, { description: string; handler: unknown }>();
		registerCommands({ registerCommand: (name, options) => { registered.set(name, options as never); } } as never);
		assert([...registered.keys()].join(",") === "arnative,providers", "two commands: /arnative and /providers");
		assert(typeof registered.get("providers")!.handler === "function", "/providers has a handler");
		assert(MENUS.some((m) => m.value === "providers"), "/providers routes to a menu row that exists");
		assert(
			registered.get("arnative")!.description === "Arnative settings menu: themes, headers, footers, chatbox, animations, auto-compact, model heal, render cache, payload limit, providers, usage, budget",
			"the /arnative command description names every screen: " + registered.get("arnative")!.description,
		);
	}
	// Usage is reachable from /arnative even though it is a dashboard, not a setting.
	assert(MENUS.some((m) => m.value === "usage"), "usage menu registered");
	assert(arnativeCompletions("us")![0]!.value === "usage", "usage menu has completions");
	assert(typeof MENUS.find((m) => m.value === "usage")!.open === "function", "the usage row opens the dashboard");
	// The Budget row: warn-only caps, enforce on blocks the next turn.
	assert(MENUS.some((m) => m.value === "budget" && typeof m.open === "function"), "budget menu registered");
	assert(arnativeCompletions("b")![0]!.value === "budget", "budget menu has completions");
	assert(
		rowText(labels[labels.length - 1]!) === "Budget · warn-only spend caps on today / 30d; enforce on blocks the next turn",
		"the budget row text is pinned: " + rowText(labels[labels.length - 1]!),
	);

	// The /arnative picker lists the package's family only; everything else (system, dark,
	// light, a theme of the user's own) stays in /settings → Theme.
	assert(isArnativeThemeName("arnative"), "the default theme is family");
	assert(isArnativeThemeName("arnative-cyberpunk"), "a variant is family");
	for (const outsider of ["system", "dark", "light", "omarchy-system", "arnativeX", ""])
		assert(!isArnativeThemeName(outsider), `${JSON.stringify(outsider)} is not family`);

	// The shipped theme is applied only when pi has no theme setting of its own.
	assert(shouldApplyDefaultTheme(undefined, [{ name: "arnative" }]), "an unset theme installs Arnative");
	assert(!shouldApplyDefaultTheme("arnative", [{ name: "arnative" }]), "an explicit Arnative setting is left alone");
	assert(!shouldApplyDefaultTheme("gruvbox", [{ name: "arnative" }]), "a chosen theme is never overridden");
	assert(!shouldApplyDefaultTheme(undefined, [{ name: "dark" }]), "no install when the theme did not load");
	assert(arnativeCompletions("zz") === null, "completions null when nothing matches");

	// Live-preview picker (shared by Themes and Headers): move = preview, Enter = keep, Esc = revert.
	const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const pickerText: ListPickerText = { title: screenTitle("Themes"), description: "sub", legend: "[Esc] Back" };
	const previews: string[] = [];
	let reverted = 0;
	let done = 0;
	// Wrap means one step down from the last row lands on the initial value, leaving
	// nothing for Esc to revert, so the list carries a third row for this assertion.
	const picker = new ListPicker(fakeTheme, nameRows(["arnative", "arnative-cyberpunk", "arnative-mono"]), "arnative", {
		preview: (n) => previews.push(n),
		revert: () => reverted++,
		done: () => done++,
		requestRender: () => {},
	}, pickerText);
	const lines = picker.render(50);
	assert(lines[0]!.startsWith("╭") && lines[lines.length - 1]!.startsWith("╰"), "picker framed");
	assert(lines.every((l) => visibleWidth(l) === 50), "picker lines fit width 50");
	assert(lines.some((l) => l.includes(screenTitle("Themes"))), "picker renders the configured title");
	assert(lines.some((l) => l.includes("❯ arnative")), "the cursor marks the live value");
	assert(!lines.some((l) => l.includes("●")), "no redundant ● column next to the ❯ cursor");
	picker.handleInput("\x1b[B"); // down
	assert(previews.length === 1 && previews[0] === "arnative-cyberpunk", "move previews immediately");
	assert(picker.render(50).some((l) => l.includes("❯ arnative-cyberpunk")), "the cursor follows the preview");
	picker.handleInput("\r"); // enter
	assert(done === 1 && reverted === 0, "Enter keeps (no revert)");
	picker.handleInput("\x1b[B");
	picker.handleInput("\x1b"); // escape
	assert(reverted === 1 && done === 2, "Esc reverts after preview");

	// `←` reports upward instead of closing on a screen with a parent, reverting the live
	// preview first; the root menu has nothing behind it and omits the key.
	assert(LIST_LEGEND_ROOT === "[↑↓] Move  [Enter] Select  [Esc] Close", "root menu legend omits ←");
	assert(LIST_LEGEND_MOVE === "[↑↓] Move  [Enter] Select  [Esc] Back", "submenu legend advertises Esc Back");
	assert(LIST_LEGEND_LIVE === "[↑↓] Preview  [Enter] Select  [Esc] Back", "live legend advertises Esc Back");
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
	childPicker.handleInput("\x1b"); // Esc
	assert(backs === 2 && backReverts === 0, "Esc and ← both report back; the parent owns the revert");
	// The root menu has no parent, so the same keys must still leave the screen.
	let rootCancels = 0;
	const rootPicker = new ListPicker(fakeTheme, nameRows(["a"]), undefined, {
		preview: () => {},
		revert: () => {},
		done: () => {},
		cancel: () => rootCancels++,
		requestRender: () => {},
	}, pickerText, false);
	rootPicker.handleInput("\x1b[D");
	rootPicker.handleInput("\x1b"); // Esc
	assert(rootCancels === 2, "Esc and ← close the root menu, which has no parent");

	// The main menu reuses the picker with preview/revert as no-ops: moving changes no
	// setting, only Enter opens a row. `reverted` proves it.
	let menuReverts = 0;
	let menuCancelled = false;
	const categoryRows = menuRows([...MENU_CATEGORIES]);
	const mainPicker = new ListPicker(fakeTheme, categoryRows, undefined, {
		preview: () => {},
		revert: () => { menuReverts++; },
		done: () => {},
		cancel: () => { menuCancelled = true; },
		requestRender: () => {},
	}, { title: MENU_TITLE, description: MENU_DESC, legend: LIST_LEGEND_ROOT }, false);
	// 120 columns: the description names the screens (a tripwire — a screen added to MENUS must
	// be added to the copy too), and that one-liner no longer fits 100.
	const menuLines = mainPicker.render(120);
	assert(menuLines.some((l) => l.includes(MENU_TITLE)), "the main menu renders its title");
	assert(menuLines.some((l) => l.includes("[Esc] Close") && !l.includes("←")), "the root menu legend renders without a back key");
	assert(menuLines.some((l) => l.includes(MENU_DESC)), "the main menu renders the description under the title");
	assert(menuLines.findIndex((l) => l.includes(MENU_TITLE)) < menuLines.findIndex((l) => l.includes(MENU_DESC)), "description sits below the title");
	assert(menuLines.every((l) => visibleWidth(l) === 120), "main menu lines fit the width");
	// The pinned /arnative layout: `❯ Appearance  ·  themes, headers…`, every `·` in one column.
	const plainMenu = menuLines.map(stripAnsi);
	const row0 = menuLines.map(stripAnsi).find((l) => l.includes("❯ Appearance"))!;
	// The row is `│ ❯ <label padded to the widest label><divider><note>`: assert the shape,
	// not a literal run of spaces, so adding a wider screen cannot break the layout test.
	const widest = Math.max(...MENU_CATEGORIES.map((c) => c.label.length));
	assert(
		row0.startsWith(`│ ❯ ${"Appearance".padEnd(widest)}${ROW_DIVIDER}themes, headers, footers`),
		`menu row layout, got ${JSON.stringify(row0)}`,
	);
	assert(plainMenu.filter((l) => l.includes(ROW_DIVIDER)).every((l) => l.indexOf(ROW_DIVIDER) === row0.indexOf(ROW_DIVIDER)), "every divider sits in one column");
	assert(
		plainMenu.some((l) => l.startsWith(`│   ${"Display".padEnd(widest)}${ROW_DIVIDER}`)),
		"unselected rows indent to the marker column",
	);

	// A menu opened with a `current` row starts there. The handler passes the row it last
	// used, so a submenu reopened by `←` lands back on that row instead of jumping to the
	// top of the list — the cursor is the user's place, not the component's business.
	const resumed = new ListPicker(fakeTheme, categoryRows, "Models & Context", {
		preview: () => {},
		revert: () => {},
		done: () => {},
		requestRender: () => {},
	}, { title: MENU_TITLE, description: MENU_DESC, legend: LIST_LEGEND_ROOT }, false);
	const resumedRows = resumed.render(60).map(stripAnsi);
	assert(resumedRows.some((l) => l.startsWith("│ ❯ Models & Context")), "the menu reopens on the row it was left on");
	assert(!resumedRows.some((l) => l.startsWith("│ ❯ Appearance")), "and not on the first row");

	// The box border follows the session's thinking level (theme `thinking*` slot), so the
	// menu reads as belonging to the active model.
	const tagged = { fg: (c: string, t: string) => `<${c}>${t}</>`, bold: (t: string) => `<bold>${t}</bold>` };
	const thinkingPicker = new ListPicker(tagged, categoryRows, undefined, {
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
	// `❯` marker stays on `accent` so the cursor is still findable when the theme has no accentSoft.
	assert(
		taggedLines.some((l) => l.includes("<accent>❯ </><accentSoft><bold>")),
		"the chosen label is the accentSoft token in bold",
	);
	assert(taggedLines.some((l) => l.includes("<accent>❯ ")), "the ❯ marker keeps the accent voice");
	const offPicker = new ListPicker(tagged, categoryRows, undefined, {
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
	assert(headerLines.some((l) => l.includes("❯ Arnative (Full)")), "headers picker cursors the active preset");
	assert(headerLines.some((l) => l.includes("  Pi (system)")), "headers picker lists the built-in preset");

	// Footers reuses the same picker too.
	assert(FOOTER_PRESETS[0] === "Pi (system)", "built-in footer preset is listed first");
	const footerPicker = new ListPicker(fakeTheme, nameRows(FOOTER_PRESETS), "Pi (system)", { preview: () => {}, revert: () => {}, done: () => {}, requestRender: () => {} }, footersPickerText());
	const footerLines = footerPicker.render(50);
	assert(footerLines.some((l) => l.includes(screenTitle("Footers"))), "footers picker title");
	assert(footerLines.some((l) => l.includes("❯ Pi (system)")), "footers picker cursors the active preset");
	assert(footerLines.some((l) => l.includes("Arnative (Minimal)")), "footers picker lists the minimal preset");
	assert(footerLines.some((l) => l.includes("Zen")), "footers picker lists the Zen preset");
	assert(footerLines.filter((l) => l.includes("Arnative (")).length === 2, "both arnative footer presets are selectable");
	assert(/\[c\] Cost (on|off)/.test(footersPickerText().legend), "footers legend advertises the cost switch and its live state");

	// Chatbox reuses the same picker with summary rows (Box/Icon/Dialog), Pi (system) first and Arnative second.
	assert(CHATBOX_PRESETS[0] === "Pi (system)" && CHATBOX_PRESETS[1] === "Arnative", "chatbox presets list Pi (system) then Arnative");
	assert(CHATBOX_DIALOGS.includes(activeChatboxDialog()), "active chatbox dialog is valid");
	const chatboxTagTheme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
	const chatboxTagged = chatboxSummary(chatboxTagTheme);
	assert(chatboxTagged.some((l) => l.includes("<dim>Box   </dim><dim> · </dim><text>")), "chatbox summary renders dim Box label and separator");
	assert(chatboxTagged.some((l) => l.startsWith("<dim>Icon  </dim><dim> · </dim>") && l.includes(`<accent>${activeChatboxPrompt()}</accent>`) && l.includes("  ") && !l.includes("|")), "chatbox summary highlights the active icon in accent with double spacing and no |");
	const expectedDialogTag = activeChatboxDialog() === DEFAULT_CHATBOX_DIALOG ? " <dim>(default)</dim>" : "";
	assert(chatboxTagged.some((l) => l === `<dim>Dialog</dim><dim> · </dim><text>${activeChatboxDialog().toLowerCase()}</text>${expectedDialogTag}`), "chatbox summary renders dim Dialog label, separator, and default tag");
	const chatboxPicker = new ListPicker(fakeTheme, chatboxRows(), "Arnative", { preview: () => {}, revert: () => {}, done: () => {}, requestRender: () => {}, summary: () => chatboxSummary(fakeTheme) }, CHATBOX_PICKER_TEXT);
	const chatboxLines = chatboxPicker.render(84);
	assert(chatboxLines.some((l) => l.includes(screenTitle("Chatbox"))), "chatbox picker title");
	assert(chatboxLines.some((l) => l.includes("Box    · Arnative")), "chatbox picker shows Box summary");
	assert(chatboxLines.some((l) => l.includes("❯ Arnative")), "chatbox picker cursors the active preset");
	assert(chatboxLines.some((l) => l.includes("  Pi (system)")), "chatbox picker lists the built-in preset");
	assert(CHATBOX_PICKER_TEXT.legend.includes("[i] Icon  [D] Dialog"), "chatbox legend advertises [i] Icon and [D] Dialog");

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

	// Multi-select (Providers → model list): Space toggles, `[x]` marks, the cursor still moves.
	const picked: string[] = [];
	const chosen = new Set<string>(["a"]);
	const multiRows = nameRows(["a", "b", "c"]);
	const multiPicker = new ListPicker(fakeTheme, multiRows, "a", {
		preview: quiet,
		revert: quiet,
		done: quiet,
		requestRender: quiet,
		toggle: () => {
			const label = multiRows[multiPicker.index]!.label;
			if (chosen.has(label)) chosen.delete(label);
			else chosen.add(label);
			picked.push(label);
		},
		marked: (label) => chosen.has(label),
	}, { title: screenTitle("Providers"), description: "pick models", legend: "[Space] Toggle" }, false);
	const multiLines = multiPicker.render(50).map(stripAnsi);
	assert(multiLines.some((l) => l.includes("❯ [x] a")), "a checked row shows [x] behind the cursor");
	assert(multiLines.some((l) => l.includes("[ ] b")), "unchecked rows show [ ]");
	multiPicker.handleInput(" ");
	assert(picked[0] === "a" && !chosen.has("a"), "Space toggles the row under the cursor");
	multiPicker.handleInput("\x1b[B");
	multiPicker.handleInput(" ");
	assert(chosen.has("b"), "Space toggles the row the cursor moved to");
	assert(multiPicker.render(50).map(stripAnsi).some((l) => l.includes("❯ [x] b")), "the check follows the cursor");
	mainPicker.handleInput(" ");
	assert(chosen.has("b") && picked.length === 2, "a screen without the toggle hook ignores Space");

	// Unhandled keys reach the screen's own switch (`press`), and no hook means no route.
	let pressed: string[] = [];
	const pressPicker = new ListPicker(fakeTheme, nameRows(["a", "b", "c"]), "a", {
		preview: quiet,
		revert: quiet,
		done: quiet,
		requestRender: quiet,
		press: (keyData) => pressed.push(keyData),
	}, { title: screenTitle("Providers"), description: "pick models", legend: "[a] API" }, false);
	pressPicker.handleInput("a");
	assert(pressed.length === 1 && pressed[0] === "a", "an unhandled key reaches the screen via press");
	const routed = new ListPicker(fakeTheme, nameRows(["a"]), undefined, {
		preview: quiet,
		revert: quiet,
		done: quiet,
		requestRender: quiet,
	});
	routed.handleInput("a");
	assert(pressed.length === 1, "a screen without press ignores stray letters");

});
