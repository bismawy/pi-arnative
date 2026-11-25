import test from "node:test";
import { assert } from "../helpers/check.ts";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenTitle } from "../../lib/box.ts";
import { stripAnsi } from "../../lib/ansi.ts";
import { ListPicker, type ListRow } from "../../lib/list-picker.ts";
import { chatBaseUrl, guessProviderName, normalizeBase, buildCandidates, parseModelList, probeEndpoint, detectLevel, withProvider, withoutProvider, providerNames, withProviderFields, renameProvider, renameAuth, summarizeProviders, withAuth, withoutAuth, levelToWire, wireToLevel, withProviderModels, resolveMissingMeta, mergeLevels, looseJsonParse, loadModelsConfig, saveModelsConfig, saveProvider, saveProviderKey, inlineKey, keyHint, readAuthKey, loadProviderEntry, __test } from "../../lib/provider.ts";

const { PROVIDERS_TEXT, ADD_ROW, MODEL_LEGEND, levelsSummary } = __test;

test("lib/provider.ts self-check", async () => {
	// Flavors and bases.
	assert(chatBaseUrl("openai-completions", "https://api.x.com/v1") === "https://api.x.com/v1", "openai keeps an explicit /v1");
	assert(chatBaseUrl("openai-completions", "https://api.x.com") === "https://api.x.com/v1", "openai appends /v1");
	assert(chatBaseUrl("openai-completions", "https://api.x.com/v1beta/") === "https://api.x.com/v1", "openai rewrites /v1beta to /v1");
	assert(chatBaseUrl("anthropic-messages", "https://relay.x.com/v1") === "https://relay.x.com", "anthropic strips /v1");
	assert(chatBaseUrl("google-generative-ai", "https://relay.x.com/v1beta") === "https://relay.x.com", "gemini strips /v1beta");
	assert(normalizeBase("localhost:11434") === "http://localhost:11434", "bare host defaults to http");
	assert(normalizeBase(" https://x.com/ ") === "https://x.com", "trailing slashes trimmed");
	assert(guessProviderName("https://api.deepseek.com/v1") === "deepseek", "api prefix and tld dropped");
	assert(guessProviderName("https://openrouter.ai/api/v1") === "openrouter", "openrouter keeps its name");
	assert(guessProviderName("http://localhost:11434") === "localhost", "localhost stays localhost");
	assert(guessProviderName("http://192.168.1.10:11434") === "192.168.1.10", "an IP is kept verbatim");

	// Probe parsing.
	const listPath = buildCandidates("https://x.com/v1", "k").find((c) => c.url === "https://x.com/v1/models")!;
	assert(listPath.url === "https://x.com/v1/models", "a /v1 base probes /models");
	const paths = buildCandidates("https://x.com", "").map((c) => c.url);
	assert(paths.includes("https://x.com/v1/models") && paths.includes("https://x.com/api/tags") && paths.includes("https://x.com/v1beta/models"), "a bare base probes the common layouts");
	const authed = buildCandidates("https://x.com", "sk-1")[0]!;
	assert(authed.url === "https://x.com/api/tags", "the ollama probe comes first");
	const openaiShape = { data: [{ id: "m1", context_length: 262_144, max_output_tokens: 32_000 }, { id: "m2" }] };
	const geminiShape = { models: [{ name: "models/gemini-x" }] };
	const ollamaShape = { models: [{ name: "qwen:7b" }] };
	assert(parseModelList(listPath, openaiShape)!.join() === "m1,m2", "data[].id parses");
	assert(parseModelList(listPath, geminiShape) === undefined, "a models[] shape is not a list answer for openai paths");
	const geminiCandidate = buildCandidates("https://x.com", "k").find((c) => c.url.endsWith("/v1beta/models"))!;
	assert(parseModelList(geminiCandidate, geminiShape)![0] === "gemini-x", "gemini strips the models/ prefix");
	const ollamaCandidate = buildCandidates("https://x.com", "k").find((c) => c.url.endsWith("/api/tags"))!;
	assert(parseModelList(ollamaCandidate, ollamaShape)![0] === "qwen:7b", "ollama keeps the tag verbatim");
	assert(parseModelList(listPath, { data: "no" }) === undefined, "a non-array data is no list");
	assert(parseModelList(listPath, "nope") === undefined, "a scalar body is no list");

	// Probe priority with a fake fetch routed by path — the same layout every real server
	// has: each endpoint answers only its own shape, the rest 404.
	const route = (map: Record<string, unknown>) => async (url: string) => {
		const body = map[new URL(url).pathname];
		if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => body };
	};
	const probeOllama = await probeEndpoint("http://localhost:11434", "", route({ "/api/tags": ollamaShape }));
	assert(probeOllama?.flavor === "openai-completions" && probeOllama.via === "/api/tags" && probeOllama.keyless, "an ollama answer wins and is keyless");
	assert(probeOllama?.baseUrl === "http://localhost:11434/v1", "the ollama chat base gets /v1");
	const probeGemini = await probeEndpoint("https://relay.x.com", "k", route({ "/v1beta/models": geminiShape }));
	assert(probeGemini?.flavor === "google-generative-ai" && probeGemini.models[0] === "gemini-x", "a gemini answer is detected");
	const probeOpenai = await probeEndpoint("https://api.x.com/v1", "k", route({ "/v1/models": openaiShape }));
	assert(probeOpenai?.flavor === "openai-completions" && probeOpenai.baseUrl === "https://api.x.com/v1", "an openai answer is detected");
	assert(probeOpenai?.meta.get("m1")?.contextWindow === 262_144 && probeOpenai.meta.get("m1")?.maxTokens === 32_000, "the same answer carries the limits, so no second request is needed");
	const none = await probeEndpoint("https://api.x.com", "", route({}));
	assert(none === undefined, "no answer → undefined, the caller falls back to manual entry");
	const empty = await probeEndpoint("https://api.x.com/v1", "", route({ "/v1/models": { data: [] } }));
	assert(empty === undefined, "an empty list is no answer");

	// Store merges: one provider in, one out, everything else preserved.
	const config = { providers: { a: { baseUrl: "x", api: "openai-completions", models: [] } }, other: 1 };
	const added = withProvider(config, "b", { baseUrl: "y", api: "anthropic-messages", models: [{ id: "m" }] });
	assert((added.providers as Record<string, unknown>).a !== undefined && added.other === 1, "withProvider preserves other keys and providers");
	assert((config.providers as Record<string, unknown>).b === undefined, "withProvider does not mutate its input");
	assert(providerNames(withoutProvider(added, "a")).join() === "b", "withoutProvider removes one");
	assert(summarizeProviders(added)[1]!.modelCount === 1, "summarize counts models");
	assert(summarizeProviders(undefined).length === 0, "summarize survives a missing file body");
	assert(summarizeProviders({ providers: { a: {} } })[0]!.modelCount === 0, "summarize survives a provider without models");
	const auth = withAuth({ a: { type: "api_key", key: "1" } }, "b", "2");
	assert((auth.b as { key: string }).key === "2" && auth.a !== undefined, "withAuth adds one credential");
	assert(withoutAuth(auth, "a").a === undefined, "withoutAuth removes one");

	// Secrets: the hint never shows more than the tail, and only a literal inline key counts.
	assert(keyHint("sk-abcdefgh1234") === "••••1234", "the hint keeps the last four characters");
	assert(keyHint("short") === "••••", "a short secret shows nothing at all");
	assert(!keyHint("sk-abcdefgh1234").includes("abcdefgh"), "the body of the key never reaches the screen");
	assert(inlineKey({ baseUrl: "b", api: "openai-completions", apiKey: "dummy", models: [] }) === undefined, "a placeholder is not a key");
	assert(inlineKey({ baseUrl: "b", api: "openai-completions", apiKey: "ollama", models: [] }) === undefined, "the keyless placeholder is not a key");
	assert(inlineKey({ baseUrl: "b", api: "openai-completions", apiKey: "$OPENAI_KEY", models: [] }) === undefined, "an env reference is not a key");
	assert(inlineKey({ baseUrl: "b", api: "openai-completions", apiKey: "sk-1", models: [] }) === "sk-1", "a literal key is read back");

	// The Edit screen's patches: one field lands, the models and every sibling survive, and
	// a rename keeps the provider's place in the list with its credential following it.
	const fieldEntry = { providers: { r: { name: "r", baseUrl: "old", api: "openai-completions", apiKey: "sk-1", compat: { x: 1 }, models: [{ id: "m1" }] } } };
	const patched = withProviderFields(fieldEntry, "r", { baseUrl: "https://new.example/v1" });
	const patchedEntry = (patched.providers as Record<string, Record<string, unknown>>).r!;
	assert(patchedEntry.baseUrl === "https://new.example/v1" && patchedEntry.apiKey === "sk-1", "withProviderFields rewrites the named field only");
	assert((patchedEntry.models as unknown[]).length === 1 && patchedEntry.compat !== undefined, "an endpoint edit keeps models and compat");
	assert(((fieldEntry.providers as Record<string, Record<string, unknown>>).r!).baseUrl === "old", "withProviderFields does not mutate its input");
	assert((withProviderFields(fieldEntry, "r", { apiKey: undefined }).providers as Record<string, Record<string, unknown>>).r!.apiKey === undefined, "an undefined patch drops the field");
	const renamed = renameProvider({ providers: { a: { name: "a", models: [{ id: "m" }] }, b: { name: "" } } }, "a", "c");
	assert(providerNames(renamed).join() === "c,b", "renameProvider keeps the position and changes the id");
	assert((renamed.providers as Record<string, { name?: string; models?: unknown[] }>).c!.name === "c", "a name that repeated the old id follows it");
	assert(((renamed.providers as Record<string, { models?: unknown[] }>).c!.models ?? []).length === 1, "a rename keeps the models");
	assert((renameProvider({ providers: { a: { name: "Keep" } } }, "a", "c").providers as Record<string, { name?: string }>).c!.name === "Keep", "a hand-written display name is untouched");
	assert((renameProvider({ providers: { a: {} } }, "missing", "c").providers as Record<string, unknown>).a !== undefined, "renaming a missing provider writes nothing");
	const movedAuth = renameAuth({ a: { type: "api_key", key: "1" }, b: { type: "api_key", key: "2" } }, "a", "c");
	assert((movedAuth.c as { key: string }).key === "1" && movedAuth.a === undefined && (movedAuth.b as { key: string }).key === "2", "renameAuth moves one credential");
	assert(renameAuth({}, "a", "c").a === undefined, "an absent credential is not invented");

	// The model picker screen: checks toggle, `a` cycles, Esc leaves, Enter returns the ids.
	const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const renderModels = (checked: Set<string>, rows: ListRow[]) =>
		new ListPicker(fakeTheme, rows, undefined, {
			preview: () => {},
			revert: () => {},
			done: () => {},
			requestRender: () => {},
			marked: (label) => checked.has(label),
		}, { title: screenTitle("Models"), description: "d", legend: MODEL_LEGEND }, false).render(60).map(stripAnsi);
	const picked0 = renderModels(new Set(["m1"]), [{ label: "m1" }, { label: "m2" }]);
	assert(picked0.some((l) => l.includes("[x] m1")) && picked0.some((l) => l.includes("[ ] m2")), "checked and unchecked rows render");
	assert(picked0.some((l) => l.includes("[a] API")), "the model legend advertises the flavor switch");
	// Models and Probe models share this screen, so the filter is checked once here.
	const searchable = new ListPicker(fakeTheme, [{ label: "river/flash" }, { label: "river/glm" }, { label: "other/kimi" }], undefined, { preview: () => {}, revert: () => {}, done: () => {}, requestRender: () => {}, search: "models" }, { title: screenTitle("Models"), description: "d", legend: MODEL_LEGEND }, false);
	assert(searchable.render(70).map(stripAnsi).some((l) => l.includes("> Type to filter models...")), "the idle model filter names the key-less placeholder");
	searchable.handleInput("/");
	for (const ch of "river glm") searchable.handleInput(ch);
	const narrowed = searchable.render(70).map(stripAnsi);
	assert(narrowed.filter((l) => /river\/(flash|glm)|other\/kimi/.test(l)).length === 1 && narrowed.some((l) => l.includes("river/glm")), "typing narrows the model list to the fuzzy match");
	assert(searchable.index === 1, "the selection follows the filtered row back to its model");

	// The store reads with pi's own tolerance: a hand-edited models.json (comments, trailing
	// commas) is exactly what pi itself accepts, and strings containing `//` or `,]` survive.
	assert((looseJsonParse('{\n// c\n"a": 1, // x\n"b": [1, 2,],\n}') as { a: number; b: number[] }).b.join() === "1,2", "trailing commas and // comments are dropped");
	const kept = looseJsonParse('{"u":"http://x//y","v":"a,b]"}') as Record<string, string>;
	assert(kept.u === "http://x//y" && kept.v === "a,b]", "string literals survive the strip");
	assert((looseJsonParse("{\"a\": 1,}") as { a: number }).a === 1, "a trailing comma before the closing brace parses");
	let threw = false;
	try {
		looseJsonParse("{nope");
	} catch {
		threw = true;
	}
	assert(threw, "genuinely broken JSON still throws, so the caller can report it");

	// Thinking levels auto-detect from ids (relay catalogs expose only ids).
	assert(detectLevel("ag/claude-opus-4-6-thinking") === "auto", "a thinking token means flexible thinking");
	assert(detectLevel("ag/gemini-4-argon-high") === "high", "a -high suffix pins high");
	assert(detectLevel("ag/gemini-4-argon-xhigh") === "xhigh", "an -xhigh suffix pins xhigh");
	assert(detectLevel("ag/gemini-4-argon-x-high") === "xhigh", "-x-high also pins xhigh");
	assert(detectLevel("foo/bar-max") === "max", "a -max suffix pins max");
	assert(detectLevel("foo/bar-medium") === "medium", "a -medium suffix pins medium");
	assert(detectLevel("foo/bar-low") === "low", "a -low suffix pins low");
	assert(detectLevel("foo/bar-minimal") === "minimal", "a -minimal suffix pins minimal");
	assert(detectLevel("deepseek-reasoner") === "auto", "reasoner means flexible thinking");
	assert(detectLevel("o1-mini") === "auto", "an o-generation id means flexible thinking");
	assert(detectLevel("deepseek-r1") === "auto", "r1 means flexible thinking");
	assert(detectLevel("ocz/mimo-v2.6-flash-free") === "auto", "a plain flash id starts at auto");
	assert(detectLevel("oc/big-pickle") === "auto", "an unrelated id starts at auto");

	// Levels serialize to pi's wire shape and read back unchanged.
	const wireHigh = levelToWire("high") as { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> };
	assert(wireHigh.reasoning === true, "a pinned level sets reasoning");
	assert(wireHigh.thinkingLevelMap?.high === "high", "the pinned level maps to itself");
	assert(wireHigh.thinkingLevelMap?.medium === "medium" && wireHigh.thinkingLevelMap?.minimal === "minimal", "levels below the ceiling stay available");
	assert(wireHigh.thinkingLevelMap?.xhigh === null && wireHigh.thinkingLevelMap?.max === null, "levels above the ceiling are null");
	assert(!("off" in wireHigh.thinkingLevelMap!), "off stays unmapped, so thinking can still be turned off");
	assert(wireToLevel(true, { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: null }) === "xhigh", "the old single-pin shape still reads as its level");
	assert(wireToLevel(true, { low: "low", medium: "medium", high: "high", xhigh: "xhigh" }) === "auto", "heal's default map is auto, not an xhigh pin");
	assert(wireToLevel(true, { medium: "high" }) === "auto", "a probed remap is auto");
	assert(wireToLevel(true, { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" }) === "auto", "an exact probed map with gaps is auto, not a max ceiling");
	assert(loadProviderEntry({ providers: { p: { models: [{ id: "m", reasoning: true, thinkingLevelMap: { medium: null } }] } } }, "p")?.models[0]?.map?.medium === null, "a probed map survives a reload");
	for (const l of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) assert(wireToLevel(true, levelToWire(l).thinkingLevelMap) === l, `wire round-trips ${l}`);
	assert(levelToWire("xhigh")!.thinkingLevelMap!.xhigh === "xhigh", "xhigh needs its explicit map entry");
	const wireAuto = levelToWire("auto") as { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> };
	assert(wireAuto.reasoning === true && wireAuto.thinkingLevelMap === undefined, "auto is reasoning without a map");
	assert(Object.keys(levelToWire("off")).length === 0, "off writes no flags");
	assert(wireToLevel(true, undefined) === "auto" && wireToLevel(false, undefined) === "off", "wire round-trips auto and off");
	assert(wireToLevel(true, levelToWire("medium").thinkingLevelMap) === "medium", "wire round-trips a pinned level");

	// Edit flows rewrite only `models` and keep every other provider field.
	const rich = { providers: { r: { name: "R", baseUrl: "b", api: "openai-completions", compat: { supportsLongCacheRetention: false }, models: [{ id: "m1", reasoning: true }] } } };
	const edited = withProviderModels(rich, "r", [{ id: "m2", level: "high" }]);
	const savedProvider = (edited.providers as Record<string, Record<string, unknown>>).r!;
	assert(savedProvider.compat !== undefined && savedProvider.name === "R", "withProviderModels keeps sibling fields");
	const savedModels = savedProvider.models as { id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }[];
	assert(savedModels[0]!.id === "m2" && savedModels[0]!.reasoning === true && savedModels[0]!.thinkingLevelMap?.high === "high", "withProviderModels serializes the level");
	const savedCompat = (savedModels[0] as { compat?: Record<string, unknown> }).compat;
	assert(savedCompat?.supportsLongCacheRetention === false && savedCompat?.sendSessionAffinityHeaders === true, "a save writes the compat flags a relay needs");

	// A probe's limits land in the entry and survive a later edit that does not mention them.
	const withMeta = withProviderModels(rich, "r", [{ id: "m1", level: "auto", meta: { contextWindow: 1_000_000, maxTokens: 64_000 } }]);
	const metaModels = (withMeta.providers as Record<string, { models: { id: string; contextWindow?: number; maxTokens?: number }[] }>).r!.models;
	assert(metaModels[0]!.contextWindow === 1_000_000 && metaModels[0]!.maxTokens === 64_000, "a probed window and cap are written");
	const keptMeta = withProviderModels(withMeta, "r", [{ id: "m1", level: "high" }]);
	const keptModel = (keptMeta.providers as Record<string, { models: { contextWindow?: number; maxTokens?: number }[] }>).r!.models[0]!;
	assert(keptModel.contextWindow === 1_000_000 && keptModel.maxTokens === 64_000, "an edit that says nothing about limits keeps them");
	assert((loadProviderEntry(withMeta, "r")?.models[0]!.meta?.contextWindow ?? 0) === 1_000_000, "the limits load back as meta");
	const probedMap = withProviderModels(rich, "r", [{ id: "m1", level: "auto", map: { medium: "high", xhigh: null } }]);
	const probedModel = (probedMap.providers as Record<string, { models: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }[] }>).r!.models[0]!;
	assert(probedModel.reasoning === true && probedModel.thinkingLevelMap?.medium === "high", "a probed map wins over the level's own pin");
	const levelAfterProbe = withProviderModels(probedMap, "r", [{ id: "m1", level: "high" }]);
	assert((levelAfterProbe.providers as Record<string, { models: { thinkingLevelMap?: Record<string, string | null> }[] }>).r!.models[0]!.thinkingLevelMap?.high === "high", "changing the level replaces the probed map");
	const merged = mergeLevels({ name: "n", baseUrl: "b", api: "openai-completions", models: [{ id: "m1", level: "auto" }, { id: "m2", level: "off" }] }, ["m2", "x-thinking"]);
	assert(merged[0]!.id === "m2" && merged[0]!.level === "off", "a stored chat model stays chat");
	assert(merged[1]!.level === "auto", "a new id defaults to auto");
	const keptFlag = mergeLevels({ name: "n", baseUrl: "b", api: "openai-completions", models: [{ id: "m1", level: "low" }] }, ["m1"]);
	assert(keptFlag[0]!.level === "low", "a stored level survives a reselect");
	// A reselect used to reserialize `auto` without its map, wiping every probed level.
	const reselected = withProviderModels(probedMap, "r", mergeLevels(loadProviderEntry(probedMap, "r")!, ["m1"]));
	const reselectedMap = (reselected.providers as Record<string, { models: { thinkingLevelMap?: Record<string, string | null> }[] }>).r!.models[0]!.thinkingLevelMap;
	assert(reselectedMap?.medium === "high" && reselectedMap?.xhigh === null, "a reselect keeps the probed map");
	const entryLoaded = loadProviderEntry(rich, "r");
	assert(entryLoaded?.models[0]!.id === "m1" && entryLoaded.api === "openai-completions", "loadProviderEntry reads models and api");
	assert(loadProviderEntry(rich, "missing") === undefined, "loadProviderEntry misses cleanly");
	const roundTrip = loadProviderEntry(withProviderModels(rich, "r", [{ id: "m9", level: "xhigh" }]), "r");
	assert(roundTrip?.models[0]!.level === "xhigh", "a saved level loads back as itself");
	assert(levelsSummary([{ id: "a" }, { id: "b", level: "high" }, { id: "c", level: "auto" }]) === "2 thinking (high, auto)", "the save notify names the registered levels");
	assert(levelsSummary([{ id: "a" }]) === "0 thinking", "an all-chat save says so plainly");
	// The Thinking screen's bulk keys are Shift+letter: pi-tui lowercases a key id, so this
	// pins that they stay distinct from the plain letters navigation already uses.
	assert(matchesKey("R", "shift+r") && !matchesKey("r", "shift+r"), "Shift+R is its own key, not plain r");

	// The stored key is read back from auth.json in an isolated agent dir (never the user's).
	const tmp = mkdtempSync(join(tmpdir(), "arnative-providers-"));
	process.env.PI_CODING_AGENT_DIR = tmp;
	saveProvider("t1", { name: "t1", baseUrl: "https://x.com/v1", api: "openai-completions", models: [{ id: "m" }] }, "sk-x");
	assert(readAuthKey("t1") === "sk-x", "readAuthKey returns the stored key");
	assert(readAuthKey("missing") === undefined, "readAuthKey misses cleanly");
	// Atomicity: a save interrupted at the temp write (a directory sits where the temp file
	// should go) must leave the previous config intact — the direct-write code it replaces
	// truncated models.json on any mid-write failure.
	const blockedTmp = join(tmp, `models.json.${process.pid}.tmp`);
	mkdirSync(blockedTmp);
	let interrupted = false;
	try {
		saveProvider("t2", { name: "t2", baseUrl: "https://y.com/v1", api: "openai-completions", models: [{ id: "m" }] }, "sk-y");
	} catch {
		interrupted = true;
	}
	assert(interrupted, "a blocked temp write surfaces the error instead of passing silently");
	assert(providerNames(loadModelsConfig()).join() === "t1", "the previous config survives the interrupted save");
	assert(readAuthKey("t2") === undefined, "the interrupted save never reached auth.json");
	rmSync(blockedTmp, { recursive: true, force: true });

	// Automatic contextWindow fallback: probed > local modelRegistry > public catalog.
	const resolved = await resolveMissingMeta(
		["probed-m", "zai-org/GLM-5.3-Flash", "public/only-model", "unknown-model"],
		new Map([["probed-m", { contextWindow: 64_000 }]]),
		{ modelRegistry: { getAll: () => [{ id: "remote/river/zai-org/GLM-5.3-Flash", contextWindow: 1_000_000, maxTokens: 131_072 }] } },
		route({ "/api/v1/models": { data: [{ id: "public/only-model", context_length: 200_000, top_provider: { max_completion_tokens: 16_384 } }] } }),
	);
	assert(resolved.get("probed-m")?.contextWindow === 64_000, "a probed contextWindow stays untouched");
	assert(resolved.get("zai-org/GLM-5.3-Flash")?.contextWindow === 1_000_000, "missing window falls back to local modelRegistry");
	assert(resolved.get("public/only-model")?.contextWindow === 200_000 && resolved.get("public/only-model")?.maxTokens === 16_384, "still-missing window falls back to public catalog");
	assert(resolved.get("unknown-model") === undefined, "unknown models stay undefined without throwing");
	const offline = await resolveMissingMeta(["x"], undefined, undefined, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
	assert(offline.size === 0, "an offline public catalog failure degrades cleanly");
	assert(readdirSync(tmp).every((f) => !f.endsWith(".tmp")), "a completed save leaves no temp files behind");
	// Edit writes: the key moves to auth.json and leaves models.json, so the secret lives in
	// one place; an env reference is configuration and stays put.
	saveProvider("t3", { name: "t3", baseUrl: "https://z.com/v1", api: "openai-completions", apiKey: "sk-inline", models: [{ id: "m" }] }, undefined);
	saveProviderKey("t3", "sk-edited");
	assert(readAuthKey("t3") === "sk-edited", "an edited key lands in auth.json");
	const t3 = (loadModelsConfig().providers as Record<string, Record<string, unknown>>).t3!;
	assert(t3.apiKey === undefined, "the inline copy is dropped, so the secret lives in one place");
	assert(t3.baseUrl === "https://z.com/v1" && (t3.models as unknown[]).length === 1, "the key edit leaves the rest of the entry alone");
	saveProviderKey("t3", undefined);
	assert(readAuthKey("t3") === undefined, "an empty key removes the credential");
	saveProvider("t4", { name: "t4", baseUrl: "https://w.com/v1", api: "openai-completions", apiKey: "$W_KEY", models: [] }, undefined);
	saveProviderKey("t4", "sk-y");
	assert((loadModelsConfig().providers as Record<string, Record<string, unknown>>).t4!.apiKey === "$W_KEY", "an env reference survives an edit");
	saveProvider("t5", { name: "t5", baseUrl: "https://v.com/v1", api: "openai-completions", models: [{ id: "m" }] }, "sk-t5");
	saveModelsConfig(renameProvider(loadModelsConfig(), "t5", "t6"));
	assert(providerNames(loadModelsConfig()).includes("t6") && !providerNames(loadModelsConfig()).includes("t5"), "a rename reaches models.json");
	assert(loadProviderEntry(loadModelsConfig(), "t6")?.models[0]!.id === "m", "the renamed provider keeps its models");
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(tmp, { recursive: true, force: true });

	// The providers screen copy stays factual and pinned.
	assert(PROVIDERS_TEXT.title === "Providers - Arnative\u2819", `providers title pinned, got ${PROVIDERS_TEXT.title}`);
	assert(ADD_ROW === "+ Add provider", "the add row label is pinned");
	assert(visibleWidth(PROVIDERS_TEXT.legend) > 0, "the screen carries a legend");

});
