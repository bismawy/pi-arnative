import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetPresetCache } from "../lib/preset-store.ts";
import registerModelHeal from "../extensions/model-heal.ts";

// Regression gate for the DEBOUNCE_MS crash (pi exited with
// "ReferenceError: DEBOUNCE_MS is not defined" from the FSWatcher callback).
//
// The self-check inside extensions/model-heal.ts only proves the module loads. The
// constant was referenced from inside the models.json FSWatcher callback, which runs
// async with no try/catch above it, so a missing binding escaped as an uncaught
// exception and killed the process. This test trips the real watcher and fails if
// anything escapes it.

const VALID_MODELS = JSON.stringify(
	{
		providers: {
			"auto/test": {
				name: "Test",
				baseUrl: "https://example.invalid/v1",
				models: [{ id: "test-1", name: "Test 1", contextWindow: 128000 }],
			},
		},
	},
	null,
	2,
);

test("a models.json write reaches the debounce callback without throwing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-heal-watch-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();

	const escaped: unknown[] = [];
	const onUncaught = (err: unknown): void => {
		escaped.push(err);
	};
	process.on("uncaughtException", onUncaught);

	const modelsPath = join(dir, "models.json");
	writeFileSync(modelsPath, VALID_MODELS, "utf8");

	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const fakePi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		setModel: async () => true,
	} as unknown as Parameters<typeof registerModelHeal>[0];
	registerModelHeal(fakePi);

	// A ctx whose passes bail early: this gate only cares that the watch callback runs.
	const ctx = {
		model: undefined,
		modelRegistry: {
			getRegisteredProviderConfig: () => {
				throw new Error("no registry in this gate");
			},
		},
		ui: { notify: () => {} },
	} as unknown as Parameters<NonNullable<ReturnType<typeof handlers.get>> & ((...a: never[]) => never)>[1];

	try {
		await handlers.get("session_start")?.({}, ctx);
		assert.ok(handlers.has("session_shutdown"), "session_shutdown is registered to stop the watcher");

		// Trip the watcher: this fires the callback that evaluated DEBOUNCE_MS.
		writeFileSync(modelsPath, VALID_MODELS.replace("128000", "200000"), "utf8");
		await new Promise((resolve) => setTimeout(resolve, 1200));

		assert.deepEqual(
			escaped.map((e) => (e instanceof Error ? e.message : String(e))),
			[],
			"nothing may escape the models.json watcher (that path is what killed pi)",
		);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		process.off("uncaughtException", onUncaught);
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
});
