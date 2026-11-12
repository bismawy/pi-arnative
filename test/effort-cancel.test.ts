import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { probeEffort } from "../lib/compat.ts";
import { healEffort } from "../lib/model-heal.ts";

const model = { provider: "fixture", id: "m", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: true };
const options = { baseUrl: model.baseUrl };

test("a canceled probe sends no requests", async () => {
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	await assert.rejects(probeEffort(model, { ...options, signal: controller.signal,
		fetchImpl: async () => { calls++; return new Response("pong"); } }), (error) => error === controller.signal.reason);
	assert.equal(calls, 0);
});

test("cancellation during a successful fetch prevents all later levels", async () => {
	const controller = new AbortController();
	let calls = 0;
	let requestSignal: AbortSignal | undefined;
	await assert.rejects(probeEffort(model, { ...options, signal: controller.signal,
		fetchImpl: async (_url, init) => {
			calls++;
			requestSignal = init?.signal ?? undefined;
			controller.abort();
			return new Response("pong");
		} }), (error) => error === controller.signal.reason);
	assert.equal(calls, 1);
	assert.equal(requestSignal?.aborted, true);
});

test("cancellation interrupts the retry pause after a quota response", async () => {
	const controller = new AbortController();
	let calls = 0;
	await assert.rejects(probeEffort(model, { ...options, signal: controller.signal,
		fetchImpl: async () => {
			calls++;
			setImmediate(() => controller.abort());
			return new Response("quota", { status: 429 });
		} }), (error) => error === controller.signal.reason);
	assert.equal(calls, 1);
});

test("cancellation aborts a held localhost response without another request", async () => {
	let first!: ServerResponse;
	let started!: () => void;
	const received = new Promise<void>((resolve) => { started = resolve; });
	let closed!: () => void;
	const disconnected = new Promise<void>((resolve) => { closed = resolve; });
	let calls = 0;
	const server = createServer(async (req, res) => {
		for await (const chunk of req) assert.ok(chunk.length > 0);
		calls++;
		if (calls !== 1) { res.end("pong"); return; }
		first = res;
		res.on("close", closed);
		started();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const controller = new AbortController();
	const pending = probeEffort(model, { baseUrl: `http://127.0.0.1:${address.port}/v1`, signal: controller.signal });
	const rejected = assert.rejects(pending, (error) => error === controller.signal.reason);
	let rescue: ReturnType<typeof setTimeout> | undefined;
	try {
		await received;
		rescue = setTimeout(() => first.end("pong"), 1000);
		controller.abort();
		await rejected;
		await disconnected;
		assert.equal(first.writableEnded, false, "the client closed the held response before the server answered");
		assert.equal(calls, 1);
	} finally {
		if (rescue) clearTimeout(rescue);
		controller.abort();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("a probe deadline stops levels without waiting for per-level timeouts", async (t) => {
	let now = Date.now();
	const deadline = now + 120000;
	t.mock.method(Date, "now", () => now);
	let calls = 0;
	await assert.rejects(probeEffort(model, { ...options, deadline,
		fetchImpl: async () => { calls++; now = deadline + 1; return new Response("pong"); } }),
		(error: Error) => error.name === "TimeoutError");
	assert.equal(calls, 1);
});

test("heal budget exhaustion is reported without caching the model as failed", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-effort-budget-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	mkdirSync(join(dir, "arnative"));
	const path = join(dir, "models.json");
	const original = JSON.stringify({ providers: { fixture: { api: model.api, baseUrl: model.baseUrl, models: [model] } } });
	writeFileSync(path, original);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	let calls = 0;
	try {
		const result = await healEffort({ models: () => [model], ownsModels: () => false,
			fetchImpl: async () => { calls++; now += 120001; return new Response("pong"); } }, true);
		assert.equal(calls, 1);
		assert.equal(result.changed, false);
		assert.ok(result.errors.some((error) => error.includes("budget exhausted")));
		assert.equal(readFileSync(path, "utf8"), original);
		const state = JSON.parse(readFileSync(join(dir, "arnative", "model-heal.json"), "utf8"));
		assert.equal(state.efforts["fixture\0m"], undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
