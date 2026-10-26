/**
 * Providers menu (/arnative → Providers): a custom provider from three inputs — endpoint
 * URL, API key, name. The endpoint is probed once (Ollama, Gemini, OpenAI, Anthropic list
 * shapes), the models it answers with are picked over with Space (`[a]` switches the API
 * flavor when a relay answers in an ambiguous shape), and the result lands in pi's own
 * stores: the key in auth.json (the file /login writes), the declaration in models.json.
 * Opening /model reloads both files. Nothing is hand-edited by the user.
 */
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme, TUI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, isMain } from "../lib/check.ts";
import { buildEffortMap, isEffortProbeable, mergeMeta, parseModelMeta, probeEffort, suggestCompat, type Compat, type ModelMeta } from "./compat.ts";
import { screenTitle, type ScreenText } from "../lib/box.ts";
import { stripAnsi } from "../lib/ansi.ts";
import { statusRows } from "./status-widget.ts";
import { INPUT_LEGEND, InputPicker, LIST_LEGEND_MOVE, ListPicker, rowText, type ListRow } from "./list-picker.ts";

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
export const THINKING_SETTINGS: ThinkingSetting[] = ["off", "auto", ...THINKING_LEVELS.slice(1)];

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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

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
 *  wire shape: `reasoning` for anything thinking, plus a `thinkingLevelMap` that pins
 *  exactly one supported level for a detected variant. */
export function levelToWire(level: ThinkingSetting | undefined): { reasoning?: true; thinkingLevelMap?: Record<string, string | null> } {
	if (level === undefined || level === "off") return {};
	if (level === "auto") return { reasoning: true };
	const thinkingLevelMap: Record<string, string | null> = {};
	for (const l of THINKING_LEVELS) thinkingLevelMap[l] = l === level ? level : null;
	return { reasoning: true, thinkingLevelMap };
}

/** Reads pi's wire shape back into a level: a single non-off mapped level is that level;
 *  `reasoning: true` without a pin is `auto`. */
export function wireToLevel(reasoning: unknown, map: unknown): ThinkingSetting {
	if (map !== null && typeof map === "object") {
		const pinned = THINKING_LEVELS.filter((l) => l !== "off" && typeof (map as Record<string, unknown>)[l] === "string");
		if (pinned.length === 1) return pinned[0]!;
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
 *  merged into the stored one, so a reselect never loses what an earlier probe learned. */
export function mergeLevels(entry: ProviderEntry, ids: string[], meta?: Map<string, ModelMeta>): ProviderModel[] {
	return ids.map((id) => {
		const existing = entry.models.find((m) => m.id === id);
		const found = meta?.get(id);
		return { id, level: existing?.level ?? detectLevel(id), meta: found ? mergeMeta(existing?.meta, found) : existing?.meta };
	});
}

const modelsPath = (): string => join(getAgentDir(), "models.json");
const authPath = (): string => join(getAgentDir(), "auth.json");

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
function readJson(path: string): unknown {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	if (content.trim() === "") return undefined;
	return looseJsonParse(content.replace(/^\uFEFF/, ""));
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	// Temp + rename, the package's own standard (preset-store.ts, usage-store.ts): a crash
	// mid-write must never truncate models.json or auth.json — a corrupted auth.json breaks
	// the stored credentials of every provider, and the wizard refuses to save until it is
	// repaired by hand.
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
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
				return [{ id: m.id, ...(level === "off" ? {} : { level }), ...(meta ? { meta } : {}), ...(isObj(m.compat) ? { compat: m.compat } : {}) }];
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

// ---------------------------------------------------------------- wizard

const PROVIDERS_TEXT: ScreenText = {
	title: screenTitle("Providers"),
	description: "Custom endpoints: add with one probe, delete with a confirm.",
	legend: LIST_LEGEND_MOVE,
};

const ADD_ROW = "+ Add provider";

const MODEL_LEGEND = "[↑↓] Move  [Space] Toggle  [a] API  [Enter] Save  [Esc] Cancel";
const MODEL_LEGEND_LOCKED = "[↑↓] Move  [Space] Toggle  [Enter] Save  [Esc] Cancel";
/** Rows visible before the model list scrolls (a relay catalog can exceed the screen). */
const MODEL_VIEWPORT = 10;

/** One model-selection screen: Space checks rows, `a` cycles the API flavor (unless the
 *  stored api is final), Enter saves. Esc leaves without writing anything. */
const pickModels = async (
	ctx: ExtensionCommandContext,
	models: string[],
	opts: { flavor: ApiFlavor; via?: string; checked?: Set<string>; lockFlavor?: boolean },
): Promise<{ picked: string[]; flavor: ApiFlavor } | undefined> => {
	const checked = new Set(opts.checked ?? models);
	let flavor = opts.flavor;
	const rows: ListRow[] = models.map((id) => ({ label: id }));
	const picked = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
		const picker = new ListPicker(
			theme,
			rows,
			undefined,
			{
				preview: () => {},
				revert: () => {},
				done: () => done([...checked]),
				cancel: () => done(null),
				// A fill screen: `←` is hidden — it must not throw away a half-picked list.
				back: false,
				requestRender: () => tui.requestRender(),
				toggle: () => {
					const label = rows[picker.index]?.label;
					if (!label) return;
					if (checked.has(label)) checked.delete(label);
					else checked.add(label);
				},
				marked: (label) => checked.has(label),
				press: (keyData) => {
					if (opts.lockFlavor || !matchesKey(keyData, "a")) return;
					flavor = API_FLAVORS[(API_FLAVORS.indexOf(flavor) + 1) % API_FLAVORS.length]!;
				},
				description: () => `${FLAVOR_LABELS[flavor]}${opts.via ? ` · ${opts.via}` : ""}`,
				// The picked count lives in the legend, accented, next to the keys it refers to.
				legend: () =>
					`${theme.fg("accent", `${checked.size}/${models.length} picked`)}${theme.fg("dim", ` · ${opts.lockFlavor ? MODEL_LEGEND_LOCKED : MODEL_LEGEND}`)}`,
			},
			{ title: screenTitle("Models"), description: FLAVOR_LABELS[flavor], legend: opts.lockFlavor ? MODEL_LEGEND_LOCKED : MODEL_LEGEND },
			false,
			ctx.thinkingLevel,
			MODEL_VIEWPORT,
		);
		return picker;
	});
	if (!picked) return undefined;
	return { picked, flavor };
};

const readInput = async (
	ctx: ExtensionCommandContext,
	/** The arnative screen name — the box title becomes `<screen> - Arnative⠙`. */
	screen: string,
	/** What the field is, shown as the description under the title. */
	field: string,
	placeholder: string,
	initial = "",
): Promise<string | undefined> => {
	if (ctx.mode === "tui") {
		const value = await ctx.ui.custom<string | null>((tui, theme, _kb, done) =>
			new InputPicker(
				theme,
				{ title: screenTitle(screen), description: field, legend: INPUT_LEGEND },
				initial,
				{
					done: (v) => done(v),
					cancel: () => done(null),
					requestRender: () => tui.requestRender(),
				},
				placeholder,
				ctx.thinkingLevel,
			),
		);
		return value === null ? undefined : value.trim();
	}
	// No custom screens (RPC/headless): the native prompt.
	const value = await ctx.ui.input(`${screen} · ${field}`, initial || placeholder);
	return value === undefined ? undefined : value.trim();
};

/** Manual fallback when the probe found nothing: ids one at a time, a flavor question. */
const manualModels = async (ctx: ExtensionCommandContext): Promise<{ picked: string[]; flavor: ApiFlavor } | undefined> => {
	const picked: string[] = [];
	for (;;) {
		const id = await readInput(ctx, "Models", `Model id ${picked.length + 1} — empty to finish`, "paste an id");
		if (id === undefined) return undefined;
		if (id === "") break;
		picked.push(id);
	}
	if (picked.length === 0) return undefined;
	const label = await ctx.ui.select("API flavor", API_FLAVORS.map((f) => FLAVOR_LABELS[f]));
	if (label === undefined) return undefined;
	return { picked, flavor: API_FLAVORS[API_FLAVORS.map((f) => FLAVOR_LABELS[f]).indexOf(label)]! };
};

/** Transient probe status, pinned above the chat column (pi's aboveEditor widget
 *  slot) for exactly as long as the request is in flight — a one-line dim "probing
 *  endpoint…" right where the user is about to type, instead of a status row in the
 *  bottom footer. Removed the moment the probe settles. */
const PROBE_WIDGET_KEY = "arnative-probe";
function probingStatus(ctx: ExtensionCommandContext, text: string | undefined): void {
	if (!text) {
		ctx.ui.setWidget?.(PROBE_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget?.(
		PROBE_WIDGET_KEY,
		(_tui: TUI, theme: Theme) => ({
			dispose() { /* no listeners, no timers — nothing to clean up */ },
			invalidate() { /* a static line, recomputed on every render anyway */ },
			render(width: number): string[] {
				return statusRows(theme, [text], width);
			},
		}),
		{ placement: "aboveEditor" },
	);
}

const addProviderFlow = async (ctx: ExtensionCommandContext): Promise<void> => {
	const endpointRaw = await readInput(ctx, "Provider", "Endpoint API — the base URL", "https://api.example.com/v1");
	if (!endpointRaw) return;
	const endpoint = normalizeBase(endpointRaw);

	const key = await readInput(ctx, "Provider", "API key — empty for local or keyless endpoints", "sk-…");
	// Esc cancels the flow, Enter on an empty field means keyless: readInput keeps the two
	// apart (undefined vs ""), and the field's own legend promises [Esc] Cancel.
	if (key === undefined) return;

	const suggested = guessProviderName(endpoint);
	const nameInput = await readInput(ctx, "Provider", "a provider id (letters, digits, - and _)", suggested, suggested);
	if (nameInput === undefined) return; // Esc cancels; an empty Enter accepts the suggestion.
	const name = nameInput || suggested;
	if (!/^[A-Za-z0-9_-]+$/.test(name)) {
		ctx.ui.notify(`[arnative] "${name}" is not a usable provider id (letters, digits, - and _ only).`, "warning");
		return;
	}

	probingStatus(ctx, "probing endpoint…");
	let result: ProbeResult | undefined;
	try {
		result = await probeEndpoint(endpoint, key ?? "");
	} finally {
		probingStatus(ctx, undefined);
	}

	let picked: string[];
	let flavor: ApiFlavor;
	if (result) {
		ctx.ui.notify(`[arnative] ${FLAVOR_LABELS[result.flavor]} · ${result.via} · ${result.models.length} models.`, "info");
		if (ctx.mode === "tui") {
			const chosen = await pickModels(ctx, result.models, { flavor: result.flavor, via: result.via });
			if (!chosen) return;
			({ picked, flavor } = chosen);
		} else {
			// No custom screens (RPC/headless): the ids as one editable list, empty = all.
			const answer = await readInput(ctx, "Models", "ids comma/space separated — empty = all", "", result.models.join(", "));
			if (answer === undefined) return;
			picked = answer === "" ? result.models : answer.split(/[\s,]+/).filter(Boolean);
			flavor = result.flavor;
		}
	} else {
		ctx.ui.notify("[arnative] No model list answered. Enter ids by hand.", "warning");
		const manual = await manualModels(ctx);
		if (!manual) return;
		({ picked, flavor } = manual);
	}
	if (picked.length === 0) {
		ctx.ui.notify("[arnative] No models picked — nothing saved.", "warning");
		return;
	}

	const entry: ProviderEntry = {
		name,
		baseUrl: chatBaseUrl(flavor, endpoint),
		api: flavor,
		models: mergeLevels({ name, baseUrl: chatBaseUrl(flavor, endpoint), api: flavor, models: [] }, picked, result?.meta),
	};
	// A keyless endpoint still needs a resolvable credential for pi to list the models.
	if (!key) entry.apiKey = result?.keyless ? "ollama" : "dummy";
	try {
		saveProvider(name, entry, key || undefined);
	} catch (error) {
		ctx.ui.notify(`[arnative] Not saved: ${error instanceof Error ? error.message : "config file unreadable"}. Fix the JSON by hand first.`, "error");
		return;
	}
	ctx.ui.notify(`[arnative] Provider saved: ${name} (${FLAVOR_LABELS[flavor]}, ${picked.length} models, ${levelsSummary(entry.models)}). Open /model to pick one.`, "info");
};

const deleteProviderFlow = async (ctx: ExtensionCommandContext, name: string): Promise<void> => {
	if (!(await ctx.ui.confirm("Delete provider", `${name}? The stored key goes with it.`))) return;
	try {
		ctx.ui.notify(deleteProviderNamed(name) ? `[arnative] Deleted ${name}.` : `[arnative] ${name} was already gone.`, "info");
	} catch (error) {
		ctx.ui.notify(`[arnative] Not deleted: ${error instanceof Error ? error.message : "config file unreadable"}.`, "error");
	}
};

/** "3 thinking (auto, high, xhigh)" — the levels a save registered, for the notify. */
const levelsSummary = (models: ProviderModel[]): string => {
	const on = models.filter((m) => m.level && m.level !== "off");
	const distinct = [...new Set(on.map((m) => m.level!))];
	return on.length === 0 ? "0 thinking" : `${on.length} thinking (${distinct.join(", ")})`;
};

/** Writes one provider's model list through to models.json (auth.json is untouched — the
 *  key only changes through add or delete). */
const saveModelsNamed = (ctx: ExtensionCommandContext, name: string, models: ProviderModel[]): void => {
	try {
		writeJson(modelsPath(), withProviderModels(readJson(modelsPath()), name, models));
	} catch (error) {
		ctx.ui.notify(`[arnative] Not saved: ${error instanceof Error ? error.message : "config file unreadable"}.`, "error");
		return;
	}
	ctx.ui.notify(`[arnative] ${name}: ${models.length} models, ${levelsSummary(models)} — models.json updated. Open /model to refresh.`, "info");
};

const selectModelsFlow = async (ctx: ExtensionCommandContext, name: string, entry: ProviderEntry): Promise<void> => {
	const ids = entry.models.map((m) => m.id);
	let picked: string[] | undefined;
	if (ctx.mode === "tui") {
		const chosen = await pickModels(ctx, ids, { flavor: entry.api, checked: new Set(ids), lockFlavor: true });
		if (!chosen) return;
		picked = chosen.picked;
	} else {
		const answer = await readInput(ctx, "Models", "ids comma/space — empty = keep", "", ids.join(", "));
		if (answer === undefined || answer === "") return;
		picked = answer.split(/[\s,]+/).filter(Boolean);
	}
	saveModelsNamed(ctx, name, mergeLevels(entry, picked));
};

const probeModelsFlow = async (ctx: ExtensionCommandContext, name: string, entry: ProviderEntry): Promise<void> => {
	// The real key lives in auth.json; an inline dummy never authenticates a probe.
	const stored = readAuthKey(name);
	const inline = entry.apiKey && entry.apiKey !== "dummy" && entry.apiKey !== "ollama" ? entry.apiKey : "";
	const key = stored ?? inline;
	probingStatus(ctx, "probing endpoint…");
	let result: ProbeResult | undefined;
	try {
		result = await probeEndpoint(entry.baseUrl, key ?? "");
	} finally {
		probingStatus(ctx, undefined);
	}
	if (!result) {
		ctx.ui.notify("[arnative] The endpoint did not answer a model list (key or URL wrong?).", "warning");
		return;
	}
	ctx.ui.notify(`[arnative] ${FLAVOR_LABELS[result.flavor]} · ${result.via} · ${result.models.length} models.`, "info");
	// Vanished models stay listed (still checked) so a relay hiccup cannot shrink the set.
	const union = [...new Set([...result.models, ...entry.models.map((m) => m.id)])];
	let picked: string[] | undefined;
	if (ctx.mode === "tui") {
		const chosen = await pickModels(ctx, union, { flavor: entry.api, via: result.via, checked: new Set(entry.models.map((m) => m.id)), lockFlavor: true });
		if (!chosen) return;
		picked = chosen.picked;
	} else {
		const answer = await readInput(ctx, "Models", "ids comma/space — empty = keep", "", union.join(", "));
		if (answer === undefined || answer === "") return;
		picked = answer.split(/[\s,]+/).filter(Boolean);
	}
	saveModelsNamed(ctx, name, mergeLevels(entry, picked, result.meta));
};

const THINKING_LEGEND = "[↑↓] Move  [Space] Cycle  [A] All auto  [R] All off  [p] Probe  [Enter] Save  [Esc] Cancel";

/** Space cycles one model through off → auto → minimal → … → max. `auto` means
 *  `reasoning: true` with no map (every `/think` level passes through unchanged); an
 *  explicit level pins `thinkingLevelMap` to that single value. `p` asks the channel which
 *  effort names it really accepts and stores the answer as the model's map. */
const thinkingFlow = async (ctx: ExtensionCommandContext, name: string, entry: ProviderEntry): Promise<void> => {
	const levels = new Map(entry.models.map((m) => [m.id, m.level ?? detectLevel(m.id)] as const));
	const probed = new Map<string, Record<string, string | null>>();
	const cycle = (label: string): void => {
		const current = levels.get(label) ?? "off";
		const next = THINKING_SETTINGS[(THINKING_SETTINGS.indexOf(current) + 1) % THINKING_SETTINGS.length]!;
		levels.set(label, next);
		// A probed map belongs to `auto` only: a pinned level states its own answer.
		if (next !== "auto") probed.delete(label);
	};
	const rows: ListRow[] = entry.models.map((m) => ({ label: m.id }));
	/** "medium→high, max off" — what a probed map actually changed. */
	const summary = (map: Record<string, string | null>): string => {
		const parts = Object.entries(map)
			.filter(([level, value]) => value !== level && !(value === null && level === "off"))
			.map(([level, value]) => (value === null ? `${level} off` : `${level}→${value}`));
		return parts.length === 0 ? "all levels accepted" : parts.join(", ");
	};
	let busy: string | undefined;
	let progress: string | undefined;
	let warn: string | undefined;
	let refresh: () => void = () => {};
	let closed = false;
	const probe = async (label: string): Promise<void> => {
		const model = entry.models.find((m) => m.id === label);
		const compat = model?.compat ?? {};
		if (!isEffortProbeable({ provider: name, id: label, api: entry.api, baseUrl: entry.baseUrl, reasoning: true, compat }, compat)) {
			warn = `${label}: this channel does not take a probing request (not an OpenAI-compatible reasoning model).`;
			return;
		}
		busy = label;
		progress = "starting…";
		refresh();
		const inline = entry.apiKey && entry.apiKey !== "dummy" && entry.apiKey !== "ollama" ? entry.apiKey : undefined;
		try {
			const supported = await probeEffort(
				{ provider: name, id: label, api: entry.api, baseUrl: entry.baseUrl, reasoning: true, compat },
				{
					baseUrl: entry.baseUrl,
					key: readAuthKey(name) ?? inline,
					onLevel: (level, _accepted, index) => {
						progress = `${level} · ${index + 1}/7`;
						refresh();
					},
				},
			);
			if (supported.length === 0) {
				warn = `${label}: no effort level answered — the map is unchanged.`;
				return;
			}
			const current = probed.get(label) ?? levelToWire(levels.get(label))?.thinkingLevelMap;
			const next = buildEffortMap(current, supported);
			if (next) probed.set(label, next);
			levels.set(label, "auto");
			warn = `${label}: ${next ? summary(next) : "every level is accepted as-is"}.`;
		} finally {
			busy = undefined;
			progress = undefined;
			refresh();
		}
	};
	let saved: boolean;
	if (ctx.mode === "tui") {
		const outcome = await ctx.ui.custom<boolean | null>((tui, theme, _kb, done) => {
			refresh = () => {
				if (!closed) tui.requestRender();
			};
			const close = (value: boolean | null) => {
				closed = true;
				done(value);
			};
			const picker = new ListPicker(
				theme,
				rows,
				undefined,
				{
					preview: () => {},
					revert: () => {},
					// A probe is a round trip, but it never owns the screen: leaving mid-probe just
					// discards the answer, because the save reads `probed` before it lands.
					done: () => close(true),
					cancel: () => close(null),
					// A fill screen: `←` is hidden — it must not throw away half-set levels.
					back: false,
					requestRender: () => refresh(),
					toggle: () => {
						const label = rows[picker.index]?.label;
						if (label && !busy) cycle(label);
					},
					press: (keyData) => {
						if (busy) return;
						// Plain letters only: Ctrl/Alt/F-keys are swallowed or remapped by some
						// terminals, so the two bulk keys stay on the same key everywhere. Shift keeps
						// them deliberate — pi-tui lowercases a key id, so "A" would mean plain `a`.
						if (matchesKey(keyData, "shift+a")) {
							for (const id of levels.keys()) levels.set(id, "auto");
							probed.clear();
							refresh();
							return;
						}
						if (matchesKey(keyData, "shift+r")) {
							for (const id of levels.keys()) levels.set(id, "off");
							probed.clear();
							refresh();
							return;
						}
						const label = rows[picker.index]?.label;
						if (!label || !matchesKey(keyData, "p")) return;
						void probe(label);
					},
					note: (label) => {
						if (busy === label) return `probing ${progress ?? ""}`.trim();
						const map = probed.get(label);
						return `${levels.get(label) ?? "off"}${map ? ` · ${summary(map)}` : ""}`;
					},
					description: () => `cycle: ${THINKING_SETTINGS.join(" → ")}`,
					legend: () =>
						`${theme.fg("accent", `${[...levels.values()].filter((l) => l !== "off").length}/${rows.length} thinking`)}${theme.fg("dim", ` · ${THINKING_LEGEND}`)}`,
				},
				{ title: screenTitle("Thinking"), description: "level per model — auto-detected from the id", legend: THINKING_LEGEND },
				false,
				ctx.thinkingLevel,
				MODEL_VIEWPORT,
			);
			return picker;
		});
		saved = outcome === true;
	} else {
		// No custom screens (RPC/headless): `id:level` pairs, e.g. `o1-mini:low`.
		const answer = await readInput(ctx, "Thinking", "levels as id:level pairs — empty = cancel", "", [...levels].map(([id, l]) => `${id}:${l}`).join(", "));
		if (answer === undefined || answer === "") return;
		for (const pair of answer.split(/[\s,]+/).filter(Boolean)) {
			const [id, level] = pair.split(":");
			if (id && level && THINKING_SETTINGS.includes(level as ThinkingSetting)) levels.set(id, level as ThinkingSetting);
		}
		saved = true;
	}
	if (!saved) return;
	saveModelsNamed(
		ctx,
		name,
		entry.models.map((m) => {
			const level = levels.get(m.id);
			const map = level === "off" ? undefined : probed.get(m.id);
			return { id: m.id, level, ...(map ? { map } : {}) };
		}),
	);
	if (warn) ctx.ui.notify(`[arnative] ${warn}`, "info");
};

const ACTION_SELECT = "Select models";
const ACTION_PROBE = "Probe models";
const ACTION_THINKING = "Thinking";
const ACTION_DELETE = "Delete";

const ACTIONS_TEXT: ScreenText = {
	title: screenTitle("Provider"),
	description: "Edit the models, re-probe, toggle thinking, or delete.",
	legend: LIST_LEGEND_MOVE,
};

/** Enter on an existing provider: an action menu instead of a straight delete. Every
 *  action writes through to models.json (and auth.json for delete) before returning. */
const providerActionFlow = async (ctx: ExtensionCommandContext, name: string): Promise<void> => {
	for (;;) {
		const entry = loadProviderEntry(loadModelsConfig(), name);
		if (!entry) {
			ctx.ui.notify(`[arnative] ${name} is gone — the list will refresh.`, "warning");
			return;
		}
		const rows: ListRow[] = [
			{ label: ACTION_SELECT, note: "tick the models this provider exposes" },
			{ label: ACTION_PROBE, note: "re-read the model list from the endpoint" },
			{ label: ACTION_THINKING, note: "toggle reasoning per model (auto-detected)" },
			{ label: ACTION_DELETE, note: "remove the provider and its stored key" },
		];
		let action: string | null | undefined;
		if (ctx.mode === "tui") {
			action = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const picker = new ListPicker(
					theme,
					rows,
					undefined,
					{
						preview: () => {},
						revert: () => {},
						done: () => done(rows[picker.index]?.label),
						cancel: () => done(null),
						// `←` leaves the actions for the provider list; Esc closes the whole menu.
						back: () => done(null),
						requestRender: () => tui.requestRender(),
					},
					{ ...ACTIONS_TEXT, title: screenTitle(`Provider · ${name}`) },
					false,
					ctx.thinkingLevel,
				);
				return picker;
			});
		} else {
			const picked = await ctx.ui.select(`${name} — edit or delete`, rows.map(rowText));
			action = picked === undefined ? undefined : rows.find((r) => picked.startsWith(r.label))?.label;
		}
		if (!action) return;
		if (action === ACTION_DELETE) {
			await deleteProviderFlow(ctx, name);
			return;
		}
		if (action === ACTION_SELECT) await selectModelsFlow(ctx, name, entry);
		else if (action === ACTION_PROBE) await probeModelsFlow(ctx, name, entry);
		else if (action === ACTION_THINKING) await thinkingFlow(ctx, name, entry);
	}
};

/** The Providers screen: existing entries as rows, add as the last row. `←` reopens the
 *  settings menu, like every screen; after an add or a delete the list reopens. */
export const openProviders = async (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	/** Provider rows re-read from models.json; empty means the file turned unreadable. */
	const refresh = (): ListRow[] => {
		let summaries: ProviderSummary[];
		try {
			summaries = summarizeProviders(loadModelsConfig());
		} catch {
			ctx.ui.notify("[arnative] models.json is not valid JSON — fix it by hand first.", "error");
			return [];
		}
		const rows: ListRow[] = summaries.map((s) => ({
			label: s.name,
			note: `${s.api ?? "unknown api"} · ${s.modelCount} model${s.modelCount === 1 ? "" : "s"}`,
		}));
		rows.push({ label: ADD_ROW, note: "endpoint, key, name — the rest is automatic" });
		return rows;
	};

	const rows = refresh();
	if (rows.length === 0) return;

	const choose = async (label: string | undefined): Promise<void> => {
		if (label === ADD_ROW) await addProviderFlow(ctx);
		else if (label) await providerActionFlow(ctx, label);
	};

	if (ctx.mode !== "tui") {
		// No custom screens (RPC/headless): the blocking picker, `rowText` as the flat label.
		const picked = await ctx.ui.select(PROVIDERS_TEXT.title, rows.map(rowText));
		if (picked === undefined) return;
		// Provider ids are [A-Za-z0-9_-], so a `startsWith` on the flat row is unambiguous.
		const label = rows.find((r) => picked.startsWith(r.label))?.label;
		await choose(label);
		return;
	}

	for (;;) {
		const index = await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
			const picker = new ListPicker(theme, rows, undefined, {
				preview: () => {},
				revert: () => {},
				done: () => done(picker.index),
				cancel: () => done(null),
				// `←` steps back to the settings menu; Esc closes for good.
				back: () => done(-1),
				requestRender: () => tui.requestRender(),
			}, PROVIDERS_TEXT, false, ctx.thinkingLevel);
			return picker;
		});
		if (index === null || index === undefined) return;
		if (index === -1) return true;
		await choose(rows[index]?.label);
		// A provider may have been added, edited or deleted: re-read the list instead of
		// showing the copy the screen opened with. An unreadable models.json keeps the old
		// rows up rather than blanking the screen.
		const fresh = refresh();
		if (fresh.length > 0) {
			rows.length = 0;
			rows.push(...fresh);
		}
	}
};

// Self-check: `node lib/provider.ts`
if (isMain(import.meta.url)) {
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
	assert(THINKING_LEVELS.filter((l) => wireHigh.thinkingLevelMap![l] === null).length === 6, "every other level is null");
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
	const entryLoaded = loadProviderEntry(rich, "r");
	assert(entryLoaded?.models[0]!.id === "m1" && entryLoaded.api === "openai-completions", "loadProviderEntry reads models and api");
	assert(loadProviderEntry(rich, "missing") === undefined, "loadProviderEntry misses cleanly");
	const roundTrip = loadProviderEntry(withProviderModels(rich, "r", [{ id: "m9", level: "xhigh" }]), "r");
	assert(roundTrip?.models[0]!.level === "xhigh", "a saved level loads back as itself");
	assert(levelsSummary([{ id: "a" }, { id: "b", level: "high" }, { id: "c", level: "auto" }]) === "2 thinking (high, auto)", "the save notify names the registered levels");
	assert(levelsSummary([{ id: "a" }]) === "0 thinking", "an all-chat save says so plainly");
	// The Thinking screen's bulk keys are Shift+letter: pi-tui lowercases a key id, so this
	// pins that they stay distinct from the plain letters navigation already uses.
	assert(matchesKey("A", "shift+a") && !matchesKey("a", "shift+a"), "Shift+A is its own key, not plain a");
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
	assert(readdirSync(tmp).every((f) => !f.endsWith(".tmp")), "a completed save leaves no temp files behind");
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(tmp, { recursive: true, force: true });

	// The providers screen copy stays factual and pinned.
	assert(PROVIDERS_TEXT.title === "Providers - Arnative\u2819", `providers title pinned, got ${PROVIDERS_TEXT.title}`);
	assert(ADD_ROW === "+ Add provider", "the add row label is pinned");
	assert(visibleWidth(PROVIDERS_TEXT.legend) > 0, "the screen carries a legend");

	console.log("provider.ts self-check OK");
}
