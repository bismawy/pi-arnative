#!/usr/bin/env node
/**
 * Dev benchmark + synthetic session generator for `extensions/render-cache.ts`.
 *
 * Generates a valid v3 Pi `.jsonl` session (default ~300k tokens) in OS temp dir so
 * `git status` stays clean, and benchmarks real Pi transcript components with
 * Render cache `Off` vs `On`.
 *
 * Usage:
 *   node scripts/bench-render-cache.mjs [--tokens 300000] [--out path/to/session.jsonl] [--no-bench]
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { attachChatContainer, clearRenderCache, setRenderCache } from "../extensions/render-cache.ts";

/** Measured chars per token for this generator's code-heavy text (see targetChars). */
const CHARS_PER_TOKEN = 2.26;

function parseArgs(argv) {
	let targetTokens = 300_000;
	let outPath = join(tmpdir(), "pi-arnative-bench-300k.jsonl");
	let runBench = true;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--tokens" && argv[i + 1]) {
			const parsed = Number.parseInt(argv[++i], 10);
			if (Number.isFinite(parsed) && parsed > 0) targetTokens = parsed;
		} else if (arg === "--out" && argv[i + 1]) {
			outPath = resolve(argv[++i]);
		} else if (arg === "--no-bench") {
			runBench = false;
		}
	}
	return { targetTokens, outPath, runBench };
}

function makeAssistantUsage(contextTokens, outputTokens) {
	return {
		input: Math.max(100, contextTokens - outputTokens),
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: contextTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function buildSyntheticTurns(targetTokens) {
	const turns = [];
	// Code, hashes and punctuation tokenize far denser than prose. Measured on a
	// generated 890k session: the provider reported 1,675,111 tokens for 3,779,390
	// chars, so 4 char/token overstates the label by 1.88x and produced sessions
	// that were silently over the model window.
	const targetChars = Math.round(targetTokens * CHARS_PER_TOKEN);
	let totalChars = 0;
	let idx = 0;
	// Start one hour back, but never let the last turn land in the future: a
	// synthetic timestamp ahead of the wall clock breaks compaction and export
	// logic that compares entry times. Spacing shrinks when the session is long.
	const baseTime = Date.now() - 3600_000;

	const sampleCode = [
		"export function computeDigest(items: readonly string[]): string {",
		"\tlet acc = 0x811c9dc5;",
		"\tfor (const item of items) {",
		"\t\tfor (let i = 0; i < item.length; i++) {",
		"\t\t\tacc ^= item.charCodeAt(i);",
		"\t\t\tacc = Math.imul(acc, 0x01000193);",
		"\t\t}",
		"\t}",
		"\treturn (acc >>> 0).toString(16).padStart(8, '0');",
		"}",
	].join("\n");

	const longToolLines = Array.from({ length: 42 }, (_, line) => {
		const n = String(line + 1).padStart(2, "0");
		return `[${n}] src/module-${n}.ts:14:22 checked ok (duration=${(line % 9) + 1}ms, hash=a9f3${n}c)`;
	}).join("\n");

	while (totalChars < targetChars) {
		idx += 1;
		const ts = baseTime + idx * 5000;
		const userText =
			`Turn ${idx}: Inspect \`src/module-${idx}.ts\`, verify the digest calculation, ` +
			`and summarize any edge cases in the streaming parser pipeline.`;

		const toolCallId = `call_bench_${idx}`;
		const assistantCallText = `Checking \`src/module-${idx}.ts\` and running the targeted verification suite.`;
		const toolOutput = `Running check #${idx}...\n${longToolLines}\nSummary: ${idx} checks passed with 0 errors.\n`;
		const assistantFinalText = [
			`### Analysis for Turn ${idx}`,
			"",
			"Verified the implementation against the expected invariants:",
			"",
			"- Input boundaries are validated before hashing.",
			"- Incremental updates preserve deterministic ordering across frames.",
			"",
			"```ts",
			sampleCode,
			"```",
			"",
			`All ${42} trace lines in \`src/module-${idx}.ts\` matched without regressions.`,
		].join("\n");

		const turnChars =
			userText.length + assistantCallText.length + toolOutput.length + assistantFinalText.length;
		totalChars += turnChars;
		const runningTokens = Math.min(targetTokens, Math.round(totalChars / CHARS_PER_TOKEN));

		turns.push({
			idx,
			ts,
			userText,
			toolCallId,
			assistantCallText,
			toolOutput,
			assistantFinalText,
			runningTokens,
		});
	}

	// A long session can push the last synthetic turn past the wall clock, which
	// breaks anything comparing entry times (compaction, export). Pull the whole run
	// back so it ends at most a minute ago.
	const lastTs = turns.length > 0 ? turns[turns.length - 1].ts : 0;
	const latestAllowed = Date.now() - 60_000;
	if (lastTs > latestAllowed) {
		const shift = lastTs - latestAllowed;
		for (const turn of turns) turn.ts -= shift;
	}

	return { turns, approxTokens: Math.round(totalChars / CHARS_PER_TOKEN) };
}

function writeSessionJsonl(outPath, turns) {
	const sessionId = randomUUID();
	const lines = [];
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date(turns[0]?.ts ?? Date.now()).toISOString(),
		cwd: process.cwd(),
	};
	lines.push(JSON.stringify(header));

	let parentId = null;
	const pushEntry = (message, offsetMs) => {
		const id = randomUUID().slice(0, 8);
		lines.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: new Date(offsetMs).toISOString(),
				message,
			}),
		);
		parentId = id;
	};

	for (const t of turns) {
		pushEntry(
			{
				role: "user",
				content: [{ type: "text", text: t.userText }],
				timestamp: t.ts,
			},
			t.ts,
		);

		pushEntry(
			{
				role: "assistant",
				content: [
					{ type: "text", text: t.assistantCallText },
					{ type: "toolCall", id: t.toolCallId, name: "bash", arguments: { command: `npm test -- turn-${t.idx}` } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: makeAssistantUsage(Math.max(1000, t.runningTokens - 400), 120),
				stopReason: "toolUse",
				timestamp: t.ts + 1000,
			},
			t.ts + 1000,
		);

		pushEntry(
			{
				role: "toolResult",
				toolCallId: t.toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: t.toolOutput }],
				isError: false,
				timestamp: t.ts + 2000,
			},
			t.ts + 2000,
		);

		pushEntry(
			{
				role: "assistant",
				content: [{ type: "text", text: t.assistantFinalText }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: makeAssistantUsage(t.runningTokens, 240),
				stopReason: "stop",
				timestamp: t.ts + 3000,
			},
			t.ts + 3000,
		);
	}

	writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
	return { entries: lines.length - 1, bytes: Buffer.byteLength(`${lines.join("\n")}\n`, "utf8") };
}

function buildChatContainer(turns) {
	initTheme();
	const chat = new Container();
	const dummyUi = { requestRender: () => {} };

	for (const t of turns) {
		chat.addChild(new UserMessageComponent(t.userText));
		const tool = new ToolExecutionComponent(
			"bash",
			t.toolCallId,
			{ command: `npm test -- turn-${t.idx}` },
			{},
			undefined,
			dummyUi,
			process.cwd(),
		);
		tool.updateResult({ content: [{ type: "text", text: t.toolOutput }], isError: false }, false);
		chat.addChild(tool);

		chat.addChild(
			new AssistantMessageComponent({
				role: "assistant",
				content: [{ type: "text", text: t.assistantFinalText }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: makeAssistantUsage(t.runningTokens, 240),
				stopReason: "stop",
				timestamp: t.ts + 3000,
			}),
		);
	}

	// Add one trailing assistant message to simulate active streaming in the benchmark.
	const liveMsg = {
		role: "assistant",
		content: [{ type: "text", text: "Streaming delta 0..." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: makeAssistantUsage(turns[turns.length - 1]?.runningTokens ?? 1000, 10),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const liveChild = new AssistantMessageComponent(liveMsg);
	chat.addChild(liveChild);

	attachChatContainer(chat);
	return { chat, liveChild, liveMsg };
}

function measureAvgMs(fn, iterations) {
	const t0 = performance.now();
	for (let i = 0; i < iterations; i++) fn(i);
	return (performance.now() - t0) / iterations;
}

function runRenderBenchmark(turns) {
	const { chat, liveChild, liveMsg } = buildChatContainer(turns);
	const width = 120;
	const frames = 20;

	const benchMode = (mode) => {
		setRenderCache(mode);
		clearRenderCache();
		// Warm up once (settled transcript).
		chat.render(width);

		const idleMs = measureAvgMs(() => {
			chat.render(width);
		}, frames);

		const streamMs = measureAvgMs((i) => {
			liveMsg.content[0].text = `Streaming delta ${i}: updating final response tokens...`;
			liveChild.updateContent(liveMsg);
			chat.render(width);
		}, frames);

		const tResize = performance.now();
		chat.render(100);
		const resizeMs = performance.now() - tResize;

		return { idleMs, streamMs, resizeMs };
	};

	const off = benchMode("Off");
	const on = benchMode("On");
	setRenderCache("On");

	return { children: chat.children.length, off, on };
}

const { targetTokens, outPath, runBench } = parseArgs(process.argv.slice(2));
const { turns, approxTokens } = buildSyntheticTurns(targetTokens);
const written = writeSessionJsonl(outPath, turns);

console.log(`Generated synthetic session:`);
console.log(`  path   : ${outPath}`);
console.log(`  turns  : ${turns.length} (${written.entries} entries)`);
console.log(`  tokens : ~${approxTokens.toLocaleString()} tokens (${(written.bytes / 1024).toFixed(1)} KB JSONL)`);
console.log(`  launch : pi --session "${outPath}"`);

if (runBench) {
	console.log(`\nRunning TUI render benchmark (width=120, 20 frames)...`);
	const res = runRenderBenchmark(turns);
	const fmt = (n) => `${n.toFixed(2)} ms`;
	const speedup = (a, b) => `${(a / Math.max(0.001, b)).toFixed(1)}x`;
	console.log(`  children  : ${res.children} components`);
	console.log(`  idle      : Off ${fmt(res.off.idleMs)} -> On ${fmt(res.on.idleMs)} (${speedup(res.off.idleMs, res.on.idleMs)})`);
	console.log(`  streaming : Off ${fmt(res.off.streamMs)} -> On ${fmt(res.on.streamMs)} (${speedup(res.off.streamMs, res.on.streamMs)})`);
	console.log(`  resize    : Off ${fmt(res.off.resizeMs)} -> On ${fmt(res.on.resizeMs)}`);
}
