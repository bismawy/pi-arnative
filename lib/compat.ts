/**
 * Compat flags for a provider the wizard writes — ported from pi-auto-compat, minus its
 * background machinery. Nothing here watches models.json or repairs it later: the flags
 * are computed once, from the model list the wizard already fetched, and written by
 * `withProviderModels` in provider.ts (one writer, one moment).
 *
 * Two things ride along with the same probe: the real `contextWindow`/`maxTokens`, and
 * (on demand) which `reasoning_effort` names the channel accepts.
 */
import { setTimeout as sleep } from "node:timers/promises";

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
const CONTEXT_KEYS = [
	"context_length",
	"context_window",
	"max_context_length",
	"max_model_len",
	"max_context_window",
	"max_context_window_tokens",
	"max_input_tokens",
	"max_input_length",
	"context_size",
	"inputTokenLimit",
	"contextWindow",
	"maxContextLength",
	"maxModelLen",
	"maxContextWindow",
	"maxInputTokens",
	"contextSize",
];
const OUTPUT_KEYS = [
	"max_output_tokens",
	"max_completion_tokens",
	"max_output_length",
	"max_tokens",
	"outputTokenLimit",
	"maxOutputTokens",
	"maxCompletionTokens",
	"maxTokens",
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const positiveInt = (value: unknown): number | undefined => {
	const n = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

/** Numeric limits from one catalog entry (top-level or nested `top_provider` / `limit` / `limits` / `capabilities.limits`). */
export function parseMeta(entry: unknown): ModelMeta {
	const rec = isRecord(entry) ? entry : {};
	const sources: Record<string, unknown>[] = [rec];
	for (const nested of [rec.top_provider, rec.limit, rec.limits, isRecord(rec.capabilities) ? rec.capabilities.limits : undefined]) {
		if (isRecord(nested)) sources.push(nested);
	}
	const out: ModelMeta = {};
	for (const src of sources) {
		for (const key of CONTEXT_KEYS) {
			const value = positiveInt(src[key]);
			if (value !== undefined) {
				out.contextWindow = value;
				break;
			}
		}
		if (out.contextWindow === undefined && (src === rec.limit || src === rec.limits)) {
			const value = positiveInt(src.context);
			if (value !== undefined) out.contextWindow = value;
		}
		if (out.contextWindow !== undefined) break;
	}
	for (const src of sources) {
		for (const key of OUTPUT_KEYS) {
			const value = positiveInt(src[key]);
			if (value === undefined) continue;
			// A "max_tokens" equal to the whole window is the context length, not a cap.
			if (out.contextWindow !== undefined && value >= out.contextWindow) continue;
			out.maxTokens = value;
			break;
		}
		if (out.maxTokens === undefined && (src === rec.limit || src === rec.limits)) {
			const value = positiveInt(src.output);
			if (value !== undefined && (out.contextWindow === undefined || value < out.contextWindow)) out.maxTokens = value;
		}
		if (out.maxTokens !== undefined) break;
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
	const effective = out.contextWindow;
	if (next.maxTokens !== undefined && (prev?.maxTokens === undefined || next.maxTokens > prev.maxTokens)) {
		out.maxTokens = effective !== undefined && next.maxTokens > effective ? effective : next.maxTokens;
	}
	return out;
}

export interface CatalogIndex {
	exact: Map<string, ModelMeta>;
	bare: Map<string, ModelMeta>;
	stripped: Map<string, ModelMeta>;
}

const bareModelName = (id: string): string => {
	const lower = id.trim().toLowerCase();
	const slash = lower.lastIndexOf("/");
	return slash >= 0 ? lower.slice(slash + 1) : lower;
};

const stripVariantSuffix = (name: string): string => name.replace(/(?::(?:free|exacto|thinking)|-(?:fp8|fp16|bf16|int8|int4|awq|gptq))$/i, "");

const putPreferLarger = (map: Map<string, ModelMeta>, key: string, meta: ModelMeta): void => {
	if (!key || meta.contextWindow === undefined) return;
	const prev = map.get(key);
	if (!prev || (prev.contextWindow ?? 0) < meta.contextWindow) map.set(key, meta);
};

/** Index model metadata by exact id, bare name (after `/`), and variant-stripped name for fallback lookup. */
export function buildCatalogIndex(entries: Iterable<[string, ModelMeta]>): CatalogIndex {
	const index: CatalogIndex = { exact: new Map(), bare: new Map(), stripped: new Map() };
	for (const [id, meta] of entries) {
		if (meta.contextWindow === undefined) continue;
		const exactKey = id.trim().toLowerCase();
		const bare = bareModelName(id);
		const stripped = stripVariantSuffix(bare);
		putPreferLarger(index.exact, exactKey, meta);
		putPreferLarger(index.bare, bare, meta);
		putPreferLarger(index.stripped, stripped, meta);
	}
	return index;
}

/** Look up fallback `contextWindow` / `maxTokens` for a model id by exact, bare, or variant-stripped name. */
export function findMetaForId(id: string, index: CatalogIndex): ModelMeta | undefined {
	const exactKey = id.trim().toLowerCase();
	const bare = bareModelName(id);
	return index.exact.get(exactKey) ?? index.bare.get(bare) ?? index.stripped.get(stripVariantSuffix(bare));
}

// ------------------------------------------------------- thinking effort

// pi's levels in clamp order; `off` has no wire name of its own.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const IDENTITY: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh" };
const LEVEL_TIMEOUT_MS = 30_000;
const PROBE_TOKENS = 16;
const RETRY_PAUSE_MS = 1000;
// Only a parameter rejection indicts the level. Auth, quota and transport errors say
// nothing, and marking a level accepted without an answer would be a lie.
export const REJECTION_RE = /provider.?error|invalid.?request|http 400|400[.:]|reasoning.?effort|thinking|unsupported|not supported|invalid (?:value|option|parameter|enum)|bad request/i;

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

/** A map that remaps or drops a level was shaped by the user, not by a probe. */
export function carriesRemap(map: Record<string, string | null> | undefined): boolean {
	if (!map) return false;
	for (const [level, value] of Object.entries(map)) {
		if (value === null) return true;
		if (value !== level && IDENTITY[level] !== undefined) return true;
	}
	return false;
}

/** Probe results -> an exact `thinkingLevelMap`: each accepted effort maps to itself and
 *  every rejected one is null, so pi offers only the levels the channel really runs and
 *  never sends one it drops. `off` stays pi's call (it disables thinking; it is not an
 *  effort). Undefined when nothing answered. */
export function buildEffortMap(supported: string[]): Record<string, string | null> | undefined {
	const accepted = new Set(supported);
	if (accepted.size === 0) return undefined;
	const out: Record<string, string | null> = {};
	for (const level of THINKING_LEVELS) if (level !== "off") out[level] = accepted.has(level) ? level : null;
	return out;
}

export interface EffortProbeOptions {
	baseUrl: string;
	key?: string;
	headers?: Record<string, string>;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	deadline?: number;
	/** Called after each level, for a progress row. */
	onLevel?: (level: string, accepted: boolean | undefined, index: number) => void;
}

/** A status that names a rejected parameter rather than a broken endpoint. */
function isParamRejection(status: number, body: string): boolean {
	if (status === 400 || status === 404 || status === 422) return true;
	if (status !== 500 && status !== 502 && status !== 503) return false;
	return REJECTION_RE.test(body);
}

/** Every effort name the channel accepts, found with one tiny completion per level.
 *  `[]` means nothing answered — never call that "nothing supported". */
export async function probeEffort(model: CompatModel, options: EffortProbeOptions): Promise<string[]> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const responses = lower(model.api) === "openai-responses";
	const url = `${options.baseUrl.replace(/\/+$/, "")}/${responses ? "responses" : "chat/completions"}`;
	const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", ...options.headers };
	if (options.key) headers.authorization = `Bearer ${options.key}`;
	const accepted: string[] = [];
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		...(options.deadline !== undefined ? [AbortSignal.timeout(Math.max(1, options.deadline - Date.now()))] : []),
	]);
	const checkStopped = (): void => {
		signal.throwIfAborted();
		if (options.deadline !== undefined && Date.now() >= options.deadline) {
			throw new DOMException("Effort probe budget exhausted", "TimeoutError");
		}
	};
	for (const [index, level] of EFFORT_RANK.entries()) {
		checkStopped();
		const body = JSON.stringify(responses ? {
			model: model.id,
			input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
			...(model.compat?.supportsMaxOutputTokens === false ? {} : { max_output_tokens: PROBE_TOKENS }),
			stream: false,
			store: false,
			reasoning: { effort: level },
		} : {
			model: model.id,
			messages: [{ role: "user", content: "ping" }],
			[model.compat?.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"]: PROBE_TOKENS,
			stream: false,
			...(thinkingPayload(model.compat ?? {}, true) ?? {}),
			reasoning_effort: level,
		});
		let verdict: boolean | undefined;
		for (let attempt = 0; attempt < 2 && verdict === undefined; attempt++) {
			checkStopped();
			let status: number;
			let text: string;
			try {
				const response = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.any([signal, AbortSignal.timeout(LEVEL_TIMEOUT_MS)]) });
				status = response.status;
				text = (await response.text()).slice(0, 4000);
			} catch {
				checkStopped();
				break; // network/timeout: inconclusive
			}
			checkStopped();
			if (status < 300) {
				verdict = true;
				break;
			}
			if (status === 429) {
				try {
					await sleep(RETRY_PAUSE_MS, undefined, { signal });
				} catch (error) {
					checkStopped();
					throw error;
				}
				continue;
			}
			if (!isParamRejection(status, text)) break;
			verdict = false;
		}
		if (verdict) accepted.push(level);
		options.onLevel?.(level, verdict, index);
	}
	return accepted;
}

// ----------------------------------------------------------- self-check
