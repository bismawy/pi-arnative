import test from "node:test";
import { assert } from "../helpers/check.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestCompat } from "../../lib/compat.ts";
import { saveChoice } from "../../lib/preset-store.ts";
import { MODEL_HEAL_CHOICES, MODEL_HEAL_KEY, activeModelHeal, setModelHeal, autoCompatInstalled, DEFAULT_THINKING_MAP, healFlags, healMeta, healEffort, markRejectedLevel, type RtModel, type HealDeps, type Obj, type HealState, __test } from "../../lib/model-heal.ts";

const { isObj, none, edit } = __test;

test("lib/model-heal.ts self-check", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-heal-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert(getAgentDir() === dir, "the fixture redirects the agent dir");
		const file = join(dir, "models.json");
		const read = (): Record<string, Obj> => (JSON.parse(readFileSync(file, "utf8")) as Obj).providers as Record<string, Obj>;
		const modelIn = (provider: string, id: string): Obj => (read()[provider]!.models as Obj[]).find((m) => m.id === id)!;
		const relay = { api: "openai-completions", baseUrl: "https:\/\/relay.example/v1" };
		writeFileSync(
			file,
			JSON.stringify({
				providers: {
					relay: { ...relay, apiKey: "k", models: [{ id: "gpt-x" }, { id: "claude-sonnet-4-5" }, { id: "r1", reasoning: true }, { id: "pinned", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: null } }] },
					owned: { ...relay },
				},
			}),
		);
		const registry: RtModel[] = [
			{ provider: "relay", id: "gpt-x", ...relay },
			{ provider: "relay", id: "claude-sonnet-4-5", ...relay },
			{ provider: "relay", id: "r1", reasoning: true, ...relay },
			{ provider: "owned", id: "o1", ...relay },
		];
		const deps: HealDeps = { models: () => registry, ownsModels: (p) => p === "owned" };

		const first = healFlags(deps);
		assert(first.changed && first.errors.length === 0, "the first flags pass writes");
		const relayCompat = read().relay!.compat as Obj;
		assert(relayCompat.supportsLongCacheRetention === false && relayCompat.sendSessionAffinityHeaders === true, "a channel-wide flag lands at provider level");
		assert(relayCompat.cacheControlFormat === undefined, "a flag only one sibling needs stays off the provider");
		const overrideCompat = (id: string): Obj => ((read().relay!.modelOverrides as Record<string, Obj>)[id]!.compat as Obj);
		assert(overrideCompat("claude-sonnet-4-5").cacheControlFormat === "anthropic", "and lands on that model override");
		const r1 = modelIn("relay", "r1");
		assert(isObj(r1.thinkingLevelMap) && overrideCompat("r1").supportsDeveloperRole === false, "a reasoning model gets a map and the developer-role opt-out");
		assert(read().owned!.compat === undefined && isObj((read().owned!.modelOverrides as Obj).o1), "an extension-owned provider is fixed through modelOverrides");
		assert(existsSync(`${file}.bak-model-heal`), "the first write keeps a backup");
		const pinned = modelIn("relay", "pinned").thinkingLevelMap as Obj;
		assert(pinned.minimal === "minimal" && pinned.medium === "medium" && pinned.xhigh === "xhigh" && pinned.max === null && !("off" in pinned), "an old single-pin map becomes a ceiling map");

		// The registry stays stale until refresh; a repeat must find nothing left to write.
		assert(!healFlags(deps).changed, "a repeated pass is a no-op");

		// An explicit value, even false, produces no suggestion, so nothing overwrites it.
		const explicit: RtModel = { provider: "relay", id: "gpt-x", ...relay, compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: false } };
		assert(Object.keys(suggestCompat(explicit)).length === 0, "stated flags produce no suggestion");

		// Meta: a synced window and cap, an unloaded catalog id, the TTL, a later hand edit.
		const catalog = { data: [{ id: "gpt-x", context_length: 400_000, max_output_tokens: 32_000 }, { id: "unloaded", context_length: 9 }] };
		let calls = 0;
		const metaFetch = (async () => {
			calls++;
			return { ok: true, status: 200, text: async () => JSON.stringify(catalog) };
		}) as unknown as typeof fetch;
		const metaDeps: HealDeps = { ...deps, fetchImpl: metaFetch };
		const meta = await healMeta(metaDeps, false);
		assert(meta.changed && modelIn("relay", "gpt-x").contextWindow === 400_000 && modelIn("relay", "gpt-x").maxTokens === 32_000, "a catalog window and cap are synced");
		assert(!readFileSync(file, "utf8").includes("unloaded"), "a catalog id pi never loaded gets no entry");
		const callsAfterFirst = calls;
		await healMeta(metaDeps, false);
		assert(calls === callsAfterFirst, "a fresh signature inside the TTL costs no request");

		const edited = JSON.parse(readFileSync(file, "utf8")) as Obj;
		(((edited.providers as Record<string, Obj>).relay!.models as Obj[]).find((m) => m.id === "gpt-x")!).contextWindow = 200_000;
		writeFileSync(file, JSON.stringify(edited));
		await healMeta(metaDeps, true);
		assert(modelIn("relay", "gpt-x").contextWindow === 200_000, "a hand-edited window stays manual");

		// A write that fails must not stamp the state: the next run would read the unchanged
		// value as a hand edit and never sync it again. A directory at the temp path fails
		// the atomic write on every OS (EISDIR).
		const locked = JSON.parse(readFileSync(file, "utf8")) as Obj;
		(locked.providers as Record<string, Obj>).lock = { ...relay, models: [{ id: "m", contextWindow: 128_000 }] };
		writeFileSync(file, JSON.stringify(locked));
		const lockDeps: HealDeps = {
			models: () => [{ provider: "lock", id: "m", ...relay }],
			ownsModels: () => false,
			fetchImpl: (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "m", context_length: 400_000 }] }) })) as unknown as typeof fetch,
		};
		const blocker = file + "." + process.pid + ".tmp";
		mkdirSync(blocker);
		const failed = await healMeta(lockDeps, true);
		rmSync(blocker, { recursive: true, force: true });
		assert(!failed.changed && failed.errors.some((e) => e.startsWith("write failed")), "a failed write is reported");
		await healMeta(lockDeps, true);
		assert(modelIn("lock", "m").contextWindow === 400_000, "a failed write leaves no stamp, so the next run still syncs");

		// Effort: a relay that 400s medium remaps it upward; a shaped map is left alone.
		const effortFetch = (async (_url: string, init?: { body?: string }) => {
			const level = JSON.parse(init?.body ?? "{}").reasoning_effort as string;
			const ok = ["none", "minimal", "low", "high"].includes(level);
			return { status: ok ? 200 : 400, text: async () => (ok ? "" : "invalid reasoning_effort") };
		}) as unknown as typeof fetch;
		const r1Model: RtModel = { provider: "relay", id: "r1", reasoning: true, ...relay, thinkingLevelMap: { ...DEFAULT_THINKING_MAP } };
		const effort = await healEffort({ ...deps, fetchImpl: effortFetch }, true, [r1Model]);
		assert(effort.changed && (modelIn("relay", "r1").thinkingLevelMap as Obj).medium === null, "a rejected effort is marked unsupported, not remapped");
		const shaped = await healEffort({ ...deps, fetchImpl: effortFetch }, true, [{ ...r1Model, thinkingLevelMap: { medium: "high" } }]);
		assert(!shaped.changed, "a user-shaped map is never probed");
		const runtime = markRejectedLevel(deps, r1Model, "low");
		const afterRuntime = modelIn("relay", "r1").thinkingLevelMap as Obj;
		assert(runtime.changed && afterRuntime.low === null && afterRuntime.medium === null && afterRuntime.high === "high", "a level rejected at runtime is dropped and the rest stay");
		assert(!markRejectedLevel(deps, r1Model, "low").changed, "a level already dropped is a no-op");
		assert(!markRejectedLevel(deps, r1Model, "off").changed, "off is never dropped");
		assert((await healEffort({ ...deps, fetchImpl: effortFetch }, false, [{ ...r1Model, thinkingLevelMap: afterRuntime as Record<string, string | null> }])).errors.length === 0, "a runtime-dropped map stays probe-owned");
		assert(existsSync(join(dir, "arnative", "model-heal.json")), "state lives in the arnative folder");
		// The trigger runs meta and effort at once; neither save may drop the other's stamps.
		await Promise.all([healMeta(metaDeps, true), healEffort({ ...deps, fetchImpl: effortFetch }, true, [r1Model])]);
		const both = JSON.parse(readFileSync(join(dir, "arnative", "model-heal.json"), "utf8")) as HealState;
		assert(Object.keys(both.providers).length > 0 && Object.keys(both.efforts).length > 0, "concurrent passes keep both state sections");

		// A corrupt models.json is reported and left byte-for-byte as it was.
		writeFileSync(file, "{ broken");
		const corrupt = healFlags(deps);
		assert(!corrupt.changed && corrupt.errors.length === 1 && readFileSync(file, "utf8") === "{ broken", "a corrupt file is never rewritten");

		// Coexistence: pi-auto-compat in settings is detected in both package shapes.
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:@bismawy/pi-arnative", { source: "npm:@bismawy/pi-auto-compat" }] }));
		assert(autoCompatInstalled(), "an installed pi-auto-compat is detected");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:@bismawy/pi-arnative"] }));
		assert(!autoCompatInstalled(), "and its removal too");

		// Mode: Full until chosen, every choice round-trips, and a junk value falls back to Full.
		assert(activeModelHeal() === "Full", "Full is the default mode");
		for (const choice of MODEL_HEAL_CHOICES) {
			setModelHeal(choice);
			assert(activeModelHeal() === choice, "the " + choice + " mode is saved");
		}
		saveChoice(MODEL_HEAL_KEY, "Sometimes");
		assert(activeModelHeal() === "Full", "an unknown saved mode reads as Full");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
