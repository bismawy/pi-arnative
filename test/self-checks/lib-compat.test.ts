import test from "node:test";
import { assert } from "../helpers/check.ts";
import { suggestCompat, parseMeta, parseModelMeta, contextWindowAccepted, mergeMeta, buildCatalogIndex, findMetaForId, isEffortProbeable, thinkingPayload, carriesRemap, buildEffortMap, probeEffort } from "../../lib/compat.ts";

test("lib/compat.ts self-check", async () => {
	const base = { provider: "r", id: "m", api: "openai-completions", baseUrl: "https://relay.x/v1" };
	assert(suggestCompat(base).supportsLongCacheRetention === false, "a third-party relay declares retention false");
	assert(suggestCompat(base).sendSessionAffinityHeaders === true, "an openai-compatible relay gets affinity headers");
	assert(suggestCompat({ ...base, baseUrl: "https://api.openai.com/v1" }).supportsLongCacheRetention === true, "official OpenAI keeps long retention");
	assert(suggestCompat({ ...base, reasoning: true }).supportsDeveloperRole === false, "a reasoning model on a relay opts out of the developer role");
	assert(suggestCompat({ ...base, reasoning: true, compat: { supportsDeveloperRole: true } }).supportsDeveloperRole === undefined, "an explicit value is never overwritten");
	assert(suggestCompat({ ...base, id: "deepseek-v4" }).thinkingFormat === "deepseek", "a deepseek id gets the deepseek thinking format");
	assert(suggestCompat({ ...base, api: "anthropic-messages", id: "claude-opus-4-6" }).forceAdaptiveThinking === true, "Opus 4.6 needs adaptive thinking");
	assert(suggestCompat({ ...base, id: "claude-sonnet-4-5" }).cacheControlFormat === "anthropic", "Claude on a proxy gets anthropic cache control");
	assert(suggestCompat({ ...base, provider: "llama.cpp", compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false, supportsStrictMode: false, maxTokensField: "max_tokens" } }).sendSessionAffinityHeaders === undefined, "pi's built-in llama.cpp is left alone");

	const meta = parseModelMeta({ data: [{ id: "a", context_length: 1_000_000, max_output_tokens: 64_000 }, { id: "b", max_model_len: 262_144, max_tokens: 262_144 }] });
	assert(meta.get("a")?.contextWindow === 1_000_000 && meta.get("a")?.maxTokens === 64_000, "a catalog entry yields window and cap");
	assert(meta.get("b")?.maxTokens === undefined, "a max_tokens equal to the window is not an output cap");
	assert(parseModelMeta({ models: [{ name: "models/gemini-x", context_window: 128_000 }] }).get("gemini-x")?.contextWindow === 128_000, "a gemini-shaped list parses too");
	assert(contextWindowAccepted(1_048_576, 131_072), "growth is accepted");
	assert(!contextWindowAccepted(8192, 1_000_000), "a per-request number is rejected");
	assert(mergeMeta({ maxTokens: 4096 }, { maxTokens: 8192 }).maxTokens === 8192, "an output cap only grows");
	assert(mergeMeta({ contextWindow: 1024 }, { maxTokens: 8192 }).maxTokens === 1024, "a cap above the window clamps to the window");
	assert(mergeMeta({ contextWindow: 200_000 }, { contextWindow: 4096, maxTokens: 32_000 }).maxTokens === 32_000, "a rejected anomaly window does not clamp maxTokens");

	// Nested shapes (Gemini inputTokenLimit, OpenRouter top_provider, models.dev limit) and fallback index.
	assert(parseMeta({ inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }).contextWindow === 1_048_576, "gemini inputTokenLimit parses");
	assert(parseMeta({ top_provider: { context_length: 200_000, max_completion_tokens: 16_384 } }).contextWindow === 200_000, "nested top_provider parses");
	assert(parseMeta({ limit: { context: 262_144, output: 32_768 } }).maxTokens === 32_768, "nested limit.context/output parses");
	const idx = buildCatalogIndex([
		["z-ai/glm-5.3-flash", { contextWindow: 1_000_000, maxTokens: 131_072 }],
		["qwen/qwen3.8-27b", { contextWindow: 262_144, maxTokens: 32_768 }],
	]);
	assert(findMetaForId("zai-org/GLM-5.3-Flash", idx)?.contextWindow === 1_000_000, "vendor prefix difference still matches bare name");
	assert(findMetaForId("Qwen/Qwen3.8-27B-FP8", idx)?.contextWindow === 262_144, "quantization suffix strips for fallback lookup");

	assert(buildEffortMap([]) === undefined, "nothing answered writes nothing");
	const exact = buildEffortMap(["none", "low", "high", "max"])!;
	assert(exact.low === "low" && exact.high === "high" && exact.max === "max", "an accepted effort maps to itself");
	assert(exact.minimal === null && exact.medium === null && exact.xhigh === null, "a rejected effort is unsupported, never remapped");
	assert(exact.off === undefined, "off stays pi's call");
	assert(carriesRemap({ medium: "high" }) && carriesRemap({ low: null }) && !carriesRemap({ low: "low" }), "only a shaped map counts as deliberate");
	assert(thinkingPayload({ thinkingFormat: "zai" }, true)?.thinking !== undefined, "a channel that needs a thinking block gets one");
	assert(isEffortProbeable({ ...base, reasoning: true }), "a reasoning model on a relay is probeable");
	assert(!isEffortProbeable({ ...base, reasoning: true, baseUrl: "https://api.openai.com/v1" }), "a first-party API is not probed");
	assert(!isEffortProbeable({ ...base, reasoning: true, compat: { supportsReasoningEffort: false } }), "a channel that sends no effort is not probed");

	// The probe loop itself: a channel that takes none/minimal/low/high and 400s medium.
	const fakeFetch = (async (_url: string, init?: { body?: string }) => {
		const level = JSON.parse(init?.body ?? "{}").reasoning_effort as string;
		const ok = ["none", "minimal", "low", "high"].includes(level);
		return { status: ok ? 200 : 400, text: async () => (ok ? "" : "invalid reasoning_effort") };
	}) as unknown as typeof fetch;
	const supported = await probeEffort({ ...base, id: "relay-model", reasoning: true }, { baseUrl: base.baseUrl, fetchImpl: fakeFetch });
	assert(supported.join() === "none,minimal,low,high", "the probe reports exactly the accepted levels");
	assert(buildEffortMap(supported)?.medium === null, "a rejected level is not offered");
	const deadFetch = (async () => ({ status: 401, text: async () => "unauthorized" })) as unknown as typeof fetch;
	assert((await probeEffort({ ...base, reasoning: true }, { baseUrl: base.baseUrl, fetchImpl: deadFetch })).length === 0, "a credential failure answers nothing, so nothing is written");

});
