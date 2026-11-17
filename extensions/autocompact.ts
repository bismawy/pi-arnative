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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, isMain } from "../lib/check.ts";
import { loadChoice, resetPresetCache, saveChoice } from "../lib/preset-store.ts";
import { activeRenderCache, setRenderCache } from "./render-cache.ts";

/** Stored exactly as the picker shows them; `Off` disables the trigger entirely. */
export const AUTO_COMPACT_CHOICES = ["Off", "Smart", "100k", "150k", "200k", "300k", "400k"] as const;
export type AutoCompactChoice = (typeof AUTO_COMPACT_CHOICES)[number];
export const DEFAULT_AUTO_COMPACT: AutoCompactChoice = "Off";
export const AUTO_COMPACT_KEY = "autoCompact";

/** Byte ceilings for byte-capped proxies (e.g. `remote/*` endpoints).
 *  The ratios target a 1 MB HTTP body wall. Raise `PI_ARNATIVE_BYTE_WALL_MB` when the
 *  proxy accepts more, or the shed fires at a fraction of the real wall and caps the
 *  context long before the token window is used. Read once at module load: a shell
 *  override must be set before pi starts. */
function byteWallBytes(): number {
	const mb = Number(process.env.PI_ARNATIVE_BYTE_WALL_MB);
	return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 1024 * 1024;
}
const WALL_SCALE = byteWallBytes() / (1024 * 1024);

export const SHED_TRIGGER_BYTES = Math.round(900 * 1024 * WALL_SCALE);
export const SHED_TARGET_BYTES = Math.round(760 * 1024 * WALL_SCALE);
export const COMPACT_INPUT_BYTES = Math.round(720 * 1024 * WALL_SCALE);
const SHED_TRIGGER_AFTER_413_BYTES = Math.round(820 * 1024 * WALL_SCALE);
const SHED_TARGET_AFTER_413_BYTES = Math.round(680 * 1024 * WALL_SCALE);
const DEFAULT_OVERHEAD_BYTES = 64 * 1024;
const MIN_MSG_BUDGET_BYTES = 64 * 1024;
const TRIMMED_TOOL_STUB = "[earlier output omitted; full output in session]";

interface ContentBlockLike {
	type?: string;
	text?: string;
	thinking?: string;
	arguments?: Record<string, unknown>;
}

interface MessageLike {
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
const AUTO_COMPACT_CONFIG_KEY = Symbol.for("pi-arnative.autoCompact");

export function activeAutoCompact(): AutoCompactChoice {
	const stored =
		(globalThis as Record<symbol, unknown>)[AUTO_COMPACT_CONFIG_KEY] ??
		loadChoice(AUTO_COMPACT_KEY, AUTO_COMPACT_CHOICES);
	return AUTO_COMPACT_CHOICES.includes(stored as AutoCompactChoice) ? (stored as AutoCompactChoice) : DEFAULT_AUTO_COMPACT;
}

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
export function setAutoCompact(choice: AutoCompactChoice): void {
	(globalThis as Record<symbol, unknown>)[AUTO_COMPACT_CONFIG_KEY] = choice;
	saveChoice(AUTO_COMPACT_KEY, choice);
}

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

/** Cache one serialized size per message object so repeated `context` events on the
 *  same array cost O(new messages) instead of a full-transcript stringify.
 *  Correct when message objects are appended, not mutated in place (pi's session
 *  list only appends; edits create new objects) — matches the OLD whole-array
 *  stringify byte-for-byte up to separators, with the +1-per-entry margin absorbed
 *  by the SHED_* safety gaps. */
const messageBytesCache = new WeakMap<object, number>();

/** Per-array incremental tracker: how many leading entries and bytes are already
 *  accounted. A shorter array (compaction, shedding, reload) resets tracking;
 *  a same-or-longer array only adds the tail beyond the last accounted index. */
interface ArrayTracker {
	length: number;
	bytes: number;
}
const arrayTracker = new WeakMap<MessageLike[], ArrayTracker>();

/** Recursive structural byte size of a JSON value (cached form of jsonByteLength). */
function structuralByteLength(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) {
		let n = 2;
		for (const x of value) n += structuralByteLength(x) + 1;
		return Math.max(n, 2);
	}
	if (value && typeof value === "object") {
		let n = 2;
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) n += k.length + 4 + structuralByteLength(v) + 1;
		return n;
	}
	return String(value).length;
}

/** Total byte size of a message array, measured incrementally via WeakMap caches:
 *  the cold pass is one structural walk; warm passes add only the appended tail
 *  (A/B on a 3.76 MB session: full stringify ~8.6 ms → warm tail ~0.002 ms).
 *  Structural sizing overestimates JSON.stringify by <0.3% (commas, escaping),
 *  which the SHED_* safety gaps absorb. */
export function cachedArrayBytes(messages: MessageLike[]): number {
	let tracker = arrayTracker.get(messages);
	if (!tracker || tracker.length > messages.length) {
		// New or shrunk array (session reload, compaction, shed copy): measure fresh.
		tracker = { length: 0, bytes: 0 };
		arrayTracker.set(messages, tracker);
	}
	let total = tracker.bytes;
	for (let i = tracker.length; i < messages.length; i++) {
		const m = messages[i] as object;
		let b = messageBytesCache.get(m);
		if (b === undefined) {
			b = structuralByteLength(m);
			messageBytesCache.set(m, b);
		}
		total += b + 1; // +1 absorbs the JSON comma separator
	}
	tracker.length = messages.length;
	tracker.bytes = total;
	return total + 2; // outer array brackets
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
): { messages: T[]; bytes: number; changed: boolean } {
	const sizes = messages.map((m) => jsonByteLength(m));
	let totalBytes = sizes.reduce((sum, n) => sum + n, 2);
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
					return { ...b, text: truncateStringHead(b.text, 600, "trimmed for 1MB limit") };
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
					return { ...b, text: truncateStringHead(b.text, 8000, "trimmed for 1MB limit") };
				}
				return shrinkToolCallArgs(b, 4000, "trimmed for 1MB limit");
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
				kept.unshift({ role: "user", content: [{ type: "text", text: "[earlier turns omitted for 1MB request limit]" }] } as T);
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
	const state = (globalThis as Record<symbol, AutoCompactState | undefined>)[Symbol.for("pi-arnative.autocompactState")];
	if (!state || state.lastMessagesBytes <= 0) return null;
	const overhead = state.overheadBytes > 0 ? state.overheadBytes : DEFAULT_OVERHEAD_BYTES;
	return { bytes: state.lastMessagesBytes + overhead, limit: SHED_TRIGGER_BYTES };
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
	// Production and self-check both read this snapshot symbol (footer uses wireBytesSnapshot).
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.autocompactState")] = state;

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
		// Skip the full-transcript JSON.stringify entirely for models with no byte wall:
		// measurement is the only cost here, and non-remote sessions pay it every turn.
		if (!state.saw413 && !isByteLimitedModel(ctx?.model)) return;
		const messages = (event as { messages?: MessageLike[] } | undefined)?.messages;
		if (!Array.isArray(messages)) return;
		// Incremental accounting: cached per-message sizes make repeat events O(tail)
		// instead of a 4.6 MB stringify, while byte totals stay ~identical (A/B verified).
		const msgBytes = cachedArrayBytes(messages);
		state.lastMessagesBytes = msgBytes;
		state.awaitingContextPayload = true;

		const triggerBytes = state.saw413 ? SHED_TRIGGER_AFTER_413_BYTES : SHED_TRIGGER_BYTES;
		const targetBytes = state.saw413 ? SHED_TARGET_AFTER_413_BYTES : SHED_TARGET_BYTES;
		const effectiveOverhead = state.overheadBytes > 0 ? state.overheadBytes : DEFAULT_OVERHEAD_BYTES;
		if (msgBytes + effectiveOverhead < triggerBytes) return;

		const targetMsgBytes = Math.max(MIN_MSG_BUDGET_BYTES, targetBytes - effectiveOverhead);
		const shed = shedMessagesForByteLimit(messages, targetMsgBytes);
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
		const summaryBudget = Math.max(128 * 1024, COMPACT_INPUT_BYTES - prevBytes);
		trimCompactionInput(prep.messagesToSummarize, summaryBudget);
		trimCompactionInput(prep.turnPrefixMessages, Math.round(COMPACT_INPUT_BYTES / 2));
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

// Self-check: `node extensions/autocompact.ts`
if (isMain(import.meta.url)) {
	// The real agent dir must not decide pass/fail, and the test must not touch it.
	const fixture = mkdtempSync(join(tmpdir(), "arnative-autocompact-"));
	process.env.PI_CODING_AGENT_DIR = fixture;
	delete (globalThis as Record<symbol, unknown>)[AUTO_COMPACT_CONFIG_KEY];

	// Choice parsing and persistence.
	assert(activeAutoCompact() === "Off", "the default is off");
	assert(activeAutoCompactThreshold(1_048_576) === null, "off reads as no threshold");
	setAutoCompact("200k");
	assert(activeAutoCompactThreshold(131072) === 200000, "a manual budget ignores the window");
	assert(loadChoice(AUTO_COMPACT_KEY, AUTO_COMPACT_CHOICES) === "200k", "the choice survives a restart (read from disk)");

	// Smart's tier table: scales to 90% with Render cache On, and falls back to ~200k tiers when Off.
	setRenderCache("On");
	assert(smartPercent(131072) === null, "128k defers to pi core (the 100% tier)");
	assert(smartPercent(196607) === null, "just under the 192k tier edge still defers");
	assert(smartPercent(196608) === 90, "the 192k tier edge takes 90% when render cache is On");
	assert(smartPercent(262144) === 90, "256k takes 90% when render cache is On");
	assert(smartPercent(524288) === 90, "512k takes 90% when render cache is On");
	assert(smartPercent(1048576) === 90, "1M takes 90% when render cache is On");
	assert(smartPercent(1048576, false) === 20, "1M falls back to 20% when render cache is Off");
	assert(smartPercent(524288, false) === 40, "512k falls back to 40% when render cache is Off");
	assert(smartPercent(262144, false) === 80, "256k falls back to 80% when render cache is Off");
	setAutoCompact("Smart");
	assert(activeAutoCompactThreshold(1048576) === 943718, "Smart + Render cache On triggers at 90% of 1M");
	assert(activeAutoCompactThreshold(262144) === 235930, "Smart + Render cache On triggers at 90% of 256k");
	assert(activeAutoCompactThreshold(131072) === null, "Smart on 128k defers to pi core");
	setRenderCache("Off");
	assert(activeAutoCompactThreshold(1048576) === 209715, "Smart + Render cache Off falls back to ~200k on 1M");
	assert(activeAutoCompactThreshold(262144) === 209715, "Smart + Render cache Off falls back to ~205k on 256k");
	setRenderCache("On");
	setAutoCompact("Off");
	assert(activeAutoCompactThreshold(1048576) === null, "switching back to off disables the trigger");

	// Remote / 413 detection helpers.
	assert(isByteLimitedModel({ id: "remote/agy-cli/gemini-4-hydrogen" }), "remote/* is byte-limited");
	assert(isByteLimitedModel({ id: "remote-magpie/auto/glm-5.3" }), "remote-magpie/* is byte-limited");
	assert(!isByteLimitedModel({ id: "auto/zaicoding_glm-5.3" }), "non-remote model is not byte-limited by default");
	assert(isPayloadTooLargeError('413 {"error":{"type":"request_too_large"}}'), "detects HTTP 413 request_too_large");
	assert(!isPayloadTooLargeError("429 rate limit"), "ignores non-413 errors");

	// Decision table (tokens only — byte protection stays decoupled from ctx.compact).
	const s = freshAutoCompactState();
	assert(autoCompactDecision(s, null, 200000) === "wait", "no usage estimate: wait");
	assert(autoCompactDecision(s, 199999, 200000) === "wait", "below the threshold: wait");
	assert(autoCompactDecision(s, 200000, 200000) === "compact", "at the threshold with fresh state: compact");
	s.inFlight = true;
	assert(autoCompactDecision(s, 250000, 200000) === "wait", "a compaction is still running: wait");
	s.inFlight = false;
	s.blockedUntilTokens = 260000;
	assert(autoCompactDecision(s, 250000, 200000) === "wait", "below the failure backoff: wait");
	s.blockedUntilTokens = 0;
	s.attemptSettled = true;
	s.lastAttemptTokens = 240000;
	assert(autoCompactDecision(s, 245000, 200000) === "wait", "a settled attempt that freed too little waits for the growth margin");
	assert(autoCompactDecision(s, 250500, 200000) === "compact", "usage outgrew the settled attempt: compact again");

	// Rearm after a dip: shallow keeps the attempt memory, deep forgets it.
	const r = freshAutoCompactState();
	r.lastAttemptTokens = 200000;
	r.attemptSettled = true;
	r.blockedUntilTokens = 200001;
	rearmAfterDip(r, 195000, 200000);
	assert(r.lastAttemptTokens === 200000, "a shallow dip keeps the attempt memory");
	rearmAfterDip(r, 189000, 200000);
	assert(r.lastAttemptTokens === null && r.attemptSettled === false && r.blockedUntilTokens === 0, "a real drop forgets the attempt and re-arms");

	// Mid-run byte shedding keeps recent tail + latest image + latest thinking + tool pairing intact.
	const bigText = "x".repeat(80_000);
	const sampleMsgs: MessageLike[] = [
		{ role: "user", content: [{ type: "text", text: "goal" }, { type: "image", data: "A".repeat(40_000) }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "T".repeat(30_000), thinkingSignature: "sig123" } as ContentBlockLike,
				{ type: "toolCall", arguments: { path: "a.ts" } },
			],
		},
		{ role: "toolResult", content: [{ type: "text", text: bigText }] },
		{ role: "assistant", content: [{ type: "toolCall", arguments: { path: "b.ts" } }] },
		{ role: "toolResult", content: [{ type: "text", text: bigText }] },
		{ role: "user", content: [{ type: "text", text: "latest" }, { type: "image", data: "B".repeat(20_000) }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "keep latest thinking", thinkingSignature: "sigLatest" } as ContentBlockLike,
				{ type: "text", text: "working" },
			],
		},
	];
	const shed = shedMessagesForByteLimit(sampleMsgs, 90_000);
	assert(shed.changed && shed.bytes <= 90_000, "shedding brings oversized messages under budget");
	assert((shed.messages[0].content as ContentBlockLike[])[1].type === "text", "earlier image is omitted");
	assert(
		!(shed.messages[1].content as ContentBlockLike[]).some((b) => b.type === "thinking"),
		"earlier thinking and signature are dropped before latest user turn",
	);
	assert((shed.messages[5].content as ContentBlockLike[])[1].type === "image", "latest image is kept");
	assert(
		(shed.messages[6].content as ContentBlockLike[]).some((b) => b.type === "thinking"),
		"latest turn thinking is kept",
	);
	assert((shed.messages[2].content as ContentBlockLike[])[0].text === TRIMMED_TOOL_STUB, "old tool result trimmed");
	assert((sampleMsgs[2].content as ContentBlockLike[])[0].text === bigText, "shedding never mutates original messages");

	// Compaction input trimming shrinks huge toolCall args without mutating originals.
	const hugeWriteArgs = "y".repeat(20_000);
	const compactInput: MessageLike[] = [
		{ role: "assistant", content: [{ type: "toolCall", arguments: { path: "big.ts", content: hugeWriteArgs } }] },
	];
	assert(trimCompactionInput(compactInput, 5_000), "trimCompactionInput shrinks oversized toolCall arguments");
	assert((compactInput[0].content as ContentBlockLike[])[0].arguments!.content !== hugeWriteArgs, "cloned argument was truncated");

	// Emergency tail trim: a single massive toolResult in the newest turn still sheds below target.
	const tailOnlyHuge: MessageLike[] = [
		{ role: "user", content: [{ type: "text", text: "run tool" }] },
		{ role: "toolResult", content: [{ type: "text", text: "y".repeat(SHED_TRIGGER_BYTES + 20_000) }] },
	];
	const tailShed = shedMessagesForByteLimit(tailOnlyHuge, 100_000);
	assert(tailShed.changed && tailShed.bytes <= 100_000, "emergency tail trim bounds even a single giant newest message");

	// Registered handlers against a fake pi: Smart + Render cache On uses 90% on 1M (~943k tokens),
	// while Render cache Off falls back to ~200k tokens.
	setRenderCache("Off");
	setAutoCompact("Smart");
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	registerAutoCompact({ on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => void (handlers[name] = fn) } as never);
	const compactCalls: number[] = [];
	const ctxOf = (tokens: number | null, contextWindow = 1_048_576, model?: { id: string }) => ({
		model,
		getContextUsage: () => ({ tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 }),
		compact: () => compactCalls.push(tokens ?? -1),
	});

	await handlers.session_start!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(210000));
	assert(compactCalls.length === 1 && compactCalls[0] === 210000, "usage at/above the threshold triggers pi's compaction");
	await handlers.agent_before_settle!({}, ctxOf(215000));
	assert(compactCalls.length === 1, "the anti-flap guard blocks an immediate re-trigger");
	await handlers.session_compact!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(215000));
	assert(compactCalls.length === 1, "a settled attempt that still sits above the threshold waits for growth");
	await handlers.agent_before_settle!({}, ctxOf(222000));
	assert(compactCalls.length === 2 && compactCalls[1] === 222000, "usage outgrowing the attempt compacts again");
	await handlers.session_compact!({}, undefined); // the compaction that made usage drop
	await handlers.agent_before_settle!({}, ctxOf(60000));
	assert(compactCalls.length === 2, "below the threshold nothing fires");
	await handlers.agent_before_settle!({}, ctxOf(210500));
	assert(compactCalls.length === 3 && compactCalls[2] === 210500, "the next crossing starts a fresh cycle");

	// Oscillation at the threshold: one compaction per growth margin, not every turn.
	await handlers.session_compact!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(208000)); // shallow dip under the threshold
	await handlers.agent_before_settle!({}, ctxOf(211000));
	assert(compactCalls.length === 3, "an oscillation at the threshold does not re-summarize every turn");
	await handlers.agent_before_settle!({}, ctxOf(222000));
	assert(compactCalls.length === 4 && compactCalls[3] === 222000, "real growth past the attempt compacts again");

	// A failed compaction backs off; session_start clears the backoff for a fresh session.
	await handlers.session_compact_failed!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(225000));
	assert(compactCalls.length === 4, "after a failure the backoff holds below attempt + margin");
	await handlers.agent_before_settle!({}, ctxOf(234000));
	assert(compactCalls.length === 5, "and gives way once usage outgrows the failed attempt");
	await handlers.session_compact_failed!({}, undefined);
	await handlers.session_start!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(210500));
	assert(compactCalls.length === 6, "a fresh session clears the backoff");

	// Smart + Render cache On: scales 1M window to 90% (~943k), and remote 1 MB payloads shed silently
	// without forcing premature session compaction at low token counts (e.g. 49k–110k).
	setRenderCache("On");
	await handlers.session_start!({}, undefined);
	const remoteCtx = ctxOf(49836, 1_048_576, { id: "remote/agy-cli/gemini-4-hydrogen" });
	const hugeRunMsgs: MessageLike[] = [
		{ role: "user", content: [{ type: "text", text: "start" }] },
		{ role: "assistant", content: [{ type: "toolCall", arguments: { path: "x" } }] },
		{ role: "toolResult", content: [{ type: "text", text: "z".repeat(SHED_TRIGGER_BYTES + 10_000) }] },
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const ctxResult = (await handlers.context!({ messages: hugeRunMsgs }, remoteCtx)) as { messages?: MessageLike[] } | undefined;
	assert(
		Array.isArray(ctxResult?.messages) &&
			jsonByteLength(ctxResult.messages) + DEFAULT_OVERHEAD_BYTES <= SHED_TARGET_BYTES,
		"context hook sheds payload with hysteresis down to ~760 KB before 1 MB",
	);
	await handlers.before_provider_request!({ payload: { blob: "p".repeat(SHED_TRIGGER_BYTES + 20_000) } }, remoteCtx);
	await handlers.agent_before_settle!({}, remoteCtx);
	assert(compactCalls.length === 6, "remote byte shedding does not force premature compaction at 49k tokens");

	// Only crossing 90% of 1M context triggers Smart compaction when Render cache is On.
	await handlers.agent_before_settle!({}, ctxOf(900000, 1_048_576, { id: "remote/agy-cli/gemini-4-hydrogen" }));
	assert(compactCalls.length === 6, "900k tokens is still under 90% of 1M");
	await handlers.agent_before_settle!({}, ctxOf(945000, 1_048_576, { id: "remote/agy-cli/gemini-4-hydrogen" }));
	assert(compactCalls.length === 7 && compactCalls[6] === 945000, "945k tokens hits 90% Smart threshold and compacts");
	await handlers.session_compact!({}, undefined);

	// Compaction input trimming shrinks split-turn prefixes cleanly without triggering follow-ups.
	const splitTurnPrefix: MessageLike[] = [
		{ role: "assistant", content: [{ type: "toolCall", arguments: { content: "q".repeat(COMPACT_INPUT_BYTES) } }] },
	];
	await handlers.session_before_compact!({ preparation: { turnPrefixMessages: splitTurnPrefix } }, remoteCtx);
	assert(jsonByteLength(splitTurnPrefix) < COMPACT_INPUT_BYTES, "session_before_compact trims split-turn prefix messages too");

	// Remote 1 MB silent shedding stays active even when Auto-compact is Off, and never triggers ctx.compact().
	setAutoCompact("Off");
	await handlers.session_start!({}, undefined);
	const manyMsgs: MessageLike[] = [];
	for (let i = 0; i < 900; i++) {
		manyMsgs.push(
			{ role: "user", content: [{ type: "text", text: `turn ${i}: ` + "u".repeat(350) }] },
			{ role: "assistant", content: [{ type: "toolCall", arguments: { cmd: `echo ${i}` } }] },
			{ role: "toolResult", content: [{ type: "text", text: "r".repeat(600) }] },
			{ role: "assistant", content: [{ type: "text", text: "a".repeat(350) }] },
		);
	}
	assert(jsonByteLength(manyMsgs) > 1_048_576, "fixture exceeds 1 MB across thousands of messages");
	const shedMany = (await handlers.context!({ messages: manyMsgs }, remoteCtx)) as { messages?: MessageLike[] } | undefined;
	assert(
		Array.isArray(shedMany?.messages) &&
			jsonByteLength(shedMany.messages) <= SHED_TARGET_BYTES &&
			shedMany.messages[0]?.role === "user",
		"many-message session sheds below 1 MB even with Auto-compact Off",
	);
	const compactMany = manyMsgs.slice();
	await handlers.session_before_compact!({ preparation: { messagesToSummarize: compactMany } }, remoteCtx);
	assert(
		jsonByteLength(compactMany) <= COMPACT_INPUT_BYTES && compactMany[0]?.role !== "toolResult",
		"many-message compaction input trims below 720 KB without orphaned toolResult",
	);
	await handlers.agent_before_settle!({}, ctxOf(950000, 1_048_576, { id: "remote/agy-cli/gemini-4-hydrogen" }));
	assert(compactCalls.length === 7, "Auto-compact Off never calls ctx.compact() even at 950k tokens on remote/*");

	// Non-remote model that hits HTTP 413 tightens silent shedding without forcing compaction.
	const nonRemoteCtx = ctxOf(50000, 1_048_576, { id: "custom/model" });
	await handlers.turn_end!({ message: { stopReason: "error", errorMessage: "413 request_too_large" } }, nonRemoteCtx);
	const after413 = (await handlers.context!({ messages: hugeRunMsgs }, nonRemoteCtx)) as { messages?: MessageLike[] } | undefined;
	assert(
		Array.isArray(after413?.messages) &&
			jsonByteLength(after413.messages) + DEFAULT_OVERHEAD_BYTES <= SHED_TARGET_AFTER_413_BYTES,
		"saw413 activates tighter silent shedding on any model",
	);
	setAutoCompact("Smart");

	// i1 guard: models with no byte wall never measure payload bytes at all.
	await handlers.session_start!({}, undefined);
	const plainCtx = ctxOf(210000, 1_048_576, { id: "auto/zaicoding_glm-5.3" });
	const plainMsgs: MessageLike[] = [{ role: "user", content: [{ type: "text", text: "plain" }] }];
	const plainResult = (await handlers.context!({ messages: plainMsgs }, plainCtx)) as { messages?: MessageLike[] } | undefined;
	assert(plainResult === undefined, "non-remote context hook skips byte measurement entirely");
	const overheadBefore = trackedOverheadBytes;
	const plainReq = await handlers.before_provider_request!({ payload: { blob: "p".repeat(4 * 1024 * 1024) } }, plainCtx);
	assert(plainReq === undefined && trackedOverheadBytes === overheadBefore, "non-remote before_provider_request skips the 4 MB stringify");

	// The 128k case from the field: Smart defers the whole window to pi's own
	// compaction — no percent, however close to full, ever fires ours.
	await handlers.session_start!({}, undefined);
	await handlers.agent_before_settle!({}, ctxOf(130000, 131072));
	assert(compactCalls.length === 7, "a 128k window under Smart never triggers: pi core stays in charge");

	// Older hosts: missing ctx APIs must degrade to a no-op, not throw.
	await handlers.agent_before_settle!({}, { getContextUsage: () => undefined });
	assert(compactCalls.length === 7, "no usage estimate: no trigger");
	// Reset inFlight first, so the missing compact() — not a pending compaction — is what stops it.
	await handlers.session_start!({}, undefined);
	await handlers.agent_before_settle!({}, { getContextUsage: () => ({ tokens: 950000, contextWindow: 1_048_576, percent: 90.6 }) });
	assert(compactCalls.length === 7, "no ctx.compact on the host: no trigger");

	// Restore: the next module load starts from the real agent dir and the stored default.
	rmSync(fixture, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete (globalThis as Record<symbol, unknown>)[AUTO_COMPACT_CONFIG_KEY];
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.renderCache")];
	resetPresetCache();
	console.log("autocompact.ts self-check OK");
}
