/**
 * Test reporter with the arnative marks.
 *
 * Node's built-in `spec` reporter paints `✔ ✖ ℹ ⛳`; a direct `node --test` uses it and
 * there is no hook to restyle it. A custom reporter replaces it instead: same events,
 * arnative glyphs (`✓` pass, `✗` fail, `🛈` summary, `⚑` file-level failure), the
 * assertion message and stack kept.
 *
 *   npm test
 *   node --test --test-reporter=./scripts/reporter.mjs
 *   NODE_OPTIONS=--test-reporter=./scripts/reporter.mjs node --test   # every run
 *
 * The self-check covers the formatters: `node scripts/reporter.mjs --self-check`.
 */
const PASS = "✓";
const FAIL = "✗";
const INFO = "🛈";
const FILE_FAIL = "⚑";

const isFile = (name) => /\.(?:ts|mjs|cjs|js)$/.test(name);

/** `<glyph> name (12.3ms)`, one row per test; the duration is omitted when absent. */
export function row(name, ms, failed) {
	const duration = Number.isFinite(ms) ? ` (${ms.toFixed(1)}ms)` : "";
	return `${failed ? FAIL : PASS} ${name}${duration}`;
}

/** `🛈 pass 5` — the counters Node reports as diagnostics, plus the final summary. */
export function info(message) {
	return `${INFO} ${message}`;
}

/** File-level failure (a test file that throws before any test runs). */
export function fileFailure(name, message) {
	return `${FILE_FAIL} ${name}: ${message}`;
}

function stackOf(error) {
	if (!error) return "";
	return String(error.stack ?? error.message ?? error);
}

export default async function* reporter(source) {
	const details = [];
	for await (const event of source) {
		const data = event.data ?? {};
		if (event.type === "test:pass" || event.type === "test:fail") {
			const failed = event.type === "test:fail";
			// A file's own pass bucket repeats the per-test rows; only its failure is new.
			if (isFile(data.name)) {
				if (failed) yield `${fileFailure(data.name, stackOf(data.details?.error))}\n`;
				continue;
			}
			yield `${row(data.name, Number(data.details?.duration_ms), failed)}\n`;
			if (failed && data.details?.error) details.push({ name: data.name, error: data.details.error });
			continue;
		}
		if (event.type === "test:diagnostic") {
			yield `${info(String(data.message ?? ""))}\n`;
			continue;
		}
		if (event.type === "test:summary" && data.suite && data.suite !== data.name) continue;
	}
	for (const { error } of details) yield `\n${stackOf(error)}\n`;
}

if (process.argv.includes("--self-check")) {
	const { assert } = await import("../lib/check.ts");
	assert(row("works", 12.34, false) === "✓ works (12.3ms)", `row: ${row("works", 12.34, false)}`);
	assert(row("breaks", undefined, true) === "✗ breaks", "row: no duration when absent");
	assert(info("pass 5") === "🛈 pass 5", "info row");
	assert(fileFailure("a.test.ts", "boom") === "⚑ a.test.ts: boom", "file-level failure");
	console.log("OK");
}
