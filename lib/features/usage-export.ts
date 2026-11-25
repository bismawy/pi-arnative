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
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicSync } from "../preset-store.ts";
import { collectUsageSummary, type UsageSummary } from "../usage-store.ts";

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
 * what "last scan" means), rendered as seconds in `arnative_usage_last_change_timestamp_seconds`.
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
	gauge("arnative_usage_last_change_timestamp_seconds", "Unix time this process last saw the usage data change (not the last scrape).", now / 1000);
	return `${lines.join("\n")}\n`;
}

/** Write the exposition atomically: temp file + rename, so a collector never reads a half-written
 *  file. A rename refused with `EPERM`/`EBUSY`/`EXDEV` (Windows: a running pi session holds the
 *  target open) falls back to an in-place write and removes its temp file — the
 *  `lib/preset-store.ts` pattern. */
export function writePromFile(text: string, path: string, rename: (from: string, to: string) => void = renameSync): void {
	writeAtomicSync(path, text, rename);
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
		// the one this export is for. The stamp moves here, not after the write, so a skipped
		// write (unchanged text, unwritable folder) cannot force a scan on every later turn.
		lastExportMs = now;
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
