// Render A/B for the wire-bytes footer segment (i3): byte-limited model shows ◆ x.xxMB/1MB,
// plain model never does, and the segment ordering around the context icon stays intact.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetPresetCache } from "../lib/preset-store.ts";
import registerAutoCompact from "../extensions/autocompact.ts";
import { getUsage } from "../extensions/footer.ts";
import { wireBytesSnapshot } from "../extensions/autocompact.ts";

const plain = (text: string) => text;
const sessionManager = { getBranch: (): readonly unknown[] => [] };

test("wire-bytes segment: A/B render between byte-limited and plain models", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "wire-bytes-ab-"));
	process.env.PI_CODING_AGENT_DIR = fixture;
	try {
		resetPresetCache();
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		registerAutoCompact({ on: (name, fn) => void (handlers[name] = fn) } as never);

		const ctx = (modelId: string) => ({
			model: { id: modelId },
			sessionManager,
			getContextUsage: () => ({ tokens: 50000, contextWindow: 1_048_576, percent: 4.8 }),
		});

		// Prime the snapshot via a remote context event (~100 KB payload).
		const msgs = [{ role: "user", content: [{ type: "text", text: "y".repeat(100 * 1024) }] }];
		await handlers.context!({ messages: msgs }, ctx("remote/agy-cli/gemini-4-hydrogen"));
		assert.ok(wireBytesSnapshot(), "snapshot primed");

		// A: byte-limited model — segment renders.
		const lineA = getUsage(ctx("remote/agy-cli/gemini-4-hydrogen"), plain, plain);
		// B: plain model — no segment, despite the same snapshot state.
		const lineB = getUsage(ctx("auto/zaicoding_glm-5.3"), plain, plain);

		assert.match(lineA, /◆\s+0\.1[0-9]+MB\/1MB/, "byte-limited model renders the wire segment");
		assert.ok(!lineB.includes("MB/1MB"), "plain model never renders the wire segment");
		assert.ok(lineA.includes("4.8%"), "context percent still present alongside the wire segment");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
		resetPresetCache();
	}
});
