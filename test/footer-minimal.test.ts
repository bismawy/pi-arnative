/**
 * Behavioral suite for the Arnative (Minimal) footer in extensions/footer.ts.
 *
 * Drives the real extension through a fake `pi` (only the host API is faked — the
 * footer component, its layout, its hit zones and its click handling are the shipped
 * code) so the disclosure is tested the way a user meets it: render, click, render.
 */
import assert from "node:assert/strict";
import test from "node:test";
import register, { armIdleProbe, clock, formatDuration, isPointerOrFocusInput, repaintIdle, stopIdleProbe, wrapInputListener } from "../extensions/footer.ts";

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
	assert.ok(fgCalls.some((c) => c.color === "accentSoft" && c.text === "-"), "a running clock is soft, not dim");

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
	const idleKey = Symbol.for("pi-arnative.idleTimer");
	const clockKey = Symbol.for("pi-arnative.clockTimer");
	const armed = () => (globalThis as Record<symbol, unknown>)[idleKey] != null;
	const ticking = () => (globalThis as Record<symbol, unknown>)[clockKey] != null;
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
	assert.ok(fgCalls.some((c) => c.color === "accentSoft" && c.text === frozen), "after the keystroke the clock is soft again");
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
	const savedHook = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.activityHook")];
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.inputDispatchWrapped")];
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
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.activityHook")] = savedHook;
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
	const { EDITOR_KEY, paintLiveIndicator } = await import("../extensions/animations.ts");
	const { spinnerPainter } = await import("../lib/spinner.ts");
	(globalThis as Record<symbol, any>)[EDITOR_KEY] = { workingStatusIndicator: loader };
	paintLiveIndicator(spinnerPainter("Diamond Glow", { fg: (c: string, t: string) => `[${c}:${t}]` }));
	delete (globalThis as Record<symbol, any>)[EDITOR_KEY];
	const line = loader.render(40)[1]!;
	assert.ok(line.includes("[accent:⬥]"), "the frame goes through the painted accent, verbatim cleared");
	assert.ok(line.includes("[SOFT:Executing"), "the label keeps its own colour fn, not the spinner's");
});
