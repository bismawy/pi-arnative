/**
 * Behavioral suite for the Arnative (Minimal) footer in extensions/footer.ts.
 *
 * Drives the real extension through a fake `pi` (only the host API is faked — the
 * footer component, its layout, its hit zones and its click handling are the shipped
 * code) so the disclosure is tested the way a user meets it: render, click, render.
 */
import assert from "node:assert/strict";
import test from "node:test";
import register from "../extensions/footer.ts";

const FOOTER_PRESET_KEY = Symbol.for("pi-arnative.footerPreset");
const EXPAND_KEY = Symbol.for("pi-arnative.minimalFooter.expanded");

type Footer = { render(width: number): string[]; handleMouse?(e: unknown): unknown };

/** Build the extension once: its handlers are registered per process. */
const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
let footerFactory: ((tui: unknown, theme: unknown, data: unknown) => Footer) | null = null;

const pi = {
	on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
	registerShortcut: () => {},
	registerCommand: () => {},
	getSettings: () => ({}),
} as never;

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const footerData = {
	getExtensionStatuses: () => new Map([["mcp", "MCP: 3 servers enabled"]]),
	onBranchChange: () => () => {},
	getGitBranch: () => "main",
};
const tui = { requestRender: () => {} };

const ctx = {
	// A fixed path, not `process.cwd()`: the renderer shortens the cwd (`shortenCwd`),
	// so a runner whose checkout lives elsewhere would assert on different text. The
	// suite must pass in CI (/home/runner/work/...) and in a local checkout alike.
	cwd: "/home/dev/Pi/pi-arnative",
	model: { id: "deepseek-v4.1-flash", name: "Deepseek V4.1 Flash", provider: "Wally" },
	thinkingLevel: "low",
	ui: {
		setFooter: (f: unknown) => {
			if (typeof f === "function") footerFactory = f as never;
		},
		setEditorComponent: () => {},
		theme,
	},
	sessionManager: {
		getHeader: () => ({ timestamp: new Date().toISOString() }),
		// One assistant message so the metrics side has something to show.
		getBranch: () => [{ type: "message", message: { role: "assistant", usage: { input: 1200, output: 500, cacheRead: 0 } } }],
	},
	getContextUsage: () => undefined,
};

register(pi);
await handlers.get("session_start")!({ reason: "startup" }, ctx);

/** A footer component built for the given preset. */
function footerFor(preset: string): Footer {
	(globalThis as Record<symbol, unknown>)[FOOTER_PRESET_KEY] = preset;
	delete (globalThis as Record<symbol, unknown>)[EXPAND_KEY];
	assert.ok(footerFactory, "session_start registered a footer factory");
	return footerFactory(tui, theme, footerData);
}

const mouse = (type: string, x: number) => ({
	type,
	button: "left",
	x,
	y: 0,
	screenX: x,
	screenY: 0,
	width: 100,
	height: 1,
	shift: false,
	alt: false,
	ctrl: false,
});

test("the minimal preset lists a collapsed head row for each side", () => {
	const footer = footerFor("Arnative (Minimal)");
	const lines = footer.render(100);
	assert.equal(lines.length, 1, "starts as a single head row");
	assert.ok(lines[0]!.includes("▲"), "both heads show the collapsed arrow");
	assert.ok(lines[0]!.includes("pi-arnative"), "the cwd head is visible");
	assert.ok(lines[0]!.includes("Deepseek V4.1 Flash"), "the model head is visible");
	assert.ok(!lines[0]!.includes("MCP"), "statuses stay hidden while collapsed");
});

test("the left head is clickable anywhere, not only on its arrow", () => {
	const footer = footerFor("Arnative (Minimal)");
	const head = footer.render(100)[0]!;
	const leftX = head.indexOf("▲");
	assert.ok(leftX > 0, "left arrow column found");
	// Click the cwd text itself, far from the arrow.
	const textX = head.indexOf("pi-arnative");
	footer.handleMouse!(mouse("press", textX));
	footer.handleMouse!(mouse("click", textX));

	const lines = footer.render(100);
	assert.ok(lines.some((l) => l.includes("MCP")), "clicking the head text opens the left side");
	assert.ok(!lines.some((l) => l.includes("↑")), "metrics stay closed");
});

test("the right head is clickable anywhere, not only on its arrow", () => {
	const footer = footerFor("Arnative (Minimal)");
	const head = footer.render(100)[0]!;
	const modelX = head.indexOf("Deepseek");
	assert.ok(modelX > 0, "model text column found");
	footer.handleMouse!(mouse("press", modelX));
	footer.handleMouse!(mouse("click", modelX));

	const lines = footer.render(100);
	assert.ok(lines.some((l) => l.includes("↑1.2k")), "clicking the model text opens the right side");
	assert.ok(!lines.some((l) => l.includes("MCP")), "statuses stay closed");
});

test("the left arrow opens only the left side", () => {
	const footer = footerFor("Arnative (Minimal)");
	const leftX = footer.render(100)[0]!.indexOf("▲");
	assert.ok(leftX > 0, "left arrow column found");
	footer.handleMouse!(mouse("press", leftX));
	footer.handleMouse!(mouse("click", leftX));

	const lines = footer.render(100);
	assert.ok(lines.some((l) => l.includes("MCP")), "statuses appear");
	assert.ok(!lines.some((l) => l.includes("↑")), "metrics stay closed");
});

test("the right arrow opens only the right side", () => {
	const footer = footerFor("Arnative (Minimal)");
	footer.handleMouse!(mouse("press", 98));
	footer.handleMouse!(mouse("click", 98));

	const lines = footer.render(100);
	assert.ok(lines.some((l) => l.includes("↑1.2k")), "metrics appear");
	assert.ok(!lines.some((l) => l.includes("MCP")), "statuses stay closed");
	assert.ok(lines[0]!.endsWith("▼"), "the opened head switches to ▼");
});

test("the click zones track the real rendered row at every width", () => {
	for (const width of [40, 60, 80, 100, 120, 160, 200]) {
		const footer = footerFor("Arnative (Minimal)");
		const row = footer.render(width)[0]!;
		const plain = row.replace(/\x1b\[[0-9;]*m/g, "");

		// Press-only: `handled` marks a live zone without toggling anything.
		const live: number[] = [];
		for (let x = 0; x < width; x++) {
			if (footer.handleMouse!(mouse("press", x)) !== undefined) live.push(x);
		}

		// One run per head, and the right head is always flush to the terminal edge.
		const runs: number[][] = [];
		for (const x of live) {
			const last = runs[runs.length - 1];
			if (last && x === last[last.length - 1]! + 1) last.push(x);
			else runs.push([x]);
		}
		assert.ok(runs.length <= 2, `width ${width}: at most one zone per head (${runs.length} runs)`);
		assert.equal(runs[runs.length - 1]!.at(-1), width - 1, `width ${width}: the right head is clickable to the edge`);

		// Whatever sits between the two zones is inert: it is the blank gap, and a click
		// there must do nothing. (Blank cells *inside* a head are part of that head.)
		if (runs.length === 2) {
			const gap = runs[1]![0]! - runs[0]!.at(-1)! - 1;
			assert.ok(gap >= 0, `width ${width}: zones stay ordered`);
			if (gap > 0) {
				for (let x = runs[0]!.at(-1)! + 1; x < runs[1]![0]!; x++) {
					assert.ok(!live.includes(x), `width ${width}: column ${x} of the gap is inert`);
				}
			}
		}

		// The model text is always inside a zone, whatever the width.
		const modelAt = plain.indexOf("Deepseek");
		if (modelAt > 0) assert.ok(live.includes(modelAt), `width ${width}: the model text is clickable`);
	}
});

test("a click in the blank gap does nothing", () => {
	const footer = footerFor("Arnative (Minimal)");
	const head = footer.render(100)[0]!;
	const arrowX = head.lastIndexOf("▲");
	const gapX = arrowX + 6; // blank cells after the left head, before the model text
	assert.ok(!head.slice(gapX, gapX + 1).trim(), "the probed cell is blank");
	assert.equal(footer.handleMouse!(mouse("press", gapX)), undefined, "press on the gap is ignored");
	assert.equal(footer.handleMouse!(mouse("click", gapX)), undefined, "click on the gap is ignored");
	assert.equal(footer.render(100).length, 1, "still collapsed");
});

test("a click on the far-right head row still toggles the right side", () => {
	const footer = footerFor("Arnative (Minimal)");
	assert.ok(footer.handleMouse!(mouse("press", 99))?.handled === true, "the last cell belongs to the model head");
	footer.handleMouse!(mouse("click", 99));
	assert.ok(footer.render(100).some((l) => l.includes("↑1.2k")), "the right side opened");
});

test("the full preset is unchanged: no arrows, statuses always visible", () => {
	const lines = footerFor("Arnative (Full)").render(100);
	assert.ok(lines.length > 1, "statuses render without a click");
	assert.ok(lines.some((l) => l.includes("MCP")), "statuses always visible");
	assert.ok(lines.every((l) => !l.includes("▲")), "no disclosure arrow");
});