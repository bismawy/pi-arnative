/**
 * Model heal: keep models.json correct without a command. Adopted from pi-auto-compat and
 * built on the rules in compat.ts (the same rules the provider wizard writes).
 *
 * Three passes, each a single synchronous read-modify-write of models.json so two passes
 * can never interleave:
 *   flags  - compat flags + a default thinkingLevelMap (offline, cheap, every trigger)
 *   meta   - contextWindow / maxTokens from each channel's GET /models (TTL-gated)
 *   effort - the reasoning_effort levels a relay accepts -> thinkingLevelMap (TTL-gated)
 *
 * A pass writes only a value that differs from what is stored, so a repeated trigger is a
 * no-op and an explicit user value (even `false`) is never overwritten: suggestCompat only
 * returns keys the merged model leaves undefined, and a network value the user has since
 * edited is remembered as manual and left alone.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, isMain } from "./check.ts";
import {
	buildEffortMap,
	carriesRemap,
	contextWindowAccepted,
	isEffortProbeable,
	parseModelMeta,
	probeEffort,
	suggestCompat,
	type Compat,
	type CompatModel,
	type ModelMeta,
} from "./compat.ts";
import { loadChoice, saveChoice } from "./preset-store.ts";
import { loadModelsConfig, looseJsonParse, readAuthKey, saveModelsConfig } from "./provider.ts";

// ------------------------------------------------------------- setting

export const MODEL_HEAL_CHOICES = ["Full", "Flags", "Off"] as const;
export type ModelHealChoice = (typeof MODEL_HEAL_CHOICES)[number];
export const MODEL_HEAL_KEY = "modelHeal";
export const DEFAULT_MODEL_HEAL: ModelHealChoice = "Full";

export const activeModelHeal = (): ModelHealChoice => loadChoice(MODEL_HEAL_KEY, MODEL_HEAL_CHOICES) ?? DEFAULT_MODEL_HEAL;
export const setModelHeal = (choice: ModelHealChoice): void => saveChoice(MODEL_HEAL_KEY, choice);

/** pi-auto-compat writes the same file; two healers would double every backup and probe. */
export function autoCompatInstalled(): boolean {
	try {
		const settings = looseJsonParse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as { packages?: unknown };
		if (!Array.isArray(settings?.packages)) return false;
		return settings.packages.some((p) => String(typeof p === "string" ? p : ((p as { source?: unknown })?.source ?? "")).includes("pi-auto-compat"));
	} catch {
		return false;
	}
}

// --------------------------------------------------------------- types

export type RtModel = CompatModel & { provider: string; id: string; thinkingLevelMap?: unknown };
type Obj = Record<string, unknown>;

/** What a pass needs from the running session; injected so the self-check runs offline. */
export interface HealDeps {
	/** Merged registry models (models.json + built-ins + extension providers). */
	models: () => RtModel[];
	/** True when an extension supplies the provider's model list: pi applies that list after
	 *  models.json, so only `modelOverrides` reaches the merged model. */
	ownsModels: (provider: string) => boolean;
	fetchImpl?: typeof fetch;
}

export interface HealResult {
	changed: boolean;
	detail: string[];
	errors: string[];
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const lower = (v: unknown): string => String(v ?? "").toLowerCase();
const modelKey = (provider: string, id: string): string => `${lower(provider)}\0${id}`;
const none = (): HealResult => ({ changed: false, detail: [], errors: [] });
const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The map a reasoning model gets when it declares none: pi's four named efforts as-is. */
export const DEFAULT_THINKING_MAP = { low: "low", medium: "medium", high: "high", xhigh: "xhigh" };

const HOUR_MS = 60 * 60 * 1000;
const META_TTL_MS = 6 * HOUR_MS;
const META_TIMEOUT_MS = 8000;
const META_MAX_BYTES = 2 * 1024 * 1024;
const EFFORT_TTL_MS = 24 * HOUR_MS;
const EFFORT_FAILURE_TTL_MS = HOUR_MS;
const EFFORT_BUDGET_MS = 2 * 60 * 1000;

function groupByProvider(models: RtModel[]): Map<string, RtModel[]> {
	const out = new Map<string, RtModel[]>();
	for (const m of models) {
		if (!m?.provider || !m.id) continue;
		const list = out.get(lower(m.provider)) ?? [];
		list.push(m);
		out.set(lower(m.provider), list);
	}
	return out;
}

// ------------------------------------------------------------ models.json

let backedUp = false;

/** Read, mutate, write once. A corrupt models.json throws in the read and is never
 *  rewritten; the first write of a process keeps one backup of the file it replaced. */
function edit(mutate: (cfg: Obj) => string[]): HealResult {
	let cfg: unknown;
	try {
		cfg = loadModelsConfig();
	} catch (error) {
		return { changed: false, detail: [], errors: [`models.json unreadable, not touched: ${errText(error)}`] };
	}
	if (!isObj(cfg)) return none();
	if (!isObj(cfg.providers)) cfg.providers = {};
	const detail = mutate(cfg);
	if (detail.length === 0) return none();
	try {
		const path = join(getAgentDir(), "models.json");
		if (!backedUp && existsSync(path)) {
			copyFileSync(path, `${path}.bak-model-heal`);
			backedUp = true;
		}
		saveModelsConfig(cfg);
	} catch (error) {
		return { changed: false, detail: [], errors: [`write failed: ${errText(error)}`] };
	}
	return { changed: true, detail, errors: [] };
}

const providersOf = (cfg: Obj): Record<string, Obj> => cfg.providers as Record<string, Obj>;

function providerEntry(cfg: Obj, provider: string): Obj {
	const providers = providersOf(cfg);
	if (!isObj(providers[provider])) providers[provider] = {};
	return providers[provider]!;
}

const modelEntryOf = (entry: Obj, id: string): Obj | undefined =>
	Array.isArray(entry.models) ? (entry.models as unknown[]).find((m): m is Obj => isObj(m) && String(m.id) === id) : undefined;

/** The layer a per-model value lands in: the stated models[] entry, else modelOverrides. */
function modelSlot(entry: Obj, id: string, owned: boolean): { slot: Obj; label: string } {
	const stated = owned ? undefined : modelEntryOf(entry, id);
	if (stated) return { slot: stated, label: `models[${id}]` };
	if (!isObj(entry.modelOverrides)) entry.modelOverrides = {};
	const overrides = entry.modelOverrides as Record<string, Obj>;
	if (!isObj(overrides[id])) overrides[id] = {};
	return { slot: overrides[id]!, label: `modelOverrides[${id}]` };
}

/** Assign the keys that differ; returns the ones written. */
function assignCompat(holder: Obj, values: Compat): string[] {
	const compat = isObj(holder.compat) ? holder.compat : {};
	const written = Object.keys(values).filter((k) => compat[k] !== values[k]);
	if (written.length === 0) return written;
	for (const k of written) compat[k] = values[k];
	holder.compat = compat;
	return written;
}

// ---------------------------------------------------------- pass: flags

/** The models a flags pass looks at: every model of a provider the user declared (or an
 *  extension owns), plus the active one - never an entry for each unused built-in. */
function flagTargets(deps: HealDeps, cfg: Obj, active?: RtModel): RtModel[] {
	const declared = new Set(Object.keys(providersOf(cfg)).map(lower));
	const seen = new Set<string>();
	const out: RtModel[] = [];
	for (const m of [...deps.models(), ...(active ? [active] : [])]) {
		if (!m?.provider || !m.id || seen.has(modelKey(m.provider, m.id))) continue;
		if (m !== active && !declared.has(lower(m.provider)) && !deps.ownsModels(m.provider)) continue;
		seen.add(modelKey(m.provider, m.id));
		out.push(m);
	}
	return out;
}

/**
 * Compat flags + default thinking maps. A flag goes to provider level only when every
 * sibling would get the identical value (or already has it) and no model layer states the
 * key, so a mixed provider (Claude next to GPT on one relay) keeps per-model flags with no
 * per-key rule list to maintain.
 */
export function healFlags(deps: HealDeps, only?: RtModel[], active?: RtModel): HealResult {
	return edit((cfg) => {
		const detail: string[] = [];
		for (const [provider, entry] of Object.entries(providersOf(cfg))) {
			if (!isObj(entry) || !Array.isArray(entry.models)) continue;
			for (const m of entry.models) {
				if (!isObj(m) || m.reasoning !== true) continue;
				if (isObj(m.thinkingLevelMap) && Object.keys(m.thinkingLevelMap).length > 0) continue;
				m.thinkingLevelMap = { ...DEFAULT_THINKING_MAP };
				detail.push(`${provider} models[${String(m.id)}]: thinkingLevelMap`);
			}
		}

		const siblingsOf = groupByProvider(deps.models());
		for (const m of only ?? flagTargets(deps, cfg, active)) {
			const suggestion = suggestCompat(m);
			if (Object.keys(suggestion).length === 0) continue;
			const owned = deps.ownsModels(m.provider);
			const entry = providerEntry(cfg, m.provider);
			const stated = owned ? undefined : modelEntryOf(entry, m.id);
			const override = isObj(entry.modelOverrides) ? (entry.modelOverrides as Obj)[m.id] : undefined;
			const modelLayer = { ...(isObj(override) && isObj(override.compat) ? override.compat : {}), ...(stated && isObj(stated.compat) ? stated.compat : {}) };
			const siblings = siblingsOf.get(lower(m.provider)) ?? [m];

			const shared: Compat = {};
			const own: Compat = {};
			for (const [k, v] of Object.entries(suggestion)) {
				const fitsAll = siblings.every((s) => s.id === m.id || suggestCompat(s)[k] === v || s.compat?.[k] === v);
				if (!owned && !(k in modelLayer) && fitsAll) shared[k] = v;
				else own[k] = v;
			}
			const atProvider = assignCompat(entry, shared);
			if (atProvider.length) detail.push(`${m.provider}: compat += ${atProvider.join(", ")}`);
			if (Object.keys(own).length) {
				const { slot, label } = modelSlot(entry, m.id, owned);
				const atModel = assignCompat(slot, own);
				if (atModel.length) detail.push(`${m.provider} ${label}: compat += ${atModel.join(", ")}`);
			}
		}
		return detail;
	});
}

// ---------------------------------------------------------------- state

interface HealState {
	schema: 1;
	providers: Record<string, { signature: string; fetchedAt: number }>;
	sources: Record<string, { contextWindow?: number; maxTokens?: number; at: number }>;
	efforts: Record<string, { at: number; map: Record<string, string | null>; failed?: boolean }>;
}

const statePath = (): string => join(getAgentDir(), "arnative", "model-heal.json");
// pi-auto-compat's state has the same schema; seeding from it keeps its provenance, so a
// value the user edited by hand under the old package stays manual after the switch.
const legacyStatePath = (): string => join(getAgentDir(), "pi-auto-compat-sync.json");

function loadState(): HealState {
	for (const path of [statePath(), legacyStatePath()]) {
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HealState>;
			if (raw?.schema === 1) return { schema: 1, providers: raw.providers ?? {}, sources: raw.sources ?? {}, efforts: raw.efforts ?? {} };
		} catch {
			// absent or unreadable: try the next, then start clean
		}
	}
	return { schema: 1, providers: {}, sources: {}, efforts: {} };
}

/** Writes only the sections a pass owns, merged onto a fresh read: meta and effort run
 *  concurrently, and a whole-object save from one would drop the other's stamps. */
function saveState(part: Partial<Omit<HealState, "schema">>): void {
	try {
		const state = { ...loadState(), ...part };
		const path = statePath();
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch {
		// best effort: a lost stamp only costs one extra request next run
	}
}

// ------------------------------------------------------------- channels

/** A models.json apiKey: "$VAR" env, "!cmd" shell output, else the literal. */
function resolveSecret(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	if (value.startsWith("$")) return process.env[value.slice(1)]?.trim() || undefined;
	if (value.startsWith("!")) {
		try {
			return execSync(value.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	return value;
}

interface Channel {
	provider: string;
	baseUrl: string;
	api: string;
	key?: string;
	headers: Record<string, string>;
	compat: Compat;
	ids: string[];
}

/** Every declared provider with a baseUrl. The key comes from auth.json (what /login and
 *  the wizard write) before models.json's apiKey. */
function channelsOf(cfg: Obj, deps: HealDeps): Channel[] {
	const byProvider = groupByProvider(deps.models());
	const out: Channel[] = [];
	for (const [provider, entry] of Object.entries(providersOf(cfg))) {
		if (!isObj(entry)) continue;
		const merged = byProvider.get(lower(provider)) ?? [];
		const baseUrl = typeof entry.baseUrl === "string" && entry.baseUrl ? entry.baseUrl : merged.find((m) => typeof m.baseUrl === "string" && m.baseUrl)?.baseUrl;
		if (typeof baseUrl !== "string" || !baseUrl) continue;
		const headers: Record<string, string> = {};
		if (isObj(entry.headers)) for (const [k, v] of Object.entries(entry.headers)) if (typeof v === "string") headers[k] = v;
		const stated = Array.isArray(entry.models) ? (entry.models as unknown[]).flatMap((m) => (isObj(m) && m.id ? [String(m.id)] : [])) : [];
		out.push({
			provider,
			baseUrl,
			api: lower(entry.api ?? merged[0]?.api),
			key: readAuthKey(provider) ?? resolveSecret(entry.apiKey),
			headers,
			compat: { ...(isObj(entry.compat) ? entry.compat : {}), ...(merged[0]?.compat ?? {}) },
			ids: [...new Set([...stated, ...merged.map((m) => m.id)])].sort(),
		});
	}
	return out;
}

async function fetchMeta(channel: Channel, fetchImpl: typeof fetch): Promise<Map<string, ModelMeta>> {
	const headers: Record<string, string> = { accept: "application/json", "accept-encoding": "identity", ...channel.headers };
	if (channel.key) headers.authorization = `Bearer ${channel.key}`;
	const response = await fetchImpl(`${channel.baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(META_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const text = await response.text();
	if (text.length > META_MAX_BYTES) throw new Error("response too large");
	const body = JSON.parse(text) as unknown;
	return parseModelMeta(Array.isArray(body) ? { data: body } : body);
}

/** Read models.json for a network pass; a corrupt file is the flags pass's to report. */
function readForPass(): Obj | undefined {
	try {
		const cfg = loadModelsConfig();
		return isObj(cfg) && isObj(cfg.providers) ? cfg : undefined;
	} catch {
		return undefined;
	}
}

// ----------------------------------------------------------- pass: meta

let metaInFlight = false;

/** contextWindow / maxTokens from each channel's catalog. A non-forced run skips a channel
 *  fetched within the TTL whose baseUrl and model ids are unchanged. */
export async function healMeta(deps: HealDeps, force: boolean): Promise<HealResult> {
	if (metaInFlight) return none();
	metaInFlight = true;
	try {
		const cfg = readForPass();
		if (!cfg) return none();
		const state = loadState();
		const now = Date.now();
		const errors: string[] = [];
		const fetched = new Map<string, { meta: Map<string, ModelMeta>; signature: string }>();
		for (const channel of channelsOf(cfg, deps)) {
			const signature = JSON.stringify({ baseUrl: channel.baseUrl, ids: channel.ids });
			const prev = state.providers[channel.provider];
			if (!force && prev?.signature === signature && now - prev.fetchedAt < META_TTL_MS) continue;
			try {
				fetched.set(channel.provider, { meta: await fetchMeta(channel, deps.fetchImpl ?? fetch), signature });
			} catch (error) {
				errors.push(`${channel.provider}: ${errText(error)}`);
			}
		}
		if (fetched.size === 0) return { changed: false, detail: [], errors };

		const byProvider = groupByProvider(deps.models());
		const result = edit((fresh) => {
			const detail: string[] = [];
			for (const [provider, { meta, signature }] of fetched) {
				const entry = providerEntry(fresh, provider);
				const owned = deps.ownsModels(provider);
				const loaded = new Set((byProvider.get(lower(provider)) ?? []).map((m) => m.id));
				for (const [id, fields] of meta) {
					// A catalog id pi never loaded is not a model the user runs: no entry for it.
					if (!loaded.has(id) && !modelEntryOf(entry, id)) continue;
					const { slot, label } = modelSlot(entry, id, owned);
					const key = modelKey(provider, id);
					const prev = state.sources[key];
					const curCtx = typeof slot.contextWindow === "number" ? slot.contextWindow : undefined;
					const curMax = typeof slot.maxTokens === "number" ? slot.maxTokens : undefined;
					// A value this pass wrote that no longer matches was edited by hand: manual from now on.
					const manualCtx = prev?.contextWindow !== undefined && curCtx !== prev.contextWindow;
					const manualMax = prev?.maxTokens !== undefined && curMax !== prev.maxTokens;
					const next = { at: Date.now(), contextWindow: prev?.contextWindow, maxTokens: prev?.maxTokens };

					if (fields.contextWindow !== undefined && !manualCtx && contextWindowAccepted(fields.contextWindow, curCtx)) {
						if (curCtx !== fields.contextWindow) {
							slot.contextWindow = fields.contextWindow;
							detail.push(`${provider} ${label}: contextWindow ${curCtx ?? "unset"} -> ${fields.contextWindow}`);
						}
						next.contextWindow = fields.contextWindow;
					}
					const window = typeof slot.contextWindow === "number" ? slot.contextWindow : undefined;
					if (fields.maxTokens !== undefined && !manualMax) {
						const cap = window !== undefined && fields.maxTokens > window ? window : fields.maxTokens;
						if (curMax === undefined || cap > curMax) {
							slot.maxTokens = cap;
							next.maxTokens = cap;
							detail.push(`${provider} ${label}: maxTokens ${curMax ?? "unset"} -> ${cap}`);
						}
					}
					// An override this pass created and left empty must not stay behind.
					if (Object.keys(slot).length === 0 && isObj(entry.modelOverrides)) delete (entry.modelOverrides as Obj)[id];
					if (next.contextWindow !== undefined || next.maxTokens !== undefined) state.sources[key] = next;
				}
				if (isObj(entry.modelOverrides) && Object.keys(entry.modelOverrides).length === 0) delete entry.modelOverrides;
				state.providers[provider] = { signature, fetchedAt: Date.now() };
			}
			return detail;
		});
		saveState({ providers: state.providers, sources: state.sources }); // fetchedAt is kept even when nothing changed, so the TTL holds
		return { ...result, errors: [...errors, ...result.errors] };
	} finally {
		metaInFlight = false;
	}
}

// --------------------------------------------------------- pass: effort

let effortInFlight = false;

const mapOf = (m: RtModel): Record<string, string | null> | undefined => (isObj(m.thinkingLevelMap) ? (m.thinkingLevelMap as Record<string, string | null>) : undefined);

/** Probe the reasoning efforts each relay accepts and remap rejected levels. A map the user
 *  shaped (a remap or a null) is theirs and never probed, not even when forced. */
export async function healEffort(deps: HealDeps, force: boolean, only?: RtModel[]): Promise<HealResult> {
	if (effortInFlight) return none();
	effortInFlight = true;
	try {
		const cfg = readForPass();
		if (!cfg) return none();
		const channels = new Map(
			channelsOf(cfg, deps)
				.filter((c) => c.api === "openai-completions" || c.api === "openai-responses")
				.map((c) => [lower(c.provider), c] as const),
		);
		if (channels.size === 0) return none();

		const state = loadState();
		const now = Date.now();
		const pending = (only ?? deps.models()).filter((m) => {
			const channel = m?.provider ? channels.get(lower(m.provider)) : undefined;
			if (!channel || !isEffortProbeable(m, channel.compat) || carriesRemap(mapOf(m))) return false;
			if (force) return true;
			const prev = state.efforts[modelKey(m.provider, m.id)];
			if (!prev) return true;
			if (now - prev.at >= (prev.failed ? EFFORT_FAILURE_TTL_MS : EFFORT_TTL_MS)) return true;
			return JSON.stringify(mapOf(m) ?? {}) !== JSON.stringify(prev.map); // edited since: respect it
		});
		if (pending.length === 0) return none();

		const errors: string[] = [];
		const answered: { model: RtModel; supported: string[] }[] = [];
		const deadline = now + EFFORT_BUDGET_MS;
		for (const model of pending) {
			if (Date.now() >= deadline) {
				errors.push(`${model.provider}: probe budget exhausted`);
				break;
			}
			const channel = channels.get(lower(model.provider))!;
			const supported = await probeEffort(
				{ ...model, compat: { ...channel.compat, ...(model.compat ?? {}) } },
				{ baseUrl: channel.baseUrl, key: channel.key, headers: channel.headers, fetchImpl: deps.fetchImpl },
			);
			if (supported.length === 0) {
				// Stamped as failed so the next run waits the short TTL instead of re-sending.
				errors.push(`${model.provider}/${model.id}: no level answered (not patched)`);
				state.efforts[modelKey(model.provider, model.id)] = { at: now, map: mapOf(model) ?? {}, failed: true };
				continue;
			}
			answered.push({ model, supported });
		}

		const result = edit((fresh) => {
			const detail: string[] = [];
			for (const { model, supported } of answered) {
				const current = mapOf(model);
				const next = buildEffortMap(current, supported);
				state.efforts[modelKey(model.provider, model.id)] = { at: Date.now(), map: next ?? current ?? {} };
				if (!next) continue;
				const { slot, label } = modelSlot(providerEntry(fresh, model.provider), model.id, deps.ownsModels(model.provider));
				slot.thinkingLevelMap = next;
				const parts = Object.entries(next).flatMap(([level, value]) => (value === null ? [`${level}=unsupported`] : value === level ? [] : [`${level}->${value}`]));
				detail.push(`${model.provider} ${label}: thinkingLevelMap ${parts.join(", ")}`);
			}
			return detail;
		});
		saveState({ efforts: state.efforts });
		return { ...result, errors: [...errors, ...result.errors] };
	} finally {
		effortInFlight = false;
	}
}

// ----------------------------------------------------------- self-check

if (isMain(import.meta.url)) {
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
					relay: { ...relay, apiKey: "k", models: [{ id: "gpt-x" }, { id: "claude-sonnet-4-5" }, { id: "r1", reasoning: true }] },
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
		assert((modelIn("relay", "claude-sonnet-4-5").compat as Obj).cacheControlFormat === "anthropic", "and lands on that model");
		const r1 = modelIn("relay", "r1");
		assert(isObj(r1.thinkingLevelMap) && (r1.compat as Obj).supportsDeveloperRole === false, "a reasoning model gets a map and the developer-role opt-out");
		assert(read().owned!.compat === undefined && isObj((read().owned!.modelOverrides as Obj).o1), "an extension-owned provider is fixed through modelOverrides");
		assert(existsSync(`${file}.bak-model-heal`), "the first write keeps a backup");

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

		// Effort: a relay that 400s medium remaps it upward; a shaped map is left alone.
		const effortFetch = (async (_url: string, init?: { body?: string }) => {
			const level = JSON.parse(init?.body ?? "{}").reasoning_effort as string;
			const ok = ["none", "minimal", "low", "high"].includes(level);
			return { status: ok ? 200 : 400, text: async () => (ok ? "" : "invalid reasoning_effort") };
		}) as unknown as typeof fetch;
		const r1Model: RtModel = { provider: "relay", id: "r1", reasoning: true, ...relay, thinkingLevelMap: { ...DEFAULT_THINKING_MAP } };
		const effort = await healEffort({ ...deps, fetchImpl: effortFetch }, true, [r1Model]);
		assert(effort.changed && (modelIn("relay", "r1").thinkingLevelMap as Obj).medium === "high", "a rejected effort is remapped to the nearest accepted one");
		const shaped = await healEffort({ ...deps, fetchImpl: effortFetch }, true, [{ ...r1Model, thinkingLevelMap: { medium: "high" } }]);
		assert(!shaped.changed, "a user-shaped map is never probed");
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
	console.log("model-heal.ts self-check OK");
}
