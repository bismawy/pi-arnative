import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { buildEffortMap } from "../lib/compat.ts";
import { healEffort, healFlags, healMeta, type HealDeps, type RtModel } from "../lib/model-heal.ts";

const HOUR_MS = 60 * 60 * 1000;
const map = buildEffortMap(["minimal", "low", "medium", "high", "xhigh", "max"])!;
const model: RtModel = { provider: "relay", id: "m", api: "openai-completions", baseUrl: "https://relay.example/v1", reasoning: true, thinkingLevelMap: map };
let dir: string;
let previous: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "arnative-heal-cache-"));
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	mkdirSync(join(dir, "arnative"));
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { relay: { api: model.api, baseUrl: model.baseUrl, models: [{ id: model.id, reasoning: true, thinkingLevelMap: map }] } } }));
});

afterEach(() => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	rmSync(dir, { recursive: true, force: true });
});

function seedEffort(entry: { at: number; map: Record<string, string | null>; failed?: boolean; exact?: boolean }): void {
	writeFileSync(join(dir, "arnative", "model-heal.json"), JSON.stringify({ schema: 1, providers: {}, sources: {}, efforts: { ["relay\0m"]: entry } }));
}

const depsFor = (fetchImpl: typeof fetch, runtime = model): HealDeps => ({ models: () => [runtime], ownsModels: () => false, fetchImpl });
const readState = () => JSON.parse(readFileSync(join(dir, "arnative", "model-heal.json"), "utf8"));
const catalog = (id = "m") => new Response(JSON.stringify({ data: [{ id, context_length: 128_000, max_output_tokens: 8192 }] }));

// Counters intercept the real pass; fixture auth never reaches the operator's credentials.
test("effort: a newly failed probe waits one hour before trying again", async () => {
	let calls = 0;
	const deps = depsFor(async () => {
		calls++;
		return new Response("unauthorized", { status: 401 });
	});
	assert.equal((await healEffort(deps, false)).errors.length, 1);
	assert.equal(calls, 7);
	assert.equal(readState().efforts["relay\0m"].failed, true);
	const repeated = await healEffort(deps, false);
	assert.equal(calls, 7, "a repeated event must not send another batch during the failure TTL");
	assert.deepEqual(repeated, { changed: false, detail: [], errors: [] });
});

test("effort: a failed probe retries after its one-hour cooldown", async (t) => {
	const at = Date.now();
	seedEffort({ at, map, failed: true });
	t.mock.method(Date, "now", () => at + HOUR_MS + 1);
	let calls = 0;
	await healEffort(depsFor(async () => {
		calls++;
		return new Response("unauthorized", { status: 401 });
	}), false);
	assert.equal(calls, 7);
});

test("effort: forcing a failed probe bypasses its cooldown", async () => {
	seedEffort({ at: Date.now(), map, failed: true });
	let calls = 0;
	await healEffort(depsFor(async () => {
		calls++;
		return new Response("unauthorized", { status: 401 });
	}), true);
	assert.equal(calls, 7);
});

test("effort: reordered keys keep a successful cache fresh", async () => {
	seedEffort({ at: Date.now(), map, exact: true });
	const reordered = { ...model, thinkingLevelMap: Object.fromEntries(Object.entries(map).reverse()) };
	let calls = 0;
	await healEffort(depsFor(async () => {
		calls++;
		return new Response("unauthorized", { status: 401 });
	}, reordered), false);
	assert.equal(calls, 0, "key order is not a change in supported levels");
});

test("effort: a successful probe stays cached past 24 hours until forced", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	seedEffort({ at: now, map, exact: true });
	let calls = 0;
	const deps = depsFor(async () => {
		calls++;
		return new Response("pong");
	});
	await healEffort(deps, false);
	assert.equal(calls, 0);
	now += 24 * HOUR_MS + 1;
	await healEffort(deps, false);
	assert.equal(calls, 0, "an automatic run must keep the local cache instead of re-probing");
	await healEffort(deps, true);
	assert.equal(calls, 7, "forcing still probes on demand");
	assert.equal(readState().efforts["relay\0m"].exact, true);
});

test("effort: a case-changed model ID reuses its cached probe", async () => {
	seedEffort({ at: Date.now(), map, exact: true });
	let calls = 0;
	await healEffort(depsFor(async () => {
		calls++;
		return new Response("unauthorized", { status: 401 });
	}, { ...model, id: "M" }), false);
	assert.equal(calls, 0);
});

test("effort: a legacy identity entry without exact:true is not re-probed automatically", async () => {
	const identity = { low: "low", medium: "medium", high: "high", xhigh: "xhigh" };
	seedEffort({ at: Date.now(), map: identity });
	let calls = 0;
	await healEffort(depsFor(async () => {
		calls++;
		return new Response("unauthorized", { status: 401 });
	}, { ...model, thinkingLevelMap: { ...identity, off: "none" } }), false);
	assert.equal(calls, 0);
});

test("effort: a newly added model is probed while cached siblings stay skipped", async () => {
	seedEffort({ at: Date.now(), map, exact: true });
	const added: RtModel = { ...model, id: "m-new", thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" } };
	let calls = 0;
	const deps: HealDeps = {
		models: () => [model, added],
		ownsModels: () => false,
		fetchImpl: async () => {
			calls++;
			return new Response("pong");
		},
	};
	const res = await healEffort(deps, false);
	assert.equal(calls, 7);
	assert.equal(res.changed, true);
	assert.equal(readState().efforts["relay\0m-new"].exact, true);
});

test("effort: an older successful remap still migrates before the TTL", async () => {
	const old = { low: "low", medium: "high", high: "high" };
	seedEffort({ at: Date.now(), map: old });
	let calls = 0;
	await healEffort(depsFor(async () => {
		calls++;
		return new Response("unauthorized", { status: 401 });
	}, { ...model, thinkingLevelMap: old }), false);
	assert.equal(calls, 7, "only a successful legacy probe needs immediate migration");
});

test("effort: forcing never probes a hand-shaped map", async () => {
	let calls = 0;
	await healEffort(depsFor(async () => {
		calls++;
		return new Response("unauthorized", { status: 401 });
	}, { ...model, thinkingLevelMap: { medium: "high" } }), true);
	assert.equal(calls, 0);
});

test("effort: a real map change still invalidates a fresh cache", async () => {
	seedEffort({ at: Date.now(), map, exact: true });
	const changed = { ...map };
	delete changed.max;
	let calls = 0;
	await healEffort(depsFor(async () => {
		calls++;
		return new Response("unauthorized", { status: 401 });
	}, { ...model, thinkingLevelMap: changed }), false);
	assert.equal(calls, 7);
});

test("metadata: a failed catalog waits one hour before trying again", async () => {
	const before = readFileSync(join(dir, "models.json"), "utf8");
	let calls = 0;
	const deps = depsFor(async () => {
		calls++;
		return new Response("unavailable", { status: 503 });
	});
	assert.equal((await healMeta(deps, false)).errors.length, 1);
	await healMeta(deps, false);
	assert.equal(calls, 1, "a repeated event must not retry an unavailable catalog");
	assert.equal(readState().providers.relay.failed, true);
	assert.equal(readFileSync(join(dir, "models.json"), "utf8"), before);
});

test("metadata: an expired failure retries and stays cached until a new model appears", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	let calls = 0;
	const deps = depsFor(async () => {
		calls++;
		return calls === 1 ? new Response("unavailable", { status: 503 }) : catalog();
	});
	await healMeta(deps, false);
	now += HOUR_MS + 1;
	assert.equal((await healMeta(deps, false)).changed, true);
	assert.equal(readState().providers.relay.failed, undefined);
	now += 7 * HOUR_MS;
	await healMeta(deps, false);
	assert.equal(calls, 2, "unchanged model ids stay cached past 6 hours");

	const added: RtModel = { ...model, id: "m-new" };
	const config = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
	config.providers.relay.models.push({ id: "m-new", reasoning: true, thinkingLevelMap: map });
	writeFileSync(join(dir, "models.json"), JSON.stringify(config));
	await healMeta({
		models: () => [model, added],
		ownsModels: () => false,
		fetchImpl: async () => {
			calls++;
			return new Response(JSON.stringify({ data: [{ id: "m-new", context_length: 256_000, max_output_tokens: 16_000 }] }));
		},
	}, false);
	assert.equal(calls, 3, "a newly added model triggers catalog sync");
});

test("flags: per-model compat in modelOverrides survives a rewrite of models[]", () => {
	const config = {
		providers: {
			relay: {
				api: model.api,
				baseUrl: model.baseUrl,
				models: [
					{ id: "chat-only", reasoning: false },
					{ id: "deepseek-r", reasoning: true, thinkingLevelMap: map },
				],
			},
		},
	};
	writeFileSync(join(dir, "models.json"), JSON.stringify(config));
	const runtime: RtModel[] = [
		{ provider: "relay", id: "chat-only", api: model.api, baseUrl: model.baseUrl, reasoning: false },
		{ provider: "relay", id: "deepseek-r", api: model.api, baseUrl: model.baseUrl, reasoning: true, thinkingLevelMap: map },
	];
	const first = healFlags({ models: () => runtime, ownsModels: () => false });
	assert.equal(first.changed, true);

	// Simulate an external provider sync (e.g. Magpie) rewriting models[] without compat.
	const saved = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
	saved.providers.relay.models = config.providers.relay.models;
	writeFileSync(join(dir, "models.json"), JSON.stringify(saved));

	const mergedRuntime: RtModel[] = runtime.map((r) => ({
		...r,
		compat: { ...(saved.providers.relay.compat ?? {}), ...(saved.providers.relay.modelOverrides?.[r.id]?.compat ?? {}) },
	}));
	const afterRefresh = healFlags({ models: () => mergedRuntime, ownsModels: () => false });
	assert.equal(afterRefresh.changed, false);
});

test("metadata: force bypasses a failed catalog cooldown", async () => {
	let calls = 0;
	const deps = depsFor(async () => {
		calls++;
		return calls === 1 ? new Response("unavailable", { status: 503 }) : catalog();
	});
	await healMeta(deps, false);
	assert.equal((await healMeta(deps, true)).changed, true);
	assert.equal(calls, 2);
	assert.equal(readState().providers.relay.failed, undefined);
});

test("metadata: an endpoint change invalidates its failure cooldown", async () => {
	let calls = 0;
	const deps = depsFor(async () => {
		calls++;
		return new Response("unavailable", { status: 503 });
	});
	await healMeta(deps, false);
	const config = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
	config.providers.relay.baseUrl = "https://replacement.example/v1";
	writeFileSync(join(dir, "models.json"), JSON.stringify(config));
	await healMeta(deps, false);
	assert.equal(calls, 2);
	assert.equal(readState().providers.relay.failed, true);
});

test("metadata: failed and successful providers keep independent cooldowns", async () => {
	const other = { ...model, provider: "other", id: "n", baseUrl: "https://other.example/v1" };
	const config = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
	config.providers.other = { api: other.api, baseUrl: other.baseUrl, models: [{ id: other.id }] };
	writeFileSync(join(dir, "models.json"), JSON.stringify(config));
	let calls = 0;
	const deps: HealDeps = { models: () => [model, other], ownsModels: () => false, fetchImpl: async (url) => {
		calls++;
		return String(url).includes("other.example") ? catalog("n") : new Response("unavailable", { status: 503 });
	} };
	const result = await healMeta(deps, false);
	assert.equal(result.changed, true);
	assert.equal(result.errors.length, 1);
	await healMeta(deps, false);
	assert.equal(calls, 2);
	assert.equal(readState().providers.relay.failed, true);
	assert.equal(readState().providers.other.failed, undefined);
});

test("localhost HTTP: a fresh failed effort cache sends no more POSTs", async () => {
	const requests: { method?: string; path?: string; effort: string; maxTokens: number }[] = [];
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		requests.push({ method: req.method, path: req.url, effort: body.reasoning_effort, maxTokens: body.max_tokens });
		res.writeHead(401);
		res.end("unauthorized");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const baseUrl = `http://127.0.0.1:${address.port}/v1`;
		const config = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
		config.providers.relay.baseUrl = baseUrl;
		writeFileSync(join(dir, "models.json"), JSON.stringify(config));
		const deps: HealDeps = { models: () => [{ ...model, baseUrl }], ownsModels: () => false };
		await healEffort(deps, false);
		assert.equal(requests.length, 7);
		assert.deepEqual(requests.map((r) => r.effort), ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.ok(requests.every((r) => r.method === "POST" && r.path === "/v1/chat/completions" && r.maxTokens === 16));
		await healEffort(deps, false);
		assert.equal(requests.length, 7, "a second real invocation must not send another HTTP request");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
