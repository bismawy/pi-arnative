/**
 * Model price-table loader, cost estimator, token formatter, and UTC usage range math.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** A time window the dashboard can show. `all` is the whole history. */
export type UsageRange = "all" | "today" | "7d" | "30d";

/** Tab order of the range bar. */
export const USAGE_RANGES: readonly UsageRange[] = ["all", "today", "7d", "30d"];

/** UTC day bucket key (`YYYY-MM-DD`) of a timestamp. */
export function dayKey(ms: number): string {
	return new Date(ms > 0 ? ms : 0).toISOString().slice(0, 10);
}

/** UTC midnight where `range` starts: today, 7 or 30 calendar days back. `undefined` for `all`. */
export function rangeStart(range: UsageRange, now = Date.now()): number | undefined {
	if (range === "all") return undefined;
	const d = new Date(now);
	d.setUTCHours(0, 0, 0, 0);
	if (range === "today") return d.getTime();
	d.setUTCDate(d.getUTCDate() - (range === "7d" ? 6 : 29));
	return d.getTime();
}

export type ModelPrices = Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
export type PriceTable = Record<string, ModelPrices>;

const modelsFilePath = (): string => join(getAgentDir(), "models.json");

type ModelsJsonCost = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

let priceMemo: { key: string; table: PriceTable } | null = null;

/** Clear the memoized `models.json` price table (called by `resetUsageCache()`). */
export function resetPriceMemo(): void {
	priceMemo = null;
}

/**
 * Rates declared in pi's `models.json` (`providers.<name>.models[].cost`).
 * Memoized on the file's stat so an unchanged file is parsed once.
 */
export function loadPriceTable(): PriceTable {
	const path = modelsFilePath();
	let key: string;
	try {
		const st = statSync(path);
		key = `${path}\u0000${st.mtimeMs}\u0000${st.size}`;
	} catch {
		key = `${path}\u0000absent`;
	}
	if (priceMemo && priceMemo.key === key) return priceMemo.table;
	const table: PriceTable = {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			providers?: Record<string, { models?: { id?: string; cost?: ModelsJsonCost }[] }>;
		};
		for (const [provider, cfg] of Object.entries(raw.providers ?? {})) {
			const models: ModelPrices = {};
			for (const m of cfg?.models ?? []) {
				const c = m?.cost;
				if (!m?.id || !c || typeof c.input !== "number" || typeof c.output !== "number") continue;
				models[m.id] = {
					input: c.input,
					output: c.output,
					cacheRead: typeof c.cacheRead === "number" ? c.cacheRead : 0,
					cacheWrite: typeof c.cacheWrite === "number" ? c.cacheWrite : 0,
				};
			}
			if (Object.keys(models).length > 0) table[provider] = models;
		}
	} catch {
		// Malformed or absent models.json means no declared rates.
	}
	priceMemo = { key, table };
	return table;
}

/** True when this provider+model has a usable input+output price (cacheRead/cacheWrite are optional). */
export function hasPrice(provider: string, modelId: string, table: PriceTable = loadPriceTable()): boolean {
	return findPrice(provider, modelId, table) !== null;
}

/** Rates for one provider+model. The provider's own entry wins over the `*` fallback. */
function findPrice(
	provider: string,
	modelId: string,
	table: PriceTable,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
	return rateFor(table[provider], modelId) ?? rateFor(table["*"], modelId);
}

function rateFor(
	entries: ModelPrices | undefined,
	modelId: string,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
	if (!entries || typeof entries !== "object") return null;
	const lower = modelId.toLowerCase();
	const keys = Object.keys(entries).filter((k) => !k.startsWith("_"));
	const key =
		keys.find((k) => k.toLowerCase() === lower) ??
		keys.find((k) => lower.endsWith("/" + k.toLowerCase()) || k.toLowerCase().endsWith("/" + lower));
	if (!key) return null;
	const p = entries[key]!;
	if (typeof p.input !== "number" || typeof p.output !== "number") return null;
	return {
		input: p.input,
		output: p.output,
		cacheRead: typeof p.cacheRead === "number" ? p.cacheRead : 0,
		cacheWrite: typeof p.cacheWrite === "number" ? p.cacheWrite : 0,
	};
}

/** Cost of one provider+model's token counts from the price table, or null when unpriced. */
export function estimateCost(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	modelId: string,
	provider: string,
	table: PriceTable = loadPriceTable(),
): number | null {
	const p = findPrice(provider, modelId, table);
	if (!p) return null;
	return (input / 1e6) * p.input + (output / 1e6) * p.output + (cacheRead / 1e6) * p.cacheRead + (cacheWrite / 1e6) * p.cacheWrite;
}

/** Scaled value with 1 decimal ("2.5k"); a value that rounds up to the next unit is promoted (999,999 -> "1M", not "1000k"). */
const fmtUnit = (v: number, unit: string, next: string): string => {
	const s = v.toFixed(1).replace(/\.0$/, "");
	return s === "1000" ? `1${next}` : `${s}${unit}`;
};

/** Token count with k/M/B units; 0 or negative = "-". */
export function formatTokens(n: number): string {
	if (!n || n <= 0) return "-";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return fmtUnit(n / 1000, "k", "M");
	if (n < 1_000_000_000) return fmtUnit(n / 1_000_000, "M", "B");
	return fmtUnit(n / 1_000_000_000, "B", "T");
}
