/**
 * Behavioral suite for the Arnative (Minimal) footer in extensions/footer.ts.
 *
 * Drives the real extension through a fake `pi` (only the host API is faked — the
 * footer component, its layout, its hit zones and its click handling are the shipped
 * code) so the disclosure is tested the way a user meets it: render, click, render.
 */
import assert from "node:assert/strict";
import test from "node:test";
import register, { armIdleProbe, clock, formatDuration, repaintIdle, stopIdleProbe, wrapInputListener, __test as footerTest } from "../lib/features/footer.ts";
import { getRuntime } from "../lib/runtime.ts";

const FOOTER_PRESET_KEY = Symbol.for("pi-arnative.footerPreset");

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

const fgCalls: Array<{ color: string; text: string }> = [];
const theme = {
	fg: (c: string, t: string) => {
		fgCalls.push({ color: c, text: t });
		return t;
	},
	bold: (t: string) => t,
};
const footerData = {
	getExtensionStatuses: () => new Map([["mcp", "MCP: 3 servers enabled"]]),
	onBranchChange: () => () => {},
	getGitBranch: () => "main",
};
// Shaped like the real TuiBase: input goes through handleTerminalInput, which listeners
// only see until one of them consumes it. The footer wraps this method to count activity,
// so the test drives the same entry point a terminal does.
const tui = { requestRender: () => {}, handleTerminalInput: (_data: string) => {} };
/** One keystroke in the editor, through the patched dispatch. */
const type = () => tui.handleTerminalInput("a");

// Two entries a short gap apart: a resume seeds that gap as active time.
const T0 = Date.now();
const SEED_GAP_MS = Math.min(25_000, Math.floor(clock.pauseMs / 2));
const logged = [
	{ type: "message", timestamp: new Date(T0 - SEED_GAP_MS - 25_000).toISOString() },
	{ type: "message", timestamp: new Date(T0 - 25_000).toISOString() },
];

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
		setWorkingIndicator: (options?: Record<string, unknown>) => ui.calls.push(options),
		theme,
	},
	sessionManager: {
		getHeader: () => ({ timestamp: new Date().toISOString() }),
		getEntries: () => logged,
		// One assistant message so the metrics side has something to show.
		getBranch: () => [{ type: "message", message: { role: "assistant", usage: { input: 1200, output: 500, cacheRead: 0 } } }],
	},
	getContextUsage: () => undefined,
};

register(pi);
await handlers.get("session_start")!({ reason: "startup" }, ctx);
// The wiring, not just the helper: session_start must seed the clock from the log.
assert.equal(clock.active, SEED_GAP_MS, "session_start seeds active time from the session log");

/** A footer component built for the given preset. */
function footerFor(preset: string): Footer {
	(globalThis as Record<symbol, unknown>)[FOOTER_PRESET_KEY] = preset;
	getRuntime().minimalFooterExpanded = null;
	assert.ok(footerFactory, "session_start registered a footer factory");
	return footerFactory(tui, theme, footerData);
}

const mouse = (type: string, x: number, extra: Record<string, unknown> = {}) => ({
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
	...extra,
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

test("pressing head text leaves selection to pi; single-click still toggles, double-click does not", () => {
	const footer = footerFor("Arnative (Minimal)");
	const head = footer.render(100)[0]!;
	const textX = head.indexOf("pi-arnative");
	const modelX = head.indexOf("Deepseek");
	assert.ok(textX > 0 && modelX > 0, "head text columns found");

	// Press on text must return undefined so TuiAltScreen can start drag/word/line selection.
	assert.equal(footer.handleMouse!(mouse("press", textX)), undefined, "left head text press stays selectable");
	assert.equal(footer.handleMouse!(mouse("press", modelX)), undefined, "right head text press stays selectable");
	// Double-click on text must also stay with pi (word selection).
	assert.equal(footer.handleMouse!(mouse("click", textX, { clickCount: 2 })), undefined, "double-click on left head does not toggle");
	assert.equal(footer.handleMouse!(mouse("click", modelX, { clickCount: 2 })), undefined, "double-click on right head does not toggle");
	assert.equal(footer.render(100).length, 1, "still collapsed after presses and double-clicks");

	// Arrow press acts immediately and swallows the follow-up release/click (no double-toggle).
	const leftArrowX = head.indexOf("▲");
	assert.ok(footer.handleMouse!(mouse("press", leftArrowX)) !== undefined, "arrow press toggles immediately");
	assert.ok(footer.render(100).some((l) => l.includes("MCP")), "left side opened on arrow press");
	footer.handleMouse!(mouse("release", leftArrowX));
	footer.handleMouse!(mouse("click", leftArrowX));
	assert.ok(footer.render(100).some((l) => l.includes("MCP")), "follow-up release/click after arrow press is swallowed");
});

test("the click zones track the real rendered row at every wide width", () => {
	for (const width of [80, 100, 120, 160, 200]) {
		const footer = footerFor("Arnative (Minimal)");
		const row = footer.render(width)[0]!;
		const plain = row.replace(/\x1b\[[0-9;]*m/g, "");

		// Single-click (clickCount 1) marks the live head zones; press on text stays undefined for selection.
		const live: number[] = [];
		for (let x = 0; x < width; x++) {
			if (footer.handleMouse!(mouse("click", x)) !== undefined) {
				live.push(x);
				// Restore collapsed state so the next probe starts clean.
				footer.handleMouse!(mouse("click", x));
			}
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

		// The model text is always inside a click zone, while press on it stays undefined for selection.
		const modelAt = plain.indexOf("Deepseek");
		if (modelAt > 0) {
			assert.ok(live.includes(modelAt), `width ${width}: the model text is clickable`);
			assert.equal(footer.handleMouse!(mouse("press", modelAt)), undefined, `width ${width}: pressing model text leaves selection to pi`);
		}
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

test("narrow mobile viewport stacks left layout then right layout with auto-wrap and multi-row clicks", () => {
	const footer = footerFor("Arnative (Minimal)");
	const collapsed = footer.render(40);
	assert.ok(collapsed.length >= 2, "narrow viewport stacks left head above right head");
	assert.ok(collapsed[0]!.includes("pi-arnative"), "row 0 starts with the left head");
	const rightHeadIdx = collapsed.findIndex((l) => l.includes("Deepseek"));
	assert.ok(rightHeadIdx > 0, "right head follows below the left head");

	// Single-click on the left head expands left statuses right below it.
	assert.ok(footer.handleMouse!(mouse("click", 2, { y: 0 }))?.handled === true, "clicking left head toggles left");
	const leftOpen = footer.render(40);
	const mcpIdx = leftOpen.findIndex((l) => l.includes("MCP"));
	const shiftedRightIdx = leftOpen.findIndex((l) => l.includes("Deepseek"));
	assert.ok(mcpIdx > 0 && mcpIdx < shiftedRightIdx, "left statuses appear between left head and right head");

	// Single-click on the shifted right head expands right metrics below it.
	assert.ok(footer.handleMouse!(mouse("click", 2, { y: shiftedRightIdx }))?.handled === true, "clicking right head toggles right");
	const bothOpen = footer.render(40);
	const metricsIdx = bothOpen.findIndex((l) => l.includes("↑1.2k"));
	assert.ok(metricsIdx > shiftedRightIdx, "right metrics appear below the right head");
});

test("the full preset is unchanged: no arrows, statuses always visible", () => {
	const lines = footerFor("Arnative (Full)").render(100);
	assert.ok(lines.length > 1, "statuses render without a click");
	assert.ok(lines.some((l) => l.includes("MCP")), "statuses always visible");
	assert.ok(lines.every((l) => !l.includes("▲")), "no disclosure arrow");
});
// ActiveClock behavior: active time tracking, idle freeze, and keystroke activity.
const clockMs = (l: string) => {
	const m = l.match(/\uf017 ([0-9hms -]+)/);
	return m ? m[1]!.trim() : null;
};

test("the clock runs on its own, freezes when idle, and never rewinds", () => {
	// The threshold is read from the clock, never hardcoded: raising `IDLE_PAUSE_MS` is a
	// documented user choice (README), so a test that pinned 30s would break that choice.
	const P = clock.pauseMs;
	const t0 = Date.now();
	clock.active = 0;
	clock.runStarted = t0;
	clock.lastSeen = t0;
	fgCalls.length = 0;
	const line = footerFor("Arnative (Full)").render(100)[0]!;
	assert.equal(clockMs(line), "-", "a fresh session starts at zero, shown as -");
	assert.ok(fgCalls.some((c) => (c.color === "secondarySoft" || c.color === "borderAccent" || c.color === "primarySoft" || c.color === "accentSoft") && c.text === "-"), "a running clock is soft, not dim");

	assert.equal(clock.total(t0 + 5_000), 5_000, "the value advances with no event arriving");
	assert.equal(clock.total(t0 + Math.floor(P / 2)), Math.floor(P / 2), "and keeps advancing while the run is live");

	// A pause is worth at most the threshold, so a night away cannot inflate the total.
	assert.equal(clock.total(t0 + P), P, "it counts up to the threshold");
	assert.equal(clock.total(t0 + 8 * 3600_000), P, "past the threshold it freezes, it does not run forever");

	const away = t0 + 8 * 3600_000;
	clock.tick(away);
	assert.equal(clock.total(away), P, "the away gap itself is never counted");
	assert.equal(clock.total(away + 10_000), P + 10_000, "the new run counts from the resume");
	// Monotonic: whatever order the render happens to observe, the value never drops.
	assert.ok(clock.total(away + 10_000) >= clock.total(away) && clock.total(away) >= clock.total(t0 + P - 1_000), "the displayed value never rewinds");
});

test("an idle clock is dim and typing resumes it", () => {
	const now = Date.now();
	clock.active = 600_000;
	clock.runStarted = now - clock.pauseMs - 30_000;
	clock.lastSeen = clock.runStarted;
	assert.ok(clock.idle(), "precondition: past the threshold the clock is idle");
	const frozen = formatDuration(600_000 + clock.pauseMs);
	fgCalls.length = 0;
	const line = footerFor("Arnative (Full)").render(100)[0]!;
	assert.equal(clockMs(line), frozen, "the frozen run keeps its value");
	assert.ok(fgCalls.some((c) => c.color === "dim" && c.text === frozen), "a paused clock is drawn dim");

	type(); // a keystroke in the editor
	// `tick()` runs with a fresh Date.now(), so allow a millisecond of drift.
	const seen = clock.total();
	const expected = 600_000 + clock.pauseMs;
	assert.ok(seen >= expected && seen < expected + 50, `the away gap itself is never counted (got ${seen}, expected ${expected})`);
	assert.ok(!clock.idle(), "the keystroke unpauses the clock");
	assert.equal(clock.total(clock.lastSeen + 2_000), clock.active + 2_000, "time counts again after the keystroke");
});

test("the idle watchdog fires by itself and the 1s tick stops with it", async () => {
	const armed = () => getRuntime().idleTimer != null;
	const ticking = () => getRuntime().clockTimer != null;
	stopIdleProbe();

	// Past the threshold: wait is 0, so the probe fires on the next macrotask and clears
	// itself. The dim pause appears with no input and no render to trigger it.
	clock.lastSeen = Date.now() - clock.pauseMs - 1_000;
	assert.ok(clock.idle(), "precondition: the session is past the threshold");
	armIdleProbe();
	assert.ok(armed(), "activity arms the watchdog");
	assert.ok(ticking(), "activity also starts the moving clock");
	await new Promise((r) => setTimeout(r, 30));
	assert.ok(!armed(), "the probe fired once and stopped (it does not spin while frozen)");
	assert.ok(!ticking(), "the 1s clock tick stops with it");

	// A live run instead keeps both alive until the threshold elapses.
	clock.lastSeen = Date.now();
	armIdleProbe();
	await new Promise((r) => setTimeout(r, 30));
	assert.ok(armed(), "while the run is live the watchdog is still waiting");
	stopIdleProbe();
	assert.ok(!armed(), "the watchdog is cleared on stop/shutdown");
});

test("the first keystroke after a resume unpauses immediately", () => {
	// A session resumed after a night away is frozen at startup: its first keystroke must
	// repaint the resumed (soft) value without waiting for the moving clock.
	const now = Date.now();
	clock.active = 720_000;
	clock.runStarted = now - clock.pauseMs - 30_000;
	clock.lastSeen = clock.runStarted;
	assert.ok(clock.idle(), "precondition: the resumed session is frozen");
	const frozen = formatDuration(720_000 + clock.pauseMs);
	fgCalls.length = 0;
	footerFor("Arnative (Full)").render(100);
	assert.ok(fgCalls.some((c) => c.color === "dim" && c.text === frozen), "the first paint of a resumed session is dim");
	type(); // the keystroke unpauses it
	fgCalls.length = 0;
	footerFor("Arnative (Full)").render(100);
	assert.ok(fgCalls.some((c) => (c.color === "secondarySoft" || c.color === "borderAccent" || c.color === "primarySoft" || c.color === "accentSoft") && c.text === frozen), "after the keystroke the clock is soft again");
	clock.lastSeen = Date.now();
	clock.runStarted = clock.lastSeen;
	repaintIdle(); // no-op while running
	armIdleProbe();
	stopIdleProbe();
});

test("the freeze paints itself, with no input and no manual render", async () => {
	// The probe automatically triggers a render once the idle threshold is crossed.
	let repaints = 0;
	const saved = tui.requestRender;
	tui.requestRender = () => { repaints++; };
	footerFor("Arnative (Full)");
	const savedPause = clock.pauseMs;
	(clock as unknown as { pauseMs: number }).pauseMs = 60;
	clock.active = 0;
	clock.runStarted = Date.now();
	clock.lastSeen = Date.now();
	wrapInputListener(tui);
	repaints = 0;
	tui.handleTerminalInput("a");
	assert.ok(repaints >= 1, "the keystroke repaints the running clock");
	const afterKey = repaints;
	await new Promise((r) => setTimeout(r, 250));
	assert.ok(clock.idle(), "the run really did freeze");
	assert.ok(repaints > afterKey, `the freeze repainted itself (repaints ${afterKey} -> ${repaints})`);
	(clock as unknown as { pauseMs: number }).pauseMs = savedPause;
	stopIdleProbe();
	tui.requestRender = saved;
});

test("typing counts as activity, pointer and focus do not", () => {
	const seen: string[] = [];
	const fake = { handleTerminalInput(data: string) { seen.push(data); } };
	const savedHook = getRuntime().activityHook;
	getRuntime().wrappedTuis = new WeakSet<object>();
	const detach = wrapInputListener(fake);
	const freeze = () => {
		clock.active = 0;
		clock.runStarted = Date.now() - clock.pauseMs - 1_000;
		clock.lastSeen = clock.runStarted;
		assert.ok(clock.idle(), "precondition: frozen");
	};

	for (const noise of ["\u001b[<35;10;5M", "\u001b[<64;10;5M", "\u001b[M !!", "\u001b[I", "\u001b[O"]) {
		freeze();
		fake.handleTerminalInput(noise);
		assert.ok(clock.idle(), `pointer/focus input stays frozen (${JSON.stringify(noise)})`);
		assert.ok(seen.includes(noise), "the input still reaches the original dispatch");
	}

	freeze();
	fake.handleTerminalInput("a");
	assert.ok(!clock.idle(), "a keystroke resumes the clock");
	assert.ok(seen.includes("a"), "the keystroke still reaches the original dispatch");
	stopIdleProbe();
	detach();
	getRuntime().activityHook = savedHook;
});

// pi renders custom working-indicator frames verbatim, skipping `spinnerColorFn`
// (`Loader.getRenderedIndicator`). The extension must clear that flag, or the spinner
// silently loses its accent colour while the label keeps its own token.
test("the spinner frame is coloured accent, the label keeps accentSoft", async () => {
	const { Loader } = await import("@earendil-works/pi-tui");
	const ui = { requestRender() {} };
	const loader = new Loader(ui, (t: string) => `[ACCENT:${t}]`, (t: string) => `[SOFT:${t}]`, "Executing (3s)", {
		frames: ["⬥"],
		intervalMs: 200,
	});
	loader.updateDisplay();
	assert.ok(loader.render(40)[1]!.includes("⬥"), "plain frame, no accent, while verbatim — the bug the fix targets");

	// The extension's own seam, driven the way `/arnative` → Animations drives it: publish the
	// editor, then let paintLiveIndicator install the preset's painter on the live Loader.
	const { paintLiveIndicator, spinnerPainter } = await import("../lib/spinner.ts");
	getRuntime().editor = { workingStatusIndicator: loader };
	paintLiveIndicator(spinnerPainter("Diamond Glow", { fg: (c: string, t: string) => `[${c}:${t}]` }));
	getRuntime().editor = null;
	const line = loader.render(40)[1]!;
	assert.ok(line.includes("[accent:⬥]"), "the frame goes through the painted accent, verbatim cleared");
	assert.ok(line.includes("[SOFT:Executing"), "the label keeps its own colour fn, not the spinner's");
});

// The footer's two-tone look: icons on `accent`, their text on the soft border-accent
// tier. `secondarySoft` lives in `vars` only (Pi 1.2.0 forbids custom `colors` keys), so
// the text colour must be *derived* from `borderAccent`, not read from a token. Before
// this, the label fell back to softOf(accent) and the footer went monochrome-pink.
test("footer labels take the soft border-accent tier, icons keep accent", async () => {
	const { softOf, softSecondaryOf } = await import("../lib/ansi.ts");
	// Shaped like the real 1.2.0 Theme: no accentSoft/secondarySoft token, `colors` present.
	const modern = {
		fg: (c: string) => {
			throw new Error(`Unknown theme color: ${c}`);
		},
		style: (t: string, o: { fg: unknown }) => `<${JSON.stringify(o.fg)}>${t}`,
		colors: { accent: { kind: "oklch", l: 0.78, c: 0.146, h: 355 }, borderAccent: { kind: "oklch", l: 0.82, c: 0.139, h: 200 } },
	};
	const label = softSecondaryOf(modern as never)("main");
	const icon = softOf(modern as never)("main");
	assert.ok(label.includes('"h":200'), "the label keeps the border-accent hue (blue), not the accent hue");
	assert.ok(icon.includes('"h":355'), "the accent tier keeps its own hue (pink)");
	assert.ok(label.includes('"c":0.04865'), "the label chroma is the border accent softened by 0.35");
	assert.ok(label.includes('"l":0.9'), "the soft tier sits at L 0.90");
});

test("working clock and footer clock share one 1s RuntimeState timer", () => {
	footerTest.stopWorkingClock();
	stopIdleProbe();
	clock.lastSeen = Date.now();
	armIdleProbe();
	const sharedHandle = getRuntime().clockTimer;
	assert.ok(sharedHandle != null, "idle probe starts the shared 1s clock timer");
	footerTest.startWorkingClock({ ui: { setWorkingMessage: () => {} } });
	assert.equal(getRuntime().clockTimer, sharedHandle, "startWorkingClock reuses the same 1s timer handle");
	footerTest.stopWorkingClock();
	assert.equal(getRuntime().clockTimer, sharedHandle, "stopping work keeps the footer clock ticking while active");
	stopIdleProbe();
	assert.equal(getRuntime().clockTimer, null, "stopping idle probe clears the shared timer");
});

test("stale RuntimeState timers from a previous reload are cleared by stopIdleProbe", async () => {
	footerTest.stopWorkingClock();
	stopIdleProbe();
	let leakedClockCalls = 0;
	let leakedIdleCalls = 0;
	const rt = getRuntime();
	rt.clockTimer = setInterval(() => {
		leakedClockCalls++;
	}, 15);
	rt.idleTimer = setTimeout(() => {
		leakedIdleCalls++;
	}, 15);
	stopIdleProbe();
	assert.equal(rt.clockTimer, null);
	assert.equal(rt.idleTimer, null);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(leakedClockCalls, 0, "stale clockTimer from prior reload must be cleared");
	assert.equal(leakedIdleCalls, 0, "stale idleTimer from prior reload must be cleared");
});
