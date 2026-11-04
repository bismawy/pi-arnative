/**
 * Prometheus textfile export — the agent's spend lands in Grafana without this package ever
 * opening a socket: a textfile collector that already runs on the host (`node_exporter
 * --collector.textfile.directory=…`, or any other textfile collector) scrapes
 * `<agent dir>/arnative/usage.prom` and the gauges show up next to the infra metrics.
 *
 * {@link renderProm} is pure — summary in, exposition text out — so it is the unit under test;
 * this module only does the I/O. The write happens on `turn_end`, at most once per
 * {@link EXPORT_THROTTLE_MS} and only when the rendered text differs from the last one written,
 * so an idle session never touches the file (the scan-timestamp gauge only moves when the data
 * does). The file is replaced atomically — temp file + rename, with the Windows `EPERM`
 * in-place fallback `lib/preset-store.ts` uses — and a failed export is swallowed: it must
 * never disturb the session. `PI_ARNATIVE_EXPORT=0` turns the export off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, isMain } from "../lib/check.ts";
import { collectUsageSummary, resetUsageCache, type UsageSummary } from "../lib/usage-store.ts";

/** At most one write per minute, whatever the turn rate. */
export const EXPORT_THROTTLE_MS = 60_000;
/** `PI_ARNATIVE_EXPORT=0` disables the export (a local file with no network, so it ships on). */
export const EXPORT_ENV = "PI_ARNATIVE_EXPORT";

// Resolved per call, not at import: the self-check points getAgentDir() at a fixture dir.
/** The textfile a collector scrapes: `<agent dir>/arnative/usage.prom`. */
export function promFilePath(): string {
	return join(getAgentDir(), "arnative", "usage.prom");
}

/** Escape a label value per the exposition format: backslash first, then quote, then newline. */
const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/**
 * Render the exposition text for one summary. Pure and deterministic: the same summary and
 * `now` always produce byte-identical output. `now` is the scan time in ms (the caller decides
 * what "last scan" means), rendered as seconds in `arnative_usage_last_scan_timestamp_seconds`.
 */
export function renderProm(summary: UsageSummary, now: number): string {
	const lines: string[] = [];
	/** One sample line: `name{label="value",…} value`. */
	const sample = (name: string, labels: [string, string][], value: number): string =>
		`${name}${labels.length > 0 ? `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}` : ""} ${value}`;
	/** One gauge family: its `# HELP` and `# TYPE` lines, then a single sample. */
	const gauge = (name: string, help: string, value: number): void => {
		lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, sample(name, [], value));
	};

	const t = summary.totals;
	gauge("arnative_cost_billed_total", "Provider-billed cost in USD across all sessions (totalFromProvider; estimates never mixed in).", t.cost);
	gauge("arnative_cost_estimated_total", "Catalog-estimated cost in USD from models.json rates; never billed.", t.estimatedCost);
	gauge("arnative_cost_today", "Provider-billed cost in USD in the current UTC day (the day buckets).", t.today?.cost ?? 0);
	gauge("arnative_cost_30d", "Provider-billed cost in USD over the last 30 UTC days (the day buckets).", t.last30d?.cost ?? 0);
	lines.push("# HELP arnative_tokens_total Token usage by provider, model and kind.", "# TYPE arnative_tokens_total gauge");
	for (const p of summary.providers) {
		for (const m of p.models) {
			for (const [kind, value] of [["input", m.input], ["output", m.output], ["cache_read", m.cacheRead], ["cache_write", m.cacheWrite]] as const) {
				const labels: [string, string][] = [
					["provider", p.name],
					["model", m.name],
					["kind", kind],
				];
				lines.push(sample("arnative_tokens_total", labels, value));
			}
		}
	}
	gauge("arnative_sessions_total", "Distinct Pi session files scanned.", t.sessions);
	gauge("arnative_usage_last_scan_timestamp_seconds", "Unix time of the last usage scan whose data changed.", now / 1000);
	return `${lines.join("\n")}\n`;
}

/** Write the exposition atomically: temp file + rename, so a collector never reads a half-written
 *  file. A rename refused with `EPERM`/`EBUSY`/`EXDEV` (Windows: a running pi session holds the
 *  target open) falls back to an in-place write and removes its temp file — the
 *  `lib/preset-store.ts` pattern. */
export function writePromFile(text: string, path: string, rename: (from: string, to: string) => void = renameSync): void {
	const tmp = `${path}.${process.pid}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(tmp, text, "utf8");
	try {
		rename(tmp, path);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EBUSY" && code !== "EXDEV") throw e;
		writeFileSync(path, text, "utf8");
		rmSync(tmp, { force: true });
	}
}

let lastExportMs = 0;
let lastExportText = "";
let lastSummaryJson = "";
let lastScanAt = 0;

/**
 * One export attempt: throttled to one write per {@link EXPORT_THROTTLE_MS}, skipped when the
 * rendered text matches the last one written, disabled by `PI_ARNATIVE_EXPORT=0`, and never
 * throwing. Returns true when the file was written. `path` defaults to {@link promFilePath};
 * the self-check points it at a temp dir.
 */
export function exportProm(now: number, path: string = promFilePath()): boolean {
	try {
		if (process.env[EXPORT_ENV] === "0") return false;
		if (now - lastExportMs < EXPORT_THROTTLE_MS) return false;
		// Force the scan: the memo can be up to 5s old, and the turn that just ended is exactly
		// the one this export is for. The throttle above keeps this to one scan per minute.
		const summary = collectUsageSummary(true);
		// The scan timestamp only moves when the data does, so an idle session renders
		// byte-identical text and the diff below skips the write.
		const key = JSON.stringify(summary);
		if (key !== lastSummaryJson) {
			lastSummaryJson = key;
			lastScanAt = now;
		}
		const text = renderProm(summary, lastScanAt);
		if (text === lastExportText) return false;
		writePromFile(text, path);
		lastExportMs = now;
		lastExportText = text;
		return true;
	} catch {
		// A failed export must not disturb the session.
		return false;
	}
}

export default function registerUsageExport(pi: ExtensionAPI): void {
	pi.on("turn_end", () => {
		exportProm(Date.now());
	});
	// The throttle must not swallow the last turns of a session: reset it and flush once, so a
	// quit does not leave the file reporting an hour-old total.
	pi.on("session_shutdown", () => {
		lastExportMs = 0;
		exportProm(Date.now());
	});
}

// Self-check: `node extensions/usage-export.ts`
if (isMain(import.meta.url)) {
	const NL = String.fromCharCode(10);

	// ---- the renderer: pure, no agent dir involved ----
	const emptySummary: UsageSummary = {
		providers: [],
		projects: [],
		totals: { sessions: 0, msgs: 0, input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: 0, reportedCost: 0, estimatedCost: 0 },
	};
	const empty = renderProm(emptySummary, 1_700_000_000_000);
	assert(
		empty ===
			[
				"# HELP arnative_cost_billed_total Provider-billed cost in USD across all sessions (totalFromProvider; estimates never mixed in).",
				"# TYPE arnative_cost_billed_total gauge",
				"arnative_cost_billed_total 0",
				"# HELP arnative_cost_estimated_total Catalog-estimated cost in USD from models.json rates; never billed.",
				"# TYPE arnative_cost_estimated_total gauge",
				"arnative_cost_estimated_total 0",
				"# HELP arnative_cost_today Provider-billed cost in USD in the current UTC day (the day buckets).",
				"# TYPE arnative_cost_today gauge",
				"arnative_cost_today 0",
				"# HELP arnative_cost_30d Provider-billed cost in USD over the last 30 UTC days (the day buckets).",
				"# TYPE arnative_cost_30d gauge",
				"arnative_cost_30d 0",
				"# HELP arnative_tokens_total Token usage by provider, model and kind.",
				"# TYPE arnative_tokens_total gauge",
				"# HELP arnative_sessions_total Distinct Pi session files scanned.",
				"# TYPE arnative_sessions_total gauge",
				"arnative_sessions_total 0",
				"# HELP arnative_usage_last_scan_timestamp_seconds Unix time of the last usage scan whose data changed.",
				"# TYPE arnative_usage_last_scan_timestamp_seconds gauge",
				"arnative_usage_last_scan_timestamp_seconds 1700000000",
			].join(NL) + NL,
		"an empty summary renders the pinned exposition, zeros included: " + JSON.stringify(empty),
	);

	const full: UsageSummary = {
		providers: [
			{
				name: 'pro"v\\x',
				sessions: 1,
				msgs: 1,
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 4,
				totalTokens: 15,
				cost: 0.02,
				estimatedCost: 0.01,
				models: [{ name: "m\n1", sessions: 1, msgs: 1, input: 10, output: 5, cacheRead: 2, cacheWrite: 4, totalTokens: 15, cost: 0.02, estimatedCost: 0.01 }],
			},
		],
		projects: [],
		totals: {
			sessions: 1,
			msgs: 1,
			input: 10,
			output: 5,
			cacheRead: 2,
			totalTokens: 15,
			cost: 0.02,
			reportedCost: 0.02,
			estimatedCost: 0.01,
			today: { cost: 0.02, estimated: 0, input: 10, output: 5, cacheRead: 2 },
			last30d: { cost: 0.02, estimated: 0, input: 10, output: 5, cacheRead: 2 },
		},
	};
	const text = renderProm(full, 1_700_000_000_000);
	assert(text === renderProm(full, 1_700_000_000_000), "two renders of the same summary are byte-identical");
	for (const line of text.trimEnd().split(NL)) {
		if (line.startsWith("#")) continue;
		const m = /^([a-z_0-9]+)(\{[^}]*\})? (\S+)$/.exec(line);
		assert(m !== null && Number.isFinite(Number(m[3])), "a sample line parses as name{labels} value: " + JSON.stringify(line));
	}
	assert(text.includes('arnative_tokens_total{provider="pro\\"v\\\\x",model="m\\n1",kind="input"} 10'), "label values escape backslash, quote and newline: " + JSON.stringify(text));
	assert(text.includes('arnative_tokens_total{provider="pro\\"v\\\\x",model="m\\n1",kind="output"} 5'), "the output kind is labelled: " + text);
	assert(text.includes('arnative_tokens_total{provider="pro\\"v\\\\x",model="m\\n1",kind="cache_read"} 2'), "the cache_read kind is labelled: " + text);
	assert(text.includes("arnative_cost_billed_total 0.02\n"), "billed cost is its own metric: " + text);
	assert(text.includes("arnative_cost_estimated_total 0.01\n"), "the estimate is never folded into the billed _total: " + text);
	assert(text.includes("arnative_cost_today 0.02\n") && text.includes("arnative_cost_30d 0.02\n"), "the today/30d buckets render: " + text);
	assert(text.includes("arnative_sessions_total 1\n"), "the session count renders: " + text);

	// ---- the writer: pointed at a temp dir, never at the real agent dir ----
	const fixture = mkdtempSync(join(tmpdir(), "arnative-export-"));
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = fixture;
	resetUsageCache();
	assert(promFilePath() === join(fixture, "arnative", "usage.prom"), "the default target is <agent dir>/arnative/usage.prom");

	mkdirSync(join(fixture, "sessions", "p"), { recursive: true });
	const sessionFile = join(fixture, "sessions", "p", "s.jsonl");
	const asst = (input: number, cost: number) =>
		JSON.stringify({
			message: { role: "assistant", provider: "google", model: "m1", timestamp: Date.now(), usage: { input, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: cost, totalFromProvider: true } } },
		});
	writeFileSync(sessionFile, asst(100, 0.5) + NL);
	const path = join(fixture, "usage.prom");
	// Epoch-scale `now` values, so the throttle (which starts at 0) lets the first call through.
	const T0 = 1_700_000_000_000;

	assert(exportProm(T0, path) === true, "the first export writes");
	const first = readFileSync(path, "utf8");
	assert(first.includes("arnative_cost_billed_total 0.5\n"), "the file carries the billed cost: " + first);
	assert(first.includes('arnative_tokens_total{provider="google",model="m1",kind="input"} 100\n'), "the file carries the token rows: " + first);
	assert(first.includes("arnative_usage_last_scan_timestamp_seconds 1700000000\n"), "the scan timestamp is the export time in seconds: " + first);
	assert(exportProm(T0 + 2_000, path) === false, "throttled: no second write within 60s");
	assert(readFileSync(path, "utf8") === first, "the throttled attempt did not touch the file");
	assert(exportProm(T0 + 61_000, path) === false, "past the throttle but unchanged data: the diff skips the write");
	assert(readFileSync(path, "utf8") === first, "an idle session does not touch the file");

	writeFileSync(sessionFile, asst(50, 0.25) + NL, { flag: "a" });
	resetUsageCache();
	assert(exportProm(T0 + 122_000, path) === true, "changed data past the throttle writes again");
	const second = readFileSync(path, "utf8");
	assert(
		second.includes("arnative_cost_billed_total 0.75\n") && second.includes('kind="input"} 150\n') && second.includes("arnative_usage_last_scan_timestamp_seconds 1700000122\n"),
		"the new spend, tokens and scan time land: " + second,
	);

	process.env[EXPORT_ENV] = "0";
	writeFileSync(sessionFile, asst(1, 0.125) + NL, { flag: "a" });
	resetUsageCache();
	assert(exportProm(T0 + 200_000, path) === false, `${EXPORT_ENV}=0 disables the export`);
	assert(readFileSync(path, "utf8") === second, "the disabled export did not touch the file");
	delete process.env[EXPORT_ENV];
	assert(exportProm(T0 + 261_000) === true, "re-enabled past the throttle, it writes to the default path");
	assert(existsSync(join(fixture, "arnative", "usage.prom")), "the default path is <agent dir>/arnative/usage.prom");

	writeFileSync(sessionFile, asst(1, 0.0625) + NL, { flag: "a" });
	resetUsageCache();
	writeFileSync(join(fixture, "blocked"), "not a directory", "utf8");
	assert(exportProm(T0 + 400_000, join(fixture, "blocked", "usage.prom")) === false, "an unwritable target is swallowed, not thrown");

	// Windows: a rename refused with EPERM falls back to an in-place write (the rename seam).
	const seamPath = join(fixture, "seam", "usage.prom");
	const locked = (): never => {
		throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
	};
	writePromFile("seamed\n", seamPath, locked);
	assert(readFileSync(seamPath, "utf8") === "seamed\n", "a refused rename still writes the file in place");
	assert(!existsSync(`${seamPath}.${process.pid}.tmp`), "no temp file is left behind after the fallback");

	rmSync(fixture, { recursive: true, force: true });
	if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevDir;
	resetUsageCache();
	console.log("usage-export.ts self-check OK");
}
