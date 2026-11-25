import test from "node:test";
import { assert } from "../helpers/check.ts";
import { createLsToolDefinition, createPowerShellToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBoxLines as box, textSpans } from "../../lib/box.ts";
import { stripAnsi } from "../../lib/ansi.ts";
import { resetPresetCache } from "../../lib/preset-store.ts";
import arnativeTools, { recordTiming, spinIcon, Lines, paintLinks, smartTitle, titleRow, resText, numRes, toolSummary, fullText, stripBlankEdges, isImageLine, stripEdgesKeepingImages, expandedBoxBodyLimit, paintScrollEdge, boxBgOf, setEditDiff, formatEditDiff, type Theme, type TCtx, __test } from "../../lib/features/tools.ts";

const { cwd, MAX_TIMINGS, TIMINGS, FRAMES, syncTicker, fmtMs, OWN_BOX, hasOwnRendererDef, BOXED_TOOLS, CDP_ICON, mcpInfo, CALL_ROWS, capped, safeCall, componentLines, codemodeOutput, minimal, EDIT_DIFF_CONFIG_KEY, codemodeRenderers } = __test;

test("lib/features/tools.ts self-check", async () => {
	const mark = (s: string) => `<${s}>`;
	const th: Theme = { fg: (_c, s) => s };
	const R = { content: [{ type: "text", text: "path:1:match a\npath:2:match b\npath:3:match c" }] };

	assert(smartTitle("echo hi") === "echo hi", "short text kept intact");
	assert(smartTitle("ls a b c d e f g h") === "ls a b c d e…", "cut at the 6-word limit");
	assert(smartTitle("a b c d e f g") === "a b c d e f…", "7 words -> 6 words + ellipsis");
	assert(smartTitle("a b c d e f") === "a b c d e f", "6 words kept intact");

	assert(paintLinks("cd /run/media/x && echo hi", mark) === "cd </run/media/x> && echo hi", "filter path absolut");
	assert(paintLinks("git clone https://github.com/a/b", mark) === "git clone <https://github.com/a/b>", "filter link URL");
	assert(paintLinks("ls extensions/tools.ts", mark) === "ls <extensions/tools.ts>", "relative path filter");
	assert(paintLinks("echo plain 2>&1", mark) === "echo plain 2>&1", "plain text untouched");

	// right-aligned duration, space-aware (overflow bug regression)
	const t1 = titleRow(th, "✓", "$", "echo hi", 30, "0.1s", false);
	assert(t1.length === 1 && visibleWidth(t1[0]) === 30, "duration right-aligned within the inner width");
	assert(t1[0].endsWith("0.1s"), "duration at the right end of the title");
	const t2 = titleRow(th, "✓", "$", "word ".repeat(40), 30, "0.1s", false);
	assert(t2.length === 1 && visibleWidth(t2[0]) === 30, "collapsed: long title stays 1 line, within width");
	const t3 = titleRow(th, "✓", "$", "word ".repeat(40), 30, "0.1s", true);
	assert(t3.every((l) => visibleWidth(l) <= 30), "expanded: every line <= inner");
	const t4 = titleRow(th, "✓", "$", "echo hi", 30, "", false);
	assert(!t4[0].includes("0.1s"), "no duration: empty (restored session)");

	// crash regression: third-party renderCall throwing at build time (pi-web-access
	// get_content: responseId.slice on undefined) must be contained, not crash pi
	assert(
		safeCall(() => {
			const args: { responseId?: string } = {};
			return args.responseId!.slice(0, 8);
		}) === null,
		"renderCall throws -> null (not a crash)",
	);
	assert(
		componentLines(
			safeCall(() => {
				throw new Error("renderer crash");
			}),
			10,
		).length === 0,
		"renderer crash -> 0 lines",
	);

	// no duplicate summary
	assert(resText(R, th, (s) => s, false, true) === "", "expand: empty summary");
	assert(resText(R, th, (s) => s, false, false) === "󱞩 path:1:match a", "collapsed: first line shown");
	assert(numRes((n) => `→ ${n} matches`)(R, th, (s) => s, false, false) === "󱞩 → 3 matches", "grep: N matches");
	assert(
		numRes((n) => `→ ${n} matches`)({ content: [{ type: "text", text: "Error: bad" }] }, th, (s) => s, true, false) ===
			"󱞩 Error: bad",
		"error: falls back to the first line",
	);

	// inter-box gap stripped
	assert(stripBlankEdges(["", "a", "", "b", "  ", ""]).join() === "a,,b", "blank edge lines dropped");
	assert(stripBlankEdges(["", "\x1b[2m\x1b[22m", "x"]).join() === "x", "blank ANSI line counts as blank");
	assert(stripBlankEdges(["a"]).join() === "a", "no blanks: kept intact");

	// Image preview: pi pads the image with blank rows (`result.rows - 1`), and the last
	// one carries a cursor-up prefix before the sequence. Those rows are the image's
	// vertical space — deleting them made the terminal paint the image over whatever
	// sits below (chat text, editor, footer). Regression: preview destroyed the layout.
	const kittySeq = "\x1b[5A\x1b_Ga=T,f=100,i=7,q=2,C=1,m=0;AAAA\x1b\\";
	const itermSeq = "\x1b]1337;File=inline=1:AAAA\x07";
	const withImage = ["", "╭─╮", "│ ✓ read form_crop.png │", "╰─╯", "", kittySeq, "", ""];
	const kept = stripEdgesKeepingImages(withImage);
	assert(kept.length === 6, "image: leading gap and box-image spacer dropped, blank tail kept");
	assert(kept[0] === "╭─╮", "image: leading Spacer removed");
	assert(kept.indexOf(kittySeq) === 3 && kept.length - 4 === 2, "image: rows after the sequence intact");
	assert(
		stripEdgesKeepingImages(["", "a", "", "b", "  ", ""]).join() === "a,,b",
		"no image: falls back to plain edge stripping",
	);
	assert(isImageLine(itermSeq) && !isImageLine("│ plain text │"), "image line detection: kitty + iTerm2 only");

	// tools without their own renderer -> same box (memory_write etc.)
	const noRenderer = { toolName: "memory_write", toolDefinition: {} };
	// tool with no definition (e.g. "Tool glob not found") -> still a box, not plain text
	const noDefinition = { toolName: "glob", toolDefinition: undefined, expanded: false };
	assert(
		ToolExecutionComponent.prototype.hasRendererDefinition.call(noDefinition) === true &&
			ToolExecutionComponent.prototype.getRenderShell.call(noDefinition) === "self",
		"tool without a definition: self shell (our box, not the plain fallback)",
	);
	assert(
		ToolExecutionComponent.prototype.hasRendererDefinition.call({ toolName: "x", toolDefinition: {} }) === true,
		"tool with a definition still has its renderer",
	);
	const noDefOut = (ToolExecutionComponent.prototype.getResultRenderer.call(noDefinition) as any)(
		{ content: [{ type: "text", text: '{\n  "pattern": "**/*.ts"\n}\nTool glob not found' }] },
		{ expanded: false, isPartial: false },
		th,
		{ args: { pattern: "**/*.ts" }, state: {} },
	).render(60);
	assert(noDefOut[0].startsWith("\u256d") && noDefOut[noDefOut.length - 1].startsWith("\u2570"), "tool without a definition: result wrapped in a box");
	assert(
		noDefOut.some((l: string) => l.includes("\u2713 glob")) &&
			noDefOut.some((l: string) => l.includes('[show]')),
		"tool without a definition: title + summary + expand hint",
	);
	// todo (this package's own tool, no renderers): the title says what the call left behind.
	const todoNoRenderer = { toolName: "todo", toolDefinition: {} };
	const todoBox = (ToolExecutionComponent.prototype.getResultRenderer.call(todoNoRenderer) as any)(
		{ content: [{ type: "text", text: "Updated #1" }], details: { detail: "completed" } },
		{ expanded: false, isPartial: false },
		th,
		{ args: { action: "update", id: 1, status: "completed" }, state: {} },
	).render(60);
	assert(
		todoBox.some((l: string) => l.includes("todo · completed")),
		`todo result: the title names the status, got ${todoBox.find((l: string) => l.includes("todo"))}`,
	);
	assert(todoBox.some((l: string) => l.includes("Updated #1")), "todo result: the status line keeps the result text");
	const todoPending = (ToolExecutionComponent.prototype.getCallRenderer.call(todoNoRenderer) as any)(
		{ action: "create", subject: "Tulis widget" },
		th,
		{ state: {}, args: {} },
	).render(60);
	assert(todoPending.some((l: string) => l.includes("todo · created")), "todo call: the title names the action");
	assert(
		!todoBox.some((l: string) => l.includes("·") && l.includes("Tulis widget")),
		"todo: the task name stays on the status line, not in the title",
	);
	// Generic predicate: any tool that ships its own renderers and no `renderShell: "self"`
	// is boxed — no name list to maintain for new extensions.
	const withRenderer = { toolName: "bash", toolDefinition: { renderResult: () => undefined } };
	assert(ToolExecutionComponent.prototype.getRenderShell.call(noRenderer) === "self", "plain tool -> self shell");
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(withRenderer) === "self",
		"tool with its own renderer -> boxed too (generic predicate, no name list)",
	);
	const extTool = { toolName: "some_ext_tool", toolDefinition: { renderCall: () => undefined } };
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(extTool) === "self",
		"unknown third-party tool with its own renderer -> boxed",
	);
	assert(
		toolSummary("memory_write", "Appended to MEMORY.md\n\nExisting MEMORY.md preview (1 lines)", {
			content: "## omaga-sync workflow (2026-08-23)\n- Repo: /x",
		}) === "Appended to MEMORY.md. ## omaga-sync workflow (2026-08-23)",
		"memory_write: summary + the heading just written",
	);
	assert(
		toolSummary("memory_write", "Appended to daily log: /x/y.md", { content: "- note without a heading" }) ===
			"Appended to daily log: /x/y.md",
		"memory_write daily: no heading -> first line",
	);
	assert(toolSummary("todo", "line1\nline2") === "line1", "other tools: first line only");
	assert(
		toolSummary("mcp", '{\n  "url": "https://example.com",\n  "ok": true\n}') === '"url": "https://example.com",',
		"first line is just '{' -> next line becomes the summary (MCP JSON)",
	);
	assert(
		toolSummary("mcp", '{\n  "url": "https://example.com",\n  "ok": true\n}', {}) === '"url": "https://example.com",' &&
			toolSummary("mcp", "{") === "{",
		"JSON summary: use the content line, fall back to the first",
	);
	assert(toolSummary("memory_write", "Appended to MEMORY.md") === "Appended to MEMORY.md", "ballast: plain summary kept intact");

	// distinct subtle bg: memory_write only
	assert(boxBgOf("memory_write") === "customMessageBg", "memory_write -> bg customMessageBg");
	assert(boxBgOf("bash") === undefined && boxBgOf("todo") === undefined, "other tools get no extra bg");
	const bgSeen: string[] = [];
	const thBgMem: Theme = { fg: (_c, s) => s, bg: (c, s) => (bgSeen.push(c), `<${s}>`) };
	const bgLines = box(thBgMem, 20, ["memory_write  0.1s", "󱞩 Appended to MEMORY.md"], boxBgOf("memory_write"));
	assert(bgSeen.length === bgLines.length && bgSeen.every((c) => c === "customMessageBg"), "bg used on every box line");
	assert(bgLines.every((l) => visibleWidth(l.replace(/[<>]/g, "")) === 20), "bg does not break the box line width");
	assert(bgLines[0]!.replace(/[<>]/g, "").startsWith("╭"), "top line stays intact");

	// pi-web-access: their renderer content, our box
	const paResult: any = { render: () => ["\x1b[32mPi Coding Agent\x1b[39m (77 matches, 77 shown)"] };
	const paCall: any = { render: () => ["\x1b[1mget_content \x1b[22m\x1b[36mfind 4\x1b[39m"] };
	const boxedRes = {
		toolName: "get_search_content",
		toolDefinition: { renderCall: () => paCall, renderResult: () => paResult },
	};
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(boxedRes) === "self",
		"pi-web-access: shell forced to self (joins our box, not a bg block)",
	);
	const searchRes = {
		toolName: "web_search",
		toolDefinition: { renderCall: () => ({ render: () => ["\x1b[1msearch \x1b[22m\x1b[36m\"site:pi.dev\"\x1b[39m"] }), renderResult: () => ({ render: () => ["\x1b[32m5 sources\x1b[39m"] }) },
	};
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(searchRes) === "self",
		"web_search: shell forced to self (joins our box)",
	);
	const bRes = ToolExecutionComponent.prototype.getResultRenderer.call(boxedRes) as any;
	const bOut = bRes(
		{ content: [{ type: "text", text: "raw text that must not be rendered" }], details: { matchCount: 77 } },
		{ expanded: false, isPartial: false },
		th,
		{ args: {} },
	).render(60);
	assert(bOut[0].startsWith("╭") && bOut[bOut.length - 1].startsWith("╰"), "pi-web-access: result wrapped in our box");
	assert(bOut.some((l: string) => l.includes("(77 matches, 77 shown)")), "pi-web-access: their renderer info kept");
	assert(!bOut.some((l: string) => l.includes("raw text")), "pi-web-access: raw text not used when a renderer exists");
	assert(
		bRes(
			{
				content: [{ type: "text", text: "No URL specified. Provide url, urlIndex, or query." }],
				details: { error: "No URL specified" },
			},
			{ expanded: false, isPartial: false },
			th,
			{ args: {} },
		)
			.render(60)
			.some((l: string) => l.includes("x get_content")),
		"pi-web-access: details.error -> x icon (not ✓)",
	);
	const bErr = bRes(
		{ content: [{ type: "text", text: "No URL specified. Provide url, urlIndex, or query." }] },
		{ expanded: false, isPartial: false },
		th,
		{ args: {}, isError: true },
	).render(60);
	assert(
		bErr.some((l: string) => l.includes("No URL specified")) &&
			bErr.filter((l: string) => l.includes("╭")).length === 1,
		"error: a single box (no nested box)",
	);
	assert(
		bRes({ content: [{ type: "text", text: "x" }] }, { expanded: false, isPartial: true }, th, { args: {} }).render(60)
			.length === 0,
		"pi-web-access: empty partial phase (no double box)",
	);
	const bCall = ToolExecutionComponent.prototype.getCallRenderer.call(boxedRes) as any;
	const bCallOut = bCall({}, th, { args: {}, state: {} }).render(60);
	assert(
		bCallOut[0].startsWith("╭") && bCallOut.some((l: string) => l.includes("find 4")),
		"pi-web-access: their renderer arg lines go in the box",
	);

	// pi-fff override mode: find/grep re-registered with own renderers, no renderShell
	const fffCall = { render: () => ["\x1b[1mfind \x1b[22m\x1b[36m*.ts in /tmp/work\x1b[39m"] };
	const fffRes = { render: () => ["src/a.ts \x1b[2m... (6 more lines)\x1b[22m"] };
	const fffFind = { toolName: "find", toolDefinition: { renderCall: () => fffCall, renderResult: () => fffRes } };
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(fffFind) === "self",
		"pi-fff find: shell forced to self (joins our box)",
	);
	const fffOut = (ToolExecutionComponent.prototype.getResultRenderer.call(fffFind) as any)(
		{ content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }] },
		{ expanded: false, isPartial: false },
		th,
		{ args: { pattern: "*.ts", path: "/tmp/work" }, state: {} },
	).render(60);
	assert(fffOut[0].startsWith("╭") && fffOut[fffOut.length - 1].startsWith("╰"), "pi-fff find: result wrapped in a box");
	assert(fffOut.some((l: string) => l.includes("*.ts in /tmp/work")), "pi-fff find: renderCall title goes in the box");
	assert(fffOut.some((l: string) => l.includes("6 more lines")), "pi-fff find: renderResult summary goes in the box");

	// pi-fff default mode (`ffgrep`/`fffind`): same renderer shape, different names.
	for (const n of ["ffgrep", "fffind"]) {
		const t = { toolName: n, toolDefinition: { renderCall: () => fffCall, renderResult: () => fffRes } };
		assert(
			ToolExecutionComponent.prototype.getRenderShell.call(t) === "self",
			`pi-fff ${n}: shell forced to self (default mode is boxed too)`,
		);
		const out = (ToolExecutionComponent.prototype.getResultRenderer.call(t) as any)(
			{ content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }] },
			{ expanded: false, isPartial: false },
			th,
			{ args: { pattern: "*.ts" }, state: {} },
		).render(60);
		assert(
			out[0].startsWith("╭") && out.some((l: string) => l.includes("6 more lines")),
			`pi-fff ${n}: result + summary merged into one box`,
		);
	}

	// pi core `powershell` / `ls` spread their renderers into the tool object and set no
	// renderShell, so pi's "default" shell used to render them as a bare bg block (see the
	// OWN_BOX block below for the registration half of this fix).
	for (const [n, t] of [
		["powershell", createPowerShellToolDefinition(cwd)],
		["ls", createLsToolDefinition(cwd)],
	] as const) {
		assert(
			ToolExecutionComponent.prototype.getRenderShell.call({ toolName: n, toolDefinition: t }) === "self",
			`pi core ${n}: shell forced to self (joins our box, not a bg block)`,
		);
	}

	const oursFind = { toolName: "find", toolDefinition: { renderShell: "self", renderCall: () => fffCall, renderResult: () => fffRes } };
	assert(
		(ToolExecutionComponent.prototype.getCallRenderer.call(oursFind) as any)() === fffCall &&
			(ToolExecutionComponent.prototype.getResultRenderer.call(oursFind) as any)() === fffRes,
		"our find (renderShell self): its own renderer as-is, not boxed again",
	);

	// Guard: source_check is deliberately NOT boxed — its curator partial carries
	// URLs + approval state, while our partial path returns nothing. Without this
	// assert a later edit of BOXED_TOOLS would swallow it silently.
	for (const n of ["source_check"]) {
		const theirs = () => "their-renderer";
		assert(
			ToolExecutionComponent.prototype.getResultRenderer.call({ toolName: n, toolDefinition: { renderResult: theirs } })() ===
				"their-renderer",
			`${n}: deliberately not boxed (the curator partial needs URLs)`,
		);
	}

	// pi-mcp-adapter: result does NOT use their renderer (unbounded error dump)
	// -> 1-line summary + [show]; the invoked tool stays visible.
	const mcpTheirs = () => "renderer-mcp";
	const mcpTool = { toolName: "mcp", toolDefinition: { renderCall: mcpTheirs, renderResult: mcpTheirs } };
	assert(
		(ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any) !== mcpTheirs,
		"mcp: third-party result renderer skipped (error dump capped)",
	);
	assert(
		(ToolExecutionComponent.prototype.getResultRenderer.call({ toolName: "mcp__tinyfish", toolDefinition: { renderResult: mcpTheirs } }) as any) !==
			mcpTheirs,
		"mcp__<server>: their renderer skipped (our box path)",
	);
	const mcpPayload = {
		content: [{ type: "text", text: "x Failed to call tool\nu Expected parameters:\n{\n  \"required\": []\n}" }],
		details: { error: "failed" },
	};
	const mcpOut = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any)(
		mcpPayload,
		{ expanded: false, isPartial: false },
		th,
		{ args: { tool: "fetch_content", server: "tinyfish" }, state: {} },
	).render(96);
	assert(mcpOut.length <= 6, `mcp error collapsed stays short (${mcpOut.length} lines)`);
	assert(
		mcpOut.some((l: string) => l.includes("fetch_content @ tinyfish")),
		"mcp: title names the invoked MCP tool",
	);
	assert(mcpOut.some((l: string) => l.includes("[show]")), "mcp: expand hint present");
	// Nothing hidden (a single output line), so the label goes away in both states.
	const mcpTiny = { content: [{ type: "text", text: "ok" }], details: {} };
	for (const expanded of [false, true]) {
		const rows = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any)(
			mcpTiny,
			{ expanded, isPartial: false },
			th,
			{ args: { tool: "fetch_content", server: "tinyfish" }, state: {} },
		).render(96);
		assert(rows.every((l: string) => !l.includes("[show]") && !l.includes("[hide]")), `mcp: nothing hidden, so no label (expanded=${expanded})`);
	}
	// A box whose content comes from a third-party renderer still shows its runtime, the
	// way pi's own box did before this module replaced it.
	recordTiming("mcp-dur", 2400);
	const mcpTimed = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any)(
		mcpPayload,
		{ expanded: false, isPartial: false },
		th,
		{ args: { tool: "fetch_content", server: "tinyfish" }, state: {}, toolCallId: "mcp-dur" },
	).render(96);
	assert(mcpTimed[1]!.includes("2.4s"), "mcp: the title row carries the runtime");
	const mcpFull = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpTool) as any)(
		mcpPayload,
		{ expanded: true, isPartial: false },
		th,
		{ args: { tool: "fetch_content", server: "tinyfish" }, state: {} },
	).render(96);
	assert(mcpFull.length > mcpOut.length, "mcp: expand shows the full dump + args");

	// pi-mcp-adapter >= 2.3x defaults to `toolResultRendering: "compact"`, which sets
	// `renderShell: "self"` and paints flat text (`mcp call x @ y`, no border). That
	// `self` means "no box", not "my own box", so the MCP names must still be boxed.
	const mcpCompact = { toolName: "mcp", toolDefinition: { renderShell: "self", renderCall: mcpTheirs, renderResult: mcpTheirs } };
	assert(
		ToolExecutionComponent.prototype.getRenderShell.call(mcpCompact) === "self" &&
			(ToolExecutionComponent.prototype.getResultRenderer.call(mcpCompact) as any) !== mcpTheirs,
		"mcp compact (renderShell self): still boxed, their flat renderer skipped",
	);
	const mcpCompactOut = (ToolExecutionComponent.prototype.getResultRenderer.call(mcpCompact) as any)(
		{ content: [{ type: "text", text: "ok" }], details: {} },
		{ expanded: false, isPartial: false },
		th,
		{ args: { tool: "cloudflare_execute", server: "cloudflare" }, state: {} },
	).render(96);
	assert(
		mcpCompactOut[0].startsWith("\u256d") && mcpCompactOut.some((l: string) => l.includes("cloudflare_execute @ cloudflare")),
		"mcp compact: bordered box naming the invoked tool",
	);
	const mcpCompactCall = (ToolExecutionComponent.prototype.getCallRenderer.call(mcpCompact) as any)(
		{ tool: "cloudflare_execute", server: "cloudflare" },
		th,
		{ args: {}, state: {} },
	).render(96);
	assert(
		mcpCompactCall[0].startsWith("\u256d") && mcpCompactCall.some((l: string) => l.includes("cloudflare_execute @ cloudflare")),
		"mcp compact: the running box is ours too (no flat `mcp call ...` line)",
	);
	// A non-MCP fourth-party `renderShell: "self"` still draws its own box: untouched.
	assert(
		ToolExecutionComponent.prototype.getResultRenderer.call({ toolName: "other_ext", toolDefinition: { renderShell: "self", renderResult: mcpTheirs } })() === "renderer-mcp",
		"renderShell self outside MCP keeps its own renderer",
	);

	// Gap is only stripped for our own box lines.
	// The default export registers the tools (filling OWN_BOX); a pi stub suffices.
	arnativeTools({
		registerTool: () => {},
		registerToolRenderer: () => {},
		on: () => {},
		registerShortcut: () => {},
		registerMessageRenderer: () => {},
	} as never);
	assert(
		OWN_BOX.has("bash") && OWN_BOX.has("read") && OWN_BOX.has("edit") && OWN_BOX.has("fetch_content") && OWN_BOX.has("web_search"),
		"OWN_BOX: our own tools + boxed tools registered",
	);
	assert(!OWN_BOX.has("mcp") && !OWN_BOX.has("source_check"), "OWN_BOX: third-party renderers not tightened");
	// pi core `powershell`/`ls` spread their renderer functions onto the tool object and
	// set no renderShell; that is exactly the shape that used to fall into pi's "default"
	// shell and render as a bare bg block. Registering them through minimal() boxes them.
	const coreReg: Record<string, any> = {};
	arnativeTools({ registerTool: (t: any) => { coreReg[t.name] = t; }, registerToolRenderer: () => {}, on: () => {} } as never);
	for (const [n, t] of [
		["powershell", createPowerShellToolDefinition(cwd)],
		["ls", createLsToolDefinition(cwd)],
	] as const) {
		const def = t as any;
		assert(
			Boolean(def.renderCall) && Boolean(def.renderResult),
			`pi core ${n}: the definition pi runs spreads its renderers onto the object`,
		);
		assert(
			ToolExecutionComponent.prototype.getRenderShell.call({ toolName: n, toolDefinition: def }) === "self",
			`pi core ${n}: shell forced to self (joins our box, not a bg block)`,
		);
	}
	// The guard is load-bearing: `getPowerShellConfig()` throws off Windows, and our
	// registration activates a tool the builtin deliberately leaves off.
	assert(
		coreReg.ls?.renderShell === "self",
		"pi core ls: registered through minimal() (boxing is live)",
	);
	assert(
		process.platform === "win32" ? coreReg.powershell?.renderShell === "self" : coreReg.powershell === undefined,
		"pi core powershell: registered on Windows only (getPowerShellConfig throws elsewhere)",
	);	assert(hasOwnRendererDef(mcpTool) && !hasOwnRendererDef(noRenderer), "tightened benchmark: tool renderer definition");
	assert(
		capped(th, ["a", "b", "c"], false).length === CALL_ROWS + 1 &&
			capped(th, ["a", "b", "c"], true).length === 3 &&
			capped(th, ["a"], false).length === 1,
		"third-party call lines capped only when collapsed",
	);
	assert(
		mcpInfo("bash", { tool: "x" }, th) === "" && mcpInfo("mcp", { tool: "x", server: "s" }, th).includes("x @ s"),
		"mcpInfo only for MCP tools",
	);

	const ctxState: TCtx = { args: { content: "## Heading\n- x" }, state: {} };
	const resRenderer = ToolExecutionComponent.prototype.getResultRenderer.call(noRenderer) as any;
	const out = resRenderer(
		{ content: [{ type: "text", text: "Appended to MEMORY.md\n\nExisting MEMORY.md preview" }] },
		{ expanded: false, isPartial: false },
		th,
		ctxState,
	).render(60);
	assert(out[0].startsWith("╭") && out[out.length - 1].startsWith("╰"), "plain tool result wrapped in a box");
	assert(
		out.some((l: string) => l.includes("Appended to MEMORY.md. ## Heading")),
		"box carries the summary + heading",
	);
	assert(out.some((l: string) => l.includes("[show]")), "collapsed: expand hint present");
	assert(
		resRenderer(
			{ content: [{ type: "text", text: "Appended to MEMORY.md\n\nExisting preview" }] },
			{ expanded: true, isPartial: false },
			th,
			ctxState,
		).render(60).length > out.length,
		"expand: full detail shown too",
	);

	// stale 󰔟 box regression (restore-safe)
	const st: Record<string, unknown> = {};
	const comp = new Lines(() => (st.hasResult ? [] : ["row"]));
	assert(comp.render(10).length === 1, "running: 󰔟 box shown");
	st.hasResult = true;
	assert(comp.render(10).length === 0, "final: running box gone (restore-safe)");
	assert(FRAMES.includes(spinIcon()), "animation icon is always a valid frame");
	__test.ACTIVE = 3;
	syncTicker();
	assert(__test.TICK !== null, "ticker alive while a tool is running");
	__test.ACTIVE = 0;
	syncTicker();
	assert(__test.TICK === null, "ticker stops when idle (no timer leak)");

	// Expanded detail: themed markdown, error text intact and no longer plain dim.
	const errDetail = fullText(
		{ content: [{ type: "text", text: '{\n  "pattern": "**/*.ts"\n}\nTool glob not found' }], isError: true },
		th,
		40,
	);
	const plain = stripAnsi(errDetail.join("\n"));
	assert(plain.includes("Tool glob not found") && plain.includes('"pattern"'), "error detail: content intact");
	assert(
		errDetail.every((l: string) => visibleWidth(l) === 40),
		"error detail: rendered as markdown (wrapped + padded to width), not a plain line split",
	);
	assert(
		fullText({ content: [{ type: "text", text: "a\nb" }] }, th, 0).join("|") === th.fg("dim", "a") + "|" + th.fg("dim", "b"),
		"no width (self-check) still dumps dim",
	);

	// codemode: one box per call, driven through the real component (what pi uses).
	const cmArgs = { code: 'const l = await tools.todo({ action: "list" });\nconsole.log(l);' };
	const cmRes = {
		content: [
			{ type: "text", text: "Script completed\nWall time 0.01 seconds\nOutput:\n" },
			{ type: "text", text: "alpha: ok" },
		],
		details: { calls: [{ status: "ok", name: "todo", args: '{"action":"list"}', durationMs: 2 }] },
	};
	initTheme(); // ToolExecutionComponent resolves a real theme, not the fg-passthrough stub
	const cmRender = (args: any, result: any, expanded = false) => {
		const c: any = new ToolExecutionComponent("codemode", "1", args, {}, codemodeRenderers as any, { requestRender() {} }, cwd);
		if (result) c.updateResult(result, false);
		c.setExpanded(expanded);
		// pi prefixes the box with a spacer blank line; drop blanks so the rows are predictable.
		return (c.render(100) as string[]).map(stripAnsi).filter((l) => l !== "");
	};
	recordTiming("1", 10);
	const cmCollapsed = cmRender(cmArgs, cmRes);
	assert(cmCollapsed.length === 4 && cmCollapsed[0]!.startsWith("╭") && cmCollapsed[3]!.startsWith("╰"), "codemode: collapsed box is title + one script line inside the border");
	assert(cmCollapsed[1]!.endsWith("10ms · [show] │"), "codemode: the title row right-aligns the runtime and expand hint");
	assert(cmCollapsed[2]!.includes("const l = await tools.todo"), "codemode: collapsed shows the first script line");
	const cmExpanded = cmRender(cmArgs, cmRes, true);
	assert(cmExpanded[1]!.endsWith("10ms · [hide] │"), "codemode: the expanded title row right-aligns the runtime and fold hint");
	assert(cmExpanded.some((l) => l.includes("✓ todo") && l.includes("2ms")) && cmExpanded.some((l) => l.includes("alpha: ok")), "codemode: expanded shows the nested calls and the output");
	// A failing run is never truncated: the whole output is shown without a hint in either state.
	const longErr = { content: [{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" + Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") }], isError: true };
	const cmErr = cmRender({ code: "boom()" }, longErr);
	assert(cmErr.some((l) => l.includes("line 12")) && !cmErr.some((l) => l.includes("[show]")), "codemode: a failed run shows all its output, no hint");
	assert(!cmRender({ code: "boom()" }, longErr, true).some((l) => l.includes("[hide]")), "codemode: a failed single-line run has nothing to fold when expanded");
	// Running: the shared spinner, not the codemode glyph, and no hint while nothing is hidden.
	const cmRunning = cmRender({ code: "console.log(1);" }, undefined);
	assert(FRAMES.some((f) => cmRunning.join("\n").includes(f)) && !cmRunning.join("\n").includes("\uf489"), "codemode: running box uses the shared spinner, not the codemode glyph");
	assert(!cmRunning.some((l) => l.includes("[show]")), "codemode: nothing hidden on a single-line script");
	assert([...cmCollapsed, ...cmExpanded, ...cmErr].every((l) => visibleWidth(l) === 100), "codemode: box fills the given width");
	assert(fmtMs(2) === "2ms" && fmtMs(1400) === "1.4s" && fmtMs(undefined) === "", "duration wording: ms under a second, s above");
	assert(codemodeOutput(cmRes.content) === "alpha: ok", "codemode: Script completed header dropped (own block)");
	assert(codemodeOutput([{ type: "text", text: "Script completed\nWall time 0.01 seconds\nOutput:\n2" }]) === "2", "codemode: header dropped when joined with the output");
	// minimal(): a collapsed summary hides more than it shows -> hint; expanded shows all.
	{
		const reg2: Record<string, any> = {};
		const fakePi: any = { registerTool: (t: any) => { reg2[t.name] = t; }, registerToolRenderer: () => {}, on: () => {} };
		arnativeTools(fakePi);
		const minRender = (name: string, args: any, result: any, expanded = false) => {
			const c: any = new ToolExecutionComponent(name, "1", args, {}, reg2[name], { requestRender() {} }, cwd);
			c.updateResult(result, false);
			c.setExpanded(expanded);
			return (c.render(74) as string[]).map(stripAnsi).filter((l) => l !== "");
		};
		const diffRes = { content: [{ type: "text", text: "ok" }], details: { diff: "@@\n-old\n+new" } };
		// The runtime comes from pi's own duration first (a restored session, a tool this
		// module does not wrap), then from the wall clock this module records. The pinned
		// devDependency predates `durationMs`, so only the fallback is reachable here; the
		// pi-supplied path is checked against the installed 1.4.0 in the release audit.
		const withDur = (id: string, expanded: boolean) => {
			const c: any = new ToolExecutionComponent("bash", id, { command: "true" }, {}, reg2.bash, { requestRender() {} }, cwd);
			c.updateResult(diffRes, false);
			c.setExpanded(expanded);
			return (c.render(74) as string[]).map(stripAnsi).filter((l) => l !== "");
		};
		recordTiming("dur-collapsed", 1400);
		const durRow = withDur("dur-collapsed", false)[1]!;
		assert(durRow.includes("1.4s"), "duration: the collapsed title row keeps the runtime");
		assert(
			durRow.indexOf("1.4s") < durRow.indexOf("[show]") && durRow.includes("1.4s · [show]"),
			"duration: the runtime comes first, the label keeps the right edge",
		);
		recordTiming("dur-open", 400);
		const durOpen = withDur("dur-open", true);
		assert(
			durOpen[1]!.includes("400ms · [hide]"),
			"duration: the expanded title row carries the runtime before the fold label",
		);
		const bare = withDur("dur-none", false)[1]!;
		assert(!/dms|d.ds/.test(bare), "duration: a call with no figure leaves the row clean");
		const ed = minRender("edit", { path: "README.md" }, diffRes);
		assert(ed[1]!.includes("[show]"), "minimal(): the title row carries the expand hint");
		assert(ed.some((l) => l.includes("+1 / -1")), "minimal(): the summary stays on its own row");
		assert(!ed.some((l) => l.includes("+1 / -1") && l.includes("[show]")), "minimal(): the summary no longer shares its row with the hint");
		assert(!minRender("edit", { path: "README.md" }, diffRes, true).some((l) => l.includes("[show]")), "minimal(): expanded edit drops the hint");
		// Expanded, the affordance stays: the same key folds the box back, on the title row.
		const opened = minRender("edit", { path: "README.md" }, diffRes, true);
		assert(opened[1]!.includes("[hide]"), "minimal(): the expanded title row offers the fold hint");
		assert(!opened.some((l) => l.includes("[show]")), "minimal(): the folded box offers no expand hint");
		assert(opened.every((l) => visibleWidth(l) === 74), "minimal(): the fold hint keeps every row the box width");
		assert(
			minRender("edit", { path: "README.md" }, { content: [{ type: "text", text: "done" }], details: {} }, true).every((l) => !l.includes("[hide]")),
			"minimal(): nothing hidden, so an expanded box offers no fold hint",
		);
		assert(
			minRender("bash", { command: "true" }, { content: [{ type: "text", text: "done" }], details: {} }).every((l) => !l.includes("[show]")),
			"minimal(): a single-line output has nothing hidden, so no hint",
		);
		// Output that merely STARTS with "Error" is content, not a failure: the box keeps its ✓.
		assert(
			minRender("bash", { command: "true" }, { content: [{ type: "text", text: "Error handling notes" }], details: {} }).some((l) => l.includes("✓")),
			"minimal(): text starting with 'Error' is not treated as a failed call",
		);
		assert(
			minRender("edit", { path: "README.md" }, diffRes).every((l) => visibleWidth(l) === 74),
			"minimal(): hint row still fills the box width",
		);
		// Side-by-side edit diff: Before | After at wide widths, unified fallback when narrow
		const diffTmp = mkdtempSync(join(tmpdir(), "arnative-editdiff-"));
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = diffTmp;
		delete (globalThis as Record<symbol, unknown>)[EDIT_DIFF_CONFIG_KEY];
		resetPresetCache();
		try {
			const openedIsolated = minRender("edit", { path: "README.md" }, diffRes, true);
			assert(openedIsolated.some((l) => l.includes("Before") && l.includes("│") && l.includes("After")), "edit: expanded view shows Before | After header");
			assert(openedIsolated.some((l) => l.includes("─┼─")), "edit: expanded view shows header separator");
			assert(openedIsolated.some((l) => l.includes("old") && !l.includes("-old") && l.includes("│") && l.includes("new") && !l.includes("+new")), "edit: expanded view pairs old and new without +/- prefix");
			const intraRes = { content: [{ type: "text", text: "ok" }], details: { diff: "-const x = 1;\n+const x = 2;" } };
			const intraLines = formatEditDiff(intraRes, th, 70);
			assert(intraLines.some((l) => l.includes("const x = \x1b[7m1\x1b[27m;") && l.includes("const x = \x1b[7m2\x1b[27m;")), "edit: intra-line diff highlights only changed tokens");
			const pureAdd = minRender("edit", { path: "README.md" }, { content: [{ type: "text", text: "ok" }], details: { diff: "+ 10 added\n  11 ctx" } }, true);
			assert(pureAdd.some((l) => /^\│\s+\│\s+10 added/.test(l)), "edit: pure addition leaves Before column blank and strips +");
			assert(pureAdd.some((l) => l.includes("11 ctx") && l.indexOf("11 ctx") !== l.lastIndexOf("11 ctx")), "edit: context line appears in both columns");
			assert(pureAdd.every((l) => visibleWidth(l) === 74), "edit: side-by-side rows keep exact box width");
			const narrow = formatEditDiff(diffRes, th, 40);
			assert(!narrow.some((l) => l.includes("Before") && l.includes("After")), "edit: narrow width falls back to unified diff");
			setEditDiff("Unified");
			const liveUnified = minRender("edit", { path: "README.md" }, diffRes, true);
			assert(!liveUnified.some((l) => l.includes("Before") && l.includes("After")), "edit: setEditDiff('Unified') switches immediately");
			assert(liveUnified.some((l) => l.includes("-old")) && liveUnified.some((l) => l.includes("+new")), "edit: Unified mode keeps +/- lines");
			setEditDiff("Split");
			const liveSplit = minRender("edit", { path: "README.md" }, diffRes, true);
			assert(liveSplit.some((l) => l.includes("Before") && l.includes("After")), "edit: setEditDiff('Split') switches back immediately");
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			delete (globalThis as Record<symbol, unknown>)[EDIT_DIFF_CONFIG_KEY];
			resetPresetCache();
			rmSync(diffTmp, { recursive: true, force: true });
		}
	}

	// Chrome DevTools: their bare renderers are replaced by our box (title + summary).
	const textComp = (text: string, color?: string) => ({
		render: (w: number) => (text ? text.split("\n").map((l) => (color ? th.fg(color, l) : l).slice(0, Math.max(0, w))) : []),
		invalidate() {},
	});
	const cdpRes = {
		toolName: "chrome_devtools_navigate",
		toolDefinition: {
			renderCall: () => textComp("Chrome DevTools: navigate"),
			renderResult: () => textComp(""),
		},
	};
	// The call renderer is not theirs (their bare line would swallow our icon/title).
	assert(
		ToolExecutionComponent.prototype.getCallRenderer.call(cdpRes) !== (cdpRes.toolDefinition.renderCall as any)(),
		"chrome-devtools: their bare call renderer is replaced by our box",
	);
	const cdpResult = { content: [{ type: "text", text: 'navigated\n{\n  "pageId": "p1",\n  "url": "https://example.com"\n}' }], details: {} };
	const cdpComp = (result: any, expanded = false) => {
		const c: any = new ToolExecutionComponent("chrome_devtools_navigate", "1", { url: "https://example.com" }, {}, cdpRes.toolDefinition as any, { requestRender() {} }, cwd);
		if (result) c.updateResult(result, false);
		c.setExpanded(expanded);
		return (c.render(74) as string[]).map(stripAnsi).filter((l) => l !== "");
	};
	const cdpCollapsed = cdpComp(cdpResult);
	assert(
		cdpCollapsed[0]!.startsWith("╭") && cdpCollapsed[cdpCollapsed.length - 1]!.startsWith("╰") && cdpCollapsed.some((l) => l.includes("navigate")),
		"chrome-devtools: result renders in our box with the tool name",
	);
	const cdpCall = ToolExecutionComponent.prototype.getCallRenderer.call(cdpRes) as any;
	const cdpCallOut: string[] = cdpCall({ url: "https://example.com" }, th, { args: {}, state: {} }).render(74);
	assert(
		cdpCallOut[0]!.startsWith("╭") && cdpCallOut.some((l) => stripAnsi(l).includes("Chrome DevTools: navigate")),
		"chrome-devtools: call box keeps the tool title and the CDP glyph",
	);
	assert(stripAnsi(cdpCallOut[1]!).includes(CDP_ICON), "chrome-devtools: call box uses the Chrome glyph, not the spinner");
	const cdpExpanded = cdpComp(cdpResult, true);
	assert(cdpExpanded.some((l) => l.includes('"pageId": "p1"')), "chrome-devtools: expanded shows the full tool output");
	assert(cdpCollapsed.some((l) => l.includes("navigated")), "chrome-devtools: collapsed shows the first line");
	assert(cdpCollapsed[1]!.includes("[show]"), "chrome-devtools: the title row carries the expand hint");
	assert([...cdpCollapsed, ...cdpExpanded].every((l) => visibleWidth(l) === 74), "chrome-devtools: box fills the given width");
	// Mouse on a tool box: the strip patch removes the blank rows above the box AFTER
	// pi laid out its mouse regions, so a click used to land one row high and the top
	// border was dead. pi also drops the click when the pointer drifts one cell.
	const mouseBox = () => {
		const c: any = new ToolExecutionComponent("mouse_probe", "1", {}, {}, {}, { requestRender: () => undefined }, cwd);
		c.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree" }] }, false);
		// Render before any event: pi only hit-tests a click against a box it has measured.
		c.render(60);
		return c;
	};
	// Height comes from the box as drawn, the same number pi puts in the event.
	const mouse = (c: any, type: string, y: number, x = 5): any =>
		c.handleMouse({
			type,
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width: 60,
			height: (c.render(60) as string[]).length,
			shift: false,
			alt: false,
			ctrl: false,
		});
	const click = (c: any, y: number, x = 5) => {
		mouse(c, "press", y, x);
		mouse(c, "release", y, x);
		mouse(c, "click", y, x);
	};
	const spans = (c: any) => textSpans(c.render(60) as string[], "[show]");
	const probeLines = mouseBox().render(60) as string[];
	assert(
		probeLines.length === 4 && stripAnsi(probeLines[0]!).startsWith("╭"),
		"mouse probe: 4 rows, blank edges stripped",
	);
	{
		const box = mouseBox();
		const [hint] = spans(box);
		assert(hint !== undefined, "mouse: the drawn box carries the hint span");
		const x = hint!.start;
		click(box, hint!.row, x);
		assert(box.expanded === true, "mouse: a click on the hint expands");
		click(box, hint!.row, x);
		assert(box.expanded === false, "mouse: the next click on the hint collapses");
	}
	{
		// A one-cell drift used to swallow the click: the press toggles, so it cannot.
		const box = mouseBox();
		const [hint] = spans(box);
		const x = hint!.start;
		mouse(box, "press", hint!.row, x);
		mouse(box, "move", hint!.row, x + 1);
		mouse(box, "release", hint!.row, x + 1);
		assert(box.expanded === true, "mouse: a one-cell drift on the hint still expands");
		mouse(box, "click", hint!.row, x + 1);
		assert(box.expanded === true, "mouse: the swallowed click does not toggle twice");
	}
	{
		// A label inside the output is content, not a button: only the title rows are matched.
		const outLabel: any = new ToolExecutionComponent("bash", "8", { command: "printf" }, {}, {}, { requestRender() {} }, cwd);
		outLabel.updateResult({ content: [{ type: "text", text: "line\n[show] in the output\nmore" }], details: {} }, false);
		outLabel.setExpanded(true);
		const outLines = (outLabel.render(60) as string[]).map(stripAnsi);
		const labelRow = outLines.findIndex((l) => l.includes("in the output"));
		assert(labelRow > 1, "mouse: the output label sits below the title rows");
		const labelX = outLines[labelRow]!.indexOf("[show]");
		const labelTaken = outLabel.handleMouse({ type: "press", button: "left", x: labelX, y: labelRow, screenX: labelX, screenY: labelRow, width: 60, height: outLines.length, shift: false, alt: false, ctrl: false });
		assert(labelTaken === undefined && outLabel.expanded === true, "mouse: a [show] inside the output is not a button");
	}
	{
		// Expanded, the fold hint is a click target too: the same cells, the other label.
		const box = mouseBox();
		const [open] = textSpans(box.render(60) as string[], "[show]");
		click(box, open!.row, open!.start);
		assert(box.expanded === true, "mouse: the expand hint opens the box");
		const [fold] = textSpans(box.render(60) as string[], "[hide]");
		assert(fold !== undefined, "mouse: the expanded box draws the fold hint");
		// One cell of drift: pi would drop the click, so only the hint cells can fold it.
		const fx = fold!.start;
		mouse(box, "press", fold!.row, fx);
		mouse(box, "move", fold!.row, fx + 1);
		mouse(box, "release", fold!.row, fx + 1);
		assert(box.expanded === false, "mouse: a drifting press on the fold hint closes the box");
		mouse(box, "click", fold!.row, fx + 1);
		assert(box.expanded === false, "mouse: the swallowed click does not reopen it");
	}
	{
		// Every cell off the hint keeps press uncaptured for text selection, while a plain
		// single click anywhere on the box still toggles expand/collapse.
		const box = mouseBox();
		const taken = mouse(box, "press", 2, 6);
		assert(taken === undefined && box.expanded === false, "mouse: a press off the hint is left to pi (text selection)");
		mouse(box, "move", 2, 14);
		mouse(box, "release", 2, 14);
		assert(box.expanded === false, "mouse: a drag over the output does not expand the box");
		click(box, 1, 6);
		assert(box.expanded === true, "mouse: single click on box title text expands without blocking drag select");
		click(box, 0, 6);
		assert(box.expanded === false, "mouse: single click on top border collapses without blocking drag select");
		box.handleMouse({
			type: "click",
			button: "left",
			x: 6,
			y: 2,
			screenX: 6,
			screenY: 2,
			width: 60,
			height: (box.render(60) as string[]).length,
			clickCount: 2,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert(box.expanded === false, "mouse: double-click selection does not toggle box");
	}
	{
		// Expanded long output caps body height and offers clickable primary ↑/↓ N more borders.
		const prevRows = process.stdout.rows;
		Object.defineProperty(process.stdout, "rows", { value: 28, configurable: true });
		try {
			const maxBody = expandedBoxBodyLimit(28);
			assert(maxBody === 9, "expanded body viewport adapts cleanly (9 rows at 28-line terminal)");
			const longText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
			const longBox: any = new ToolExecutionComponent("bash", "9", { command: "seq 20" }, {}, {}, { requestRender() {} }, cwd);
			longBox.updateResult({ content: [{ type: "text", text: longText }], details: {} }, false);
			longBox.setExpanded(true);
			const topView = (longBox.render(60) as string[]).map(stripAnsi);
			assert(topView.length === maxBody + 3, `expanded long box caps height to ${maxBody + 3} lines`);
			assert(!topView[0]!.includes("↑") && topView[topView.length - 1]!.includes("↓ 12 more"), "top of expanded box shows only ↓ N more");
			const [downBtn] = textSpans(longBox.render(60) as string[], "↓ 12 more");
			assert(downBtn !== undefined, "↓ N more is clickable on bottom border");
			click(longBox, downBtn!.row, downBtn!.start);
			const midView = (longBox.render(60) as string[]).map(stripAnsi);
			assert(midView[0]!.includes("↑ 4 more") && midView[midView.length - 1]!.includes("↓ 8 more"), "clicking ↓ N more scrolls body down");
			assert(midView.some((l) => l.includes("line 4")) && !midView.some((l) => l.includes("󱞩 line 1")), "scrolled viewport hides scrolled-past rows");
			const [upBtn] = textSpans(longBox.render(60) as string[], "↑ 4 more");
			assert(upBtn !== undefined, "↑ N more is clickable on top border");
			click(longBox, upBtn!.row, upBtn!.start);
			const backView = (longBox.render(60) as string[]).map(stripAnsi);
			assert(!backView[0]!.includes("↑") && backView.some((l) => l.includes("line 1")), "clicking ↑ N more scrolls back to top");
			const edge = paintScrollEdge("\x1b[48;2;10;20;30m\x1b[2m╭──────────╮\x1b[39m\x1b[49m", "\u256d", "\u256e", "\u2191 1 more", 24, (t) => `<bdr>${t}</bdr>`, (t) => `<pri>${t}</pri>`);
			assert(edge.startsWith("\x1b[48;2;10;20;30m") && edge.endsWith("\x1b[49m") && edge.includes("<pri>↑ 1 more</pri>"), "scroll edge preserves background and paints N more in primary");
		} finally {
			Object.defineProperty(process.stdout, "rows", { value: prevRows, configurable: true });
		}
	}

	// Capped timings map self-check
	for (let i = 0; i < 250; i++) recordTiming(`call_${i}`, i);
	assert(TIMINGS.size === MAX_TIMINGS, `TIMINGS size is bounded to ${MAX_TIMINGS}`);
	assert(!TIMINGS.has("call_0") && TIMINGS.has("call_249"), "TIMINGS evicts oldest entries");
	TIMINGS.clear();

	// /reload re-evaluates this module inside the same pi process. The prototype patches
	// must reinstall with the new closures; a globalThis guard bailed out on the second
	// load and kept the old ones, so a UI fix never appeared until pi restarted.
	{
		const before = ToolExecutionComponent.prototype.getResultRenderer;
		await import(`${new URL("../../lib/features/tools.ts", import.meta.url).href}?reload=1`);
		const after = ToolExecutionComponent.prototype.getResultRenderer;
		assert(after !== before, "/reload: the prototype patch reinstalls on re-evaluation");
		// The stored original must stay pi's own method: capturing our previous patch
		// wrapped every box in a second one (double border + double ✓).
		const stored = (ToolExecutionComponent.prototype as any)[Symbol.for("pi-arnative.protoOriginals")];
		const patchedMark = Symbol.for("pi-arnative.patchedMethod");
		assert(
			!stored.render[patchedMark] && !stored.getResultRenderer[patchedMark],
			"/reload: originals stay pi's own methods, never a previous patch",
		);
		const plainAfter = (ToolExecutionComponent.prototype.getResultRenderer.call(noRenderer) as any)(
			{ content: [{ type: "text", text: "Appended to MEMORY.md" }] },
			{ expanded: false, isPartial: false },
			th,
			{ args: {}, state: {} },
		).render(60);
		assert(
			plainAfter.filter((l: string) => l.startsWith("\u256d")).length === 1,
			"/reload: a plain tool draws one box, not a box inside a box",
		);
		const mcpAfter = (after as any).call(mcpCompact);
		assert(mcpAfter !== mcpTheirs, "/reload: MCP stays boxed after re-evaluation");
		const out2 = mcpAfter(
			{ content: [{ type: "text", text: "ok" }], details: {} },
			{ expanded: false, isPartial: false },
			th,
			{ args: { tool: "cloudflare_execute", server: "cloudflare" }, state: {} },
		).render(96);
		assert(
			out2[0].startsWith("\u256d") && out2.some((l: string) => l.includes("cloudflare_execute @ cloudflare")),
			"/reload: the box still renders (no double-patch loop, originals kept once)",
		);
	}


	// --- Third-party boxes carry a title row, so they can be folded like any other ----
	// pi-web-access paints its own template; without our title row the box lost the tool
	// name, the runtime and the [show] label, so the only way to expand it was ctrl+o.
	const paFolding = {
		toolName: "web_search",
		toolDefinition: {
			renderResult: (_r: unknown, o: { expanded?: boolean }) => ({
				render: () => (o.expanded ? ["a", "b", "c", "d"] : ["a"]),
			}),
		},
	};
		const paFold = (expanded: boolean) =>
		(ToolExecutionComponent.prototype.getResultRenderer.call(paFolding) as any)(
			{ content: [{ type: "text", text: "raw" }], details: {} },
			{ expanded, isPartial: false },
			th,
			{ args: {}, state: {} },
			).render(80) as string[];
		const paFolded = paFold(false).map(stripAnsi);
		const paOpen = paFold(true).map(stripAnsi);
		assert(paFolded[1]!.includes("search"), "third-party box: the title row names the tool");
		assert(paFolded[1]!.includes("[show]"), "third-party box: collapsed offers [show]");
		assert(paOpen[1]!.includes("[hide]"), "third-party box: expanded offers [hide]");
		assert(paOpen.length > paFolded.length, "third-party box: expanding really shows more rows");
		// A renderer that ignores `expanded` has nothing to fold, so it gets no label.
		const flat = { toolName: "web_search", toolDefinition: { renderResult: () => ({ render: () => ["only line"] }) } };
		for (const expanded of [false, true]) {
			const rows = (ToolExecutionComponent.prototype.getResultRenderer.call(flat) as any)(
			{ content: [{ type: "text", text: "raw" }], details: {} },
			{ expanded, isPartial: false },
			th,
			{ args: {}, state: {} },
			).render(80) as string[];
			assert(rows.every((l: string) => !l.includes("[show]") && !l.includes("[hide]")), `third-party box: nothing to fold, no label (expanded=${expanded})`);
		}

	// --- A one-line payload that fills the screen still folds ---------------------
	// A JSON reply has no newline, so it used to count as one row: no [show], and the
	// summary row wrapped into 30 rows because nothing clipped it.
		const longJson = JSON.stringify({ results: [{ url: "https://example.com", text: "x".repeat(4000) }] });
		const longBox = resRenderer(
		{ content: [{ type: "text", text: longJson }] },
		{ expanded: false, isPartial: false },
		th,
		{ args: {}, state: {} },
		).render(80) as string[];
		assert(longBox.some((l: string) => l.includes("[show]")), "a wrapped one-line payload offers [show]");
		assert(longBox.length <= 6, `a folded box stays short whatever the payload (${longBox.length} rows)`);
		assert(
		longBox.every((l: string) => !l.includes("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")),
		"the summary row is one row: the payload is clipped, not wrapped",
		);
		const shortBox = resRenderer(
		{ content: [{ type: "text", text: "done" }] },
		{ expanded: false, isPartial: false },
		th,
		{ args: {}, state: {} },
		).render(80) as string[];
		assert(shortBox.every((l: string) => !l.includes("[show]")), "a one-row answer has nothing to fold, so no label");
});
