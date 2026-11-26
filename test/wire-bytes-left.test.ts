// The wire-bytes cell renders on the LEFT rows beside the extension statuses,
// not among the right-hand metrics (speed, cache, tokens, cost).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { resetPresetCache } from "../lib/preset-store.ts";
import registerAutoCompact from "../lib/features/autocompact.ts";
import registerFooter from "../lib/features/footer.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const tui = { requestRender: () => {}, handleTerminalInput: (_d: string) => {} };

/** Render the real footer at a width where the left row has room. */
async function renderLeftRow(model: { id: string; provider: string }): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "arnative-wire-left-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();
	try {
		mkdirSync(join(dir, "arnative"), { recursive: true });
		writeFileSync(join(dir, "arnative", "config.json"), JSON.stringify({ footer: "Arnative (Full)", footerCost: "On" }));

		// Seed the byte snapshot the way a turn does.
		const autoHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerAutoCompact({ on: (e: string, h: never) => autoHandlers.set(e, h) } as never);
		await autoHandlers.get("context")!(
			{ messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(200 * 1024) }] }] },
			{ model },
		);

		let factory: ((t: unknown, th: unknown, fd: unknown) => { render(w: number): string[] }) | undefined;
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const noop = () => {};
		registerFooter({ on: (e: string, h: never) => handlers.set(e, h), registerCommand: noop, registerShortcut: noop } as never);
		await handlers.get("session_start")?.(
			{},
			{
				ui: { setFooter: (f: never) => { factory = f; } },
				model,
				cwd: dir,
				sessionManager: { getBranch: () => [], getHeader: () => ({ timestamp: new Date().toISOString() }) },
			},
		);
		assert.ok(factory, "footer factory registered");
		const footer = factory(tui, theme, {
			getExtensionStatuses: () => new Map([["jev", " Eye: \u25cf ON (Jev)"]]),
			onBranchChange: () => () => {},
		});
		const out = footer.render(200).join("\n");
		footer.dispose?.();
		// session_start started the clock tick; shutdown stops it so the test process exits.
		await handlers.get("session_shutdown")?.({}, {});
		return out;
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		resetPresetCache();
		// Windows keeps a handle briefly after the shutdown flush; retry instead of failing.
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
}

test("wire bytes render on the left beside the extension statuses", async () => {
	const line = await renderLeftRow({ id: "remote/auto/glm-5.3", provider: "magpie" });
	console.log("LINE:\n" + line);
	assert.match(line, /● ON \(Jev\)/, "status renders");
	// The denominator is the live shed trigger, so the assertion follows the wall
	// instead of pinning 900KB: the same label shape must survive PI_ARNATIVE_BYTE_WALL_MB.
	assert.match(line, /\udb80\udd93 0\.2[0-9]MB\/\d+(\.\d+)?(KB|MB)/, "wire cell shows payload against the live ceiling");
	assert.ok(!line.includes("/1MB "), "the raw proxy wall is not the denominator");
});

test("a model without a byte wall never renders the wire cell", async () => {
	const line = await renderLeftRow({ id: "gpt-6.1-sol", provider: "agentrouter" });
	console.log("LINE:\n" + line);
	assert.match(line, /\u25cf ON \(Jev\)/, "status still renders");
	assert.ok(!line.includes("MB/"), "no wire cell for a plain model");
});

test("the wire cell keeps the dim dot separator", async () => {
	const line = await renderLeftRow({ id: "remote/auto/glm-5.3", provider: "magpie" });
	assert.match(line, /\u25cf ON \(Jev\) · \udb80\udd93/, "status and wire cell split by the row separator");
});
