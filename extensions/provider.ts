/**
 * Providers menu (/arnative → Providers): a custom provider from three inputs — endpoint
 * URL, API key, name. The endpoint is probed once (Ollama, Gemini, OpenAI, Anthropic list
 * shapes), the models it answers with are picked over with Space (`[a]` switches the API
 * flavor when a relay answers in an ambiguous shape), and the result lands in pi's own
 * stores: the key in auth.json (the file /login writes), the declaration in models.json.
 * Opening /model reloads both files. Nothing is hand-edited by the user.
 */
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, isMain } from "../lib/check.ts";
import { screenTitle, type ScreenText } from "../lib/box.ts";
import { stripAnsi } from "../lib/ansi.ts";
import { LIST_LEGEND_MOVE, ListPicker, rowText, type ListRow } from "./list-picker.ts";

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
			const models = parseModelList(candidate, await response.json());
			if (!models || models.length === 0) throw new Error("no models");
			return { candidate, models };
		}),
	);
	for (let i = 0; i < candidates.length; i++) {
		const result = settled[i];
		if (result?.status !== "fulfilled") continue;
		const { candidate, models } = result.value;
		return {
			flavor: candidate.flavor,
			baseUrl: chatBaseUrl(candidate.flavor, base),
			models: [...new Set(models)],
			via: new URL(candidate.url).pathname,
			keyless: candidate.keyless,
		};
	}
	return undefined;
}

// ---------------------------------------------------------------- stores

export interface ProviderEntry {
	name?: string;
	baseUrl: string;
	api: ApiFlavor;
	/** Set only when the endpoint needs no credential; a real key goes to auth.json. */
	apiKey?: string;
	models: { id: string }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Pure merge: one provider added or replaced, every other key preserved. */
export function withProvider(config: unknown, name: string, entry: ProviderEntry): Record<string, unknown> {
	const root = isObj(config) ? { ...config } : {};
	const providers = isObj(root.providers) ? { ...root.providers } : {};
	providers[name] = entry;
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

const modelsPath = (): string => join(getAgentDir(), "models.json");
const authPath = (): string => join(getAgentDir(), "auth.json");

/** Missing file → undefined. Corrupt JSON is thrown, never overwritten: the caller aborts
 *  and reports, so a broken models.json cannot be clobbered by a save. */
function readJson(path: string): unknown {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	return JSON.parse(content) as unknown;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function loadModelsConfig(): unknown {
	return readJson(modelsPath());
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

// ---------------------------------------------------------------- wizard

const PROVIDERS_TEXT: ScreenText = {
	title: screenTitle("Providers"),
	description: "Custom endpoints: add with one probe, delete with a confirm.",
	legend: LIST_LEGEND_MOVE,
};

const ADD_ROW = "+ Add provider";

const MODEL_LEGEND = "[↑↓] Move  [Space] Toggle  [a] API  [Enter] Save  [Esc] Cancel";

/** One model-selection screen: Space checks rows, `a` cycles the API flavor, Enter saves.
 *  Esc leaves without writing anything. */
const pickModels = async (
	ctx: ExtensionCommandContext,
	models: string[],
	probe: ProbeResult | undefined,
): Promise<{ picked: string[]; flavor: ApiFlavor } | undefined> => {
	const checked = new Set(models);
	let flavor: ApiFlavor = probe?.flavor ?? "openai-completions";
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
				requestRender: () => tui.requestRender(),
				toggle: () => {
					const label = rows[picker.index]?.label;
					if (!label) return;
					if (checked.has(label)) checked.delete(label);
					else checked.add(label);
				},
				marked: (label) => checked.has(label),
				press: (keyData) => {
					if (!matchesKey(keyData, "a")) return;
					flavor = API_FLAVORS[(API_FLAVORS.indexOf(flavor) + 1) % API_FLAVORS.length]!;
				},
				description: () =>
					probe
						? `${FLAVOR_LABELS[flavor]} · ${probe.via} · ${checked.size}/${models.length} picked`
						: `${FLAVOR_LABELS[flavor]} · ${checked.size}/${models.length} picked`,
			},
			{ title: screenTitle("Models"), description: FLAVOR_LABELS[flavor], legend: MODEL_LEGEND },
			false,
			ctx.thinkingLevel,
		);
		return picker;
	});
	if (!picked) return undefined;
	return { picked, flavor };
};

const readInput = async (ctx: ExtensionCommandContext, title: string, placeholder: string): Promise<string | undefined> => {
	const value = await ctx.ui.input(title, placeholder);
	return value === undefined ? undefined : value.trim();
};

/** Manual fallback when the probe found nothing: ids one at a time, a flavor question. */
const manualModels = async (ctx: ExtensionCommandContext): Promise<{ picked: string[]; flavor: ApiFlavor } | undefined> => {
	const picked: string[] = [];
	for (;;) {
		const id = await readInput(ctx, `Model id ${picked.length + 1}`, "paste an id — empty to finish");
		if (id === undefined) return undefined;
		if (id === "") break;
		picked.push(id);
	}
	if (picked.length === 0) return undefined;
	const label = await ctx.ui.select("API flavor", API_FLAVORS.map((f) => FLAVOR_LABELS[f]));
	if (label === undefined) return undefined;
	return { picked, flavor: API_FLAVORS[API_FLAVORS.map((f) => FLAVOR_LABELS[f]).indexOf(label)]! };
};

const addProviderFlow = async (ctx: ExtensionCommandContext): Promise<void> => {
	const endpointRaw = await readInput(ctx, "Provider · Endpoint API", "https://api.example.com/v1");
	if (!endpointRaw) return;
	const endpoint = normalizeBase(endpointRaw);

	const key = await readInput(ctx, "Provider · API Key", "empty for local or keyless endpoints");

	const suggested = guessProviderName(endpoint);
	const name = await readInput(ctx, "Provider · Name", suggested) || suggested;
	if (!/^[A-Za-z0-9_-]+$/.test(name)) {
		ctx.ui.notify(`[arnative] "${name}" is not a usable provider id (letters, digits, - and _ only).`, "warning");
		return;
	}

	ctx.ui.setStatus("arnative", "probing endpoint…");
	let result: ProbeResult | undefined;
	try {
		result = await probeEndpoint(endpoint, key ?? "");
	} finally {
		ctx.ui.setStatus("arnative", undefined);
	}

	let picked: string[];
	let flavor: ApiFlavor;
	if (result) {
		ctx.ui.notify(`[arnative] ${FLAVOR_LABELS[result.flavor]} · ${result.via} · ${result.models.length} models.`, "info");
		if (ctx.mode === "tui") {
			const chosen = await pickModels(ctx, result.models, result);
			if (!chosen) return;
			({ picked, flavor } = chosen);
		} else {
			// No custom screens (RPC/headless): the ids as one editable list, empty = all.
			const answer = await readInput(ctx, "Model ids (comma/space separated; empty = all)", result.models.join(", "));
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
		models: picked.map((id) => ({ id })),
	};
	// A keyless endpoint still needs a resolvable credential for pi to list the models.
	if (!key) entry.apiKey = result?.keyless ? "ollama" : "dummy";
	try {
		saveProvider(name, entry, key || undefined);
	} catch (error) {
		ctx.ui.notify(`[arnative] Not saved: ${error instanceof Error ? error.message : "config file unreadable"}. Fix the JSON by hand first.`, "error");
		return;
	}
	ctx.ui.notify(`[arnative] Provider saved: ${name} (${FLAVOR_LABELS[flavor]}, ${picked.length} models). Open /model to pick one.`, "info");
};

const deleteProviderFlow = async (ctx: ExtensionCommandContext, name: string): Promise<void> => {
	if (!(await ctx.ui.confirm("Delete provider", `${name}? The stored key goes with it.`))) return;
	try {
		ctx.ui.notify(deleteProviderNamed(name) ? `[arnative] Deleted ${name}.` : `[arnative] ${name} was already gone.`, "info");
	} catch (error) {
		ctx.ui.notify(`[arnative] Not deleted: ${error instanceof Error ? error.message : "config file unreadable"}.`, "error");
	}
};

/** The Providers screen: existing entries as rows, add as the last row. `←` reopens the
 *  settings menu, like every screen; after an add or a delete the list reopens. */
export const openProviders = async (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	let summaries: ProviderSummary[];
	try {
		summaries = summarizeProviders(loadModelsConfig());
	} catch {
		ctx.ui.notify("[arnative] models.json is not valid JSON — fix it by hand first.", "error");
		return;
	}
	const rows: ListRow[] = summaries.map((s) => ({
		label: s.name,
		note: `${s.api ?? "unknown api"} · ${s.modelCount} model${s.modelCount === 1 ? "" : "s"}`,
	}));
	rows.push({ label: ADD_ROW, note: "endpoint, key, name — the rest is automatic" });

	const choose = async (index: number): Promise<void> => {
		const label = rows[index]?.label;
		if (label === ADD_ROW) await addProviderFlow(ctx);
		else if (label) await deleteProviderFlow(ctx, label);
	};

	if (ctx.mode !== "tui") {
		// No custom screens (RPC/headless): the blocking picker, `rowText` as the flat label.
		const picked = await ctx.ui.select(PROVIDERS_TEXT.title, rows.map(rowText));
		if (picked === undefined) return;
		// Provider ids are [A-Za-z0-9_-], so a `startsWith` on the flat row is unambiguous.
		const index = rows.findIndex((r) => picked.startsWith(r.label));
		if (index >= 0) await choose(index);
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
		await choose(index);
	}
};

// Self-check: `node extensions/provider.ts`
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
	const openaiShape = { data: [{ id: "m1" }, { id: "m2" }] };
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

	// The providers screen copy stays factual and pinned.
	assert(PROVIDERS_TEXT.title === "Providers - Arnative\u2819", `providers title pinned, got ${PROVIDERS_TEXT.title}`);
	assert(ADD_ROW === "+ Add provider", "the add row label is pinned");
	assert(visibleWidth(PROVIDERS_TEXT.legend) > 0, "the screen carries a legend");

	console.log("provider.ts self-check OK");
}
