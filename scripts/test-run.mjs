/**
 * `npm test` runner: Node's spec reporter with the arnative glyphs.
 *
 * Node paints `✔ ✖ ℹ` and the coverage reporter paints `⛳`. Arnative uses the thinner
 * check, the ballot X and the outlined info/flag marks, so the reporter output is piped
 * through one replacement table instead of forking the reporter. The exit code is the
 * test run's own, so a failure still fails `npm test`.
 *
 * Self-check: `node scripts/test-run.mjs --self-check`.
 */
import { spawn } from "node:child_process";

/** Reporter glyph -> the arnative mark. Order matters only for readability. */
const GLYPHS = [
	["✔", "✓"], // U+2714 heavy check -> U+2713 check
	["✖", "✗"], // U+2716 heavy multiplication X -> U+2717 ballot X
	["ℹ", "\u{1F6C8}"], // U+2139 info -> U+1F6C8 circled information source
	["⛳", "\u2691"], // U+26F3 flag in hole -> U+2691 black flag
];

export function remapGlyphs(text) {
	let out = text;
	for (const [from, to] of GLYPHS) out = out.split(from).join(to);
	return out;
}

if (process.argv.includes("--self-check")) {
	const { assert } = await import("../lib/check.ts");
	const mapped = remapGlyphs("✔ pass ✖ fail ℹ info ⛳ coverage");
	assert(mapped === "✓ pass ✗ fail \u{1F6C8} info \u2691 coverage", `glyph map: ${mapped}`);
	assert(remapGlyphs("plain output") === "plain output", "plain text passes through");
	console.log("OK");
} else {
	const child = spawn(process.execPath, ["--test", "--test-reporter=spec", ...process.argv.slice(2)], {
		stdio: ["inherit", "pipe", "inherit"],
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => process.stdout.write(remapGlyphs(chunk)));
	child.on("error", (err) => {
		console.error(`test runner failed: ${err.message}`);
		process.exit(1);
	});
	child.on("close", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}
