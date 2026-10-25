/**
 * Compat flags for a provider the wizard writes — ported from pi-auto-compat, minus its
 * background machinery. Nothing here watches models.json or repairs it later: the flags
 * are computed once, from the model list the wizard already fetched, and written by
 * `withProviderModels` in provider.ts (one writer, one moment).
 *
 * Two things ride along with the same probe: the real `contextWindow`/`maxTokens`, and
 * (on demand) which `reasoning_effort` names the channel accepts.
 */
import { assert, isMain } from "./check.ts";

export type Compat = Record<string, unknown>;

/** The fields a compat decision depends on — a merged registry model, or the pieces the
 *  wizard holds while it writes a provider. */
export interface CompatModel {
	provider: string;
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	compat?: Compat;
}

const lower = (v: unknown): string => String(v ?? "").toLowerCase();
const tokensOf = (m: CompatModel): string[] => [m.id, m.name].map(lower).filter(Boolean);

const isOpenAICompatible = (api: unknown): boolean => {
	const v = lower(api);
	return v === "openai-completions" || v === "openai-responses";
};

// Claude Opus/Sonnet >= 4.6, Fable >= 5 — the generations that need adaptive thinking.
const ADAPTIVE_RE =
	/(?:^|[/\s:_-])(?:opus-4[.-][6-9]|opus-4-[1-9][0-9]|opus-(?:[5-9]|[1-9][0-9])|sonnet-4[.-][6-9]|sonnet-4-[1-9][0-9]|sonnet-(?:[5-9]|[1-9][0-9])|fable-(?:[5-9]|[1-9][0-9]))(?:$|[-_.:/\s[])/i;

const isKimiCoding = (m: CompatModel): boolean => lower(m.provider).includes("kimi-coding") || lower(m.baseUrl).includes("api.kimi.com/coding");
const isKimiK3 = (m: CompatModel): boolean =>
	isKimiCoding(m) &&
	tokensOf(m).some((t) => t === "k3" || t.includes("kimi-k3") || t.includes("kimi k3") || t.includes("kimi-for-coding") || t.includes("kimi for coding"));

/** pi's built-in llama.cpp provider declares this exact compat set; every rule skips it. */
function isPiLlamaCpp(m: CompatModel): boolean {
	if (lower(m.provider) !== "llama.cpp" || lower(m.api) !== "openai-completions") return false;
	const c = m.compat ?? {};
	return (
		c.supportsStore === false &&
		c.supportsDeveloperRole === false &&
		c.supportsReasoningEffort === false &&
		c.supportsUsageInStreaming === false &&
		c.supportsStrictMode === false &&
		c.maxTokensField === "max_tokens" &&
		c.sendSessionAffinityHeaders === undefined &&
		c.sessionAffinityFormat === undefined &&
		c.supportsLongCacheRetention === undefined
	);
}

function isOfficialOpenAI(m: CompatModel): boolean {
	const value = String(m.baseUrl ?? "").trim().toLowerCase();
	if (!value) return lower(m.provider) === "openai";
	try {
		return new URL(value).hostname === "api.openai.com";
	} catch {
		return value === "api.openai.com" || value.startsWith("api.openai.com/");
	}
}

const isOpenRouter = (m: CompatModel): boolean => lower(m.provider) === "openrouter" || lower(m.baseUrl).includes("openrouter.ai");

/** Flags a model needs, in pi's own priority order. Only keys the stored entry leaves
 *  undefined are returned, so an explicit user value — even `false` — always wins. */
export function suggestCompat(m: CompatModel): Compat {
	const api = lower(m.api);
	const compat = m.compat ?? {};
	const tokens = tokensOf(m);
	const out: Compat = {};

	// pi defaults long retention to true when undeclared, and some relays 400 on the
	// parameter (Fireworks caches automatically) — declare it either way.
	if (compat.supportsLongCacheRetention === undefined) out.supportsLongCacheRetention = api === "anthropic-messages" || isOfficialOpenAI(m);

	// Third-party routers reject role "developer" with `messages.0.role: Invalid option`;
	// every OpenAI-compatible channel accepts "system". First-party APIs keep the role.
	if (m.reasoning === true && isOpenAICompatible(api) && compat.supportsDeveloperRole === undefined && !isOfficialOpenAI(m) && !isOpenRouter(m)) {
		out.supportsDeveloperRole = false;
	}

	if (api === "anthropic-messages" && (tokens.some((t) => ADAPTIVE_RE.test(t)) || isKimiK3(m))) {
		if (compat.forceAdaptiveThinking !== true) out.forceAdaptiveThinking = true;
		if (isKimiK3(m) && compat.allowEmptySignature !== true) out.allowEmptySignature = true;
		return out;
	}

	if (tokens.some((t) => t.includes("deepseek")) && isOpenAICompatible(api) && !isPiLlamaCpp(m)) {
		if (api === "openai-completions" && compat.sendSessionAffinityHeaders === undefined) out.sendSessionAffinityHeaders = true;
		if (compat.requiresReasoningContentOnAssistantMessages !== true) out.requiresReasoningContentOnAssistantMessages = true;
		if (compat.thinkingFormat !== "deepseek") out.thinkingFormat = "deepseek";
		return out;
	}

	if (tokens.some((t) => t.includes("anthropic") || t.includes("claude")) && isOpenAICompatible(api) && !isPiLlamaCpp(m) && compat.cacheControlFormat !== "anthropic") {
		out.cacheControlFormat = "anthropic";
	}

	if (api === "openai-completions" && !isOfficialOpenAI(m) && !isPiLlamaCpp(m) && compat.sendSessionAffinityHeaders === undefined) out.sendSessionAffinityHeaders = true;

	return out;
}

// ------------------------------------------------------------ metadata

export interface ModelMeta {
	contextWindow?: number;
	maxTokens?: number;
}

// Widest window first: max_model_len / max_input_tokens are upstream limits, not the
// served window, and some channels only publish the input side.
const CONTEXT_KEYS = ["context_length", "context_window", "max_context_length", "max_model_len", "max_context_window", "max_input_tokens", "max_input_length", "context_size"];
const OUTPUT_KEYS = ["max_output_tokens", "max_completion_tokens", "max_output_length", "max_tokens"];

const positiveInt = (value: unknown): number | undefined => {
	const n = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

/** Numeric limits from one catalog entry. */
export function parseMeta(entry: unknown): ModelMeta {
	const rec = (entry ?? {}) as Record<string, unknown>;
	const out: ModelMeta = {};
	for (const key of CONTEXT_KEYS) {
		const value = positiveInt(rec[key]);
		if (value !== undefined) {
			out.contextWindow = value;
			break;
		}
	}
	for (const key of OUTPUT_KEYS) {
		const value = positiveInt(rec[key]);
		if (value === undefined) continue;
		// A "max_tokens" equal to the whole window is the context length, not a cap.
		if (out.contextWindow !== undefined && value >= out.contextWindow) continue;
		out.maxTokens = value;
		break;
	}
	return out;
}

/** Every model's limits from one `/models` body — the same response the id list comes
 *  from, so the metadata costs no extra request. */
export function parseModelMeta(body: unknown): Map<string, ModelMeta> {
	const out = new Map<string, ModelMeta>();
	if (typeof body !== "object" || body === null) return out;
	const record = body as Record<string, unknown>;
	const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
	for (const item of list) {
		if (typeof item !== "object" || item === null) continue;
		const rec = item as Record<string, unknown>;
		const raw = typeof rec.id === "string" ? rec.id : typeof rec.name === "string" ? rec.name.replace(/^models\//, "") : undefined;
		if (!raw) continue;
		const meta = parseMeta(rec);
		if (meta.contextWindow !== undefined || meta.maxTokens !== undefined) out.set(raw, meta);
	}
	return out;
}

/** Keep a real API correction, reject unit anomalies: an order of magnitude below the
 *  stored window is a per-request number, not the served window. */
export function contextWindowAccepted(candidate: number, existing: number | undefined): boolean {
	if (existing === undefined || candidate === existing) return true;
	return candidate > existing || candidate * 5 >= existing;
}

/** Merge a freshly probed limit into a stored one; undefined means "keep what is there". */
export function mergeMeta(prev: ModelMeta | undefined, next: ModelMeta): ModelMeta {
	const out: ModelMeta = { ...prev };
	const ctx = next.contextWindow;
	if (ctx !== undefined && contextWindowAccepted(ctx, prev?.contextWindow)) out.contextWindow = ctx;
	const effective = ctx ?? prev?.contextWindow;
	if (next.maxTokens !== undefined && (prev?.maxTokens === undefined || next.maxTokens > prev.maxTokens)) {
		out.maxTokens = effective !== undefined && next.maxTokens > effective ? effective : next.maxTokens;
	}
	return out;
}

// ------------------------------------------------------- thinking effort

// pi's levels in clamp order; `off` has no wire name of its own.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const PROBED = new Set(EFFORT_RANK);
const IDENTITY: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh" };
const LEVEL_TIMEOUT_MS = 30_000;
const PROBE_TOKENS = 16;
const RETRY_PAUSE_MS = 1000;
// Only a parameter rejection indicts the level. Auth, quota and transport errors say
// nothing, and marking a level accepted without an answer would be a lie.
const REJECTION_RE = /provider.?error|invalid.?request|http 400|400[.:]|reasoning.?effort|thinking|unsupported|not supported|invalid (?:value|option|parameter|enum)|bad request/i;

/** A reasoning model on a relay that expects `reasoning_effort` and does not publish its
 *  own level support — the only case a probe can fix. */
export function isEffortProbeable(m: CompatModel & { compat?: Compat }, channelCompat: Compat = {}): boolean {
	if (m.reasoning !== true || !isOpenAICompatible(m.api)) return false;
	if (isOfficialOpenAI(m) || isOpenRouter(m) || isPiLlamaCpp(m)) return false;
	const compat = { ...channelCompat, ...(m.compat ?? {}) };
	if (compat.supportsReasoningEffort === false) return false;
	return !["openrouter", "chat-template", "qwen-chat-template", "ant-ling"].includes(String(compat.thinkingFormat ?? ""));
}

/** The non-effort half of pi's request, so the probe tests the level like a real turn
 *  would: a channel that needs `thinking:{type:enabled}` must not report that as a failure. */
export function thinkingPayload(compat: Compat, enabled: boolean): Record<string, unknown> | undefined {
	switch (compat.thinkingFormat) {
		case "deepseek":
			return { thinking: { type: enabled ? "enabled" : "disabled" } };
		case "zai":
			return { thinking: enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" } };
		case "qwen":
			return { enable_thinking: enabled };
		case "together":
			return { reasoning: { enabled } };
		case "openrouter":
			return enabled ? { reasoning: { effort: "medium" } } : undefined;
		default:
			return undefined;
	}
}

/** Nearest accepted effort, up first (pi's clamp order), ties down. */
export function nearestEffort(level: string, accepted: Set<string>): string | undefined {
	const idx = EFFORT_RANK.indexOf(level);
	if (idx === -1) return undefined;
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of accepted) {
		const cIdx = EFFORT_RANK.indexOf(candidate);
		if (cIdx === -1) continue;
		const distance = cIdx >= idx ? cIdx - idx : (idx - cIdx) * 1.01;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = candidate;
		}
	}
	return best;
}

/** A map that remaps or drops a level was shaped by the user, not by a probe. */
export function carriesRemap(map: Record<string, string | null> | undefined): boolean {
	if (!map) return false;
	for (const [level, value] of Object.entries(map)) {
		if (value === null) return true;
		if (value !== level && IDENTITY[level] !== undefined) return true;
	}
	return false;
}

/** Probe results → `thinkingLevelMap`. A rejected level maps to the nearest accepted one;
 *  a level that works stays unmapped, so nothing is pinned that need not be. Undefined when
 *  nothing answered or nothing changed. */
export function buildEffortMap(current: Record<string, string | null> | undefined, supported: string[]): Record<string, string | null> | undefined {
	const accepted = new Set(supported);
	if (accepted.size === 0) return undefined;
	const out: Record<string, string | null> = {};
	let changed = false;
	for (const level of THINKING_LEVELS) {
		const existing = current?.[level];
		const optIn = level === "off" || level === "xhigh" || level === "max";
		if (optIn) {
			if (existing === undefined) continue; // not offered → not the probe's call
			if (existing === null || !PROBED.has(existing)) {
				out[level] = existing;
				continue;
			}
			const from = level === "off" ? "minimal" : level;
			const value = accepted.has(existing) ? existing : level === "off" && accepted.has("none") ? "none" : nearestEffort(from, accepted);
			if (!value) {
				out[level] = null;
				changed = true;
				continue;
			}
			if (value !== existing) changed = true;
			out[level] = value;
			continue;
		}
		if (existing !== undefined && existing !== level) {
			out[level] = existing; // offered under another name: deliberate
			continue;
		}
		if (existing === null) {
			out[level] = null;
			continue;
		}
		if (accepted.has(level)) continue;
		out[level] = nearestEffort(level, accepted) ?? null;
		changed = true;
	}
	return changed ? out : undefined;
}

export interface EffortProbeOptions {
	baseUrl: string;
	key?: string;
	headers?: Record<string, string>;
	fetchImpl?: typeof fetch;
	/** Called after each level, for a progress row. */
	onLevel?: (level: string, accepted: boolean | undefined, index: number) => void;
}

/** A status that names a rejected parameter rather than a broken endpoint. */
function isParamRejection(status: number, body: string): boolean {
	if (status === 400 || status === 404 || status === 422) return true;
	if (status !== 500 && status !== 502 && status !== 503) return false;
	return REJECTION_RE.test(body);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every effort name the channel accepts, found with one tiny completion per level.
 *  `[]` means nothing answered — never call that "nothing supported". */
export async function probeEffort(model: CompatModel, options: EffortProbeOptions): Promise<string[]> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", ...options.headers };
	if (options.key) headers.authorization = `Bearer ${options.key}`;
	const accepted: string[] = [];

	for (const [index, level] of EFFORT_RANK.entries()) {
		const body = JSON.stringify({
			model: model.id,
			messages: [{ role: "user", content: "ping" }],
			max_tokens: PROBE_TOKENS,
			stream: false,
			...(thinkingPayload(model.compat ?? {}, true) ?? {}),
			reasoning_effort: level,
		});
		let verdict: boolean | undefined;
		// Two attempts per level: a first 400 can be an upstream flake, a second confirms it.
		for (let attempt = 0; attempt < 2 && verdict === undefined; attempt++) {
			let status: number;
			let text: string;
			try {
				const response = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(LEVEL_TIMEOUT_MS) });
				status = response.status;
				text = (await response.text()).slice(0, 4000);
			} catch {
				break; // network/timeout: inconclusive
			}
			if (status < 300) {
				verdict = true;
				break;
			}
			if (status === 429) {
				await sleep(RETRY_PAUSE_MS);
				continue;
			}
			if (!isParamRejection(status, text)) break; // 401/403/5xx without a hint: unknown
			verdict = false;
		}
		if (verdict) accepted.push(level);
		options.onLevel?.(level, verdict, index);
	}
	return accepted;
}

// ----------------------------------------------------------- self-check

if (isMain(import.meta.url)) {
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

	assert(nearestEffort("medium", new Set(["low", "high"])) === "high", "a rejected level moves up first");
	assert(nearestEffort("high", new Set(["low", "medium"])) === "medium", "with no level above it moves down");
	assert(buildEffortMap(undefined, ["minimal", "low", "high"])?.medium === "high", "a rejected level is remapped");
	assert(buildEffortMap(undefined, ["minimal", "low", "high"])?.xhigh === undefined, "an opt-in level is not invented");
	assert(buildEffortMap({ medium: null, high: "high" }, ["high"])?.medium === null, "a deliberate null survives");
	assert(buildEffortMap({ medium: "high" }, ["high"])?.medium === "high", "a deliberate remap is preserved");
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
	assert(buildEffortMap(undefined, supported)?.medium === "high", "a rejected level is remapped to the nearest accepted one");
	const deadFetch = (async () => ({ status: 401, text: async () => "unauthorized" })) as unknown as typeof fetch;
	assert((await probeEffort({ ...base, reasoning: true }, { baseUrl: base.baseUrl, fetchImpl: deadFetch })).length === 0, "a credential failure answers nothing, so nothing is written");

	console.log("compat.ts self-check OK");
}
