/**
 * Provider endpoint probing, model metadata merging, and models.json / auth.json store operations.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalogIndex, findMetaForId, mergeMeta, parseModelMeta, suggestCompat, type CatalogIndex, type Compat, type ModelMeta } from "./compat.ts";
import { writeJsonAtomicSync } from "./preset-store.ts";

// ---------------------------------------------------------------- flavors

/** The wire protocols pi implements. A provider entry names one; the probe guesses it. */
export const API_FLAVORS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export type ApiFlavor = (typeof API_FLAVORS)[number];

export const FLAVOR_LABELS: Record<ApiFlavor, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Gemini (Generative Language)",
};

/** Chat base for a flavor: the OpenAI implementations append to `/v1`, the Anthropic and
 *  Gemini ones carry their version in the path, so a `/v1` suffix there is a lie. */
export function chatBaseUrl(flavor: ApiFlavor, base: string): string {
	const stripped = base.replace(/\/(v1|v1beta)\/?$/i, "");
	if (flavor === "anthropic-messages" || flavor === "google-generative-ai") return stripped;
	return /\/v\d+\w*$/.test(base) ? base.replace(/\/$/, "") : `${stripped}/v1`;
}

/** `https://api.deepseek.com/v1` → `deepseek`; the offered default for the name input. */
export function guessProviderName(base: string): string {
	try {
		const host = new URL(base).hostname;
		if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "localhost") return host;
		const labels = host.split(".");
		const generic = new Set(["api", "llm", "gateway", "proxy", "relay", "open", "cloud"]);
		const named = labels.filter((l, i) => !(i === 0 && generic.has(l)));
		const tld = new Set(["com", "ai", "org", "net", "io", "dev", "app", "cn", "id", "co"]);
		const body = named.length > 1 && tld.has(named[named.length - 1]!) ? named.slice(0, -1) : named;
		return body.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") || host;
	} catch {
		return "custom";
	}
}

/** Trim, default the scheme to `http://` for bare hosts (Ollama), drop trailing slashes. */
export function normalizeBase(input: string): string {
	const trimmed = input.trim().replace(/\/+$/, "");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
	return `http://${trimmed}`;
}

// ---------------------------------------------------------------- probe

export type ProbeShape = "openai" | "ollama" | "gemini";

export interface ProbeCandidate {
	/** Full URL to GET. */
	url: string;
	/** Flavor a list at this URL implies. */
	flavor: ApiFlavor;
	/** Body shape this path serves; the parse is strict to it. */
	shape: ProbeShape;
	/** The endpoint works without a key (Ollama); the saved entry then carries a dummy key. */
	keyless: boolean;
	/** Extra headers for this probe only (the Gemini key header, the OpenAI/Anthropic set). */
	headers?: Record<string, string>;
}

/** GETs whose answer decides flavor and model list, in priority order. */
export function buildCandidates(base: string, key: string): ProbeCandidate[] {
	const keyless = !key;
	const auth: Record<string, string> = key
		? {
				// Every header style at once: a strict server ignores the others.
				authorization: `Bearer ${key}`,
				"x-api-key": key,
				"anthropic-version": "2023-06-01",
			}
		: {};
	const candidates: ProbeCandidate[] = [
		{ url: `${base}/api/tags`, flavor: "openai-completions", shape: "ollama", keyless: true },
		{
			url: `${base}/v1beta/models`,
			flavor: "google-generative-ai",
			shape: "gemini",
			keyless: false,
			headers: key ? { "x-goog-api-key": key } : undefined,
		},
	];
	// A base already ending in `/v1` serves the list at `/models`; anything else tries the
	// common layouts. Both answer `{data: [{id}]}` — openai-completions wins the tie, the
	// model picker's `[a]` is the override for an Anthropic-shaped relay.
	const listPaths = /\/v1$/.test(base) ? ["/models"] : ["/v1/models", "/models"];
	for (const path of listPaths) {
		candidates.push({ url: `${base}${path}`, flavor: "openai-completions", shape: "openai", keyless, headers: auth });
	}
	return candidates;
}

/** Model ids from a probed list body, or undefined when the body does not match the
 *  shape the path serves — a strict parse keeps a relay's answer on its own path. */
export function parseModelList(candidate: ProbeCandidate, body: unknown): string[] | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;
	if (candidate.shape === "openai") {
		if (!Array.isArray(record.data)) return undefined;
		return record.data.map((m) => (typeof m === "object" && m !== null ? (m as Record<string, unknown>).id : undefined)).filter((id): id is string => typeof id === "string");
	}
	if (!Array.isArray(record.models)) return undefined;
	return record.models
		.map((m) => (typeof m === "object" && m !== null ? (m as Record<string, unknown>).name : undefined))
		.filter((n): n is string => typeof n === "string")
		.map((n) => (candidate.shape === "gemini" ? n.replace(/^models\//, "") : n));
}

export interface ProbeResult {
	flavor: ApiFlavor;
	/** Chat base for the flavor (`chatBaseUrl`). */
	baseUrl: string;
	models: string[];
	/** `contextWindow`/`maxTokens` from the same answer — no second request. */
	meta: Map<string, ModelMeta>;
	/** Path that answered, for the notify line. */
	via: string;
	keyless: boolean;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
	ok: boolean;
	status?: number;
	json(): Promise<unknown>;
}>;

/** Probe once: every candidate GET runs in parallel, the first candidate in priority
 *  order that answers with a recognized model list wins. Undefined when none does. */
export async function probeEndpoint(base: string, key: string, fetchImpl: FetchLike = fetch, timeoutMs = 10_000): Promise<ProbeResult | undefined> {
	const candidates = buildCandidates(base, key);
	const settled = await Promise.allSettled(
		candidates.map(async (candidate) => {
			const response = await fetchImpl(candidate.url, {
				headers: candidate.headers,
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status ?? "error"}`);
			const body = await response.json();
			const models = parseModelList(candidate, body);
			if (!models || models.length === 0) throw new Error("no models");
			return { candidate, models, meta: parseModelMeta(body) };
		}),
	);
	for (let i = 0; i < candidates.length; i++) {
		const result = settled[i];
		if (result?.status !== "fulfilled") continue;
		const { candidate, models, meta } = result.value;
		return {
			flavor: candidate.flavor,
			baseUrl: chatBaseUrl(candidate.flavor, base),
			models: [...new Set(models)],
			meta,
			via: new URL(candidate.url).pathname,
			keyless: candidate.keyless,
		};
	}
	return undefined;
}

// ---------------------------------------------------------------- stores

/** pi's thinking scale, in order — `/think` clamps a request to the nearest level a model
 *  supports, and `xhigh`/`max` only exist when the map names them. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** `auto` is not a pi level: it means `reasoning: true` with no map, so every `/think`
 *  level travels to the endpoint unchanged — for models that take an effort parameter. */
export type ThinkingSetting = ThinkingLevel | "auto";
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ProviderModel {
	id: string;
	/** Thinking level; undefined means chat (no `reasoning` flag). */
	level?: ThinkingSetting;
	/** An effort map a probe produced; it wins over the level's own single pin. */
	map?: Record<string, string | null>;
	/** Stopped in the stored entry, so a reselect never loses it. */
	meta?: ModelMeta;
	compat?: Compat;
}

export interface ProviderEntry {
	name?: string;
	baseUrl: string;
	api: ApiFlavor;
	/** Set only when the endpoint needs no credential; a real key goes to auth.json. */
	apiKey?: string;
	models: ProviderModel[];
}

/** Level heuristic over a relay catalog id: the catalogs expose only ids, so an explicit
 *  level suffix (`-high`, `-xhigh`, `-max`…) pins that level, and everything else starts at
 *  `auto` — the endpoint decides. A chat-only model is switched to `off` by hand in the
 *  Thinking screen; pi passes an unmapped level through, so an endpoint that rejects
 *  reasoning parameters only breaks when `/think` is above `off`. */
export function detectLevel(id: string): ThinkingSetting {
	const s = id.toLowerCase();
	if (/-x-?high$/.test(s)) return "xhigh";
	if (/-max(imum)?$/.test(s)) return "max";
	if (/-high$/.test(s)) return "high";
	if (/-med(ium)?$/.test(s)) return "medium";
	if (/-low$/.test(s)) return "low";
	if (/-min(imal)?$/.test(s)) return "minimal";
	return "auto";
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Pure merge: one provider added or replaced, every other key preserved. */
export function withProvider(config: unknown, name: string, entry: ProviderEntry): Record<string, unknown> {
	const root = isObj(config) ? { ...config } : {};
	const providers = isObj(root.providers) ? { ...root.providers } : {};
	// The same wire serialization every edit uses, so a first save and a later edit of the
	// same provider produce the same models.json shape.
	providers[name] = { ...entry, models: wireModels(name, entry, entry.models, []) };
	root.providers = providers;
	return root;
}

export function withoutProvider(config: unknown, name: string): Record<string, unknown> {
	const root = isObj(config) ? { ...config } : {};
	const providers = isObj(root.providers) ? { ...root.providers } : {};
	delete providers[name];
	root.providers = providers;
	return root;
}

export function providerNames(config: unknown): string[] {
	return isObj(config) && isObj(config.providers) ? Object.keys(config.providers) : [];
}

/** Pure patch of one provider's scalar fields (endpoint, id, display name, inline key).
 *  `undefined` drops the field; models, compat, headers and every sibling survive — the
 *  same contract as {@link withProviderModels}. */
export function withProviderFields(config: unknown, name: string, patch: Record<string, string | undefined>): Record<string, unknown> {
	const root = isObj(config) ? { ...config } : {};
	const providers = isObj(root.providers) ? { ...root.providers } : {};
	const next: Record<string, unknown> = { ...(isObj(providers[name]) ? providers[name] : {}), ...patch };
	for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
	providers[name] = next;
	root.providers = providers;
	return root;
}

/** Pure rename: the provider keeps its position in the list, and a `name` that only
 *  repeated the old id follows it (a hand-written display name stays as written). */
export function renameProvider(config: unknown, from: string, to: string): Record<string, unknown> {
	const root = isObj(config) ? { ...config } : {};
	const providers = isObj(root.providers) ? { ...root.providers } : {};
	if (!(from in providers)) return root;
	root.providers = Object.fromEntries(
		Object.entries(providers).map(([key, value]): [string, unknown] => {
			if (key !== from) return [key, value];
			const entry: Record<string, unknown> = isObj(value) ? { ...value } : {};
			if (entry.name === from) entry.name = to;
			return [to, entry];
		}),
	);
	return root;
}

/** The credential follows its provider in auth.json; a provider with no entry stays without one. */
export function renameAuth(auth: unknown, from: string, to: string): Record<string, unknown> {
	const root = isObj(auth) ? { ...auth } : {};
	if (!(from in root)) return root;
	return Object.fromEntries(Object.entries(root).map(([key, value]): [string, unknown] => [key === from ? to : key, value]));
}

export interface ProviderSummary {
	name: string;
	api?: string;
	modelCount: number;
}

export function summarizeProviders(config: unknown): ProviderSummary[] {
	if (!isObj(config) || !isObj(config.providers)) return [];
	return Object.entries(config.providers).map(([name, value]) => {
		const entry = isObj(value) ? value : {};
		const models = Array.isArray(entry.models) ? entry.models.length : 0;
		return { name, api: typeof entry.api === "string" ? entry.api : undefined, modelCount: models };
	});
}

/** Pure merge: the auth.json credential `/login` writes, keyed by provider id. */
export function withAuth(auth: unknown, name: string, key: string): Record<string, unknown> {
	const root = isObj(auth) ? { ...auth } : {};
	root[name] = { type: "api_key", key };
	return root;
}

export function withoutAuth(auth: unknown, name: string): Record<string, unknown> {
	const root = isObj(auth) ? { ...auth } : {};
	delete root[name];
	return root;
}

/** Rewrites one provider's model list and nothing else — compat, headers, name, every
 *  sibling field survives an edit exactly as it was stored. Levels serialize to pi's
 *  wire shape: `reasoning` for anything thinking, plus a `thinkingLevelMap` whose pinned
 *  level is a ceiling: every effort up to it maps to itself, every level above it is null,
 *  and `off` stays unmapped. pi reads null as unsupported, so the old map that nulled every
 *  level but one left the user stuck on that level, unable to lower it or turn thinking off. */
export function levelToWire(level: ThinkingSetting | undefined): { reasoning?: true; thinkingLevelMap?: Record<string, string | null> } {
	if (level === undefined || level === "off") return {};
	if (level === "auto") return { reasoning: true };
	const ceiling = THINKING_LEVELS.indexOf(level);
	const thinkingLevelMap: Record<string, string | null> = {};
	THINKING_LEVELS.forEach((l, i) => {
		if (l !== "off") thinkingLevelMap[l] = i <= ceiling ? l : null;
	});
	return { reasoning: true, thinkingLevelMap };
}

/** Reads pi's wire shape back into a level: the highest level mapped to itself is that level
 *  when every level above it is null (a ceiling, or the old single-pin shape). Any other map
 *  (heal's default, a probed remap) and `reasoning: true` alone are `auto`. */
export function wireToLevel(reasoning: unknown, map: unknown): ThinkingSetting {
	if (isObj(map)) {
		const levels = THINKING_LEVELS.filter((l) => l !== "off");
		const top = levels.findLastIndex((l) => map[l] === l);
		if (top !== -1 && levels.slice(top + 1).every((l) => map[l] === null)) {
			// A ceiling maps every level below it to itself; the old single pin nulls them all.
			// Anything else (an exact probed map with gaps) is a map, not a pin.
			const below = levels.slice(0, top);
			if (below.every((l) => map[l] === l) || below.every((l) => map[l] === null)) return levels[top]!;
		}
	}
	return reasoning === true ? "auto" : "off";
}

export function withProviderModels(config: unknown, name: string, models: ProviderModel[]): Record<string, unknown> {
	const root = isObj(config) ? { ...config } : {};
	const providers = isObj(root.providers) ? { ...root.providers } : {};
	const base = isObj(providers[name]) ? providers[name] : {};
	const stated: Record<string, unknown>[] = Array.isArray(base.models) ? base.models.filter(isObj) : [];
	providers[name] = { ...base, models: wireModels(name, base, models, stated) };
	root.providers = providers;
	return root;
}

/** One model in pi's wire shape: the level (or a probed map), the compat flags the rules
 *  imply, and the limits the probe found. Every other key of the stored entry survives —
 *  only `reasoning` and `thinkingLevelMap` are rewritten, because the level owns them. */
function wireModels(name: string, provider: { api?: unknown; baseUrl?: unknown }, models: ProviderModel[], stated: Record<string, unknown>[]): Record<string, unknown>[] {
	const api = typeof provider.api === "string" ? provider.api : undefined;
	const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
	return models.map((m) => {
		const prev = stated.find((s) => s.id === m.id);
		const next: Record<string, unknown> = { ...(prev ?? {}) };
		next.id = m.id;
		delete next.reasoning;
		delete next.thinkingLevelMap;
		Object.assign(next, m.map ? { reasoning: true, thinkingLevelMap: m.map } : levelToWire(m.level));
		const stored = isObj(next.compat) ? next.compat : {};
		const compat = { ...stored, ...suggestCompat({ provider: name, id: m.id, api, baseUrl, reasoning: next.reasoning === true, compat: stored }), ...(m.compat ?? {}) };
		if (Object.keys(compat).length > 0) next.compat = compat;
		const meta = m.meta ?? (prev && typeof prev === "object" ? { contextWindow: prev.contextWindow as number | undefined, maxTokens: prev.maxTokens as number | undefined } : undefined);
		if (meta?.contextWindow !== undefined) next.contextWindow = meta.contextWindow;
		if (meta?.maxTokens !== undefined) next.maxTokens = meta.maxTokens;
		return next;
	});
}

/** A stored selection keeps its level; a new id gets the detected one. A probed limit is
 *  merged into the stored one, and a probed effort map travels with the level, so a reselect
 *  never loses what an earlier probe learned (an `auto` level serializes without a map). */
const PUBLIC_CATALOG_URL = "https://openrouter.ai/api/v1/models";
const PUBLIC_CATALOG_TTL_MS = 60 * 60 * 1000;
let publicCatalogCache: { index: CatalogIndex; at: number } | undefined;

type RegistryLike = { getAll?: () => readonly { id?: unknown; contextWindow?: unknown; maxTokens?: unknown }[] };

async function fetchPublicCatalog(fetchImpl: FetchLike, timeoutMs = 5_000): Promise<CatalogIndex | undefined> {
	if (fetchImpl === fetch && publicCatalogCache && Date.now() - publicCatalogCache.at < PUBLIC_CATALOG_TTL_MS) {
		return publicCatalogCache.index;
	}
	try {
		const res = await fetchImpl(PUBLIC_CATALOG_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return undefined;
		const parsed = parseModelMeta(await res.json());
		const index = buildCatalogIndex(parsed);
		if (fetchImpl === fetch) publicCatalogCache = { index, at: Date.now() };
		return index;
	} catch {
		return undefined;
	}
}

/** Fill missing `contextWindow` (and `maxTokens`) for picked models from pi's local
 *  model registry first, then from OpenRouter's public catalog if any still lack one. */
export async function resolveMissingMeta(
	ids: readonly string[],
	baseMeta: Map<string, ModelMeta> | undefined,
	ctx: { modelRegistry?: RegistryLike } | undefined,
	fetchImpl: FetchLike = fetch,
): Promise<Map<string, ModelMeta>> {
	const out = new Map<string, ModelMeta>(baseMeta ?? []);
	let missing = ids.filter((id) => out.get(id)?.contextWindow === undefined);
	if (missing.length === 0) return out;

	// Tier 1: pi's built-in catalog and already-configured providers (instant, offline).
	try {
		const all = ctx?.modelRegistry?.getAll?.() ?? [];
		const entries: [string, ModelMeta][] = [];
		for (const m of all) {
			if (typeof m?.id !== "string" || typeof m.contextWindow !== "number" || m.contextWindow <= 0) continue;
			entries.push([m.id, { contextWindow: m.contextWindow, ...(typeof m.maxTokens === "number" && m.maxTokens > 0 ? { maxTokens: m.maxTokens } : {}) }]);
		}
		if (entries.length > 0) {
			const localIdx = buildCatalogIndex(entries);
			for (const id of missing) {
				const found = findMetaForId(id, localIdx);
				if (found) out.set(id, mergeMeta(out.get(id), found));
			}
		}
	} catch {
		// Stale or partial registry must never block saving a provider.
	}

	missing = ids.filter((id) => out.get(id)?.contextWindow === undefined);
	if (missing.length === 0) return out;

	// Tier 2: public model catalog for open/commercial models not yet in local registry.
	const publicIdx = await fetchPublicCatalog(fetchImpl);
	if (publicIdx) {
		for (const id of missing) {
			const found = findMetaForId(id, publicIdx);
			if (found) out.set(id, mergeMeta(out.get(id), found));
		}
	}
	return out;
}

export const seedMeta = (entry: ProviderEntry, extra?: Map<string, ModelMeta>): Map<string, ModelMeta> => {
	const out = new Map<string, ModelMeta>();
	for (const m of entry.models) if (m.meta) out.set(m.id, m.meta);
	if (extra) for (const [id, meta] of extra) out.set(id, mergeMeta(out.get(id), meta));
	return out;
};

export function mergeLevels(entry: ProviderEntry, ids: string[], meta?: Map<string, ModelMeta>): ProviderModel[] {
	return ids.map((id) => {
		const existing = entry.models.find((m) => m.id === id);
		const found = meta?.get(id);
		return { id, level: existing?.level ?? detectLevel(id), map: existing?.map, meta: found ? mergeMeta(existing?.meta, found) : existing?.meta };
	});
}

export const modelsPath = (): string => join(getAgentDir(), "models.json");
export const authPath = (): string => join(getAgentDir(), "auth.json");

/** pi's own models.json tolerance, replicated exactly: `//` comments and trailing
 *  commas are dropped outside string literals, so the wizard accepts every file pi's
 *  ModelConfig accepts — a hand-edited file never blocks the menu. */
export function looseJsonParse(content: string): unknown {
	const stripped = content
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail?: string) => tail ?? (m[0] === '"' ? m : ""));
	return JSON.parse(stripped) as unknown;
}

/** Missing file → undefined. Corrupt JSON is thrown, never overwritten: the caller aborts
 *  and reports, so a broken models.json cannot be clobbered by a save. Reads with pi's
 *  tolerance: BOM stripped, comments and trailing commas dropped before JSON.parse. */
export function readJson(path: string): unknown {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	if (content.trim() === "") return undefined;
	return looseJsonParse(content.replace(/^\uFEFF/, ""));
}

export function writeJson(path: string, value: unknown): void {
	writeJsonAtomicSync(path, value);
}

export function loadModelsConfig(): unknown {
	return readJson(modelsPath());
}

/** Replace models.json whole, atomically (Model Heal writes a config it read and edited). */
export function saveModelsConfig(value: unknown): void {
	writeJson(modelsPath(), value);
}

export function saveProvider(name: string, entry: ProviderEntry, key: string | undefined): void {
	writeJson(modelsPath(), withProvider(readJson(modelsPath()), name, entry));
	if (key) writeJson(authPath(), withAuth(readJson(authPath()), name, key));
}

/** Writes one provider's key: a real key lands in auth.json (the file /login writes, and the
 *  credential pi prefers over an inline models.json apiKey), `undefined` removes it. A
 *  literal inline key is dropped from models.json so the secret lives in one place; an
 *  env-var or shell reference is configuration, not a secret, and stays put. */
export function saveProviderKey(name: string, key: string | undefined): void {
	const auth = readJson(authPath());
	// Nothing stored and nothing to store: leave a missing auth.json missing.
	if (key || (isObj(auth) && name in auth)) writeJson(authPath(), key ? withAuth(auth, name, key) : withoutAuth(auth, name));
	const config = readJson(modelsPath());
	const entry = isObj(config) && isObj(config.providers) && isObj(config.providers[name]) ? (config.providers[name] as Record<string, unknown>) : undefined;
	if (!entry || typeof entry.apiKey !== "string" || /^[$!]/.test(entry.apiKey)) return;
	writeJson(modelsPath(), withProviderFields(config, name, { apiKey: undefined }));
}

/** `dummy`/`ollama` are placeholders a keyless entry carries so pi can list its models;
 *  `$VAR`, `${VAR}` and `!command` are references, not secrets. Neither is a stored key. */
const PLACEHOLDER_KEYS = new Set(["dummy", "ollama"]);
export function inlineKey(entry: ProviderEntry): string | undefined {
	const value = entry.apiKey;
	if (!value || PLACEHOLDER_KEYS.has(value) || /^[$!]/.test(value)) return undefined;
	return value;
}

/** One secret as it may be shown on screen: its last four characters, never the whole key. */
export function keyHint(key: string): string {
	return key.length > 8 ? `••••${key.slice(-4)}` : "••••";
}

export function deleteProviderNamed(name: string): boolean {
	const config = readJson(modelsPath());
	if (!providerNames(config).includes(name)) return false;
	writeJson(modelsPath(), withoutProvider(config, name));
	writeJson(authPath(), withoutAuth(readJson(authPath()), name));
	return true;
}

/** The stored credential for a provider, from the same auth.json /login writes. */
export function readAuthKey(name: string): string | undefined {
	const auth = readJson(authPath());
	if (!isObj(auth) || !isObj(auth[name])) return undefined;
	const entry = auth[name] as Record<string, unknown>;
	if (entry.type === "api_key" && typeof entry.key === "string") return entry.key;
	return undefined;
}

/** The stored entry with its models typed; extra fields stay in the raw config (edits go
 *  through {@link withProviderModels}, which never drops them). */
export function loadProviderEntry(config: unknown, name: string): ProviderEntry | undefined {
	if (!isObj(config) || !isObj(config.providers)) return undefined;
	const value = (config.providers as Record<string, unknown>)[name];
	if (!isObj(value)) return undefined;
	const models: ProviderModel[] = Array.isArray(value.models)
		? (value.models as unknown[]).flatMap((m): ProviderModel[] => {
				if (!isObj(m) || typeof m.id !== "string") return [];
				const level = wireToLevel(m.reasoning, m.thinkingLevelMap);
				const contextWindow = typeof m.contextWindow === "number" ? m.contextWindow : undefined;
				const maxTokens = typeof m.maxTokens === "number" ? m.maxTokens : undefined;
				const meta = contextWindow === undefined && maxTokens === undefined ? undefined : { contextWindow, maxTokens };
				// An `auto` model keeps its stored map, so a later save never wipes what a probe learned.
				const map = level === "auto" && isObj(m.thinkingLevelMap) ? (m.thinkingLevelMap as Record<string, string | null>) : undefined;
				return [{ id: m.id, ...(level === "off" ? {} : { level }), ...(map ? { map } : {}), ...(meta ? { meta } : {}), ...(isObj(m.compat) ? { compat: m.compat } : {}) }];
			})
		: [];
	return {
		name: typeof value.name === "string" ? value.name : name,
		baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
		api: (typeof value.api === "string" ? value.api : "openai-completions") as ApiFlavor,
		apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
		models,
	};
}

