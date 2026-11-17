import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetPresetCache } from "../lib/preset-store.ts";
import registerAutoCompact, { wireBytesSnapshot } from "../extensions/autocompact.ts";

// Wire-bytes footer segment (i3): byte-limited models expose payload pressure
// through wireBytesSnapshot(); plain models never populate it.

test("wireBytesSnapshot reports payload pressure only after byte-limited context events", async () => {
	const dir = mkdtempSync(join(tmpdir(), "arnative-wirebytes-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();
	try {
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
		assert.ok(snap.bytes > 4096, "bytes include the message payload");
		assert.equal(snap.limit, 900 * 1024, "limit is the shed trigger (~900 KB)");

		// A shed (over trigger) is reflected: bytes drop under the target.
		const bigMsgs = [
			{ role: "user", content: [{ type: "text", text: "x".repeat(950 * 1024) }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		];
		const shed = (await handlers.context!({ messages: bigMsgs }, remoteCtx)) as { messages?: unknown[] } | undefined;
		assert.ok(Array.isArray(shed?.messages), "oversized remote payload sheds");
		const after = wireBytesSnapshot();
		assert.ok(after, "snapshot survives the shed");
		assert.ok(after.bytes < 900 * 1024, `shed snapshot under trigger, got ${(after.bytes / 1024).toFixed(0)}KB`);
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.autocompactState")];
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
});
