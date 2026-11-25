import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import registerPiArnative from "../extensions/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package.json exposes a single entry point and extensions/ holds only index.ts", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
	};
	assert.deepEqual(pkg.pi?.extensions, ["./extensions/index.ts"]);

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
	assert.ok(events.includes("session_start"), "missing session_start handlers");
	assert.ok(events.includes("session_shutdown"), "missing session_shutdown handlers");
});
