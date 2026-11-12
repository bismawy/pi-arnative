import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { probeEffort } from "../lib/compat.ts";
import { healEffort } from "../lib/model-heal.ts";

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const accepted = ["none", "low", "high"];
const model = { provider: "fixture", id: "m", api: "openai-completions", reasoning: true };
type Request = { path: string | undefined; method: string | undefined; body: Record<string, unknown> };

async function withServer(api: string, run: (baseUrl: string, requests: Request[]) => Promise<void>): Promise<void> {
	const requests: Request[] = [];
	const route = api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw) as Record<string, unknown>;
		requests.push({ path: req.url, method: req.method, body });
		const level = api === "openai-responses" ? (body.reasoning as { effort?: string } | undefined)?.effort : body.reasoning_effort;
		const valid = req.url === route && accepted.includes(String(level));
		res.writeHead(req.url !== route ? 404 : valid ? 200 : 400, { "content-type": "application/json" });
		res.end(valid ? '{"output":[]}' : '{"error":"invalid reasoning effort"}');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		await run(`http://127.0.0.1:${address.port}/v1`, requests);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

for (const api of ["openai-completions", "openai-responses"]) {
	test(`localhost effort probe uses the ${api} route and payload`, async () => {
		await withServer(api, async (baseUrl, requests) => {
			assert.deepEqual(await probeEffort({ ...model, api }, { baseUrl }), accepted);
			assert.equal(requests.length, 7);
			for (const request of requests) {
				assert.equal(request.method, "POST");
				assert.equal(request.body.model, "m");
				assert.equal(request.body.stream, false);
				if (api === "openai-responses") {
					assert.equal(request.path, "/v1/responses");
					assert.deepEqual(request.body.input, [{ role: "user", content: [{ type: "input_text", text: "ping" }] }]);
					assert.equal(request.body.max_output_tokens, 16);
					assert.equal(request.body.store, false);
					assert.equal(request.body.messages, undefined);
					assert.equal(request.body.reasoning_effort, undefined);
					assert.equal(request.body.max_tokens, undefined);
				} else {
					assert.equal(request.path, "/v1/chat/completions");
					assert.deepEqual(request.body.messages, [{ role: "user", content: "ping" }]);
					assert.equal(request.body.max_tokens, 16);
					assert.equal(request.body.input, undefined);
					assert.equal(request.body.reasoning, undefined);
				}
			}
			assert.deepEqual(requests.map((r) => api === "openai-responses" ? (r.body.reasoning as { effort: string }).effort : r.body.reasoning_effort), efforts);
		});
	});
}

test("completion probes preserve thinking payloads and the declared token field", async () => {
	const bodies: Record<string, unknown>[] = [];
	const result = await probeEffort({ ...model, compat: { thinkingFormat: "deepseek", maxTokensField: "max_completion_tokens" } }, {
		baseUrl: "https://fixture.invalid/v1", fetchImpl: async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response("pong");
		},
	});
	assert.deepEqual(result, efforts);
	assert.equal(bodies.length, 7);
	for (const body of bodies) {
		assert.equal(body.max_completion_tokens, 16);
		assert.equal(body.max_tokens, undefined);
		assert.deepEqual(body.thinking, { type: "enabled" });
	}
});

test("Responses does not send chat-only thinking flags or unsupported output caps", async () => {
	const bodies: Record<string, unknown>[] = [];
	await probeEffort({ ...model, api: "openai-responses", compat: { thinkingFormat: "deepseek", supportsMaxOutputTokens: false } }, {
		baseUrl: "https://fixture.invalid/v1", fetchImpl: async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response("pong");
		},
	});
	assert.equal(bodies.length, 7);
	for (const body of bodies) {
		assert.equal(body.thinking, undefined);
		assert.equal(body.max_output_tokens, undefined);
		assert.equal(body.max_tokens, undefined);
	}
});

test("a Responses credential failure remains inconclusive", async () => {
	assert.deepEqual(await probeEffort({ ...model, api: "openai-responses" }, {
		baseUrl: "https://fixture.invalid/v1", fetchImpl: async () => new Response("unauthorized", { status: 401 }),
	}), []);
});

test("Model heal learns the actual levels from a Responses-only localhost provider", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-responses-heal-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	mkdirSync(join(dir, "arnative"));
	try {
		await withServer("openai-responses", async (baseUrl, requests) => {
			const runtime = { ...model, api: "openai-responses", baseUrl };
			writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { fixture: { api: runtime.api, baseUrl, models: [runtime] } } }));
			const result = await healEffort({ models: () => [runtime], ownsModels: () => false }, true);
			assert.equal(result.changed, true);
			assert.deepEqual(result.errors, []);
			assert.equal(requests.length, 7);
			const config = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
			assert.deepEqual(config.providers.fixture.models[0].thinkingLevelMap,
				{ minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
		});
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
