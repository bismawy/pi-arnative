/**
 * Visual suite for extensions/section-headers.ts.
 *
 * Moved out of the module's in-file self-check: the same assertions, but every one gets a
 * name in the `node --test` report, and 31% of the shipped file stops being test code.
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	activeHeaderPreset,
	ArnativeHeader,
	buildLogoLines,
	centerLine,
	DEFAULT_HEADER_PRESET,
	deviceUser,
	extensionIssuesLines,
	extractItemsFromBody,
	formatModelDisplayName,
	HEADER_PRESETS,
	installedVersion,
	packageNameOf,
	resourcesListingShown,
	sectionBodyOf,
	sectionNameOf,
	setHeaderPreset,
	tabStore,
	wrapCommaItems,
	wrapPath,
	type TabKey,
} from "../extensions/section-headers.ts";
import { setActiveTheme, stripAnsi } from "../lib/ansi.ts";
import { capitalize, markedLabels } from "../lib/format.ts";
import { HEADER_PRESET_KEY as HEADER_PRESET_CONFIG_KEY, loadChoice, resetPresetCache } from "../lib/preset-store.ts";
import { SHORTCUT_RELOAD } from "../lib/shortcuts.ts";

// The module keeps its share of this globally shared switch private; Symbol.for is the
// cross-module contract here (extensions/footer.ts registers the same key).
const HEADER_PRESET_KEY = Symbol.for("pi-arnative.headerPreset");

test("section-headers visual suite", () => {
	assert(sectionNameOf("\x1b[33m[Skills]\x1b[39m\n  a, b") === "Skills", "header [Skills] detected");
	assert(sectionNameOf("pi v0.87.1") === null, "non-section text is not detected");

	// Header presets: Arnative (Full) is the default; Pi (system) hands the header slot back to pi.
	assert(DEFAULT_HEADER_PRESET === "Arnative (Full)" && HEADER_PRESETS.length === 2, "Arnative (Full) is the default header preset");
	assert(HEADER_PRESETS.join(" | ") === "Pi (system) | Arnative (Full)", "built-in preset is listed first");
	assert(markedLabels(HEADER_PRESETS, "Arnative (Full)").join(" | ") === "  Pi (system) | ● Arnative (Full)", "preset labels mark the active one");
	// Persisting a preset writes a config file: point it at a fixture so the real agent dir stays clean.
	const presetFixture = mkdtempSync(join(tmpdir(), "arnative-hdr-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = presetFixture;
	resetPresetCache();
	let installed: unknown = "untouched";
	const presetCtx: any = { ui: { setHeader: (factory: unknown) => { installed = factory; } } };
	setHeaderPreset("Pi (system)", presetCtx);
	assert(installed === undefined && activeHeaderPreset() === "Pi (system)", "Pi (system) clears the custom header");
	setHeaderPreset("Arnative (Full)", presetCtx);
	assert(typeof installed === "function" && activeHeaderPreset() === "Arnative (Full)", "Arnative (Full) installs the header factory");
	// Persist a NON-default value: asserting the default survives proves nothing.
	setHeaderPreset("Pi (system)", presetCtx);
	assert(loadChoice(HEADER_PRESET_CONFIG_KEY, HEADER_PRESETS) === "Pi (system)", "the header preset is persisted to disk");
	delete (globalThis as Record<symbol, unknown>)[HEADER_PRESET_KEY];
	resetPresetCache();
	assert(activeHeaderPreset() === "Pi (system)", "a restart reads the non-default preset back from disk");
	rmSync(presetFixture, { recursive: true, force: true });
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	resetPresetCache();

	// Parsing & wrapping
	assert(extractItemsFromBody("  a, b, c").length === 3, "extractItemsFromBody splits 3 comma items");
	assert(extractItemsFromBody("  x\n  y\n  z").length === 3, "extractItemsFromBody returns 3 lines");

	// Directory path wrapping: never truncated, always the full path
	const wp = wrapPath("/run/media/bisma/DATA/Pi/pi-arnative", 20);
	assert(wp.join("") === "/run/media/bisma/DATA/Pi/pi-arnative", "wrapPath drops no segment");
	assert(wp.every((l) => visibleWidth(l) <= 20), "wrapPath respects the width");
	assert(wrapPath("D:\\Pi\\pi-arnative", 80).join("") === "D:/Pi/pi-arnative", "wrapPath normalizes backslashes");
	assert(wrapPath("/a/very-long-segment-name", 6).every((l) => visibleWidth(l) <= 6), "long segment is sliced");

	const wrapTest = wrapCommaItems(["item1", "item2", "item3", "item4"], 15);
	assert(wrapTest.length >= 2, "wrapCommaItems wraps into lines");
	assert(visibleWidth(wrapTest[0]!) <= 15, "wrapped line width within the limit");

	const cLine = centerLine("test", 20);
	assert(visibleWidth(cLine) === 20, "centerLine is exactly 20 columns");
	assert(cLine.startsWith("│") && cLine.endsWith("│"), "centerLine starts and ends with │");

	// Model name formatting
	assert(
		formatModelDisplayName({ name: "Gemini 3.8 Flash", provider: "antigravity" }) ===
			"Gemini 3.8 Flash (Antigravity)",
		"formatModelDisplayName with name and provider",
	);
	assert(
		formatModelDisplayName({ id: "deepseek-v4.1-flash", provider: "yarz" }) ===
			"Deepseek V4.1 Flash (Yarz)",
		"formatModelDisplayName converts id to titlecase",
	);

	// Package & version resolver
	assert(packageNameOf("@bismawy/pi-agentrouter") === "@bismawy/pi-agentrouter", "plain npm label");
	assert(packageNameOf("footer.ts") === "footer.ts", "local label");

	const gitTmp = mkdtempSync(join(tmpdir(), "pi-ver-"));
	mkdirSync(join(gitTmp, "git", "github.com", "test/arnative"), { recursive: true });
	writeFileSync(join(gitTmp, "git", "github.com", "test/arnative", "package.json"), JSON.stringify({ version: "9.9.9" }));
	assert(installedVersion("test/arnative", join(gitTmp, "npm"), join(gitTmp, "git")) === "9.9.9", "version from the git clone");
	rmSync(gitTmp, { recursive: true, force: true });

	// ArnativeHeader component & mouse tab click
	tabStore.set("Context", ["AGENTS.md"]);
	tabStore.set("Skills", ["agents-sdk", "cloudflare"]);
	tabStore.set("Extensions", ["@bismawy/pi-agentrouter@1.6.1", "footer.ts"]);

	let renderRequested = false;
	const fakeTui: any = {
		requestRender: () => {
			renderRequested = true;
		},
	};
	const fakeCtx: any = {
		model: { name: "Gemini 3.8 Flash", provider: "antigravity" },
		thinkingLevel: "low",
		cwd: "/run/media/bisma/DATA/Pi/pi-arnative",
	};

	// Only "dim" is colored, so the box line colors can be asserted.
	const ansiTheme = { fg: (c: string, t: string) => (c === "dim" ? `\x1b[2m${t}\x1b[22m` : t) };

	// Counts come from pi's loaded-resource listing. With `quietStartup: true | "header"`
	// pi skips that listing, so the counts are unknown — shown as "—", never a misleading 0.
	resourcesListingShown(false);
	tabStore.set("Context", []);
	tabStore.set("Skills", []);
	tabStore.set("Extensions", []);
	const hdrQuiet = new ArnativeHeader(fakeTui, ansiTheme, fakeCtx);
	assert(hdrQuiet.getTabsData(120).map((t) => t.label).join("|").includes("Skills [—]"), "hidden listing: counts render as —, not 0");
	hdrQuiet.activeTab = "Skills";
	assert(
		hdrQuiet.render(120).some((l) => stripAnsi(l).includes("(not tracked")),
		"hidden listing: empty tab explains itself instead of a bare (empty)",
	);
	resourcesListingShown(true);
	assert(new ArnativeHeader(fakeTui, ansiTheme, fakeCtx).getTabsData(120).some((t) => t.label === "Skills [0]"), "shown listing: 0 is a real count again");
	tabStore.set("Context", ["AGENTS.md"]);
	tabStore.set("Skills", ["agents-sdk", "cloudflare"]);
	tabStore.set("Extensions", ["@bismawy/pi-agentrouter@1.6.1", "footer.ts"]);
	const hdr = new ArnativeHeader(fakeTui, ansiTheme, fakeCtx);
	assert(hdr.activeTab === "Directory", "default tab is Directory");

	// Default view: the working directory path, shown on open
	const linesDefault = hdr.render(100);
	assert(stripAnsi(linesDefault[5]!).includes("/run/media/bisma/DATA/Pi/pi-arnative"), "directory path shown as soon as the first tab opens");

	hdr.activeTab = "Model";
	const lines100 = hdr.render(100);
	assert(lines100.length === 7, "render 100 = border + 5 rows + border (left: mark + gap + pi version; info: brand line + tab box + data)");
	assert(lines100.every((l) => visibleWidth(l) === 100), "every line at width 100 is exactly 100 columns");
	assert(lines100[0]!.includes("╭") && lines100[0]!.includes("╮"), "round top border");
	assert(lines100[6]!.includes("╰") && lines100[6]!.includes("╯"), "round bottom border");
	// The column divider joins the frame: full-height split, no gap at the borders.
	const jx = stripAnsi(lines100[0]!).indexOf("┬");
	assert(jx > 0 && stripAnsi(lines100[6]!).indexOf("┴") === jx, "┬/┴ junctions sit on the border at the divider column");
	assert(
		lines100.slice(1, 6).every((l) => stripAnsi(l)[jx] === "│"),
		"the divider sits in the same column on every row",
	);
	const logoPlain = buildLogoLines(null);
	assert(logoPlain.length === 4 && visibleWidth(logoPlain[0]!) === 8, "pi block mark intact (4 lines x 8 columns)");
	// P (columns 0-2) accent, i (the right bar) soft — the old wordmark's two-tone.
	const logoTagged = buildLogoLines({
		fg: (c: string, t: string) => (c === "accent" ? `<A>${t}</A>` : c === "accentSoft" ? `<T>${t}</T>` : t),
	} as any);
	assert(logoTagged[0] === "<A>██████</A>  ", "mark top row: P in the theme accent");
	assert(logoTagged[2] === "<A>████</A>  <T>██</T>", "mark lower rows: P accent + i (right bar) soft");
	assert(
		lines100.slice(1, 5).every((l, i) => stripAnsi(l).slice(2, 10) === logoPlain[i]),
		"pi block mark in the left column, 4 lines",
	);
	assert(
		/Welcome back, \S/.test(stripAnsi(lines100[1]!)) && !stripAnsi(lines100[1]!).includes("pi v"),
		"line 1: greeting uses the device username",
	);
	// Left column: the pi version sits directly under the mark (no gap).
	assert(stripAnsi(lines100[5]!).slice(2, 12).includes("pi v"), "pi version sits under the mark in the left column");
	// Info column: brand + greeting, then the tab box straight away (no blank line).
	assert(/Arnative v\d+\.\d+\.\d+ · Welcome back, \S/.test(stripAnsi(lines100[1]!)), "info line 1: Arnative version · Welcome back, user");
	assert(!stripAnsi(lines100[2]!).includes("Menu"), "tab box border carries no label");
	// Tab box separators join its borders: ┬ above and ┴ below each "│". Compare by display
	// column, not string index: the tab icons are astral (2 code units, 1 column).
	const atColumn = (line: string, col: number): string | undefined => {
		let c = 0;
		for (const ch of stripAnsi(line)) {
			const w = visibleWidth(ch);
			if (col >= c && col < c + w) return ch;
			c += w;
		}
		return undefined;
	};
	const tabSepCols = [...stripAnsi(lines100[2]!).matchAll(/┬/g)].map((m) => visibleWidth(stripAnsi(lines100[2]!).slice(0, m.index)));
	assert(tabSepCols.length >= 2, "tab box top border has ┬ at each column divider");
	assert(
		tabSepCols.every((c) => atColumn(lines100[3]!, c) === "│" && atColumn(lines100[4]!, c) === "┴"),
		"each tab divider is full height (┬ / │ / ┴ in the same column)",
	);
	assert(!stripAnsi(lines100[1]!).includes("Interrupt"), "shortcut legend no longer on the top line");
	// Both brand names use the theme accent, not only "pi".
	const accentTheme = {
		fg: (c: string, t: string) => (c === "accent" ? `<A>${t}</A>` : c === "dim" ? `<D>${t}</D>` : t),
	};
	const accentHeader = new ArnativeHeader(fakeTui, accentTheme as any, fakeCtx);
	// The marker theme returns literal "<A>" text (not ANSI), so the measured width is
	// inflated — render wide enough that the brand/greeting line is not truncated.
	const accentLines = accentHeader.render(140);
	assert(accentLines[5]!.includes("<A>\x1b[1mpi"), "the pi name uses the theme accent");
	assert(accentLines[1]!.includes("<A>\x1b[1mArnative"), "the Arnative name uses the same theme accent");
	const greetLine = accentHeader.render(140)[1]!;
	assert(greetLine.includes("<D>Welcome back,"), "greeting text uses the dim color");
	assert(greetLine.includes(`<A>\x1b[1m${capitalize(deviceUser())}`), "device username uses the theme accent, first letter capitalized");
	assert(stripAnsi(lines100[3]!).includes("Model [Gemini 3.8 Flash]"), "Model tab in the menu (Model [name])");
	// Directory tab: name only in the menu, whole path in the content line below
	hdr.activeTab = "Directory";
	hdr.render(100);
	assert(stripAnsi(lines100[3]!).includes("Directory"), "Directory tab shown in the menu");
	assert(!stripAnsi(lines100[3]!).includes("Directory: /"), "Directory menu entry has no path (detail only on click)");
	assert(stripAnsi(lines100[3]!).indexOf("Directory") < stripAnsi(lines100[3]!).indexOf("Model ["), "Directory tab is leftmost");
	hdr.activeTab = "Model";
	hdr.render(100);
	assert(stripAnsi(lines100[5]!).includes("Gemini 3.8 Flash (Antigravity)"), "active Model tab data on the last info line");
	// Directory tab content: full path, wrapped, nothing lost
	hdr.activeTab = "Directory";
	const linesDir = hdr.render(100);
	const dirContent = stripAnsi(linesDir[5]!);
	assert(dirContent.includes("/run/media/bisma"), "full Directory tab path (start) shown");
	assert(dirContent.includes("pi-arnative"), "full Directory tab path (end) shown — no truncation");
	hdr.activeTab = "Model";
	hdr.render(100);
	// Tab box borders are a single fully dimmed block (the "─"/"┬"/"┴" runs are colored too).
	assert((lines100[4]!.match(/\x1b\[/g) ?? []).length === 8, "bottom box line (row 4) = one fully dimmed block");
	assert(
		lines100[2]!.includes("\x1b[2m╭─") && lines100[2]!.includes("┬") && lines100[2]!.includes("╮\x1b[22m"),
		"tab box top border = one dim block carrying the ┬ junctions",
	);

	// Tab regions: Model, Context, Skills, Extensions
	const tabY = (hdr as any).renderedTabLineY;
	assert(tabY > 0, "tab line Y position recorded");
	const tabRegions = (hdr as any).renderedTabRegions as Array<{ key: TabKey; startX: number; endX: number }>;
	assert(tabRegions.length >= 3, "tab regions filled (right tabs may be cut at 100 columns)");
	assert(tabRegions.some((r) => r.key === "Directory"), "Directory tab present in the menu (width 100)");

	// Click the Extensions tab (when truncated at 100 columns, use the rightmost tab)
	const extRegion = tabRegions.find((r) => r.key === "Extensions") ?? tabRegions[tabRegions.length - 1]!;
	const clickExt = hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((extRegion.startX + extRegion.endX) / 2),
		y: tabY,
	} as any);
	assert(clickExt?.handled === true, "mouse click on the tab is handled");
	assert(hdr.activeTab === extRegion.key, "activeTab switches to the clicked tab");
	assert(renderRequested === true, "requestRender called when the tab switches");

	const linesExt = hdr.render(100);
	assert(stripAnsi(linesExt[5]!).includes(extRegion.key === "Extensions" ? "@bismawy/pi-agentrouter@1.6.1" : ""), "active tab data on the last info line");

	// Click the Skills tab (measured at a width where every tab fits)
	const wide = hdr.render(140);
	const wideRegions = (hdr as any).renderedTabRegions as Array<{ key: TabKey; startX: number; endX: number }>;
	const skillsRegion = wideRegions.find((r) => r.key === "Skills") ?? wideRegions[wideRegions.length - 1]!;
	hdr.activeTab = "Model";
	hdr.render(140);
	const skillsY = (hdr as any).renderedTabLineY;
	hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((skillsRegion.startX + skillsRegion.endX) / 2),
		y: skillsY,
	} as any);
	assert(hdr.activeTab === skillsRegion.key, `activeTab switches to ${skillsRegion.key} after the click`);

	const linesSkills = hdr.render(140);
	assert(wide.every((l) => visibleWidth(l) === 140), "lines at 140 columns stay 140");
	assert(wideRegions.length === 6, "width 140: all 6 tabs shown (Shortcut included)");
	if (skillsRegion.key === "Skills") {
		assert(linesSkills[5]!.includes("agents-sdk, cloudflare"), "Skills tab data on the last info line");
		assert(!linesSkills[5]!.includes("Gemini 3.8 Flash (Antigravity)"), "Model data not shown in the Skills tab content");
		assert(linesSkills[3]!.includes("Model [Gemini 3.8 Flash]"), "tab menu still shown while another tab is active");
	}

	// The Y of a tab must point at the tab menu line, not the line above
	const rowsPlain = lines100.map((l) => stripAnsi(l));
	assert(rowsPlain[tabY]!.includes("Model ["), "renderedTabLineY points at the tab menu line");
	assert(tabRegions.every((r) => rowsPlain[tabY]!.slice(r.startX, r.endX + 1).includes(r.key === "Model" ? "Model [" : r.key)), "tab regions align with the text on that line");

	// Shortcut tab: the key cheatsheet lives in the tab content, not in a header line
	hdr.activeTab = "Shortcut";
	const linesShortcut = hdr.render(170);
	assert(
		((hdr as any).renderedTabRegions as Array<{ key: TabKey }>).some((r) => r.key === "Shortcut"),
		"width 170: Shortcut tab shown (not dropped)",
	);
	const scContent = stripAnsi(linesShortcut.slice(5).join(" "));
	assert(scContent.includes("[Esc] Interrupt"), "Shortcut tab: legend moved into the content");
	assert(
		scContent.includes(`[${SHORTCUT_RELOAD.label}] Reload`),
		`Shortcut tab: reload shortcut present in the content (${SHORTCUT_RELOAD.label})`,
	);
	assert(stripAnsi(linesShortcut[1]!).includes("Arnative v"), "the Arnative brand stays on line 1 while the Shortcut tab is active");
	hdr.activeTab = "Model";
	hdr.render(140);

	// Narrow screen: brand lines + tabs + data stay intact, rightmost tabs are dropped
	const narrow = hdr.render(60);
	assert(narrow.every((l) => visibleWidth(l) === 60), "lines at 60 columns stay 60");
	assert(stripAnsi(narrow[1]!).includes("Welcome back,"), "greeting stays intact at 60 columns");
	assert(stripAnsi(narrow[1]!).includes("Arnative v"), "Arnative brand intact at 60 columns");
	assert(stripAnsi(narrow[1]!).includes("Interrupt") === false, "legend does not come back to the top line");
	assert(
		!((hdr as any).renderedTabRegions as Array<{ key: TabKey }>).some((r) => r.key === "Shortcut"),
		"rightmost tab dropped at 60 columns",
	);
	assert(stripAnsi(narrow[3]!).includes("Model ["), "Model tab still shown at 60 columns");

	// Intercept addChild: capture the data and suppress the child
	const proto = Object.getPrototypeOf(UserMessageComponent.prototype) as { addChild?: unknown };
	const container: any = { children: [] as any[], addChild: proto.addChild as (c: any) => unknown };
	const fakeSection = {
		getCollapsedText: () => "[Skills]\n  new-skill-1, new-skill-2",
		getExpandedText: () => "[Skills]\n  new-skill-1, new-skill-2",
		setText: () => {},
		render: (_w: number) => ["should be hidden"],
	};
	container.addChild(fakeSection);
	assert(fakeSection.render(80).length === 0, "child of loadedResourcesContainer suppressed (render = [])");
	assert(tabStore.get("Skills")?.includes("new-skill-1") === true, "new data lands in tabStore");

	// pi 0.99 ExpandableText shape: `build` callback + `state` object, no getters.
	const modernSection = {
		state: { expanded: false },
		build: () => "[Context]\n  AGENTS.md, MEMORY.md",
		setText: () => {},
		render: (_w: number) => ["should be hidden"],
	};
	container.addChild(modernSection);
	assert(modernSection.render(80).length === 0, "pi 0.99 section suppressed (build + state shape)");
	assert(tabStore.get("Context")?.includes("MEMORY.md") === true, "pi 0.99 section data lands in tabStore");

	// Startup help block is not a resource section and must survive untouched.
	const helpBlock = { build: () => "\u2580\u2580\u2588  v0.99.1\n\u2588\u2580 \u2588 escape interrupt", state: { expanded: false }, render: () => ["help"] };
	container.addChild(helpBlock);
	assert(sectionBodyOf(helpBlock) === "\u2580\u2580\u2588  v0.99.1\n\u2588\u2580 \u2588 escape interrupt", "sectionBodyOf reads the build shape");
	assert(sectionNameOf(sectionBodyOf(helpBlock)!) === null, "startup help block is not a resource section");

	// pi's "[Extension issues]" diagnostic renders while the installing module's theme is
	// still null (a `/reload` copy never saw session_start). The box must draw uncolored,
	// not deref null — that crash was reported in the wild.
	setActiveTheme(null);
	const issuesChild = { build: () => "[Extension issues]\n  extension \"x\" failed", render: (_w: number) => ["[Extension issues]", '  extension "x" failed'] };
	container.addChild(issuesChild);
	const plainIssues = issuesChild.render(80);
	assert(plainIssues.length === 4, "extension-issues box is a 2-row box with frame");
	assert(plainIssues[0]!.startsWith("\u256d") && plainIssues.at(-1)!.startsWith("\u2570"), "box frame stays intact");
	assert(plainIssues[1]!.includes("Extension issues") && !plainIssues[1]!.includes("[Extension issues]"), "title drops pi's brackets");
	assert(plainIssues[1]!.includes("") && plainIssues[1]!.includes("to expand"), "title carries the warning icon and the expand hint");
	assert(plainIssues[2]!.includes('extension "x" failed'), "row 2 is the extension path, not the conflict prose");

	// The theme proxy is globalThis-backed, so the copy that owns the addChild patch still
	// paints once the other copy's session_start has stored the theme.
	setActiveTheme({ fg: (c: string, t: string) => `<${c}>${t}</${c}>` });
	const coloredChild = { build: () => "[Extension issues]\n  extension \"x\" failed", render: (_w: number) => ["[Extension issues]", '  extension "x" failed'] };
	container.addChild(coloredChild);
	const coloredIssues = coloredChild.render(80);
	assert(coloredIssues[1]!.includes("<warning>"), "shared theme proxy colors the box title even in the patched copy");
	assert(coloredIssues[1]!.includes("<dim>"), "the expand hint stays dim");

	// Narrow terminal: the box never overflows, and the title truncates instead of wrapping.
	const issuesRows = ["[Extension issues]", '  extension "x" failed'];
	const narrowIssues = extensionIssuesLines(null, 24, issuesRows, "[ctrl+o to expand]");
	assert(narrowIssues.every((l) => visibleWidth(l) === 24), "every box line is exactly 24 columns");

});
