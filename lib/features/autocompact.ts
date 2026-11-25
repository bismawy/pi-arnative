/**
 * Auto-compact — scale Smart capacity with Render cache and keep remote payloads < 1 MB.
 *
 * Why: When Render cache is Off, pi re-renders the whole transcript on every frame, so
 * Smart caps ≥192k windows around ~200k tokens to keep the TUI responsive. When Render
 * cache is On, settled history renders in O(1), so Smart scales ≥192k windows to 90%
 * of `contextWindow` (while ≤128k windows still defer to pi's `reserveTokens`).
 *
 * Remote-routed models (`remote/*`, `remote-magpie/*`) sit behind a 1 MB HTTP body limit.
 * Rather than forcing premature session compaction at low token counts, byte protection
 * stays decoupled from `ctx.compact()`:
 * - `before_provider_request` measures serialized request bytes to track prompt/tool overhead.
 * - `context` stays silent (preserving prompt caching) until payload approaches ~900 KB,
 *   then trims in-memory down to ~760 KB (old images → old thinking → old tool outputs →
 *   old args → head turns) without touching the transcript, UI, or `render-cache`.
 * - `session_before_compact` caps oversized `toolCall` arguments / text in compaction input
 *   so summarization stays under 1 MB when token compaction eventually runs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PAYLOAD_LIMIT_KEY, choiceSetting, loadSetting, saveChoice } from "../preset-store.ts";
import { getRuntime } from "../runtime.ts";
import { activeRenderCache } from "./render-cache.ts";

/** Stored exactly as the picker shows them; `Off` disables the trigger entirely. */
export const AUTO_COMPACT_CHOICES = ["Off", "Smart", "100k", "150k", "200k", "300k", "400k"] as const;
export type AutoCompactChoice = (typeof AUTO_COMPACT_CHOICES)[number];
export const DEFAULT_AUTO_COMPACT: AutoCompactChoice = "Off";
export const AUTO_COMPACT_KEY = "autoCompact";

/** Proxy payload limit presets shown in `/arnative` → Payload limit. */
export const PAYLOAD_LIMIT_PRESETS = ["Off", "1 MB", "4 MB", "8 MB", "16 MB", "32 MB"] as const;
export type PayloadLimitPreset = (typeof PAYLOAD_LIMIT_PRESETS)[number];
export const DEFAULT_PAYLOAD_LIMIT: PayloadLimitPreset = "1 MB";
export const PAYLOAD_LIMIT_MB_RANGE = { min: 1, max: 1024 } as const;
export const PAYLOAD_LIMIT_CONFIG_KEY = Symbol.for("pi-arnative.payloadLimit");

export interface ByteCeilings {
	mb: number;
	shedTriggerBytes: number;
	shedTargetBytes: number;
	compactInputBytes: number;
	shedTriggerAfter413Bytes: number;
	shedTargetAfter413Bytes: number;
}

function formatMb(mb: number): string {
	return Number.isInteger(mb) ? String(mb) : String(Number(mb.toFixed(2)));
}

/** Parse `"Off"`, a number, or `"16 MB"` / `"16m"` into normalized storage form (`"Off"` or `"<N> MB"`). */
export function parsePayloadLimit(raw: unknown): string | undefined {
	if (typeof raw === "number") {
		if (!Number.isFinite(raw) || raw < PAYLOAD_LIMIT_MB_RANGE.min || raw > PAYLOAD_LIMIT_MB_RANGE.max) return undefined;
		return `${formatMb(raw)} MB`;
	}
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (/^off$/i.test(trimmed)) return "Off";
	const m = /^(\d+(?:\.\d+)?)\s*(?:mb|m)?$/i.exec(trimmed);
	if (!m) return undefined;
	const mb = Number(m[1]);
	if (!Number.isFinite(mb) || mb < PAYLOAD_LIMIT_MB_RANGE.min || mb > PAYLOAD_LIMIT_MB_RANGE.max) return undefined;
	return `${formatMb(mb)} MB`;
}

/** Numeric MB limit for a parsed payload limit string, or `null` when `"Off"`. */
export function payloadLimitMb(choice: string): number | null {
	if (choice === "Off") return null;
	const n = Number.parseFloat(choice);
	return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Shell override via `PI_ARNATIVE_BYTE_WALL_MB`, when set to a valid positive number. */
export function envByteWallOverride(): string | undefined {
	const raw = process.env.PI_ARNATIVE_BYTE_WALL_MB;
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	const mb = Number(raw);
	return Number.isFinite(mb) && mb > 0 ? `${formatMb(mb)} MB` : undefined;
}

/** Stored `config.json` choice (`"Off"` or `"<N> MB"`), ignoring process env overrides. */
export function savedPayloadLimit(): string {
	return parsePayloadLimit(loadSetting(PAYLOAD_LIMIT_KEY)) ?? DEFAULT_PAYLOAD_LIMIT;
}

/** Active payload limit: in-session choice, else `PI_ARNATIVE_BYTE_WALL_MB`, else `config.json` (default `1 MB`). */
export function activePayloadLimit(): string {
	const slot = (globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY];
	const fromSlot = parsePayloadLimit(slot);
	if (fromSlot) return fromSlot;
	return envByteWallOverride() ?? savedPayloadLimit();
}

/** Apply a payload limit live for this session and persist it to `config.json`. */
export function setPayloadLimit(choice: string): string {
	const parsed = parsePayloadLimit(choice);
	if (!parsed) throw new Error(`Invalid payload limit: ${choice}`);
	(globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY] = parsed;
	saveChoice(PAYLOAD_LIMIT_KEY, parsed);
	return parsed;
}

/** Byte ceilings for an HTTP body wall in MB (ratios target 900/760/720 KB per 1 MB). */
export function ceilingsForMb(mb: number): ByteCeilings {
	return {
		mb,
		shedTriggerBytes: Math.round(900 * 1024 * mb),
		shedTargetBytes: Math.round(760 * 1024 * mb),
		compactInputBytes: Math.round(720 * 1024 * mb),
		shedTriggerAfter413Bytes: Math.round(820 * 1024 * mb),
		shedTargetAfter413Bytes: Math.round(680 * 1024 * mb),
	};
}

/** Active byte ceilings for this session, or `null` when payload limiting is `Off`. */
export function activeByteCeilings(): ByteCeilings | null {
	const mb = payloadLimitMb(activePayloadLimit());
	return mb === null ? null : ceilingsForMb(mb);
}

function trimLabelForMb(limitMb: number): string {
	return `trimmed for ${formatMb(limitMb)}MB limit`;
}

// Module-load ceilings retained for backward-compatible test/caller imports.
const INITIAL_CEILINGS = ceilingsForMb(payloadLimitMb(envByteWallOverride() ?? savedPayloadLimit()) ?? 1);
export const SHED_TRIGGER_BYTES = INITIAL_CEILINGS.shedTriggerBytes;
export const SHED_TARGET_BYTES = INITIAL_CEILINGS.shedTargetBytes;
export const COMPACT_INPUT_BYTES = INITIAL_CEILINGS.compactInputBytes;
const DEFAULT_OVERHEAD_BYTES = 64 * 1024;
const MIN_MSG_BUDGET_BYTES = 64 * 1024;
const TRIMMED_TOOL_STUB = "[earlier output omitted; full output in session]";

export interface ContentBlockLike {
	type?: string;
	text?: string;
	thinking?: string;
	arguments?: Record<string, unknown>;
}

export interface MessageLike {
	role?: string;
	content?: unknown;
}

/** Smart's tier table when Render cache is Off (keeps uncached transcripts near ~200k).
 *  When Render cache is On, settled history renders in O(1), so ≥192k windows scale
 *  up to 90% of contextWindow while ≤128k windows still defer to pi core. */
const SMART_TIERS_UNCACHED: ReadonlyArray<{ minWindow: number; percent: number | null }> = [
	{ minWindow: 786432, percent: 20 }, // ≥768k: a 1M window triggers at ~200k tokens
	{ minWindow: 393216, percent: 40 }, // 384k–768k: a 512k window triggers at ~205k
	{ minWindow: 196608, percent: 80 }, // 192k–384k: a 256k window triggers at ~205k
	{ minWindow: 0, percent: null }, // below 192k (128k models): pi core stays in charge
];

const SMART_TIERS_CACHED: ReadonlyArray<{ minWindow: number; percent: number | null }> = [
	{ minWindow: 196608, percent: 90 }, // ≥192k: let render-cached sessions reach 90% of capacity
	{ minWindow: 0, percent: null }, // below 192k (128k models): pi core stays in charge
];

/** The Smart percent for a context window, or null when the window defers to pi core. */
export function smartPercent(contextWindow: number, renderCacheOn = activeRenderCache() === "On"): number | null {
	const tiers = renderCacheOn ? SMART_TIERS_CACHED : SMART_TIERS_UNCACHED;
	const tier = tiers.find((t) => contextWindow >= t.minWindow);
	return tier?.percent ?? null;
}

// Active choice on globalThis so the `/arnative` picker (a second module instance, see
// animations.ts) and this module's event handlers agree without sharing memo caches.
const autoCompactSetting = choiceSetting(AUTO_COMPACT_KEY, AUTO_COMPACT_CHOICES, DEFAULT_AUTO_COMPACT);
const AUTO_COMPACT_CONFIG_KEY = autoCompactSetting.slot;

export const activeAutoCompact = (): AutoCompactChoice => autoCompactSetting.get();

/** The trigger threshold in context tokens for the given window, or null when the
 *  choice is off or Smart defers this window to pi's own compaction. */
export function activeAutoCompactThreshold(contextWindow: number): number | null {
	const choice = activeAutoCompact();
	if (choice === "Off") return null;
	if (choice === "Smart") {
		const percent = smartPercent(contextWindow);
		return percent === null ? null : Math.round((contextWindow * percent) / 100);
	}
	return Number.parseInt(choice, 10) * 1000;
}

/** Pick a choice and persist it (the `/arnative` → Auto-compact rows call this). */
export const setAutoCompact = (choice: AutoCompactChoice): void => autoCompactSetting.set(choice);

/** Session-scoped trigger state. Module-local: only this module's registrar mutates it. */
export interface AutoCompactState {
	/** A compaction this module triggered has not finished yet. */
	inFlight: boolean;
	/** Context tokens at the last trigger; null once usage really dropped under the threshold. */
	lastAttemptTokens: number | null;
	/** The last triggered compaction finished, so its effect on usage is visible. */
	attemptSettled: boolean;
	/** Do not trigger while usage stays below this (failure backoff, anti-flap). */
	blockedUntilTokens: number;
	/** Last observed `context` event messages size in bytes. */
	lastMessagesBytes: number;
	/** Estimated non-message request overhead (system prompt + tool schemas). */
	overheadBytes: number;
	/** Set if this session saw an HTTP 413 / request_too_large error on the active model. */
	saw413: boolean;
	/** True while a compaction request is in progress (prevents polluting byte metrics). */
	compacting: boolean;
	/** True between `context` and the matching `before_provider_request` for that turn. */
	awaitingContextPayload: boolean;
}

export function freshAutoCompactState(): AutoCompactState {
	return {
		inFlight: false,
		lastAttemptTokens: null,
		attemptSettled: false,
		blockedUntilTokens: 0,
		lastMessagesBytes: 0,
		overheadBytes: 0,
		saw413: false,
		compacting: false,
		awaitingContextPayload: false,
	};
}

/** How much usage must outgrow a previous attempt before it counts as real growth
 *  (5% of the threshold, at least 5k tokens). */
export function growthMargin(thresholdTokens: number): number {
	return Math.max(5000, Math.round(thresholdTokens * 0.05));
}

/** Remote-routed models enforced behind a 1 MB HTTP body proxy. */
export function isByteLimitedModel(model: { id?: string; provider?: string } | undefined): boolean {
	const id = model?.id;
	const provider = model?.provider;
	return (
		(typeof id === "string" && (id.startsWith("remote/") || id.startsWith("remote-magpie/"))) ||
		(typeof provider === "string" && (provider === "remote" || provider.startsWith("remote-")))
	);
}

/** True when a provider error string indicates an HTTP 413 request-body size limit. */
export function isPayloadTooLargeError(errorMessage: string | undefined): boolean {
	return typeof errorMessage === "string" && /\b413\b|request_too_large|entity too large/i.test(errorMessage);
}

/** UTF-8 JSON byte length, returning 0 on non-serializable values. */
export function jsonByteLength(value: unknown): number {
	try {
		const raw = JSON.stringify(value);
		return raw === undefined ? 0 : Buffer.byteLength(raw, "utf8");
	} catch {
		return 0;
	}
}

/** Keep the helper API, but measure each request: Pi clones messages before `context`. */
export function cachedArrayBytes(messages: MessageLike[]): number {
	return jsonByteLength(messages);
}

/** Pure decision for the settle handler: fire pi's compaction now, or wait. */
export function autoCompactDecision(
	state: AutoCompactState,
	tokens: number | null,
	thresholdTokens: number | null,
): "compact" | "wait" {
	if (state.inFlight || thresholdTokens === null || tokens === null) return "wait";
	if (tokens < thresholdTokens || tokens < state.blockedUntilTokens) return "wait";
	if (
		state.attemptSettled &&
		state.lastAttemptTokens !== null &&
		tokens < state.lastAttemptTokens + growthMargin(thresholdTokens)
	) {
		return "wait";
	}
	return "compact";
}

/** Clear attempt memory once usage really dropped under the threshold (prevents
 *  oscillation at the edge while re-arming cleanly after an effective compaction). */
export function rearmAfterDip(state: AutoCompactState, tokens: number | null, thresholdTokens: number | null): void {
	if (thresholdTokens === null || tokens === null || tokens >= thresholdTokens) return;
	if (state.lastAttemptTokens !== null && tokens >= state.lastAttemptTokens - growthMargin(thresholdTokens)) return;
	state.lastAttemptTokens = null;
	state.attemptSettled = false;
	state.blockedUntilTokens = 0;
}

function truncateStringHead(text: string, maxChars: number, label: string): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} chars ${label}]`;
}

function mapContentBlocks(
	msg: MessageLike,
	transform: (block: ContentBlockLike) => ContentBlockLike | null,
): MessageLike | null {
	if (!Array.isArray(msg.content)) return null;
	let changed = false;
	const nextContent: ContentBlockLike[] = [];
	for (const raw of msg.content) {
		const block = raw as ContentBlockLike;
		const updated = transform(block);
		if (updated) {
			changed = true;
			nextContent.push(updated);
		} else {
			nextContent.push(block);
		}
	}
	return changed ? { ...msg, content: nextContent } : null;
}

function shrinkToolCallArgs(block: ContentBlockLike, maxArgChars: number, label: string): ContentBlockLike | null {
	if (block.type !== "toolCall" || !block.arguments || typeof block.arguments !== "object") return null;
	let changed = false;
	const nextArgs: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(block.arguments)) {
		if (typeof v === "string" && v.length > maxArgChars) {
			changed = true;
			nextArgs[k] = truncateStringHead(v, maxArgChars, label);
		} else {
			nextArgs[k] = v;
		}
	}
	return changed ? { ...block, arguments: nextArgs } : null;
}

/**
 * Trim only older images / bulky tool payloads in-memory when a mid-run request is about
 * to exceed the hard byte ceiling, keeping message order and toolCall/toolResult pairing
 * intact so the active run finishes without hitting HTTP 413.
 */
export function shedMessagesForByteLimit<T extends MessageLike>(
	messages: readonly T[],
	targetMsgBytes: number,
	limitMb = payloadLimitMb(activePayloadLimit()) ?? 1,
): { messages: T[]; bytes: number; changed: boolean } {
	const trimLabel = trimLabelForMb(limitMb);
	const sizes = messages.map((m) => jsonByteLength(m));
	let totalBytes = jsonByteLength(messages);
	if (totalBytes <= targetMsgBytes || messages.length === 0) {
		return { messages: messages as T[], bytes: totalBytes, changed: false };
	}

	const out = messages.slice();
	let changed = false;

	const replaceMessage = (idx: number, next: MessageLike | null): void => {
		if (!next) return;
		const nextSize = jsonByteLength(next);
		if (nextSize >= sizes[idx]) return;
		totalBytes -= sizes[idx] - nextSize;
		sizes[idx] = nextSize;
		out[idx] = next as T;
		changed = true;
	};

	// Pass 1: drop images from all messages before the newest image-bearing message.
	let latestImageIdx = -1;
	for (let i = out.length - 1; i >= 0; i--) {
		const content = out[i]?.content;
		if (Array.isArray(content) && content.some((b) => (b as ContentBlockLike)?.type === "image")) {
			latestImageIdx = i;
			break;
		}
	}
	for (let i = 0; i < latestImageIdx && totalBytes > targetMsgBytes; i++) {
		replaceMessage(
			i,
			mapContentBlocks(out[i], (b) =>
				b.type === "image" ? { type: "text", text: "[earlier image omitted]" } : null,
			),
		);
	}

	// Pass 1b: drop thinking blocks (and signatures) from assistant turns before the latest user message.
	let lastUserIdx = -1;
	for (let i = out.length - 1; i >= 0; i--) {
		if (out[i]?.role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	for (let i = 0; i < lastUserIdx && totalBytes > targetMsgBytes; i++) {
		if (out[i]?.role !== "assistant" || !Array.isArray(out[i]?.content)) continue;
		const content = out[i].content as ContentBlockLike[];
		if (!content.some((b) => b.type === "thinking")) continue;
		const filtered = content.filter((b) => b.type !== "thinking");
		replaceMessage(i, {
			...out[i],
			content: filtered.length > 0 ? filtered : [{ type: "text", text: "[thinking omitted]" }],
		});
	}

	// Preserve the newest turn(s) untouched so the active prompt/tool results stay exact.
	const tailStart = Math.max(0, out.length - (out.length > 8 ? 4 : 2));

	// Pass 2: trim bulky toolResult text blocks from oldest to newest before tailStart.
	for (let i = 0; i < tailStart && totalBytes > targetMsgBytes; i++) {
		if (out[i]?.role !== "toolResult") continue;
		replaceMessage(
			i,
			mapContentBlocks(out[i], (b) =>
				b.type === "text" && typeof b.text === "string" && b.text.length > 300
					? { ...b, text: TRIMMED_TOOL_STUB }
					: null,
			),
		);
	}

	// Pass 3: trim long assistant/user text & toolCall args before tailStart.
	for (let i = 0; i < tailStart && totalBytes > targetMsgBytes; i++) {
		replaceMessage(
			i,
			mapContentBlocks(out[i], (b) => {
				if (b.type === "text" && typeof b.text === "string" && b.text.length > 600) {
					return { ...b, text: truncateStringHead(b.text, 600, trimLabel) };
				}
				if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 300) {
					return { ...b, thinking: truncateStringHead(b.thinking, 300, "trimmed") };
				}
				return shrinkToolCallArgs(b, 400, "trimmed");
			}),
		);
	}

	// Pass 4: emergency tail trim when even the newest turn alone exceeds the byte ceiling.
	for (let i = tailStart; i < out.length && totalBytes > targetMsgBytes; i++) {
		replaceMessage(
			i,
			mapContentBlocks(out[i], (b) => {
				if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 300) {
					return { ...b, thinking: truncateStringHead(b.thinking, 300, "trimmed") };
				}
				if (b.type === "text" && typeof b.text === "string" && b.text.length > 8000) {
					return { ...b, text: truncateStringHead(b.text, 8000, trimLabel) };
				}
				return shrinkToolCallArgs(b, 4000, trimLabel);
			}),
		);
	}

	// Pass 5: when thousands of short messages still exceed the byte ceiling, drop oldest
	// turns from the head while keeping toolCall/toolResult pairing and user-first order intact.
	if (totalBytes > targetMsgBytes && out.length > 2) {
		const minKeep = Math.min(out.length, 4);
		let dropEnd = 0;
		while (totalBytes > targetMsgBytes && out.length - dropEnd > minKeep) {
			totalBytes -= sizes[dropEnd] + 1;
			dropEnd += 1;
			while (dropEnd < out.length - minKeep && out[dropEnd]?.role === "toolResult") {
				totalBytes -= sizes[dropEnd] + 1;
				dropEnd += 1;
			}
		}
		if (dropEnd > 0) {
			const kept = out.slice(dropEnd);
			if (kept[0]?.role !== "user") {
				kept.unshift({ role: "user", content: [{ type: "text", text: `[earlier turns omitted for ${formatMb(limitMb)}MB request limit]` }] } as T);
			}
			return { messages: kept, bytes: jsonByteLength(kept), changed: true };
		}
	}

	return { messages: out, bytes: totalBytes, changed };
}

/**
 * Shrink oversized `toolCall` arguments and long text blocks inside `messagesToSummarize`
 * (cloned, never mutating live transcript entries) so compaction itself stays under 1 MB.
 */
export function trimCompactionInput(messagesToSummarize: MessageLike[] | undefined, maxBytes: number): boolean {
	if (!Array.isArray(messagesToSummarize) || messagesToSummarize.length === 0) return false;
	let totalBytes = jsonByteLength(messagesToSummarize);
	if (totalBytes <= maxBytes) return false;

	let changed = false;
	const shrinkPass = (maxText: number, maxArg: number): void => {
		for (let i = 0; i < messagesToSummarize.length && totalBytes > maxBytes; i++) {
			const msg = messagesToSummarize[i];
			const oldSize = jsonByteLength(msg);
			const next = mapContentBlocks(msg, (b) => {
				const shrunk = shrinkToolCallArgs(b, maxArg, "trimmed for compaction");
				if (shrunk) return shrunk;
				if (b.type === "text" && typeof b.text === "string" && b.text.length > maxText) {
					return { ...b, text: truncateStringHead(b.text, maxText, "trimmed for compaction") };
				}
				return null;
			});
			if (!next) continue;
			const nextSize = jsonByteLength(next);
			if (nextSize < oldSize) {
				messagesToSummarize[i] = next;
				totalBytes -= oldSize - nextSize;
				changed = true;
			}
		}
	};

	shrinkPass(3000, 1200);
	if (totalBytes > maxBytes) {
		shrinkPass(800, 300);
	}
	if (totalBytes > maxBytes && messagesToSummarize.length > 2) {
		const sizes = messagesToSummarize.map((m) => jsonByteLength(m));
		let dropEnd = 0;
		const minKeep = 2;
		while (totalBytes > maxBytes && messagesToSummarize.length - dropEnd > minKeep) {
			totalBytes -= sizes[dropEnd] + 1;
			dropEnd += 1;
			while (dropEnd < messagesToSummarize.length - minKeep && messagesToSummarize[dropEnd]?.role === "toolResult") {
				totalBytes -= sizes[dropEnd] + 1;
				dropEnd += 1;
			}
		}
		if (dropEnd > 0) {
			messagesToSummarize.splice(0, dropEnd);
			changed = true;
		}
	}
	return changed;
}

// Registered handlers against a fake pi: Smart + Render cache On uses 90% on 1M (~943k tokens),
// while Render cache Off falls back to ~200k tokens. The registrar's byte tracking is exposed
// through a getter so the self-check can assert the i1 guard never touches it for plain models.
let trackedOverheadBytes = -1;

/** Last observed wire size (messages + overhead) for byte-limited models, or null.
 *  Consumed by the footer to show payload pressure against the 1 MB proxy wall. */
export function wireBytesSnapshot(): { bytes: number; limit: number } | null {
	const ceilings = activeByteCeilings();
	if (!ceilings) return null;
	const state = getRuntime().autocompactState as AutoCompactState | null;
	if (!state || state.lastMessagesBytes <= 0) return null;
	const overhead = state.overheadBytes > 0 ? state.overheadBytes : DEFAULT_OVERHEAD_BYTES;
	return { bytes: state.lastMessagesBytes + overhead, limit: ceilings.shedTriggerBytes };
}

export default function registerAutoCompact(pi: ExtensionAPI): void {
	const state = freshAutoCompactState();
	Object.defineProperty(state, "overheadBytes", {
		get(): number {
			return this._overheadBytes;
		},
		set(v: number) {
			this._overheadBytes = v;
			trackedOverheadBytes = v;
		},
	});
	(state as { _overheadBytes?: number })._overheadBytes = 0;
	// Production and self-check both read this snapshot via RuntimeState (footer uses wireBytesSnapshot).
	getRuntime().autocompactState = state;

	const resetByteTracking = (): void => {
		state.lastMessagesBytes = 0;
		state.overheadBytes = 0;
		state.saw413 = false;
		state.compacting = false;
		state.awaitingContextPayload = false;
	};

	pi.on("session_start", async () => {
		// Fresh session (or /reload): backoff and attempt state belonged to the previous branch.
		Object.assign(state, freshAutoCompactState());
	});

	pi.on("model_select", async () => {
		resetByteTracking();
	});

	pi.on("turn_end", async (event) => {
		const msg = (event as { message?: { stopReason?: string; errorMessage?: string } } | undefined)?.message;
		if (msg?.stopReason === "error" && isPayloadTooLargeError(msg.errorMessage)) {
			state.saw413 = true;
		}
	});

	pi.on("context", async (event, ctx) => {
		const ceilings = activeByteCeilings();
		if (!ceilings) return;
		// Skip the full-transcript JSON.stringify entirely for models with no byte wall:
		// measurement is the only cost here, and non-remote sessions pay it every turn.
		if (!state.saw413 && !isByteLimitedModel(ctx?.model)) return;
		const messages = (event as { messages?: MessageLike[] } | undefined)?.messages;
		if (!Array.isArray(messages)) return;
		// JSON serialization includes UTF-8 characters, escapes, and array separators.
		const msgBytes = cachedArrayBytes(messages);
		state.lastMessagesBytes = msgBytes;
		state.awaitingContextPayload = true;

		const triggerBytes = state.saw413 ? ceilings.shedTriggerAfter413Bytes : ceilings.shedTriggerBytes;
		const targetBytes = state.saw413 ? ceilings.shedTargetAfter413Bytes : ceilings.shedTargetBytes;
		const effectiveOverhead = state.overheadBytes > 0 ? state.overheadBytes : DEFAULT_OVERHEAD_BYTES;
		if (msgBytes + effectiveOverhead < triggerBytes) return;

		const targetMsgBytes = Math.max(MIN_MSG_BUDGET_BYTES, targetBytes - effectiveOverhead);
		const shed = shedMessagesForByteLimit(messages, targetMsgBytes, ceilings.mb);
		if (!shed.changed) return;

		state.lastMessagesBytes = shed.bytes;
		return { messages: shed.messages } as never;
	});

	pi.on("before_provider_request", async (event) => {
		if (state.inFlight || state.compacting) return;
		if (!state.awaitingContextPayload || state.lastMessagesBytes <= 0) return;
		const payload = (event as { payload?: unknown } | undefined)?.payload;
		const bytes = jsonByteLength(payload);
		if (bytes <= 0) return;

		if (bytes >= state.lastMessagesBytes) {
			state.overheadBytes = bytes - state.lastMessagesBytes;
		}
		state.awaitingContextPayload = false;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		state.compacting = true;
		const ceilings = activeByteCeilings();
		if (!ceilings) return;
		if (!state.saw413 && !isByteLimitedModel(ctx?.model)) return;
		const prep = (
			event as {
				preparation?: {
					messagesToSummarize?: MessageLike[];
					turnPrefixMessages?: MessageLike[];
					previousSummary?: string;
				};
			} | undefined
		)?.preparation;
		if (!prep) return;
		const prevBytes = prep.previousSummary ? jsonByteLength(prep.previousSummary) : 0;
		const summaryBudget = Math.max(128 * 1024, ceilings.compactInputBytes - prevBytes);
		trimCompactionInput(prep.messagesToSummarize, summaryBudget);
		trimCompactionInput(prep.turnPrefixMessages, Math.round(ceilings.compactInputBytes / 2));
	});

	pi.on("agent_before_settle", async (_event, ctx) => {
		const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		const window = typeof usage?.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : 0;

		const threshold = window > 0 ? activeAutoCompactThreshold(window) : null;
		const tokens = usage?.tokens ?? null;
		if (threshold === null || tokens === null) return;

		rearmAfterDip(state, tokens, threshold);

		if (autoCompactDecision(state, tokens, threshold) !== "compact") {
			return;
		}
		if (typeof ctx.compact !== "function") return; // older host without the API

		state.inFlight = true;
		state.attemptSettled = false;
		state.lastAttemptTokens = tokens;
		state.blockedUntilTokens = tokens + 1; // anti-flap: re-fire only past this attempt
		ctx.compact();
	});

	pi.on("session_compact", async () => {
		// Also fires for pi's own compactions; harmless — the flags only matter after a trigger.
		state.inFlight = false;
		state.compacting = false;
		state.attemptSettled = true;
		state.lastMessagesBytes = 0;
	});

	pi.on("session_compact_failed", async () => {
		state.compacting = false;
		if (!state.inFlight) return;
		// A failed (or user-aborted) compaction must not retry-loop at the same usage:
		// wait until usage outgrows the attempt by the growth margin.
		state.inFlight = false;
		state.attemptSettled = true;
		if (state.lastAttemptTokens !== null) {
			state.blockedUntilTokens = state.lastAttemptTokens + growthMargin(state.lastAttemptTokens);
		}
	});
}

export const __test = {
	DEFAULT_OVERHEAD_BYTES,
	TRIMMED_TOOL_STUB,
	AUTO_COMPACT_CONFIG_KEY,
	get trackedOverheadBytes() {
		return trackedOverheadBytes;
	},
	set trackedOverheadBytes(v) {
		trackedOverheadBytes = v;
	},
};
