import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	AssistantMessageComponent,
	FooterComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { attachChatContainer, clearRenderCache, type ChatContainerLike } from "../lib/features/render-cache.ts";
import { repairBubbleBg } from "../lib/features/timestamps.ts";
import "../lib/features/footer.ts";
import "../lib/features/tools.ts";
import "../lib/features/ui-render-tweaks.ts";

const ORIGINALS_KEY = Symbol.for("pi-arnative.protoOriginals");

/**
 * Temporarily replace a prototype's recorded original method, re-import the extension module
 * so its `originalOf`/`patchOnce` wrapper binds to the stub, run `fn`, and restore both the
 * original record and wrapper afterward.
 */
async function withFrozenOriginal(
	proto: Record<symbol | string, any>,
	key: string,
	stub: (...args: any[]) => unknown,
	modulePath: string,
	fn: () => void | Promise<void>,
): Promise<void> {
	const originals = proto[ORIGINALS_KEY] as Record<string, any> | undefined;
	assert.ok(originals && typeof originals[key] === "function", `recorded original for ${key}`);
	const savedOriginal = originals[key];
	const savedWrapper = proto[key];
	try {
		originals[key] = stub;
		await import(`${pathToFileURL(join(process.cwd(), modulePath)).href}?freeze=${Date.now()}-${Math.random()}`);
		await fn();
	} finally {
		originals[key] = savedOriginal;
		proto[key] = savedWrapper;
	}
}

test("timestamps.ts never mutates frozen cached UserMessageComponent.render output and stays idempotent", async () => {
	const bg = "\x1b[48;2;40;42;54m";
	const tsState = (globalThis as Record<symbol, any>)[Symbol.for("pi-arnative.chatTimestampState")];
	const prevTheme = tsState?.theme;
	const fakeTheme = {
		fg: (_c: string, t: string) => `\x1b[36m${t}\x1b[39m`,
		bg: (_c: string, t: string) => `${bg}${t}\x1b[49m`,
	};
	const frozenShort = Object.freeze([
		`\x1b]133;A\x07${bg}${" ".repeat(40)}\x1b[49m`,
		`${bg} hello\x1b[0m   \x1b[49m`,
		`\x1b]133;B\x07\x1b]133;C\x07${bg}${" ".repeat(40)}\x1b[49m`,
	]);
	const snapshot = [...frozenShort];

	await withFrozenOriginal(
		UserMessageComponent.prototype as any,
		"render",
		() => frozenShort,
		"lib/features/timestamps.ts",
		() => {
			if (tsState) tsState.theme = fakeTheme;
			const fakeComp = {
				text: "hello",
				timestamp: "2026-11-21T05:10:00.000Z",
			};
			const first = (UserMessageComponent.prototype as any).render.call(fakeComp, 40) as readonly string[];
			assert.notEqual(first, frozenShort, "returns a copy instead of the cached source array");
			assert.deepEqual([...frozenShort], snapshot, "frozen source lines are untouched");
			assert.ok(first[1]!.includes(`\x1b[0m${bg}`), "mid-line reset gets bubble bg repaired");
			for (let i = 0; i < 10; i++) {
				const next = (UserMessageComponent.prototype as any).render.call(fakeComp, 40) as readonly string[];
				assert.equal(next, first, "repeated frames hit per-component cache in O(1)");
				assert.deepEqual(next, first, "repeated frames produce identical output without growth");
			}
			// Direct repairBubbleBg idempotency guard.
			const repaired = repairBubbleBg(`${bg}hi\x1b[0m   \x1b[49m`, bg);
			assert.equal(repairBubbleBg(repaired, bg), repaired, "repairBubbleBg is idempotent");
		},
	);
	if (tsState) tsState.theme = prevTheme;
});

test("timestamps.ts never mutates frozen cached AssistantMessageComponent.render output", async () => {
	const frozen = Object.freeze(["\x1b]133;A\x07Answer text", "\x1b]133;B\x07\x1b]133;C\x07Second line"]);
	const snapshot = [...frozen];

	await withFrozenOriginal(
		AssistantMessageComponent.prototype as any,
		"render",
		() => frozen,
		"lib/features/timestamps.ts",
		() => {
			const fakeComp = {
				lastMessage: {
					role: "assistant",
					timestamp: Date.parse("2026-11-21T05:10:00.000Z"),
					content: [{ type: "text", text: "Answer text" }],
				},
			};
			const first = (AssistantMessageComponent.prototype as any).render.call(fakeComp, 40) as readonly string[];
			assert.notEqual(first, frozen, "returns a copy when placing the clock");
			assert.deepEqual([...frozen], snapshot, "frozen source lines are untouched");
			for (let i = 0; i < 5; i++) {
				const next = (AssistantMessageComponent.prototype as any).render.call(fakeComp, 40) as readonly string[];
				assert.equal(next, first, "repeated frames reuse cached output");
			}
		},
	);
});

test("FooterComponent, ToolExecutionComponent, and Container render wrappers tolerate frozen cached arrays", async () => {
	const frozenFooter = Object.freeze(["row 1", "row 2", "row 3"]);
	await withFrozenOriginal(
		FooterComponent.prototype as any,
		"render",
		() => frozenFooter,
		"lib/features/footer.ts",
		() => {
			const out = (FooterComponent.prototype as any).render.call({}, 80) as readonly string[];
			assert.deepEqual([...frozenFooter], ["row 1", "row 2", "row 3"]);
			assert.ok(out.length >= 2 && out.length <= 3);
		},
	);

	const frozenTool = Object.freeze(["", "╭─ read ─╮", "│ ok     │", "╰────────╯", ""]);
	await withFrozenOriginal(
		ToolExecutionComponent.prototype as any,
		"render",
		() => frozenTool,
		"lib/features/tools.ts",
		() => {
			const fakeTool: Record<string, unknown> = { toolName: "read", expanded: false };
			const out = (ToolExecutionComponent.prototype as any).render.call(fakeTool, 40) as readonly string[];
			assert.equal(out.length, 3, "blank edges stripped without mutating frozen source");
			assert.deepEqual([...frozenTool], ["", "╭─ read ─╮", "│ ok     │", "╰────────╯", ""]);
		},
	);

	const containerProto = Object.getPrototypeOf(UserMessageComponent.prototype) as Record<symbol | string, any>;
	const frozenChat = Object.freeze(["hello", "world"]);
	await withFrozenOriginal(
		containerProto,
		"render",
		() => frozenChat,
		"lib/features/ui-render-tweaks.ts",
		() => {
			const out = containerProto.render.call({}, 80) as readonly string[];
			assert.deepEqual([...out], ["hello", "world"]);
		},
	);
});

test("render-cache handles frozen child arrays and keeps Pi 1.6.0 childLines synchronized", () => {
	clearRenderCache();
	const child = Object.assign(new Text("frozen", 0, 0), { renders: 0 });
	child.render = (w: number) => {
		child.renders += 1;
		return Object.freeze([`frozen@${w}`]) as unknown as string[];
	};

	const container: ChatContainerLike = {
		children: [child],
		render(width: number) {
			return child.render(width);
		},
	};
	attachChatContainer(container);

	const first = container.render(80);
	assert.deepEqual(first, ["frozen@80"]);
	assert.equal(container.childLines?.width, 80);
	assert.equal(container.childLines?.children.length, 1);
	assert.equal(container.childLines?.parts.length, 1);
	assert.equal(container.childLines?.lines, first);

	const second = container.render(80);
	assert.equal(second, first);
	assert.equal(child.renders, 1, "cache hit avoids re-rendering frozen child");
	assert.equal(container.childLines?.lines, second, "childLines remains populated on cache hit");
});

test("installed Pi runtime exposes every patched prototype method and Container.childLines", async (t) => {
	const installRoot = join(homedir(), ".pi", "agent", "install");
	const currentVersionPath = join(installRoot, "current-version");
	if (!existsSync(currentVersionPath)) {
		t.skip("managed Pi install not present on this host");
		return;
	}
	const version = readFileSync(currentVersionPath, "utf8").trim();
	const scopeDir = join(installRoot, "releases", version, "node_modules", "@earendil-works");
	if (!existsSync(scopeDir)) {
		t.skip(`Pi release ${version} modules not found under ${scopeDir}`);
		return;
	}

	const tui = await import(pathToFileURL(join(scopeDir, "pi-tui", "dist", "index.js")).href);
	const agent = await import(pathToFileURL(join(scopeDir, "pi-coding-agent", "dist", "index.js")).href);

	const requiredMethods: Array<[string, Record<string, unknown> | undefined, string[]]> = [
		["Container.prototype", tui.Container?.prototype, ["render", "handleMouse", "addChild", "removeChild", "clear", "invalidate"]],
		["TuiAltScreen.prototype", tui.TuiAltScreen?.prototype, ["applySelectionHighlight", "compositeScrollToEndIndicator"]],
		["UserMessageComponent.prototype", agent.UserMessageComponent?.prototype, ["render"]],
		["AssistantMessageComponent.prototype", agent.AssistantMessageComponent?.prototype, ["render", "updateContent"]],
		[
			"ToolExecutionComponent.prototype",
			agent.ToolExecutionComponent?.prototype,
			["render", "handleMouse", "getCallRenderer", "getResultRenderer", "getRenderShell", "hasRendererDefinition"],
		],
		["FooterComponent.prototype", agent.FooterComponent?.prototype, ["render"]],
		["CompactionSummaryMessageComponent.prototype", agent.CompactionSummaryMessageComponent?.prototype, ["updateDisplay"]],
		["ExtensionSelectorComponent.prototype", agent.ExtensionSelectorComponent?.prototype, ["updateList"]],
		[
			"InteractiveMode.prototype",
			agent.InteractiveMode?.prototype,
			[
				"init",
				"handleReloadCommand",
				"rebuildChatFromMessages",
				"addMessageToChat",
				"handleEvent",
				"updateThinkingBlockVisibility",
				"renderWidgetContainer",
				"showStatusIndicator",
				"showPackageUpdateNotification",
				"setExtensionWidget",
				"renderWidgets",
			],
		],
	];

	for (const [label, proto, methods] of requiredMethods) {
		assert.ok(proto, `${label} exists in Pi ${version}`);
		for (const method of methods) {
			assert.equal(typeof proto[method], "function", `${label}.${method} exists in Pi ${version}`);
		}
	}

	// At least one session-render hook exists in InteractiveMode across Pi 1.5.x and 1.6.x+.
	const modeProto = agent.InteractiveMode.prototype as Record<string, unknown>;
	const sessionHooks = ["renderSessionContext", "renderSessionEntries", "renderSessionItems", "renderCurrentSessionState"];
	assert.ok(
		sessionHooks.some((m) => typeof modeProto[m] === "function"),
		`InteractiveMode exposes at least one session-render hook in Pi ${version}`,
	);

	// Live Pi Container.handleMouse must reuse childLines populated by attachChatContainer.
	clearRenderCache();
	const container = new tui.Container();
	let childRenders = 0;
	const child = new tui.Text("live", 0, 0);
	const origRender = child.render.bind(child);
	child.render = (w: number) => {
		childRenders += 1;
		return origRender(w);
	};
	container.addChild(child);
	attachChatContainer(container);
	container.render(80);
	assert.equal(childRenders, 1);
	container.handleMouse({ type: "move", button: "none", x: 0, y: 0, width: 80, height: 1 });
	assert.equal(childRenders, 1, `Pi ${version} Container.handleMouse must not cold-rerender after attachChatContainer`);
});
