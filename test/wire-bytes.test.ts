import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetPresetCache } from "../lib/preset-store.ts";
import { getRuntime } from "../lib/runtime.ts";
import registerAutoCompact, {
	PAYLOAD_LIMIT_CONFIG_KEY,
	activeByteCeilings,
	cachedArrayBytes,
	jsonByteLength,
	shedMessagesForByteLimit,
	wireBytesSnapshot,
} from "../lib/features/autocompact.ts";

// Byte-limited models expose payload pressure through wireBytesSnapshot();
// plain models never populate it.

test("cachedArrayBytes matches serialized UTF-8 bytes for all message content", () => {
	for (const text of ["ASCII", "界".repeat(100), "😀".repeat(100), 'quote " and slash \\', "\n\t\0", "\ud800"]) {
		const messages = [{ role: "user", content: [{ type: "text", text }], optional: undefined }];
		const expected = Buffer.byteLength(JSON.stringify(messages), "utf8");
		assert.equal(cachedArrayBytes(messages), expected);
		assert.equal(cachedArrayBytes(structuredClone(messages)), expected, "cloned requests retain exact sizes");
	}
});

test("cachedArrayBytes measures changed transcripts without stale identity caches", () => {
	const messages = [{ role: "user", content: [{ type: "text", text: "start" }] }];
	assert.equal(cachedArrayBytes(messages), jsonByteLength(messages));
	messages[0]!.content[0]!.text = "界".repeat(500);
	assert.equal(cachedArrayBytes(messages), jsonByteLength(messages), "nested mutation is measured");
	messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
	assert.equal(cachedArrayBytes(messages), jsonByteLength(messages), "appended message is measured");
	messages[0] = { role: "user", content: [{ type: "text", text: "replacement" }] };
	assert.equal(cachedArrayBytes(messages), jsonByteLength(messages), "same-length replacement is measured");
	messages.pop();
	assert.equal(cachedArrayBytes(messages), jsonByteLength(messages), "shorter transcript is measured");
});

test("shed byte totals include JSON array separators before and after reduction", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "start" }] },
		{ role: "assistant", content: [{ type: "toolCall", id: "call_size", name: "read", arguments: { path: "file" } }] },
		{ role: "toolResult", toolCallId: "call_size", content: [{ type: "text", text: "界".repeat(1000) }] },
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const unchanged = shedMessagesForByteLimit(messages, jsonByteLength(messages));
	assert.equal(unchanged.changed, false);
	assert.equal(unchanged.bytes, jsonByteLength(unchanged.messages));
	const reduced = shedMessagesForByteLimit(messages, 1024);
	assert.equal(reduced.changed, true);
	assert.equal(reduced.bytes, jsonByteLength(reduced.messages));
});

test("Unicode payload over the byte trigger sheds on the first context event", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-wirebytes-unicode-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete (globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY];
	resetPresetCache();
	t.after(() => {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		getRuntime().autocompactState = null;
		delete (globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY];
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	});
	const shedTrigger = activeByteCeilings()!.shedTriggerBytes;
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	registerAutoCompact({
		on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => void (handlers[name] = fn),
	} as never);
	const messages = [
		{ role: "user", content: [{ type: "text", text: "start" }] },
		{ role: "assistant", content: [{ type: "toolCall", id: "call_unicode", name: "read", arguments: { path: "file" } }] },
		{ role: "toolResult", toolCallId: "call_unicode", content: [{ type: "text", text: "界".repeat(Math.ceil(shedTrigger / 2)) }] },
		{ role: "user", content: [{ type: "text", text: "continue" }] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	];
	const original = structuredClone(messages);
	assert.ok(jsonByteLength(messages) > shedTrigger);
	const result = await handlers.context!({ messages }, { model: { id: "remote/test" } }) as { messages?: unknown[] } | undefined;
	assert.ok(Array.isArray(result?.messages), "UTF-8 size triggers shedding without a previous request");
	assert.ok(jsonByteLength(result.messages) < shedTrigger);
	assert.deepEqual(messages, original, "source transcript remains intact");
});

test("wireBytesSnapshot reports payload pressure only after byte-limited context events", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-wirebytes-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete (globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY];
	resetPresetCache();
	try {
		const shedTrigger = activeByteCeilings()!.shedTriggerBytes;
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		registerAutoCompact({
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => void (handlers[name] = fn),
		} as never);

		assert.equal(wireBytesSnapshot(), null, "no context event yet: no snapshot");

		// Plain model: the context hook skips measurement entirely, so no snapshot.
		const plainMsgs = [{ role: "user", content: [{ type: "text", text: "hello plain" }] }];
		const plainCtx = { model: { id: "auto/glm-5.3" }, getContextUsage: () => undefined };
		await handlers.context!({ messages: plainMsgs }, plainCtx);
		assert.equal(wireBytesSnapshot(), null, "plain model context event: still no snapshot");

		// Byte-limited model: snapshot appears with messages + default overhead.
		const remoteCtx = { model: { id: "remote/agy-cli/gemini-4-hydrogen" }, getContextUsage: () => undefined };
		const remoteMsgs = [{ role: "user", content: [{ type: "text", text: "x".repeat(4096) }] }];
		await handlers.context!({ messages: remoteMsgs }, remoteCtx);
		const snap = wireBytesSnapshot();
		assert.ok(snap, "remote context event populates the snapshot");
		assert.equal(snap.bytes, jsonByteLength(remoteMsgs) + 64 * 1024, "bytes are exact messages plus default overhead");
		assert.equal(snap.limit, shedTrigger, "limit is the live shed trigger, which follows PI_ARNATIVE_BYTE_WALL_MB");

		// A shed (over trigger) is reflected: bytes drop under the target. The fixture is
		// sized from the live ceiling, so it keeps meaning something when the wall scales.
		const bigMsgs = [
			{ role: "user", content: [{ type: "text", text: "x".repeat(shedTrigger + 50 * 1024) }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		];
		const shed = (await handlers.context!({ messages: bigMsgs }, remoteCtx)) as { messages?: unknown[] } | undefined;
		assert.ok(Array.isArray(shed?.messages), "oversized remote payload sheds");
		const after = wireBytesSnapshot();
		assert.ok(after, "snapshot survives the shed");
		assert.ok(after.bytes < shedTrigger, `shed snapshot under trigger, got ${(after.bytes / 1024).toFixed(0)}KB`);
	} finally {
		delete (globalThis as Record<symbol, unknown>)[PAYLOAD_LIMIT_CONFIG_KEY];
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		getRuntime().autocompactState = null;
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
});
