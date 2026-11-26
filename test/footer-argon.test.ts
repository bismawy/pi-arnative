/**
 * Behavioral suite for the Argon footer preset in lib/features/footer.ts.
 *
 * Drives the real extension through a fake `pi` so centered rendering, inline git
 * expansion via `···`, exclusive second-row details, text selection preservation,
 * narrow wrapping, and the keyboard shortcut are verified end to end.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import register, { __test as footerTest } from "../lib/features/footer.ts";
import { getRuntime } from "../lib/runtime.ts";

const FOOTER_PRESET_KEY = Symbol.for("pi-arnative.footerPreset");

type Footer = { render(width: number): string[]; handleMouse?(e: unknown): unknown };

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const shortcuts = new Map<string, () => void>();
let footerFactory: ((tui: unknown, theme: unknown, data: unknown) => Footer) | null = null;

const pi = {
	on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
	registerShortcut: (key: string, opts: { handler: () => void }) => shortcuts.set(key, opts.handler),
	registerCommand: () => {},
	getSettings: () => ({}),
} as never;

const theme = {
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
};

const footerData = {
	getExtensionStatuses: () =>
		new Map([
			["mcp", "MCP: 14 servers enabled"],
			["ponytail", "ponytail: ○ FULL"],
			["jev-eye", "Eye: ● BALANCED (mercury-decide)"],
		]),
	onBranchChange: () => () => {},
	getGitBranch: () => "perf/footer-git-and-render",
};

const tui = { requestRender: () => {}, handleTerminalInput: (_data: string) => {} };

const ctx = {
	cwd: "/home/dev/Pi/pi-arnative",
	model: { id: "gemini-4-neon", name: "Gemini 4 Neon", provider: "Magpie" },
	thinkingLevel: "high",
	ui: {
		setFooter: (f: unknown) => {
			if (typeof f === "function") footerFactory = f as never;
		},
		setEditorComponent: () => {},
		setWorkingIndicator: () => {},
		theme,
	},
	sessionManager: {
		getHeader: () => ({ timestamp: new Date().toISOString() }),
		getEntries: () => [],
		getBranch: () => [
			{
				type: "message",
				message: { role: "assistant", usage: { input: 2500, output: 455, cacheRead: 1200 } },
			},
		],
	},
	getContextUsage: () => undefined,
};

const SAMPLE_GIT = {
	branch: "perf/footer-git-and-render",
	tag: "v0.16.1",
	uncommitted: 3,
	added: 97,
	removed: 24,
	ahead: 0,
	behind: 0,
};

register(pi);
await handlers.get("session_start")!({ reason: "startup" }, ctx);

function argonFooter(gitValue: typeof SAMPLE_GIT | null = SAMPLE_GIT): Footer {
	(globalThis as Record<symbol, unknown>)[FOOTER_PRESET_KEY] = "Argon";
	getRuntime().argonFooterExpanded = null;
	footerTest.git = gitValue;
	assert.ok(footerFactory, "session_start registered a footer factory");
	return footerFactory(tui, theme, footerData);
}

const mouse = (type: string, x: number, y = 0, extra: Record<string, unknown> = {}) => ({
	type,
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 140,
	height: 2,
	shift: false,
	alt: false,
	ctrl: false,
	...extra,
});

/** Visual column (0-based) of the first occurrence of `needle` inside `line`. */
const colOf = (line: string, needle: string): number => {
	const idx = line.indexOf(needle);
	assert.ok(idx >= 0, `expected "${needle}" in "${line}"`);
	return visibleWidth(line.slice(0, idx));
};

test("Argon default renders a single centered row with cwd, clock, model, and dots", () => {
	const footer = argonFooter(SAMPLE_GIT);
	const lines = footer.render(140);
	assert.equal(lines.length, 1, "starts as a single row");
	const row = lines[0]!;
	const leading = row.length - row.trimStart().length;
	assert.ok(leading > 0, "row is centered with leading spaces");
	assert.ok(row.includes("pi-arnative"), "cwd is shown");
	assert.ok(row.includes(" | "), "left and right heads are separated by |");
	assert.ok(row.includes("Gemini 4 Neon"), "model is shown");
	assert.ok(row.trimEnd().endsWith("···"), "dots affordance is shown when git data exists");
	assert.ok(!row.includes("▲") && !row.includes("▼"), "Argon omits Minimal arrows");
	assert.ok(!row.includes("+97") && !row.includes("perf/footer-git-and-render"), "git stays hidden until ··· is clicked");
	assert.ok(!row.includes("MCP:"), "statuses stay hidden until left head is clicked");
});

test("Argon omits ··· when there is no git data", () => {
	const footer = argonFooter(null);
	const lines = footer.render(140);
	assert.equal(lines.length, 1);
	assert.ok(!lines[0]!.includes("···"), "no dots without git data");
});

test("clicking ··· expands and collapses git data inline without double-toggling", () => {
	const footer = argonFooter(SAMPLE_GIT);
	const row0 = footer.render(140)[0]!;
	const dotsX = colOf(row0, "···");

	// Real terminal click sends press -> release -> click: press toggles once, follow-ups swallow.
	const onPress = footer.handleMouse?.(mouse("press", dotsX)) as { handled?: boolean; render?: boolean } | undefined;
	assert.equal(onPress?.handled, true, "press on ··· toggles git immediately");
	assert.equal(onPress?.render, true);
	const onRelease = footer.handleMouse?.(mouse("release", dotsX)) as { handled?: boolean; render?: boolean } | undefined;
	assert.equal(onRelease?.render, false, "release after press is swallowed");
	const onClick = footer.handleMouse?.(mouse("click", dotsX, 0, { clickCount: 1 })) as { handled?: boolean; render?: boolean } | undefined;
	assert.equal(onClick?.render, false, "follow-up click after press is swallowed");

	const expanded = footer.render(140);
	assert.equal(expanded.length, 1, "git expands inline beside ··· when width allows");
	assert.ok(expanded[0]!.includes("+97") && expanded[0]!.includes("-24"), "diff stat appears after ···");
	assert.ok(expanded[0]!.includes("perf/footer-git-and-render"), "branch appears after ···");
	assert.ok(expanded[0]!.includes("v0.16.1"), "tag appears after ···");
	assert.ok(expanded[0]!.includes("~3"), "dirty count appears after ···");

	// Click ··· again at its new centered coordinate to collapse.
	const dotsX2 = colOf(expanded[0]!, "···");
	footer.handleMouse?.(mouse("press", dotsX2));
	footer.handleMouse?.(mouse("release", dotsX2));
	footer.handleMouse?.(mouse("click", dotsX2, 0, { clickCount: 1 }));
	const collapsed = footer.render(140);
	assert.ok(!collapsed[0]!.includes("perf/footer-git-and-render"), "second click on ··· collapses git");
});

test("clicking left and right head segments swaps the centered second row exclusively", () => {
	const footer = argonFooter(SAMPLE_GIT);
	const row0 = footer.render(140)[0]!;
	const leftX = colOf(row0, "pi-arnative");
	const rightX = colOf(row0, "Gemini 4 Neon");

	// Press on text returns undefined so Pi handles drag/double-click text selection.
	assert.equal(footer.handleMouse?.(mouse("press", leftX)), undefined, "press on left text leaves selection to Pi");
	// Double-click does not toggle.
	assert.equal(footer.handleMouse?.(mouse("click", leftX, 0, { clickCount: 2 })), undefined, "double-click does not toggle");

	// Single-click on left head opens the centered status row.
	const leftClick = footer.handleMouse?.(mouse("click", leftX, 0, { clickCount: 1 })) as { handled?: boolean } | undefined;
	assert.equal(leftClick?.handled, true);
	const withLeft = footer.render(140);
	assert.equal(withLeft.length, 2, "left detail adds a second row");
	assert.ok(withLeft[1]!.length - withLeft[1]!.trimStart().length > 0, "second row is centered");
	assert.ok(withLeft[1]!.includes("MCP: 14 servers enabled"), "MCP status is visible");
	assert.ok(withLeft[1]!.includes("ponytail:"), "ponytail status is visible");
	assert.ok(withLeft[1]!.includes("Eye:"), "Eye status is visible");

	// Single-click on right head replaces row 2 with metrics (never grows to 3 rows).
	const rightClick = footer.handleMouse?.(mouse("click", rightX, 0, { clickCount: 1 })) as { handled?: boolean } | undefined;
	assert.equal(rightClick?.handled, true);
	const withRight = footer.render(140);
	assert.equal(withRight.length, 2, "right detail replaces left detail on row 2");
	assert.ok(withRight[1]!.length - withRight[1]!.trimStart().length > 0, "metrics row is centered");
	assert.ok(!withRight[1]!.includes("MCP:"), "left status row is replaced");
	assert.ok(withRight[1]!.includes("↑2.5k") && withRight[1]!.includes("↓455"), "token metrics are visible");

	// Clicking right head again collapses row 2 back to 1 row.
	footer.handleMouse?.(mouse("click", rightX, 0, { clickCount: 1 }));
	assert.equal(footer.render(140).length, 1, "clicking active head again collapses row 2");
});

test("blank margin and middle separator stay inert on click", () => {
	const footer = argonFooter(SAMPLE_GIT);
	const row0 = footer.render(140)[0]!;
	const pipeX = colOf(row0, "|");
	assert.equal(footer.handleMouse?.(mouse("click", 0, 0, { clickCount: 1 })), undefined, "left margin is inert");
	assert.equal(footer.handleMouse?.(mouse("click", pipeX, 0, { clickCount: 1 })), undefined, "middle | divider is inert");
	assert.equal(footer.handleMouse?.(mouse("click", 139, 0, { clickCount: 1 })), undefined, "right margin is inert");
	assert.equal(footer.render(140).length, 1, "inert clicks leave Argon collapsed");
});

test("keyboard shortcut cycles Argon through left+git, right+git, and collapsed", () => {
	const footer = argonFooter(SAMPLE_GIT);
	const toggle = [...shortcuts.values()][0];
	assert.ok(toggle, "toggle footer shortcut is registered");

	assert.equal(footer.render(140).length, 1);
	toggle();
	const s1 = footer.render(140);
	assert.equal(s1.length, 2);
	assert.ok(s1[0]!.includes("perf/footer-git-and-render"), "first keypress opens git inline");
	assert.ok(s1[1]!.includes("MCP: 14 servers enabled"), "first keypress opens left statuses");

	toggle();
	const s2 = footer.render(140);
	assert.equal(s2.length, 2);
	assert.ok(s2[0]!.includes("perf/footer-git-and-render"), "second keypress keeps git open");
	assert.ok(s2[1]!.includes("↑2.5k"), "second keypress switches row 2 to metrics");

	toggle();
	const s3 = footer.render(140);
	assert.equal(s3.length, 1);
	assert.ok(!s3[0]!.includes("perf/footer-git-and-render"), "third keypress collapses everything");
});
