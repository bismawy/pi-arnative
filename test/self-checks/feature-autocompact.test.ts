import test from "node:test";
import { assert } from "../helpers/check.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAYLOAD_LIMIT_KEY, loadChoice, resetPresetCache, saveChoice } from "../../lib/preset-store.ts";
import { setRenderCache } from "../../lib/features/render-cache.ts";
import registerAutoCompact, { AUTO_COMPACT_CHOICES, AUTO_COMPACT_KEY, PAYLOAD_LIMIT_CONFIG_KEY, parsePayloadLimit, savedPayloadLimit, activePayloadLimit, setPayloadLimit, activeByteCeilings, smartPercent, activeAutoCompact, activeAutoCompactThreshold, setAutoCompact, freshAutoCompactState, isByteLimitedModel, isPayloadTooLargeError, jsonByteLength, autoCompactDecision, rearmAfterDip, shedMessagesForByteLimit, trimCompactionInput, wireBytesSnapshot, type ContentBlockLike, type MessageLike, __test } from "../../lib/features/autocompact.ts";

const { DEFAULT_OVERHEAD_BYTES, TRIMMED_TOOL_STUB, AUTO_COMPACT_CONFIG_KEY } = __test;

test("lib/features/autocompact.ts self-check", async () => {
	// The real agent dir must not decide pass/fail, and the test must not touch it.
	const fixture = mkdtempSync(join(tmpdir(), "arnative-autocompact-"));
	process.env.PI_CODING_AGENT_DIR = fixture;
	delete (globalThis as Record<symbol, unknown>)[AUTO_COMPACT_CONFIG_KEY];
	delete (globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY];
	resetPresetCache();

	// Payload limit parsing, persistence, and Off mode.
	assert(parsePayloadLimit("off") === "Off", "parses off case-insensitively");
	assert(parsePayloadLimit("11") === "11 MB" && parsePayloadLimit("11mb") === "11 MB", "normalizes MB unit");
	assert(parsePayloadLimit(16) === "16 MB", "accepts numeric MB");
	assert(parsePayloadLimit("0") === undefined && parsePayloadLimit("2000") === undefined && parsePayloadLimit("abc") === undefined, "rejects out-of-range or invalid payload limits");
	assert(savedPayloadLimit() === "1 MB", "stored payload limit defaults to 1 MB");
	setPayloadLimit("11 MB");
	assert(activePayloadLimit() === "11 MB" && savedPayloadLimit() === "11 MB", "custom payload limit applies live and persists");
	assert(activeByteCeilings()!.shedTriggerBytes === Math.round(900 * 1024 * 11), "custom MB scales shed trigger");
	setPayloadLimit("Off");
	assert(activeByteCeilings() === null, "Off disables byte ceilings");
	delete (globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY];
	saveChoice(PAYLOAD_LIMIT_KEY, "1 MB");
	resetPresetCache();
	const liveCeilings = activeByteCeilings()!;

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
		{ role: "toolResult", content: [{ type: "text", text: "y".repeat(liveCeilings.shedTriggerBytes + 20_000) }] },
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
		{ role: "toolResult", content: [{ type: "text", text: "z".repeat(liveCeilings.shedTriggerBytes + 10_000) }] },
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const ctxResult = (await handlers.context!({ messages: hugeRunMsgs }, remoteCtx)) as { messages?: MessageLike[] } | undefined;
	assert(
		Array.isArray(ctxResult?.messages) &&
			jsonByteLength(ctxResult.messages) + DEFAULT_OVERHEAD_BYTES <= liveCeilings.shedTargetBytes,
		"context hook sheds payload with hysteresis down to the target ceiling",
	);
	await handlers.before_provider_request!({ payload: { blob: "p".repeat(liveCeilings.shedTriggerBytes + 20_000) } }, remoteCtx);
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
		{ role: "assistant", content: [{ type: "toolCall", arguments: { content: "q".repeat(liveCeilings.compactInputBytes) } }] },
	];
	await handlers.session_before_compact!({ preparation: { turnPrefixMessages: splitTurnPrefix } }, remoteCtx);
	assert(jsonByteLength(splitTurnPrefix) < liveCeilings.compactInputBytes, "session_before_compact trims split-turn prefix messages too");

	// Remote byte silent shedding stays active even when Auto-compact is Off, and never triggers ctx.compact().
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
	assert(jsonByteLength(manyMsgs) > 1_048_576, "fixture spans thousands of messages and over a megabyte");
	const shedMany = (await handlers.context!({ messages: manyMsgs }, remoteCtx)) as { messages?: MessageLike[] } | undefined;
	// A fixture sized for the 1 MB default says nothing once the wall scales: at 16 MB
	// the same array is far under the trigger and the hook rightly stays quiet.
	// Size it against the ceiling in force, or skip when scaling makes that impractical.
	const overTrigger = jsonByteLength(manyMsgs) > liveCeilings.shedTriggerBytes;
	if (overTrigger) {
		assert(
			Array.isArray(shedMany?.messages) &&
				jsonByteLength(shedMany.messages) <= liveCeilings.shedTargetBytes &&
				shedMany.messages[0]?.role === "user",
			"many-message session sheds below the ceiling even with Auto-compact Off",
		);
	} else {
		assert(shedMany === undefined, "a fixture under the scaled trigger is left untouched");
	}
	const compactMany = manyMsgs.slice();
	await handlers.session_before_compact!({ preparation: { messagesToSummarize: compactMany } }, remoteCtx);
	assert(
		jsonByteLength(compactMany) <= liveCeilings.compactInputBytes && compactMany[0]?.role !== "toolResult",
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
			jsonByteLength(after413.messages) + DEFAULT_OVERHEAD_BYTES <= liveCeilings.shedTargetAfter413Bytes,
		"saw413 activates tighter silent shedding on any model",
	);
	// Payload limit Off skips shedding and clears wireBytesSnapshot even for remote models.
	setPayloadLimit("Off");
	const offResult = await handlers.context!({ messages: hugeRunMsgs }, remoteCtx);
	assert(offResult === undefined && wireBytesSnapshot() === null, "Off disables silent shedding and wireBytesSnapshot");
	delete (globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY];
	setAutoCompact("Smart");

	// i1 guard: models with no byte wall never measure payload bytes at all.
	await handlers.session_start!({}, undefined);
	const plainCtx = ctxOf(210000, 1_048_576, { id: "auto/zaicoding_glm-5.3" });
	const plainMsgs: MessageLike[] = [{ role: "user", content: [{ type: "text", text: "plain" }] }];
	const plainResult = (await handlers.context!({ messages: plainMsgs }, plainCtx)) as { messages?: MessageLike[] } | undefined;
	assert(plainResult === undefined, "non-remote context hook skips byte measurement entirely");
	const overheadBefore = __test.trackedOverheadBytes;
	const plainReq = await handlers.before_provider_request!({ payload: { blob: "p".repeat(4 * 1024 * 1024) } }, plainCtx);
	assert(plainReq === undefined && __test.trackedOverheadBytes === overheadBefore, "non-remote before_provider_request skips the 4 MB stringify");

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
	delete (globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY];
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.renderCache")];
	resetPresetCache();
});
