// Render A/B for the wire-bytes footer segment (i3): byte-limited model shows the ◆/󰆓 x.xxMB/1MB segment,
// plain model never does, and the segment ordering around the context icon stays intact.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

		assert.match(lineA, /\udb80\udd93\s+0\.1[0-9]+MB\/1MB/, "byte-limited model renders the wire segment");
		assert.ok(lineA.includes("· \udb80\udd93"), "a divider separates the wire segment from the context group");
		assert.ok(!lineB.includes("MB/1MB"), "plain model never renders the wire segment");
		assert.ok(lineA.includes("4.8%"), "context percent still present alongside the wire segment");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
		resetPresetCache();
	}
});

test("the wire divider paints dim, not accent or soft", async () => {
	// With distinct painters the rendered line shows exactly which role each span
	// took, so the divider assertion cannot pass on a shared painter by accident.
	const dir = mkdtempSync(join(tmpdir(), "arnative-wire-dim-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();

	try {
		mkdirSync(join(dir, "arnative"), { recursive: true });
		writeFileSync(
			join(dir, "arnative", "config.json"),
			JSON.stringify({ footer: "Full", footerCost: "On" }),
		);
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerAutoCompact({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
			},
		} as never);

		const msgs = [{ role: "user", content: [{ type: "text", text: "x".repeat(120 * 1024) }] }];
		await handlers.get("context")?.({ messages: msgs }, { model: { id: "remote/magpie-glm" } });

		const { getUsage } = await import("../extensions/footer.ts");
		const line = getUsage(
			{
				sessionManager: { getBranch: () => [] },
				getContextUsage: () => ({ tokens: 48000, contextWindow: 1_000_000, percent: 4.8 }),
				model: { id: "remote/magpie-glm", provider: "remote" },
			},
			(t) => `<A>${t}</A>`,
			(t) => `<S>${t}</S>`,
			false,
			400,
			undefined,
			(t) => `<D>${t}</D>`,
		);
		assert.ok(line.includes("<D>·</D>"), "divider before the wire cell is dim");
		assert.ok(line.includes("<A>\udb80\udd93</A>"), "wire icon takes the accent painter");
	} finally {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
});
