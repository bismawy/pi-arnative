/**
 * Tests for ADE-style chronological phase progress grouping:
 * - Virtual projection leaves chatContainer.children untouched
 * - Chronological phase grouping (narration + heuristic fallback)
 * - Final conclusion AssistantMessageComponent stays outside below the box
 * - Interactive mouse clicks on phases, [show]/[hide], and [expand all]/[collapse all]
 * - Auto-expand for running and failed phases
 * - Works with Render cache On/Off, Classic fallback, narrow widths, and Ctrl+O sync
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/ansi.ts";
import {
	attachChatContainer,
	clearRenderCache,
	setRenderCache,
} from "../lib/features/render-cache.ts";
import {
	activeToolLayout,
	buildPhases,
	classifyTool,
	projectTranscriptChildren,
	setToolLayout,
	syncProgressBoxesExpanded,
	type ToolLike,
} from "../lib/features/progress-group.ts";
import { resetPresetCache } from "../lib/preset-store.ts";

function makeAssistant(
	content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>,
): AssistantMessageComponent {
	return new AssistantMessageComponent({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	} as never);
}

function makeTool(
	name: string,
	id: string,
	args: Record<string, unknown>,
	result?: { text: string; isError?: boolean; durationMs?: number; diff?: string },
	isPartial = false,
): ToolExecutionComponent {
	const comp = new ToolExecutionComponent(
		name,
		id,
		args,
		{},
		undefined,
		{ requestRender: () => {} } as never,
		process.cwd(),
	);
	if (result) {
		comp.updateResult(
			{
				content: [{ type: "text", text: result.text }],
				isError: Boolean(result.isError),
				durationMs: result.durationMs,
				details: result.diff ? { diff: result.diff } : undefined,
			} as never,
			isPartial,
		);
	}
	return comp;
}

function withEnv(fn: () => void): void {
	const dir = mkdtempSync(join(tmpdir(), "arnative-progress-group-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();
	try {
		initTheme();
		setToolLayout("Grouped");
		setRenderCache("On");
		clearRenderCache();
		fn();
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.renderCache")];
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.toolLayout")];
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function withEnvAsync(fn: () => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "arnative-progress-group-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();
	try {
		initTheme();
		setToolLayout("Grouped");
		setRenderCache("On");
		clearRenderCache();
		await fn();
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.renderCache")];
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.toolLayout")];
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

function mouseAt(
	type: "press" | "release" | "click",
	x: number,
	y: number,
	width: number,
	height: number,
	clickCount = 1,
) {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		clickCount,
	};
}

test("classifyTool maps explore, edit, run, and other tools accurately", () => {
	assert.equal(classifyTool("ffgrep"), "explore");
	assert.equal(classifyTool("read"), "explore");
	assert.equal(classifyTool("web_search"), "explore");
	assert.equal(classifyTool("edit"), "edit");
	assert.equal(classifyTool("write"), "edit");
	assert.equal(classifyTool("powershell"), "run");
	assert.equal(classifyTool("bash"), "run");
	assert.equal(classifyTool("codemode"), "run");
	assert.equal(classifyTool("ask_user_question"), "other");
});

test("groups chronological phases, keeps conclusion below box, and preserves chatContainer.children", () => {
	withEnv(() => {
		const chat = new Container();
		const user = new UserMessageComponent("Migrate overlay IPC");
		const step1Assistant = makeAssistant([
			{ type: "toolCall", id: "c1", name: "ffgrep", arguments: { pattern: "overlay", path: "host/overlay_ipc.go" } },
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "host/overlay_ipc.go" } },
		]);
		const t1 = makeTool("ffgrep", "c1", { pattern: "overlay", path: "host/overlay_ipc.go" }, { text: "match1", durationMs: 120 });
		const t2 = makeTool("read", "c2", { path: "host/overlay_ipc.go" }, { text: "package main", durationMs: 80 });
		const t3 = makeTool("write", "c3", { path: "host/internal/overlayipc/protocol.go" }, { text: "Wrote file", durationMs: 40 });
		const t4 = makeTool("write", "c4", { path: "host/internal/overlayipc/protocol_test.go" }, { text: "Wrote file", durationMs: 30 });
		const t5 = makeTool(
			"edit",
			"c5",
			{ path: "host/internal/overlayipc/overlay_ipc.go" },
			{ text: "Updated", durationMs: 30, diff: "@@ -1,2 +1,3 @@\n-oldLine\n+newLine1\n+newLine2" },
		);
		const t6 = makeTool("powershell", "c6", { command: "go test qiwek-host/internal/overlayipc" }, { text: "ok qiwek-host/internal/overlayipc 4.1s", durationMs: 4100 });
		const conclusion = makeAssistant([{ type: "text", text: "Paket internal/overlayipc selesai dimigrasi." }]);

		for (const c of [user, step1Assistant, t1, t2, t3, t4, t5, t6, conclusion]) {
			chat.addChild(c);
		}
		const originalCount = chat.children.length;
		attachChatContainer(chat);

		const lines = chat.render(92);
		const plain = lines.map(stripAnsi);

		// Raw children array must never be mutated.
		assert.equal(chat.children.length, originalCount, "chatContainer.children stays untouched");

		// Projected output contains 1 progress box with 3 chronological phases + conclusion below it.
		const headerIdx = plain.findIndex((l) => l.includes("Progress") && l.includes("6 steps") && l.includes("[expand all]"));
		assert.ok(headerIdx >= 0, "renders a single Progress box header with step count and [expand all]");

		const exploreIdx = plain.findIndex((l) => l.includes("▸") && l.includes("Explored overlay_ipc.go"));
		const editIdx = plain.findIndex((l) => l.includes("▸") && l.includes("Created & updated overlayipc files") && l.includes("+2/-1"));
		const testIdx = plain.findIndex((l) => l.includes("▸") && l.includes("Verified tests"));
		const conclusionIdx = plain.findIndex((l) => l.includes("Paket internal/overlayipc selesai dimigrasi."));

		assert.ok(exploreIdx > headerIdx, "phase 1 (Explore) appears in chronological order");
		assert.ok(editIdx > exploreIdx, "phase 2 (Edit) appears after Explore with diff stats");
		assert.ok(testIdx > editIdx, "phase 3 (Verify) appears after Edit");
		assert.ok(conclusionIdx > testIdx, "final conclusion renders outside below the progress box");

		// Settled phases start collapsed, so individual tool rows are hidden until clicked.
		assert.ok(!plain.some((l) => l.includes("protocol_test.go")), "collapsed phase hides child tool rows");

		// Top and bottom borders close cleanly at exact width.
		assert.ok(plain[headerIdx]!.startsWith("╭") && plain[headerIdx]!.endsWith("╮"), `top border closes cleanly: ${plain[headerIdx]}`);
		assert.equal(visibleWidth(lines[headerIdx]!), 92, "top border fills exact width");
		const bottomIdx = plain.findIndex((l) => l.startsWith("╰"));
		assert.ok(bottomIdx > testIdx && plain[bottomIdx]!.endsWith("╯"), "bottom border closes cleanly");
		assert.equal(visibleWidth(lines[bottomIdx]!), 92, "bottom border fills exact width");

		// Every line stays within requested terminal width.
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 92, `line exceeds width 92: ${stripAnsi(line)}`);
		}
	});
});

test("uses intermediate assistant narration text as explicit phase label", () => {
	withEnv(() => {
		const a1 = makeAssistant([
			{ type: "text", text: "Checking IPC protocol definitions first:" },
			{ type: "toolCall", id: "n1", name: "read", arguments: { path: "protocol.go" } },
		]);
		const t1 = makeTool("read", "n1", { path: "protocol.go" }, { text: "package ipc", durationMs: 25 });
		const phases = buildPhases([a1 as never, t1 as unknown as ToolLike]);
		assert.equal(phases.length, 1);
		assert.equal(phases[0]!.explicitTitle, true);
		assert.equal(phases[0]!.title, "Checking IPC protocol definitions first");
	});
});

test("clicking phase row, tool [show]/[hide], and header [expand all]/[collapse all] toggles interactively", () => {
	withEnv(() => {
		const chat = new Container();
		const user = new UserMessageComponent("Run workflow");
		const t1 = makeTool("read", "m1", { path: "src/a.ts" }, { text: "line 1\nline 2", durationMs: 20 });
		const t2 = makeTool("edit", "m2", { path: "src/a.ts" }, { text: "edited\ndetail row", durationMs: 35, diff: "-a\n+b" });
		const conclusion = makeAssistant([{ type: "text", text: "Done." }]);
		for (const c of [user, t1, t2, conclusion]) chat.addChild(c);
		attachChatContainer(chat);

		const width = 90;
		let lines = chat.render(width);
		let plain = lines.map(stripAnsi);

		// Press alone on phase row does not toggle (preserves drag-to-select).
		const editPhaseRow = plain.findIndex((l) => l.includes("Updated a.ts"));
		assert.ok(editPhaseRow >= 0);
		assert.equal(chat.handleMouse(mouseAt("press", 8, editPhaseRow, width, lines.length)), undefined);

		// Single left click on phase 2 expands it and reveals tool row with [show].
		const clickPhase = chat.handleMouse(mouseAt("click", 8, editPhaseRow, width, lines.length));
		assert.ok(clickPhase, "phase row click is handled");
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		const toolRow = plain.findIndex((l) => l.includes("edit") && l.includes("[show]"));
		assert.ok(toolRow > editPhaseRow, "expanding phase shows its tool row with [show]");
		assert.equal(t2.expanded, false, "tool detail stays collapsed until [show] is clicked");

		// Pressing [show] opens nested ToolExecutionComponent detail and marks tool expanded.
		const showCol = plain[toolRow]!.indexOf("[show]");
		assert.ok(showCol > 0);
		const pressShow = chat.handleMouse(mouseAt("press", showCol + 1, toolRow, width, lines.length));
		assert.ok(pressShow, "[show] press is handled");
		assert.equal(t2.expanded, true, "opening tool detail expands underlying ToolExecutionComponent");
		// Following release + click are swallowed cleanly.
		chat.handleMouse(mouseAt("release", showCol + 1, toolRow, width, lines.length));
		chat.handleMouse(mouseAt("click", showCol + 1, toolRow, width, lines.length));

		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		const hideRow = plain.findIndex((l) => l.includes("edit") && l.includes("[hide]"));
		assert.ok(hideRow >= 0, "opened tool row switches label to [hide]");
		assert.ok(plain.some((l) => l.includes("detail row")), "nested tool output is rendered inside the box");

		// Pressing [expand all] in header expands all phases and switches to [collapse all].
		const headerRow = plain.findIndex((l) => l.includes("[expand all]"));
		assert.ok(headerRow >= 0);
		const expCol = plain[headerRow]!.indexOf("[expand all]");
		chat.handleMouse(mouseAt("press", expCol + 2, headerRow, width, lines.length));
		chat.handleMouse(mouseAt("release", expCol + 2, headerRow, width, lines.length));
		chat.handleMouse(mouseAt("click", expCol + 2, headerRow, width, lines.length));

		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("[collapse all]")), "header switches to [collapse all]");
		assert.ok(plain.some((l) => l.includes("read") && l.includes("src/a.ts")), "first phase is now expanded too");

		// Pressing [collapse all] collapses every phase and closes nested tool detail.
		const collapseRow = plain.findIndex((l) => l.includes("[collapse all]"));
		const colCol = plain[collapseRow]!.indexOf("[collapse all]");
		chat.handleMouse(mouseAt("press", colCol + 2, collapseRow, width, lines.length));
		chat.handleMouse(mouseAt("release", colCol + 2, collapseRow, width, lines.length));
		chat.handleMouse(mouseAt("click", colCol + 2, collapseRow, width, lines.length));

		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("[expand all]")), "header returns to [expand all]");
		assert.equal(t2.expanded, false, "[collapse all] closes nested tool detail");
		assert.ok(!plain.some((l) => l.includes("detail row")), "collapsed box hides nested detail lines");
	});
});

test("auto-expands running and failed phases, supports Classic mode, Render cache Off, narrow widths, and Ctrl+O", () => {
	withEnv(() => {
		const chat = new Container();
		const tDone = makeTool("read", "s1", { path: "a.ts" }, { text: "ok", durationMs: 10 });
		const tRun = makeTool("bash", "s2", { command: "npm test" }, undefined, true);
		const tErr = makeTool("bash", "s3", { command: "go test ./..." }, { text: "FAIL", isError: true, durationMs: 250 });
		for (const c of [tDone, tRun]) chat.addChild(c);
		attachChatContainer(chat);

		// While tRun is partial, phase 1 (done) stays collapsed and phase 2 (running) auto-expands.
		let plain = chat.render(84).map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("▸") && l.includes("Read a.ts")), "finished phase collapses");
		assert.ok(plain.some((l) => l.includes("▾") && l.includes("Verified tests")), "running phase auto-expands");

		// Once tRun finishes cleanly and an error tool exists, error phase stays auto-expanded.
		tRun.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 100 } as never, false);
		chat.addChild(tErr);
		plain = chat.render(84).map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("✗") && l.includes("1 failed")), "error phase surfaces failure visibly");

		// Narrow width (44 cols) never overflows and keeps closing corners intact.
		const narrow = chat.render(44);
		const narrowPlain = narrow.map(stripAnsi);
		const narrowTop = narrowPlain.find((l) => l.startsWith("╭"));
		assert.ok(narrowTop && narrowTop.endsWith("╮") && visibleWidth(narrowTop) === 44, `narrow top border closes cleanly: ${narrowTop}`);
		for (const line of narrow) {
			assert.ok(visibleWidth(line) <= 44, `narrow line overflows 44 cols: ${stripAnsi(line)}`);
		}

		// Render cache Off still keeps Grouped layout working.
		setRenderCache("Off");
		const offLines = chat.render(84).map(stripAnsi);
		assert.ok(offLines.some((l) => l.includes("Progress")), "Grouped layout works when render cache is Off");
		setRenderCache("On");

		// Ctrl+O sync expands all phases cleanly.
		syncProgressBoxesExpanded(chat.children, true);
		const ctrlOExpanded = chat.render(84).map(stripAnsi);
		assert.ok(ctrlOExpanded.some((l) => l.includes("[collapse all]")), "Ctrl+O expands all phases");

		// Classic mode bypasses grouping completely.
		setToolLayout("Classic");
		assert.equal(activeToolLayout(), "Classic");
		assert.equal(projectTranscriptChildren(chat.children).length, chat.children.length);
		const classicPlain = chat.render(84).map(stripAnsi);
		assert.ok(!classicPlain.some((l) => l.includes("Progress ·")), "Classic mode omits progress box");
	});
});

test("mouse gestures stay reliable across release-before-render, 1px drag drift, chevron press, and external tool collapse", () => {
	withEnv(() => {
		const chat = new Container();
		const t1 = makeTool("read", "g1", { path: "src/[show]-a.ts" }, { text: "alpha\nbeta\ngamma", durationMs: 20 });
		const t2 = makeTool("edit", "g2", { path: "src/b.ts" }, { text: "updated", durationMs: 30, diff: "-x\n+y" });
		for (const c of [t1, t2]) chat.addChild(c);
		attachChatContainer(chat);

		const width = 90;
		let lines = chat.render(width);
		let plain = lines.map(stripAnsi);

		// 1. Press [expand all], then drift 1px and release BEFORE any re-render (no synthesized click).
		const expRow = plain.findIndex((l) => l.includes("[expand all]"));
		const expCol = plain[expRow]!.lastIndexOf("[expand all]");
		assert.ok(chat.handleMouse(mouseAt("press", expCol + 2, expRow, width, lines.length)));
		chat.handleMouse(mouseAt("release", expCol + 3, expRow, width, lines.length));
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("[collapse all]")), "[expand all] opened all phases");

		// 2. Immediately click phase 1 title text -> must NOT be swallowed by stale press state.
		const p1Row = plain.findIndex((l) => l.includes("Read [show]-a.ts"));
		assert.equal(chat.handleMouse(mouseAt("press", 12, p1Row, width, lines.length)), undefined);
		assert.ok(chat.handleMouse(mouseAt("click", 12, p1Row, width, lines.length)), "phase 1 title click works immediately after [expand all]");
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("▸") && l.includes("Read [show]-a.ts")), "phase 1 collapsed on first click");

		// 3. Press phase 1 chevron (x=2) with 1px drift -> toggles immediately on press.
		const p1Collapsed = plain.findIndex((l) => l.includes("Read [show]-a.ts"));
		assert.ok(chat.handleMouse(mouseAt("press", 2, p1Collapsed, width, lines.length)), "chevron toggles on press");
		chat.handleMouse(mouseAt("release", 3, p1Collapsed, width, lines.length));
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("▾") && l.includes("Read [show]-a.ts")), "phase 1 reopened via chevron press");

		// 4. Press right-side [show] on a row whose filename contains "[show]".
		const toolRow = plain.findIndex((l) => l.includes("src/[show]-a.ts"));
		const showCol = plain[toolRow]!.lastIndexOf("[show]");
		assert.ok(showCol > plain[toolRow]!.indexOf("[show]"), "lastIndexOf targets the right button, not the filename");
		assert.ok(chat.handleMouse(mouseAt("press", showCol + 1, toolRow, width, lines.length)));
		chat.handleMouse(mouseAt("release", showCol + 1, toolRow, width, lines.length));
		chat.handleMouse(mouseAt("click", showCol + 1, toolRow, width, lines.length));
		assert.equal(t1.expanded, true);
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("[hide]")), "row switched to [hide]");
		assert.ok(plain.some((l) => l.includes("beta")), "nested output rendered");

		// 5. External collapse (e.g. clicking inside nested tool box or Ctrl+O) stays in sync with [show]/[hide].
		t1.setExpanded(false);
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(!plain.some((l) => l.includes("beta")), "detail closes when underlying tool collapses");
		assert.ok(plain.some((l) => l.includes("src/[show]-a.ts") && l.includes("[show]")), "row flips back to [show]");
	});
});

test("long turns (41+ steps with failed phase) stay interactive under render cache", () => {
	withEnv(() => {
		const chat = new Container();
		const tools: ReturnType<typeof makeTool>[] = [];
		for (let i = 0; i < 41; i++) {
			const isErr = i === 20;
			const t = makeTool(
				isErr ? "bash" : "read",
				`long-${i}`,
				isErr ? { command: "node --test test/render-cache.test.ts" } : { path: `src/f${i}.ts` },
				{ text: isErr ? "FAIL line 1\nFAIL line 2" : `content ${i}`, isError: isErr, durationMs: 25 },
			);
			tools.push(t);
			chat.addChild(t);
		}
		attachChatContainer(chat);

		const width = 100;
		let lines = chat.render(width);
		let plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("41 steps") && l.includes("1 failed")), "renders 41-step failed header");
		assert.ok(plain.some((l) => l.includes("▾") && l.includes("Verified tests")), "failed phase auto-expands");

		// 1. Collapse the auto-expanded failed phase.
		const errPhaseRow = plain.findIndex((l) => l.includes("Verified tests"));
		assert.ok(chat.handleMouse(mouseAt("press", 2, errPhaseRow, width, lines.length)));
		chat.handleMouse(mouseAt("release", 2, errPhaseRow, width, lines.length));
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("▸") && l.includes("Verified tests")), "failed phase collapses cleanly");

		// 2. Expand all phases on the 41-step box -> caps height with `↓ N more` at bottom.
		const expRow = plain.findIndex((l) => l.includes("[expand all]"));
		const expCol = plain[expRow]!.lastIndexOf("[expand all]");
		assert.ok(chat.handleMouse(mouseAt("press", expCol + 2, expRow, width, lines.length)));
		chat.handleMouse(mouseAt("release", expCol + 2, expRow, width, lines.length));
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("[collapse all]")), "[expand all] switches to [collapse all]");
		assert.ok(plain.some((l) => l.includes("src/f0.ts")), "earliest tool row is visible at top");
		assert.ok(plain.some((l) => /↓ \d+ more/.test(l)), "tall expanded box shows ↓ N more on bottom border");

		// 3. Open [show] on tool #0 (far from tail) while visible at top.
		const row0 = plain.findIndex((l) => l.includes("src/f0.ts"));
		const col0 = plain[row0]!.lastIndexOf("[show]");
		assert.ok(chat.handleMouse(mouseAt("press", col0 + 2, row0, width, lines.length)));
		chat.handleMouse(mouseAt("release", col0 + 2, row0, width, lines.length));
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.equal(tools[0]!.expanded, true);
		assert.ok(plain.some((l) => l.includes("content 0")), "tool #0 detail renders inside 41-step box");

		// 4. Scroll down via `↓ N more` until failed tool #20 enters view, then open its [show].
		for (let step = 0; step < 12 && !plain.some((l) => l.includes("node --test")); step++) {
			const downRow = plain.findIndex((l) => /↓ \d+ more/.test(l));
			assert.ok(downRow >= 0, "bottom border carries ↓ N more while scrolling down");
			const downCol = plain[downRow]!.search(/↓ \d+ more/);
			assert.ok(chat.handleMouse(mouseAt("press", downCol + 2, downRow, width, lines.length)));
			chat.handleMouse(mouseAt("release", downCol + 2, downRow, width, lines.length));
			lines = chat.render(width);
			plain = lines.map(stripAnsi);
		}
		assert.ok(plain.some((l) => /↑ \d+ more/.test(l)), "top border carries ↑ N more after scrolling down");
		const row20 = plain.findIndex((l) => l.includes("node --test"));
		assert.ok(row20 >= 0, "failed tool #20 is reachable by scrolling down");
		const col20 = plain[row20]!.lastIndexOf("[show]");
		assert.ok(chat.handleMouse(mouseAt("press", col20 + 2, row20, width, lines.length)));
		chat.handleMouse(mouseAt("release", col20 + 2, row20, width, lines.length));
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.equal(tools[20]!.expanded, true);
		assert.ok(plain.some((l) => l.includes("FAIL line 2")), "failed tool #20 detail renders while tool #0 is open");

		// 5. [collapse all] closes everything cleanly and removes scroll borders.
		const colAllRow = plain.findIndex((l) => l.includes("[collapse all]"));
		const colAllCol = plain[colAllRow]!.lastIndexOf("[collapse all]");
		assert.ok(chat.handleMouse(mouseAt("press", colAllCol + 2, colAllRow, width, lines.length)));
		chat.handleMouse(mouseAt("release", colAllCol + 2, colAllRow, width, lines.length));
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => l.includes("[expand all]")), "[collapse all] returns to [expand all]");
		assert.equal(tools[0]!.expanded, false);
		assert.equal(tools[20]!.expanded, false);
		assert.ok(!plain.some((l) => l.includes("FAIL line 2")), "collapsed box hides detail");
		assert.ok(!plain.some((l) => /[↑↓] \d+ more/.test(l)), "compact collapsed box drops scroll labels");
	});
});

test("tall multi-phase turns cap viewport height with ↑/↓ N more borders and hold-scroll", async () => {
	await withEnvAsync(async () => {
		const chat = new Container();
		// Create 20 distinct phases (alternating read/bash) with a failure at phase #10.
		for (let i = 0; i < 20; i++) {
			const isErr = i === 10;
			const isBash = i % 2 === 1;
			const t = makeTool(
				isBash ? "bash" : "read",
				`mp-${i}`,
				isBash ? { command: `echo step-${i}` } : { path: `dir${i}/file${i}.ts` },
				{ text: isErr ? "boom error" : `ok ${i}`, isError: isErr, durationMs: 20 },
			);
			chat.addChild(t);
		}
		attachChatContainer(chat);

		const width = 96;
		let lines = chat.render(width);
		let plain = lines.map(stripAnsi);

		// Height is bounded (leading spacer + top + <=12 body + bottom <= 15 lines).
		assert.ok(lines.length <= 15, `viewport capped tall 20-phase box, got ${lines.length} lines`);
		// Auto-anchors to the failed phase (#10), showing both ↑ and ↓ scroll borders.
		assert.ok(plain.some((l) => l.includes("✗") && l.includes("file10.ts")), "auto-anchors on failed phase");
		assert.ok(plain.some((l) => /↑ \d+ more/.test(l)), "top border displays ↑ N more");
		assert.ok(plain.some((l) => /↓ \d+ more/.test(l)), "bottom border displays ↓ N more");

		// Narrow width with both scroll labels still fits cleanly inside width.
		const narrow = chat.render(44);
		for (const nl of narrow) {
			assert.ok(visibleWidth(nl) <= 44, `narrow scrolled line overflows 44 cols: ${stripAnsi(nl)}`);
		}
		const narrowTop = stripAnsi(narrow[1]!);
		const narrowBot = stripAnsi(narrow[narrow.length - 1]!);
		assert.ok(narrowTop.startsWith("╭") && narrowTop.endsWith("╮"), `narrow top closes: ${narrowTop}`);
		assert.ok(narrowBot.startsWith("╰") && narrowBot.endsWith("╯"), `narrow bot closes: ${narrowBot}`);

		// Re-render at 96 cols and click `↑ N more` repeatedly to reach phase #0.
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		for (let step = 0; step < 8 && !plain.some((l) => l.includes("file0.ts")); step++) {
			const upRow = plain.findIndex((l) => /↑ \d+ more/.test(l));
			assert.ok(upRow >= 0);
			const upCol = plain[upRow]!.search(/↑ \d+ more/);
			assert.ok(chat.handleMouse(mouseAt("press", upCol + 2, upRow, width, lines.length)));
			chat.handleMouse(mouseAt("release", upCol + 2, upRow, width, lines.length));
			lines = chat.render(width);
			plain = lines.map(stripAnsi);
		}
		assert.ok(plain.some((l) => l.includes("file0.ts")), "scrolling up reaches earliest phase #0");
		assert.ok(!plain.some((l) => /↑ \d+ more/.test(l)), "top ↑ N more clears at offset 0");

		// Hold `↓ N more` to auto-scroll across multiple steps until release.
		const downRow = plain.findIndex((l) => /↓ \d+ more/.test(l));
		assert.ok(downRow >= 0);
		const downCol = plain[downRow]!.search(/↓ \d+ more/);
		assert.ok(chat.handleMouse(mouseAt("press", downCol + 2, downRow, width, lines.length)));
		await new Promise((r) => setTimeout(r, 420));
		chat.handleMouse(mouseAt("release", downCol + 2, downRow, width, lines.length));
		lines = chat.render(width);
		plain = lines.map(stripAnsi);
		assert.ok(plain.some((l) => /↑ \d+ more/.test(l)), "hold-scroll advanced offset past top");
		assert.ok(!plain.some((l) => l.includes("file0.ts")), "hold-scroll moved past phase #0");
	});
});
