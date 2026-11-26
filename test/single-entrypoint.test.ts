import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import registerPiArnative from "../extensions/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package.json exposes a single entry point and excludes dev generators from files", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		files?: string[];
		pi?: { extensions?: string[] };
	};
	assert.deepEqual(pkg.pi?.extensions, ["./extensions/index.ts"]);
	assert.ok(pkg.files?.includes("themes/*.json"), "package.json files should ship only themes/*.json");
	assert.ok(!pkg.files?.includes("themes"), "package.json files must not ship themes/gen-themes.mjs");

	const entries = readdirSync(join(root, "extensions")).sort();
	assert.deepEqual(
		entries,
		["index.ts"],
		"keeping only index.ts in extensions/ prevents older installed ./extensions/*.ts globs from double-registering during overlay",
	);
});

test("single entry point registers every feature with zero duplicate commands, tools, or shortcuts", () => {
	const commands: string[] = [];
	const tools: string[] = [];
	const shortcuts: string[] = [];
	const events: string[] = [];
	const messageRenderers: string[] = [];
	let toolRendererCount = 0;
	let thinkingLevel = "off";

	const mockPi = {
		on(event: string) {
			events.push(event);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerTool(def: { name: string }) {
			tools.push(def.name);
		},
		registerToolRenderer() {
			toolRendererCount += 1;
		},
		registerMessageRenderer(type: string) {
			messageRenderers.push(type);
		},
		registerShortcut(key: string) {
			shortcuts.push(key);
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel(level: string) {
			thinkingLevel = level;
		},
		setModel: async () => true,
	};

	registerPiArnative(mockPi as never);

	for (const required of ["arnative", "providers", "usage", "todos", "model-heal"]) {
		assert.ok(commands.includes(required), `missing command /${required}`);
	}
	assert.ok(tools.includes("todo"), "missing todo tool");
	assert.equal(toolRendererCount, 1, "expected exactly one tool renderer registration");
	assert.ok(messageRenderers.includes("pi-jev-eye-review"), "missing message renderer registration");
	assert.equal(new Set(commands).size, commands.length, `duplicate commands: ${commands.join(", ")}`);
	assert.equal(new Set(tools).size, tools.length, `duplicate tools: ${tools.join(", ")}`);
	assert.equal(new Set(shortcuts).size, shortcuts.length, `duplicate shortcuts: ${shortcuts.join(", ")}`);
	assert.equal(
		new Set(events).size,
		events.length,
		`centralized lifecycle must register at most 1 pi.on() per event type; got duplicates in [${events.join(", ")}]`,
	);
	assert.ok(events.includes("session_start"), "missing session_start handlers");
	assert.ok(events.includes("session_shutdown"), "missing session_shutdown handlers");
});

test("centralized lifecycle dispatcher preserves ordering, isolates sibling errors, and chains return values", async () => {
	const { registerLifecycleFeatures } = await import("../lib/runtime.ts");
	const registered = new Map<string, (event: any, ctx: any) => any>();
	const mockPi = {
		on(event: string, handler: (event: any, ctx: any) => any) {
			registered.set(event, handler);
		},
	};
	const order: string[] = [];
	registerLifecycleFeatures(mockPi as never, [
		(pi) => {
			pi.on("session_shutdown" as never, () => {
				order.push("first");
				throw new Error("boom");
			});
			pi.on("input" as never, (e: any) => ({ action: "transform", text: `${e.text}!` }));
			pi.on("context" as never, (e: any) => ({ messages: [...e.messages, "a"] }));
		},
		(pi) => {
			pi.on("session_shutdown" as never, () => {
				order.push("second");
			});
			pi.on("input" as never, (e: any) => ({ action: "transform", text: `${e.text}?` }));
			pi.on("context" as never, (e: any) => ({ messages: [...e.messages, "b"] }));
		},
	]);

	assert.equal(registered.size, 3);
	await assert.rejects(() => registered.get("session_shutdown")!({}, {}), /boom/);
	assert.deepEqual(order, ["first", "second"], "sibling shutdown handlers still run after an earlier error");

	const inputRes = await registered.get("input")!({ text: "hi" }, {});
	assert.deepEqual(inputRes, { action: "transform", text: "hi!?", images: undefined });

	const ctxRes = await registered.get("context")!({ messages: [] }, {});
	assert.deepEqual(ctxRes, { messages: ["a", "b"] });
});
