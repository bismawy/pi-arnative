import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { createExtensionRuntime, ExtensionRunner, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerModelHeal from "../extensions/model-heal.ts";
import { reloadCurrentModel } from "../lib/provider.ts";

const model = { provider: "relay", id: "m", api: "openai-completions", baseUrl: "https://relay.example/v1", reasoning: true,
	thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
	compat: { supportsLongCacheRetention: false, supportsDeveloperRole: false, sendSessionAffinityHeaders: true } };
let dir: string;
let previous: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "arnative-heal-command-"));
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	mkdirSync(join(dir, "arnative"));
	writeFileSync(join(dir, "arnative", "config.json"), JSON.stringify({ modelHeal: "Flags" }));
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { relay: { api: model.api, baseUrl: model.baseUrl, apiKey: "fixture", models: [model] } } }));
});

afterEach(() => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	rmSync(dir, { recursive: true, force: true });
});

function harness(refresh = async () => {} ) {
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	let command: (args: string, ctx: ExtensionContext) => Promise<void>;
	let selections = 0;
	const notifications: { message: string; type?: string }[] = [];
	const widgets: (string[] | undefined)[] = [];
	const registry = { getAll: () => [model], getRegisteredProviderConfig: () => undefined,
		refresh, find: () => ({ ...model }) };
	const pi = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
		const list = handlers.get(name) ?? [];
		list.push(handler);
		handlers.set(name, list);
	}, registerCommand(name: string, value: { handler: typeof command }) {
		if (name === "model-heal") command = value.handler;
	}, setModel: async () => { selections++; return true; } };
	registerModelHeal(pi as unknown as ExtensionAPI);
	const extension = { path: "<model-heal>", handlers };
	const runner = new ExtensionRunner([extension] as never, createExtensionRuntime(), dir, SessionManager.inMemory(dir), registry as never);
	runner.bindCore({ setModel: pi.setModel } as never, { getModel: () => model, getScopedModels: () => [model], getSignal: () => undefined } as never);
	runner.setUIContext({ ...runner.getUIContext(), notify: (message, type) => notifications.push({ message, type }),
		setWidget: (_key, lines) => widgets.push(lines as string[] | undefined) }, "tui");
	return { runner, notifications, widgets, registry, selections: () => selections,
		run: () => command("", runner.createCommandContext()) };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const catalog = () => new Response(JSON.stringify({ data: [{ id: "m", context_length: 128000, max_output_tokens: 8192 }] }));

// Pi's actual runner guards the getters, rather than a mock that assumes ctx remains valid.
test("manual lifecycle: reload during catalog sync stops without reading a stale context", async (t) => {
	const started = deferred<void>();
	const response = deferred<Response>();
	let chats = 0;
	t.mock.method(globalThis, "fetch", async (_input, init) => {
		if (init?.method === "POST") { chats++; return new Response("unauthorized", { status: 401 }); }
		started.resolve();
		return response.promise;
	});
	const h = harness();
	const pending = h.run();
	await started.promise;
	await h.runner.emit({ type: "session_shutdown", reason: "reload" });
	h.runner.invalidate();
	response.resolve(catalog());
	await assert.doesNotReject(pending);
	assert.equal(chats, 0, "a replaced session must not start the thinking pass");
	const stateFile = join(dir, "arnative", "model-heal.json");
	if (existsSync(stateFile)) assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).providers.relay?.failed, undefined);
});

test("manual lifecycle: a changed model is selected with the bound extension API", async (t) => {
	t.mock.method(globalThis, "fetch", async (_input, init) => init?.method === "POST" ? new Response("unauthorized", { status: 401 }) : catalog());
	const h = harness();
	await h.run();
	assert.equal(h.selections(), 1, "the refresh must not call an unbound pi identifier and silently swallow it");
	assert.ok(h.notifications.some((n) => n.message.includes("Model heal fixed")));
});

test("manual lifecycle: model refresh captures the current model before awaiting", async () => {
	let h: ReturnType<typeof harness>;
	h = harness(async () => { h.runner.invalidate(); });
	let selected = false;
	await assert.doesNotReject(reloadCurrentModel(h.runner.createCommandContext(), async () => { selected = true; }));
	assert.equal(selected, true);
});

test("manual lifecycle: cancellation also stops a pass with no configured channels", async () => {
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }));
	const h = harness();
	const pending = h.run();
	const noticesBefore = h.notifications.length;
	await h.runner.emit({ type: "session_shutdown", reason: "reload" });
	h.runner.invalidate();
	await assert.doesNotReject(pending);
	assert.equal(h.notifications.length, noticesBefore);
});

test("manual lifecycle: cancellation stops the remaining thinking requests", async (t) => {
	const started = deferred<void>();
	const response = deferred<Response>();
	let posts = 0;
	t.mock.method(globalThis, "fetch", async (_input, init) => {
		if (init?.method !== "POST") return catalog();
		posts++;
		started.resolve();
		return response.promise;
	});
	const h = harness();
	const pending = h.run();
	await started.promise;
	await h.runner.emit({ type: "session_shutdown", reason: "reload" });
	h.runner.invalidate();
	response.resolve(new Response("unauthorized", { status: 401 }));
	await assert.doesNotReject(pending);
	assert.equal(posts, 1);
	const file = join(dir, "arnative", "model-heal.json");
	if (existsSync(file)) assert.equal(JSON.parse(readFileSync(file, "utf8")).efforts?.["relay\0m"], undefined);
});

test("automatic Flags: session and selection events send no requests and never read models-store.json directly", async (t) => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => { requests++; return new Response("offline fixture", { status: 503 }); });
	const store = join(dir, "models-store.json");
	writeFileSync(store, "not JSON; only Pi owns this catalog store");
	const before = readFileSync(join(dir, "models.json"), "utf8");
	const h = harness();
	try {
		await h.runner.emit({ type: "session_start", reason: "startup" });
		await h.runner.emit({ type: "session_start", reason: "reload" });
		await h.runner.emit({ type: "model_select", model, previousModel: model, source: "setModel" } as never);
		assert.equal(requests, 0);
		assert.equal(readFileSync(join(dir, "models.json"), "utf8"), before);
		assert.equal(readFileSync(store, "utf8"), "not JSON; only Pi owns this catalog store");
	} finally {
		await h.runner.emit({ type: "session_shutdown", reason: "quit" });
	}
});

test("manual force: Flags still forces metadata and seven eligible effort requests", async (t) => {
	let gets = 0;
	let posts = 0;
	t.mock.method(globalThis, "fetch", async (_input, init) => {
		if (init?.method === "POST") { posts++; return new Response("unauthorized", { status: 401 }); }
		gets++;
		return catalog();
	});
	const h = harness();
	await h.run();
	await h.run();
	assert.equal(gets, 2);
	assert.equal(posts, 14);
});

test("manual lifecycle: an unexpected refresh failure reaches the boundary", async (t) => {
	t.mock.method(globalThis, "fetch", async (_input, init) => init?.method === "POST" ? new Response("unauthorized", { status: 401 }) : catalog());
	const h = harness(async () => { throw new Error("fixture refresh failed"); });
	await assert.rejects(h.run(), /fixture refresh failed/);
	assert.equal(h.widgets.at(-1), undefined);
});
