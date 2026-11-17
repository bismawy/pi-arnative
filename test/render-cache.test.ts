/**
 * Render cache tests: real pi transcript components, reload-safe patching, thinking/scroll
 * bypass, and mouseLayout preservation.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AssistantMessageComponent,
	InteractiveMode,
	ToolExecutionComponent,
	UserMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import registerRenderCache, {
	attachChatContainer,
	clearRenderCache,
	isDynamicChild,
	setRenderCache,
} from "../extensions/render-cache.ts";
import { resetPresetCache } from "../lib/preset-store.ts";

const PATCHED = Symbol.for("pi-arnative.patchedMethod");
const ORIGINALS = Symbol.for("pi-arnative.protoOriginals");
const THINKING_STATE_KEY = Symbol.for("pi-arnative.thinkingLabelState");
const SCROLL_HOLD_KEY = Symbol.for("pi-arnative.toolBoxScrollHold");
const SCROLL_OFFSET_KEY = Symbol.for("pi-arnative.toolBoxScrollOffset");

test("InteractiveMode hook reinstalls cleanly across /reload", async () => {
	await import("../extensions/render-cache.ts?rc=1");
	const proto = InteractiveMode.prototype as unknown as Record<string | symbol, any>;
	const first = proto.rebuildChatFromMessages;
	assert.equal(typeof first, "function");
	assert.equal(first[PATCHED], true);
	assert.equal(proto[ORIGINALS].rebuildChatFromMessages[PATCHED], undefined);

	await import("../extensions/render-cache.ts?rc=2");
	const second = proto.rebuildChatFromMessages;
	assert.notEqual(second, first);
	assert.equal(second[PATCHED], true);
	assert.equal(proto[ORIGINALS].rebuildChatFromMessages[PATCHED], undefined);
});

test("real pi transcript components cache when settled and update on mutation", () => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-rendercache-test-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();
	try {
		initTheme();
		setRenderCache("On");
		clearRenderCache();

		let uiRenderPokes = 0;
		const chat = new Container();
		const user = new UserMessageComponent("Hello **world**");
		const assistant = new AssistantMessageComponent({
			role: "assistant",
			content: [{ type: "text", text: "Answer text" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
		const tool = new ToolExecutionComponent(
			"bash",
			"call_1",
			{ command: "echo hi" },
			{},
			undefined,
			{ requestRender: () => { uiRenderPokes += 1; } } as never,
			process.cwd(),
		);
		tool.updateResult({ content: [{ type: "text", text: "hi\nline2" }], isError: false }, false);

		chat.addChild(user);
		chat.addChild(assistant);
		chat.addChild(tool);
		attachChatContainer(chat);

		let userRenderCalls = 0;
		const origUserRender = user.render.bind(user);
		user.render = (w: number) => {
			userRenderCalls += 1;
			return origUserRender(w);
		};

		const firstLines = chat.render(80);
		assert.ok(firstLines.length > 0);
		assert.equal(userRenderCalls, 1);

		const secondLines = chat.render(80);
		assert.equal(secondLines, firstLines, "settled chatContainer returns cached lines array");
		assert.equal(userRenderCalls, 1, "settled user message was not re-rendered");

		// Expanding the tool re-renders only the mutated tool; user stays cached.
		tool.setExpanded(true);
		const expandedLines = chat.render(80);
		assert.notEqual(expandedLines, firstLines);
		assert.equal(userRenderCalls, 1, "sibling user message stayed cached when tool expanded");
		assert.ok(uiRenderPokes >= 0);

		// clearRenderCache() forces a fresh render on next frame.
		clearRenderCache();
		chat.render(80);
		assert.equal(userRenderCalls, 2, "clearRenderCache invalidates cached children");
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.renderCache")];
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dynamic thinking animation and tool scroll-hold bypass cache cleanly", () => {
	const g = globalThis as Record<symbol, unknown>;
	const prevThinking = g[THINKING_STATE_KEY];
	const active = new Set<object>();
	g[THINKING_STATE_KEY] = { active };

	const msg: Record<string | symbol, unknown> = {};
	assert.equal(isDynamicChild(msg), false);

	active.add(msg);
	assert.equal(isDynamicChild(msg), true, "active thinking animation bypasses cache");
	active.delete(msg);
	assert.equal(isDynamicChild(msg), false, "finished thinking settles");

	msg[SCROLL_HOLD_KEY] = { delay: 1 };
	assert.equal(isDynamicChild(msg), true, "active tool scroll-hold bypasses cache");
	msg[SCROLL_HOLD_KEY] = undefined;
	msg[SCROLL_OFFSET_KEY] = 3;
	assert.equal(isDynamicChild(msg), false, "released scroll-hold settles at new offset");

	if (prevThinking === undefined) delete g[THINKING_STATE_KEY];
	else g[THINKING_STATE_KEY] = prevThinking;
});

test("width LRU keeps a third width warm (3-way terminal toggle)", () => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-rendercache-lru-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();
	try {
		initTheme();
		setRenderCache("On");
		clearRenderCache();

		const chat = new Container();
		const user = new UserMessageComponent("Hello");
		let renders = 0;
		const origRender = user.render.bind(user);
		user.render = (w: number) => {
			renders += 1;
			return origRender(w);
		};
		chat.addChild(user);
		attachChatContainer(chat);

		// Cycle three widths twice: with MAX_WIDTH_ENTRIES >= 3 the second cycle
		// is fully warm (A/B verified: 710 us/render thrash -> 35 us/render warm).
		for (const w of [120, 80, 160, 120, 80, 160]) chat.render(w);
		assert.equal(renders, 3, "a 3-way toggle stays warm after the first cycle");

		// A fourth, unseen width still renders fresh (LRU cap, not a leak).
		chat.render(200);
		assert.equal(renders, 4, "an unseen width renders fresh");
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.renderCache")];
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("registerRenderCache drops cached frames on session_start, model_select, and session_compact", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-rendercache-events-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();
	try {
		initTheme();
		setRenderCache("On");
		clearRenderCache();

		const handlers: Record<string, () => Promise<void>> = {};
		registerRenderCache({ on: (name: string, fn: () => Promise<void>) => void (handlers[name] = fn) } as never);

		const chat = new Container();
		const user = new UserMessageComponent("Hello");
		let renders = 0;
		const origRender = user.render.bind(user);
		user.render = (w: number) => {
			renders += 1;
			return origRender(w);
		};
		chat.addChild(user);
		attachChatContainer(chat);

		chat.render(80);
		assert.equal(renders, 1);
		chat.render(80);
		assert.equal(renders, 1, "cached before event");

		for (const event of ["session_compact", "session_start", "model_select"] as const) {
			assert.equal(typeof handlers[event], "function", `${event} handler registered`);
			await handlers[event]!();
			chat.render(80);
		}
		assert.equal(renders, 4, "each lifecycle reset forces a fresh render");
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.renderCache")];
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
});
