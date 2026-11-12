/**
 * Token usage data layer — the single source for /usage and the Model tab.
 * - Scans local Pi session history (~/.pi/agent/sessions/*.jsonl).
 * - mtime+size keyed cache in ~/.pi/agent/arnative/usage-cache.json, read into
 *   memory once (parsing 4MB per header frame cost ~50ms and lagged long chats).
 * - No double counting: the active session is already in its own file, so it is
 *   NOT re-added from sessionManager (that inflated the ↑↓ totals), and a subagent's
 *   spend is read from the child's own session file, never from the parent's tool result. Child spend
 *   (subagent / nested tool calls) rides on the tool result only, never on an
 *   assistant message, so summing both roles counts it once.
 * - Rollups also keep per-day buckets (UTC) and the session cwd, so /usage can answer
 *   "today", the range bar (All/Today/7d/30d/3m) and "per project" from the cache without a
 *   full re-scan.
 * - A statistics reset writes `usage-baseline.json`: the summary subtracts the baseline
 *   rollup per file, so earlier messages stop counting in every view while the session
 *   files stay untouched (see {@link resetUsageStats}).
 */
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { assert, isMain } from "./check.ts";

interface UsageEntry {
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** True when `cost` is the provider-billed total (`totalFromProvider`); false when it is a catalog estimate. */
	billed: boolean;
	/** UTC day bucket (`YYYY-MM-DD`) the message counts in. A line without a usable
	 *  timestamp inherits the file's mtime day (`fallbackDay`), like the range feature
	 *  always did — an undated record must not fall into 1970 and vanish from every window. */
	day: string;
}

interface FileCacheItem {
	mtimeMs: number;
	size: number;
	v?: number;
	/** The session's cwd, from the first line of the file. Absent on a tail-only parse, where
	 *  the value already stored in the cache item is kept (the head is not re-read). */
	cwd?: string;
	/** Byte offset of the last complete line parsed. Session files are append-only, so a
	 *  grown file only needs its tail read — re-parsing the whole 1MB+ active session on the
	 *  5s render path cost ~15ms and grew with chat length. */
	consumed?: number;
	/** Per-file rollup, not the raw entries: the summary is rebuilt from these every scan, and
	 *  a long session holds tens of thousands of entries. Storing the rolled-up numbers keeps
	 *  the cache small and makes a refresh cost the size of the *growth*, not the session. */
	rollup: FileRollup;
}

/** Usage totals for one session file, per provider and per provider+model, plus per-day rows. */
interface FileRollup {
	providers: Record<string, Rollup>;
	/** Day buckets keyed `YYYY-MM-DD\0provider\0model` (UTC day — see dayKey), so the disk `d`
	 *  map reuses the provider rows' compact array and a day's totals are the sum of its rows. */
	days: Record<string, Rollup>;
}

interface Rollup {
	sessions: number;
	msgs: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Sum of `cost.total`, billed plus catalog estimates, exactly as pi reported them. */
	cost: number;
	/** The billed subset of `cost`; `cost - billed` is the catalog-estimate part. */
	billed: number;
}

const emptyRollup = (): Rollup => ({ sessions: 0, msgs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billed: 0 });

function addToRollup(r: Rollup, e: UsageEntry): void {
	r.msgs++;
	r.input += e.input;
	r.output += e.output;
	r.cacheRead += e.cacheRead;
	r.cacheWrite += e.cacheWrite;
	r.cost += e.cost;
	r.billed += e.billed ? e.cost : 0;
}

/** A time window the dashboard can show. `all` is the whole history. */
export type UsageRange = "all" | "today" | "7d" | "30d" | "3m";

/** Tab order of the range bar. */
export const USAGE_RANGES: readonly UsageRange[] = ["all", "today", "7d", "30d", "3m"];

/** UTC day bucket key (`YYYY-MM-DD`) of a timestamp. UTC on purpose: local time would make the
 *  on-disk cache depend on the timezone of the machine that wrote it, so a restore elsewhere
 *  would re-bucket every entry. Exported for the range bar, whose windows share the buckets. */
export function dayKey(ms: number): string {
	return new Date(ms > 0 ? ms : 0).toISOString().slice(0, 10);
}

/** UTC midnight where `range` starts: today, 7 or 30 calendar days back, 3 months back.
 *  `undefined` for `all`, which has no floor. UTC to match the day buckets: a local-midnight
 *  floor would cut a UTC+7 "today" at 7am local and drop the morning's spend. */
export function rangeStart(range: UsageRange, now = Date.now()): number | undefined {
	if (range === "all") return undefined;
	const d = new Date(now);
	d.setUTCHours(0, 0, 0, 0);
	if (range === "today") return d.getTime();
	if (range === "3m") d.setUTCMonth(d.getUTCMonth() - 3);
	else d.setUTCDate(d.getUTCDate() - (range === "7d" ? 6 : 29));
	return d.getTime();
}

/** Fold entries into an existing file rollup, updating provider, provider+model and day keys
 *  together in one pass over the entries. */
function foldInto(rollup: FileRollup, entries: UsageEntry[]): void {
	if (entries.length === 0) return;
	for (const e of entries) {
		const key = `${e.provider}\u0000${e.model}`;
		(rollup.providers[e.provider] ??= emptyRollup());
		addToRollup(rollup.providers[e.provider]!, e);
		(rollup.providers[key] ??= emptyRollup());
		addToRollup(rollup.providers[key]!, e);
		const day = `${e.day}\u0000${key}`;
		(rollup.days[day] ??= emptyRollup());
		addToRollup(rollup.days[day]!, e);
	}
	// `sessions` counts the file, not the messages, so it is 1 once the file has any use.
	for (const key of Object.keys(rollup.providers)) rollup.providers[key]!.sessions = 1;
	for (const key of Object.keys(rollup.days)) rollup.days[key]!.sessions = 1;
}

/** The rollup of a freshly parsed file (a foldInto that starts from nothing). */
function rollupOfFile(entries: UsageEntry[]): FileRollup {
	const rollup: FileRollup = { providers: {}, days: {} };
	foldInto(rollup, entries);
	return rollup;
}

interface UsageModelStats {
	name: string;
	sessions: number;
	msgs: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Billed cost only (`totalFromProvider`); catalog estimates live in `estimatedCost`. */
	cost: number;
	/** Catalog totals plus the price-table reconstruction for rows that carried no cost at all. Never folded into `cost`. */
	estimatedCost: number;
}

interface UsageProviderStats {
	name: string;
	sessions: number;
	msgs: number;
	input: number;
	output: number;
	cacheRead: number;
	totalTokens: number;
	cost: number;
	/** Sum of the models' `estimatedCost`, for the same rows this provider could not bill. */
	estimatedCost: number;
	models: UsageModelStats[];
}

/** Per-project (cwd) stats: the same fields as a provider row, with the providers seen in that
 *  project as its children, so `/usage` can tree Project → Provider. */
export interface UsageProjectStats {
	name: string;
	sessions: number;
	msgs: number;
	input: number;
	output: number;
	cacheRead: number;
	totalTokens: number;
	cost: number;
	estimatedCost: number;
	providers: UsageProviderStats[];
}

/** One day-window total, summed from the day buckets. */
export interface UsageDayWindow {
	/** Billed cost only, like the summary's `cost`. */
	cost: number;
	/** Catalog-estimated cost in the same window: a budget warns on it, never blocks. */
	estimated: number;
	input: number;
	output: number;
	cacheRead: number;
}

export interface UsageSummary {
	providers: UsageProviderStats[];
	/** Per-project rollup; `"unknown"` for files whose header carried no cwd. */
	projects: UsageProjectStats[];
	totals: {
		sessions: number;
		msgs: number;
		input: number;
		output: number;
		cacheRead: number;
		totalTokens: number;
		/** Billed cost only (`totalFromProvider`); never includes the estimate. */
		cost: number;
		/** Same billed total under its old name. */
		reportedCost: number;
		/** Catalog totals plus cost reconstructed from `models.json` rates. Shown with a `~`, never folded into `cost`. */
		estimatedCost: number;
		/** Day-bucket windows, present only when the scan saw day buckets (a v8 cache). */
		today?: UsageDayWindow;
		last7d?: UsageDayWindow;
		last30d?: UsageDayWindow;
	};
}

export type ModelPrices = Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
export type PriceTable = Record<string, ModelPrices>;

const modelsFilePath = (): string => join(getAgentDir(), "models.json");

type ModelsJsonCost = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** Memo of the last price-table read, keyed by the models.json path + mtimeMs + size: one
 *  `statSync` per call instead of a `readFileSync` on every footer frame. Cleared by
 *  `resetUsageCache()` so the self-checks see a cold read after changing the fixture. */
let priceMemo: { key: string; table: PriceTable } | null = null;

/**
 * Rates declared automatically in pi's `models.json` (`providers.<name>.models[].cost`).
 * Keyed by provider to reconstruct estimates for historical or 0-cost rows. Memoized on the
 * file's stat, so an unchanged file is parsed once, not once per caller.
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

// Resolved per call, not at import: the self-check points getAgentDir() at a fixture dir.
// Everything pi-arnative writes lives in one folder (agent dir/arnative); the cache moved
// there from a flat arnative-usage-cache.json, which is migrated in on first read.
const cacheDir = (): string => join(getAgentDir(), "arnative");
const cacheFilePath = (): string => join(cacheDir(), "usage-cache.json");
const legacyCachePath = (): string => join(getAgentDir(), "arnative-usage-cache.json");
/** Dead since pricing moved into `cost` fields in models.json: nothing reads it, so the
 *  first load after the update removes it (layout "1" — see lib/preset-store.ts). */
const legacyPricesPath = (): string => join(getAgentDir(), "arnative-prices.json");
const CACHE_VERSION = 9; // v9: no tool-result rows (v8: cacheWrite + the billed split, v7: day buckets + cwd, v6: the compact rows, v5: model rows only, v4: full rollup)

/** Where pi-subagents keeps a run's transcript, inside the session's own project dir. */
const SUBAGENT_ARTIFACTS_DIR = "subagent-artifacts";

/** Synthetic provider for the spend pi attaches to a tool result instead of an assistant
 *  message (a subagent or a nested tool call). The store never reads it — the child's own
 *  session file already carries it — but the footer does, from the branch, where no child
 *  file exists. */
export const TOOL_PROVIDER = "tool";

/** The v8 disk shape: one-char keys, model rows in `r`, day rows in `d` (keyed
 *  `YYYY-MM-DD\0provider\0model`), the session cwd in `w` — provider-level and per-day
 *  rollups are derived on load, so every number is stored once. Keys on disk are
 *  paths relative to the sessions dir (the absolute path dominated the old size).
 *  A row is `[msgs, input, output, cacheRead, cacheWrite, cost, billed]`; the 5-number
 *  rows of v5/v6 are decoded with cacheWrite 0 and the whole cost counted as billed.
 *  `t` marks an item written by the current version — anything else is re-parsed once, which
 *  is how a cache written by a build that also stored tool-result rows loses them. */
type DiskItem = {
	m: number;
	s: number;
	c?: number;
	r: Record<string, [number, number, number, number, number, number, number]>;
	d?: Record<string, [number, number, number, number, number, number, number]>;
	w?: string;
	t?: number;
};

/** Decode one disk row: a 7-number v7 row verbatim, a pre-v7 5-number row with cacheWrite 0
 *  and its cost counted as billed (that was the headline meaning before the split). */
const rowOf = (a: unknown): [number, number, number, number, number, number, number] | null => {
	if (!Array.isArray(a) || a.length < 5) return null;
	return a.length >= 7
		? [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!, a[6]!]
		: [a[0]!, a[1]!, a[2]!, a[3]!, 0, a[4]!, a[4]!];
};

/** Decode one disk item (v8 compact, v7/v6/v5 compact or v4 full) into the in-memory shape. */
function decodeDiskItem(raw: unknown): FileCacheItem | null {
	if (!raw || typeof raw !== "object") return null;
	if ("rollup" in raw) {
		const v4 = raw as FileCacheItem;
		if (!v4.rollup) return null;
		// A v4 rollup predates cache writes, the billed split and the day buckets: its cost
		// counts as billed so a migrated headline is unchanged, but the item is stamped 5 so the
		// scan re-parses its file once and re-saves it with its days and its real billed split.
		for (const r of Object.values(v4.rollup.providers)) {
			if (typeof r.cacheWrite !== "number") r.cacheWrite = 0;
			if (typeof r.billed !== "number") r.billed = r.cost;
		}
		return { ...v4, v: 5, rollup: { days: {}, ...v4.rollup } };
	}
	const d = raw as Partial<DiskItem>;
	if (typeof d.m !== "number" || typeof d.s !== "number" || !d.r) return null;
	const rollup: FileRollup = { providers: {}, days: {} };
	// v7+ rows are 7 numbers; a shorter row means a pre-v7 entry, stamped below 7 so the scan
	// re-parses its file once and re-saves it with cache writes and the billed split. An empty
	// `r` (a session with no assistant message) is a v7 item, not a pre-v7 one: `some` over an
	// empty map is false, and treating it as old would re-read that file on every start.
	const wide = !Object.values(d.r).some((a) => Array.isArray(a) && a.length < 7);
	for (const [pm, a] of Object.entries(d.r)) {
		const row = rowOf(a);
		if (!row) continue;
		const [msgs, input, output, cacheRead, cacheWrite, cost, billed] = row;
		Object.assign((rollup.providers[pm] ??= emptyRollup()), { sessions: 1, msgs, input, output, cacheRead, cacheWrite, cost, billed });
		const p = (rollup.providers[pm.split("\u0000")[0]!] ??= emptyRollup());
		p.sessions = 1;
		p.msgs += msgs;
		p.input += input;
		p.output += output;
		p.cacheRead += cacheRead;
		p.cacheWrite += cacheWrite;
		p.cost += cost;
		p.billed += billed;
	}
	// v6 adds the day buckets (`d`) and the cwd (`w`). A compact item without `d` is a pre-v6
	// entry: it decodes the same way, but is stamped v5 so the scan re-parses its file once
	// and re-saves it with its days (that one re-parse is what a version bump costs).
	const hasDays = d.d !== undefined;
	if (hasDays) {
		for (const [dk, a] of Object.entries(d.d!)) {
			if (Array.isArray(a)) {
				// v6+ flat shape: `day\0provider\0model` -> one row.
				const row = rowOf(a);
				if (!row) continue;
				const [msgs, input, output, cacheRead, cacheWrite, cost, billed] = row;
				Object.assign((rollup.days[dk] ??= emptyRollup()), { sessions: 1, msgs, input, output, cacheRead, cacheWrite, cost, billed });
				continue;
			}
			// Pre-merge shape (the range-bar cache): `provider\0model` -> `day` -> row. Fold it
			// into the flat keys so an old cache or baseline still answers the windows; the
			// item is stamped below current anyway and re-parsed once from its file.
			if (!a || typeof a !== "object") continue;
			for (const [day, rowRaw] of Object.entries(a as Record<string, unknown>)) {
				const row = rowOf(rowRaw);
				if (!row) continue;
				const [msgs, input, output, cacheRead, cacheWrite, cost, billed] = row;
				const flat = `${day}\u0000${dk}`;
				Object.assign((rollup.days[flat] ??= emptyRollup()), { sessions: 1, msgs, input, output, cacheRead, cacheWrite, cost, billed });
			}
		}
	}
	return {
		mtimeMs: d.m,
		size: d.s,
		// Only an item carrying `t` AND the day map is current: a v9 writer always emits `d`
		// (empty or not), so a `t` without `d` is a tampered or truncated item, not a v9 one.
		v: d.t === CACHE_VERSION && d.d !== undefined ? CACHE_VERSION : hasDays ? (wide ? 7 : 6) : 5,
		cwd: typeof d.w === "string" ? d.w : undefined,
		consumed: typeof d.c === "number" ? d.c : d.s,
		rollup,
	};
}

/** Encode an in-memory item as v8: model rows in `r`, day rows in `d`, the cwd in `w`, and `t`
 *  marking that the rollups include tool-result spend. */
function encodeDiskItem(item: FileCacheItem): DiskItem {
	const r: DiskItem["r"] = {};
	const d: DiskItem["d"] = {};
	for (const [pm, roll] of Object.entries(item.rollup.providers)) {
		if (pm.includes("\u0000")) r[pm] = [roll.msgs, roll.input, roll.output, roll.cacheRead, roll.cacheWrite, roll.cost, roll.billed];
	}
	for (const [dk, roll] of Object.entries(item.rollup.days)) {
		d[dk] = [roll.msgs, roll.input, roll.output, roll.cacheRead, roll.cacheWrite, roll.cost, roll.billed];
	}
	const out: DiskItem = { m: item.mtimeMs, s: item.size, c: item.consumed ?? item.size, r, d, t: CACHE_VERSION };
	if (item.cwd !== undefined) out.w = item.cwd;
	return out;
}

// Disk cache is memoized; save writes memory + disk together.
let diskMemo: Map<string, FileCacheItem> | null = null;

function loadDiskCache(): Map<string, FileCacheItem> {
	if (diskMemo) return diskMemo;
	diskMemo = new Map<string, FileCacheItem>();
	try {
		// One-time move into the arnative folder (was a flat file next to it).
		if (!existsSync(cacheFilePath()) && existsSync(legacyCachePath())) {
			mkdirSync(cacheDir(), { recursive: true });
			renameSync(legacyCachePath(), cacheFilePath());
		} else if (existsSync(legacyCachePath())) {
			// Both exist — a downgrade recreated the flat file next to the folder copy. The
			// folder copy belongs to the newer layout, so the flat one is dead.
			rmSync(legacyCachePath());
		}
		if (existsSync(legacyPricesPath())) rmSync(legacyPricesPath());
	} catch {
		// a concurrent session may have moved it already: read whichever path exists
	}
	readDiskFileInto(cacheFilePath(), diskMemo);
	if (diskMemo.size === 0) readDiskFileInto(legacyCachePath(), diskMemo);
	return diskMemo;
}

/** Read one cache file into `map`. v4 items keep their absolute-path keys verbatim;
 *  v5 keys are session-dir-relative and resolved back to absolute here. */
function readDiskFileInto(path: string, map: Map<string, FileCacheItem>): void {
	try {
		if (!existsSync(path)) return;
		const sessionsDir = join(getAgentDir(), "sessions");
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		for (const [k, v] of Object.entries(raw)) {
			const item = decodeDiskItem(v);
			if (!item) continue;
			map.set(v && typeof v === "object" && "rollup" in v ? k : join(sessionsDir, k), item);
		}
	} catch {
		// ignore
	}
}

function saveDiskCache(map: Map<string, FileCacheItem>): void {
	try {
		const path = cacheFilePath();
		const sessionsDir = join(getAgentDir(), "sessions");
		// Re-read: another pi session may have cached its own files since this one loaded.
		// Skip keys whose session file is gone, so a prune done by this scan stays pruned.
		const disk = new Map<string, FileCacheItem>();
		readDiskFileInto(path, disk);
		if (disk.size === 0) readDiskFileInto(legacyCachePath(), disk);
		for (const [k, v] of disk) if (!map.has(k) && existsSync(k)) map.set(k, v);
		const out: Record<string, DiskItem> = {};
		for (const [k, v] of map.entries()) out[relative(sessionsDir, k)] = encodeDiskItem(v);
		// Temp file + rename: a concurrent pi session never reads a half-written cache.
		const tmp = `${path}.${process.pid}.tmp`;
		mkdirSync(cacheDir(), { recursive: true });
		writeFileSync(tmp, JSON.stringify(out), "utf8");
		renameSync(tmp, path);
	} catch {
		// ignore
	}
}

function scanSessionFiles(dir: string): string[] {
	const files: string[] = [];
	try {
		if (!existsSync(dir)) return files;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (!ent.isDirectory() || ent.name === SUBAGENT_ARTIFACTS_DIR) continue;
			const projectDir = join(dir, ent.name);
			for (const f of readdirSync(projectDir, { withFileTypes: true })) {
				// A session file lives directly in its project dir (`<ts>_<id>.jsonl`).
				if (f.isFile() && f.name.endsWith(".jsonl")) files.push(join(projectDir, f.name));
				// A subagent run is a session of its own, one level deeper
				// (`<project>/<parent id>/<run id>/run-N/session.jsonl`): its spend is real and
				// must be counted once, under its own provider/model.
				else if (f.isDirectory()) files.push(...childSessionFiles(join(projectDir, f.name)));
			}
		}
	} catch {
		// ignore
	}
	return files;
}

/** The child sessions of subagent runs under one project dir. Only `session.jsonl` counts: the
 *  run's transcript (`<project>/subagent-artifacts/*.jsonl`) repeats the same messages, and
 *  counting both billed every child twice — the same tokens also ride on the parent's tool
 *  result, which the store never reads for the same reason. */
function childSessionFiles(dir: string): string[] {
	const files: string[] = [];
	try {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.name === SUBAGENT_ARTIFACTS_DIR) continue;
			const full = join(dir, ent.name);
			if (ent.isDirectory()) files.push(...childSessionFiles(full));
			else if (ent.name === "session.jsonl") files.push(full);
		}
	} catch {
		// ignore
	}
	return files;
}

/** Extract a usage entry from one line, or null when the line carries none. Only an
 *  assistant message is read: pi also attaches child spend to a tool result
 *  (`ToolResultMessage.usage`), but that spend already sits in the child's own session file
 *  (see {@link scanSessionFiles}), so reading it here would count it twice. The footer reads
 *  it from the branch instead, where no child file exists. */
function entryOfLine(line: string, fallbackDay: string): UsageEntry | null {
	// Loose prefilter (fast path only): exact key would break on JSON formatting changes
	// and silently drop usage. The role is re-checked on the parsed object below.
	if (!line || !line.includes('"role"')) return null;
	try {
		const rec = JSON.parse(line) as { timestamp?: unknown; message?: { role?: string; provider?: string; model?: string; usage?: Record<string, unknown> } };
		const m = rec?.message;
		if (m?.role !== "assistant") return null;
		const u = (m.usage ?? {}) as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown; totalFromProvider?: unknown } };
		// The session entry carries its own ISO `timestamp`; the inner message carries ms.
		// Either dates the day bucket — prefer the record's, fall back to the message's,
		// then to the file's mtime day for records that carry neither.
		const recTs = typeof rec?.timestamp === "string" ? Date.parse(rec.timestamp) : tsOf(rec?.timestamp);
		const written = (Number.isFinite(recTs) && recTs > 0 ? recTs : 0) || tsOf(m?.timestamp);
		return {
			provider: String(m.provider || "unknown"),
			model: String(m.model || "unknown"),
			input: Number(u.input) || 0,
			output: Number(u.output) || 0,
			cacheRead: Number(u.cacheRead) || 0,
			cacheWrite: Number(u.cacheWrite) || 0,
			cost: Number(u.cost?.total) || 0,
			billed: u.cost?.totalFromProvider === true,
			day: written > 0 ? dayKey(written) : fallbackDay,
		};
	} catch {
		return null;
	}
}

/** A usable timestamp, or 0. `new Date(1e16).toISOString()` throws a RangeError, and one
 *  corrupt line must not break the whole scan (`/usage` and the Model tab both read it). */
function tsOf(raw: unknown): number {
	const ts = Number(raw);
	return Number.isFinite(ts) && ts > 0 && ts <= 8.64e15 ? ts : 0;
}

/** The cwd of a session-header line (`{"type":"session",...,"cwd":...}`), the first line of a
 *  session file. Undefined for any other line, so a tail parse reports none and the caller
 *  keeps the value already stored in the cache item. */
function sessionCwdOf(line: string): string | undefined {
	if (!line.includes('"type"')) return undefined;
	try {
		const o = JSON.parse(line) as { type?: unknown; cwd?: unknown };
		return o?.type === "session" && typeof o.cwd === "string" ? o.cwd : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Parse newline-terminated lines from a buffer. The returned offset is byte-granular, so it can
 * be fed back to `readSync`; a trailing segment without a newline counts only when it parses, so
 * a write caught mid-flight is left for the next scan rather than dropped. `cwd` is set only
 * when the buffer starts with the session header, i.e. on a whole-file parse. `fallbackDay`
 * dates a line that carries no usable timestamp of its own (the file's mtime day).
 */
function parseBuffer(buf: Buffer, fallbackDay: string): { entries: UsageEntry[]; consumed: number; cwd?: string } {
	const entries: UsageEntry[] = [];
	let start = 0;
	let consumed = 0;
	let cwd: string | undefined;
	for (;;) {
		const nl = buf.indexOf(10, start);
		if (nl === -1) break;
		const line = buf.toString("utf8", start, nl);
		// Only the buffer's first line can be the session header; a tail never contains it.
		if (start === 0) cwd = sessionCwdOf(line) ?? cwd;
		const entry = entryOfLine(line, fallbackDay);
		if (entry) entries.push(entry);
		start = nl + 1;
		consumed = start;
	}
	if (start < buf.length) {
		const tail = buf.toString("utf8", start);
		if (start === 0) cwd = sessionCwdOf(tail) ?? cwd;
		const entry = entryOfLine(tail, fallbackDay);
		if (entry) {
			entries.push(entry);
			consumed = buf.length;
		} else if (isJsonParseable(tail)) {
			// A complete record that is not an assistant message: consume it and move on.
			consumed = buf.length;
		}
		// Anything else is a half-written record; leave it for the next scan.
	}
	return { entries, consumed, cwd };
}

/** True when the text parses as JSON. Used to tell a whole record from a half-written one. */
function isJsonParseable(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/** Read the bytes written since `fromByte`. Null when the file cannot be opened (deleted mid-scan). */
function readTail(filePath: string, fromByte: number): Buffer | null {
	try {
		const fd = openSync(filePath, "r");
		try {
			const size = fstatSync(fd).size;
			if (size <= fromByte) return Buffer.alloc(0);
			const len = size - fromByte;
			const buf = Buffer.allocUnsafe(len);
			const read = readSync(fd, buf, 0, len, fromByte);
			return buf.subarray(0, read);
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

let cachedSummary: UsageSummary | null = null;
let cachedRange: UsageRange | null = null;
let lastScanMs = 0;

/** Drop every in-memory memo so the next scan reads the cache file and the session files
 *  again. The self-check needs this: `forceScan` skips the 5s summary cache but still
 *  trusts the memoized disk cache, so without it a "cold parse" test asserts a value
 *  against itself and can never fail. */
export function resetUsageCache(): void {
	diskMemo = null;
	priceMemo = null;
	baselineMemo = null;
	cachedSummary = null;
	cachedRange = null;
	lastScanMs = 0;
}

// =============================================================================
// Reset statistics without changing the session history
// =============================================================================

const baselinePath = (): string => join(cacheDir(), "usage-baseline.json");
let baselineMemo: { path: string; mtimeMs: number; size: number; items: Map<string, FileCacheItem> } | null = null;

function loadUsageBaseline(): Map<string, FileCacheItem> {
	const path = baselinePath();
	if (!existsSync(path)) {
		baselineMemo = null;
		return new Map();
	}
	const stat = statSync(path);
	if (baselineMemo?.path === path && baselineMemo.mtimeMs === stat.mtimeMs && baselineMemo.size === stat.size) return baselineMemo.items;
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid usage baseline");
	const items = new Map<string, FileCacheItem>();
	for (const [key, value] of Object.entries(raw)) {
		const item = decodeDiskItem(value);
		if (!item) throw new Error("Invalid usage baseline entry");
		items.set(join(getAgentDir(), "sessions", key), item);
	}
	baselineMemo = { path, mtimeMs: stat.mtimeMs, size: stat.size, items };
	return items;
}

function writeUsageBaseline(raw: string | null): void {
	const path = baselinePath();
	if (raw === null) rmSync(path, { force: true });
	else {
		mkdirSync(cacheDir(), { recursive: true });
		const tmp = path + "." + process.pid + ".tmp";
		try {
			writeFileSync(tmp, raw, "utf8");
			renameSync(tmp, path);
		} finally {
			rmSync(tmp, { force: true });
		}
	}
	resetUsageCache();
}

/** Snapshot complete messages, including daily totals, so appended messages still count. */
export function resetUsageStats(): string | null {
	collectUsageSummary(true, "today");
	const path = baselinePath();
	const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
	const sessionsDir = join(getAgentDir(), "sessions");
	const snapshot = Object.fromEntries([...loadDiskCache()].map(([file, item]) => [relative(sessionsDir, file), encodeDiskItem(item)]));
	writeUsageBaseline(JSON.stringify(snapshot));
	return previous;
}

/** Restore the previous counting baseline; session files stay where they are. */
export function restoreUsageStats(previous: string | null): void {
	writeUsageBaseline(previous);
}

/** A provider map as folded per file: provider → its models. Shared by the global provider
 *  list and each project's breakdown, so both count exactly the same rows. */
type ProviderMap = Map<
	string,
	{
		sessions: Set<string>;
		msgs: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		billed: number;
		models: Map<
			string,
			{
				sessions: Set<string>;
				msgs: number;
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				cost: number;
				billed: number;
			}
		>;
	}
>;

/** Fold one file's rollup rows into a provider map. */
function foldFileIntoProviderMap(map: ProviderMap, file: string, rollup: FileRollup): void {
	for (const [key, r] of Object.entries(rollup.providers)) {
		const sep = key.indexOf("\u0000");
		const pname = sep === -1 ? key : key.slice(0, sep);
		if (!map.has(pname)) {
			map.set(pname, { sessions: new Set(), msgs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billed: 0, models: new Map() });
		}
		const p = map.get(pname)!;
		p.sessions.add(file);

		if (sep === -1) {
			// Provider-level key: the message totals belong here only.
			p.msgs += r.msgs;
			p.input += r.input;
			p.output += r.output;
			p.cacheRead += r.cacheRead;
			p.cacheWrite += r.cacheWrite;
			p.cost += r.cost;
			p.billed += r.billed;
			continue;
		}

		const mname = key.slice(sep + 1);
		if (!p.models.has(mname)) {
			p.models.set(mname, { sessions: new Set(), msgs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billed: 0 });
		}
		const m = p.models.get(mname)!;
		m.sessions.add(file);
		m.msgs += r.msgs;
		m.input += r.input;
		m.output += r.output;
		m.cacheRead += r.cacheRead;
		m.cacheWrite += r.cacheWrite;
		m.cost += r.cost;
		m.billed += r.billed;
	}
}

/** Build the sorted provider rows (models sorted, estimates filled) from a folded provider
 *  map — used for the global list and for each project's providers, so both read the same
 *  numbers the same way. */
function providerStatsOf(map: ProviderMap, priceTable: PriceTable): UsageProviderStats[] {
	const providers: UsageProviderStats[] = [];

	for (const [pName, pData] of map.entries()) {
		const models: UsageModelStats[] = [];
		let providerEstimate = 0;
		for (const [mName, mData] of pData.models.entries()) {
			// Billed and estimated never blend: `cost` keeps only the provider-billed part, while
			// the catalog-estimate remainder — or, for a row that carried no cost at all, a
			// price-table reconstruction with cache writes — lands in `estimatedCost`.
			const estimatedCost =
				mData.cost > 0
					? mData.cost - mData.billed
					: (estimateCost(mData.input, mData.output, mData.cacheRead, mData.cacheWrite, mName, pName, priceTable) ?? 0);
			providerEstimate += estimatedCost;
			models.push({
				name: mName,
				sessions: mData.sessions.size,
				msgs: mData.msgs,
				input: mData.input,
				output: mData.output,
				cacheRead: mData.cacheRead,
				cacheWrite: mData.cacheWrite,
				totalTokens: mData.input + mData.output + mData.cacheRead,
				cost: mData.billed,
				estimatedCost,
			});
		}
		models.sort((a, b) => b.totalTokens - a.totalTokens);

		providers.push({
			name: pName,
			sessions: pData.sessions.size,
			msgs: pData.msgs,
			input: pData.input,
			output: pData.output,
			cacheRead: pData.cacheRead,
			totalTokens: pData.input + pData.output + pData.cacheRead,
			cost: pData.billed,
			estimatedCost: providerEstimate,
			models,
		});
	}

	providers.sort((a, b) => b.totalTokens - a.totalTokens);
	return providers;
}

/** One file's rollup, narrowed to the days a range covers. Reads the flat
 *  `day\0provider\0model` buckets and emits the same provider/provider\0model keys the
 *  `all` path reads straight from `providers`, so the aggregation below runs once for both. */
function rollupSince(rollup: FileRollup, sinceDay: string): Record<string, Rollup> {
	const out: Record<string, Rollup> = {};
	for (const [dk, r] of Object.entries(rollup.days)) {
		// Day keys start with the fixed-width `YYYY-MM-DD`.
		const day = dk.slice(0, 10);
		if (day < sinceDay) continue;
		const pm = dk.slice(11);
		const sep = pm.indexOf("\u0000");
		if (sep === -1) continue;
		const pname = pm.slice(0, sep);
		for (const key of [pm, pname]) {
			const o = (out[key] ??= emptyRollup());
			o.msgs += r.msgs;
			o.input += r.input;
			o.output += r.output;
			o.cacheRead += r.cacheRead;
			o.cacheWrite += r.cacheWrite;
			o.cost += r.cost;
			o.billed += r.billed;
		}
	}
	for (const r of Object.values(out)) r.sessions = 1;
	return out;
}

const ROLLUP_FIELDS = ["msgs", "input", "output", "cacheRead", "cacheWrite", "cost", "billed"] as const;

/** A file's provider rows as the summary should count them: the range's day window when one
 *  is active, minus the statistics-reset baseline — field-wise, floored at 0, empty rows
 *  dropped. Both the global provider list and the per-project breakdown read this same map,
 *  so a project never counts what the provider row above it excluded. */
function effectiveProviders(rollup: FileRollup, baseline: FileRollup | undefined, sinceDay: string, needDays: boolean): Record<string, Rollup> {
	const current = needDays ? rollupSince(rollup, sinceDay) : rollup.providers;
	const before = baseline === undefined ? undefined : needDays ? rollupSince(baseline, sinceDay) : baseline.providers;
	if (before === undefined) return current;
	const out: Record<string, Rollup> = {};
	for (const [key, r] of Object.entries(current)) {
		const b = before[key];
		const nr = { ...r };
		for (const f of ROLLUP_FIELDS) nr[f] = Math.max(0, r[f] - (b?.[f] ?? 0));
		if (nr.msgs === 0) continue;
		out[key] = nr;
	}
	return out;
}

export function collectUsageSummary(forceScan = false, range: UsageRange = "all"): UsageSummary {
	const now = Date.now();
	if (!forceScan && cachedSummary && cachedRange === range && now - lastScanMs < 5000) {
		return cachedSummary;
	}

	// A range reads day buckets. Every v9 item carries them, and anything older is already
	// re-parsed by the version stamp, so no separate "needs days" pass is required.
	const start = rangeStart(range, now);
	const sinceDay = start === undefined ? "" : dayKey(start);
	const needDays = start !== undefined;

	const sessionsDir = join(getAgentDir(), "sessions");
	const files = scanSessionFiles(sessionsDir);
	const diskCache = loadDiskCache();
	const baseline = loadUsageBaseline();
	let cacheDirty = false;

	const priceTable = loadPriceTable();
	const providerMap: ProviderMap = new Map();
	/** Per-project aggregation: a file's project is its cwd, so each file folds into exactly
	 *  one entry, whose providers keep their own model rows for the Project view. */
	const projectMap = new Map<string, { sessions: Set<string>; providers: ProviderMap }>();
	/** Day buckets across all files, keyed by the UTC day (the `day` prefix of each bucket
	 *  key), baseline-subtracted so the windows answer the same statistics the rows do. */
	const dayMap = new Map<string, Rollup>();

	for (const file of files) {
		let stat;
		try {
			stat = statSync(file);
		} catch {
			continue;
		}

		let cached = diskCache.get(file);
		if (!(cached && cached.v === CACHE_VERSION && cached.rollup)) cached = undefined;

		const fallbackDay = dayKey(stat.mtimeMs);
		const baselineItem = baseline.get(file);
		const reparse = (): FileCacheItem => {
			// Keep the prefix's original day buckets: undated records otherwise inherit the
			// file's new modification day when a cache is rebuilt after an append. The rollup
			// seeds from the baseline so the cached item still holds the full history — the
			// baseline is subtracted at read time, never baked into the cache.
			const offset = baselineItem && (baselineItem.consumed ?? 0) <= stat.size ? (baselineItem.consumed ?? 0) : 0;
			const rollup: FileRollup = offset > 0 ? structuredClone(baselineItem!.rollup) : { providers: {}, days: {} };
			const bytes = offset > 0 ? (readTail(file, offset) ?? readFileSync(file).subarray(offset)) : readFileSync(file);
			const parsed = parseBuffer(bytes, fallbackDay);
			foldInto(rollup, parsed.entries);
			return {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				v: CACHE_VERSION,
				cwd: parsed.cwd ?? (offset > 0 ? baselineItem!.cwd : undefined) ?? cached?.cwd,
				consumed: offset + parsed.consumed,
				rollup,
			};
		};

		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			// Unchanged since the last scan: its rollup already holds everything.
		} else if (cached && (cached.consumed ?? 0) > 0 && stat.size > (cached.consumed ?? 0)) {
			// Grew, and a prefix was already parsed: read only the appended tail and fold it into
			// the existing rollup. (A shrunk file, or one whose size is below the offset,
			// re-parses whole — see the final branch.) The cwd stays the one already stored:
			// the tail does not contain the session header, so the head is not re-read.
			const tail = readTail(file, cached.consumed!);
			const parsed = tail ? parseBuffer(tail, fallbackDay) : null;
			if (parsed) {
				foldInto(cached.rollup, parsed.entries);
				cached.consumed = cached.consumed! + parsed.consumed;
				cached.mtimeMs = stat.mtimeMs;
				cached.size = stat.size;
			} else {
				// Unreadable: fall back to whole-file.
				cached = reparse();
				diskCache.set(file, cached);
			}
			cacheDirty = true;
		} else {
			cached = reparse();
			diskCache.set(file, cached);
			cacheDirty = true;
		}

		// What this file contributes: range window and reset baseline already applied.
		const effective: FileRollup = { providers: effectiveProviders(cached.rollup, baselineItem?.rollup, sinceDay, needDays), days: {} };

		// A file with no cwd in its cache item lands in "unknown" rather than being re-read.
		const projectName = cached.cwd ?? "unknown";
		let project = projectMap.get(projectName);
		if (!project) projectMap.set(projectName, (project = { sessions: new Set(), providers: new Map() }));
		project.sessions.add(file);
		foldFileIntoProviderMap(providerMap, file, effective);
		foldFileIntoProviderMap(project.providers, file, effective);
		const baseDays = baselineItem?.rollup.days;
		for (const [dk, r] of Object.entries(cached.rollup.days)) {
			// Day keys start with the fixed-width `YYYY-MM-DD`; the baseline's same-key row is
			// subtracted field-wise so the windows never resurrect pre-reset spend.
			const day = dk.slice(0, 10);
			const b = baseDays?.[dk];
			let t = dayMap.get(day);
			if (!t) dayMap.set(day, (t = emptyRollup()));
			t.msgs += Math.max(0, r.msgs - (b?.msgs ?? 0));
			t.input += Math.max(0, r.input - (b?.input ?? 0));
			t.output += Math.max(0, r.output - (b?.output ?? 0));
			t.cacheRead += Math.max(0, r.cacheRead - (b?.cacheRead ?? 0));
			t.cacheWrite += Math.max(0, r.cacheWrite - (b?.cacheWrite ?? 0));
			t.cost += Math.max(0, r.cost - (b?.cost ?? 0));
			t.billed += Math.max(0, r.billed - (b?.billed ?? 0));
		}
	}

	// Session files deleted on disk must leave the cache, or the file grows forever.
	const known = new Set(files);
	for (const k of diskCache.keys()) {
		if (!known.has(k)) {
			diskCache.delete(k);
			cacheDirty = true;
		}
	}

	if (cacheDirty) {
		saveDiskCache(diskCache);
	}

	const providers = providerStatsOf(providerMap, priceTable);

	// Fold per-provider results into totals
	let totalMsgs = 0;
	let totalInp = 0;
	let totalOut = 0;
	let totalCache = 0;
	let totalCost = 0;
	let estimatedCost = 0;

	const allSessions = new Set<string>();
	for (const pData of providerMap.values()) {
		for (const s of pData.sessions) allSessions.add(s);
	}
	for (const p of providers) {
		totalMsgs += p.msgs;
		totalInp += p.input;
		totalOut += p.output;
		totalCache += p.cacheRead;
		totalCost += p.cost;
		estimatedCost += p.estimatedCost;
	}

	const projects: UsageProjectStats[] = [];
	for (const [name, pData] of projectMap.entries()) {
		const pStats = providerStatsOf(pData.providers, priceTable);
		let msgs = 0;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cost = 0;
		let est = 0;
		for (const ps of pStats) {
			msgs += ps.msgs;
			input += ps.input;
			output += ps.output;
			cacheRead += ps.cacheRead;
			cost += ps.cost;
			est += ps.estimatedCost;
		}
		projects.push({
			name,
			sessions: pData.sessions.size,
			msgs,
			input,
			output,
			cacheRead,
			totalTokens: input + output + cacheRead,
			cost,
			estimatedCost: est,
			providers: pStats,
		});
	}
	projects.sort((a, b) => b.totalTokens - a.totalTokens);

	/** Sum of the day buckets over the last `n` UTC days, today included. */
	const windowOf = (n: number): UsageDayWindow => {
		let cost = 0;
		let estimated = 0;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		for (let i = 0; i < n; i++) {
			const r = dayMap.get(dayKey(now - i * 86_400_000));
			if (!r) continue;
			cost += r.billed;
			estimated += Math.max(0, r.cost - r.billed);
			input += r.input;
			output += r.output;
			cacheRead += r.cacheRead;
		}
		return { cost, estimated, input, output, cacheRead };
	};

	const totals: UsageSummary["totals"] = {
		sessions: allSessions.size,
		msgs: totalMsgs,
		input: totalInp,
		output: totalOut,
		cacheRead: totalCache,
		totalTokens: totalInp + totalOut + totalCache,
		cost: totalCost,
		reportedCost: totalCost,
		estimatedCost,
	};
	// The windows exist only when the scan saw day buckets (a cache that is all v8).
	if (dayMap.size > 0) {
		totals.today = windowOf(1);
		totals.last7d = windowOf(7);
		totals.last30d = windowOf(30);
	}

	cachedSummary = { providers, projects, totals };
	cachedRange = range;
	lastScanMs = now;
	return cachedSummary;
}

/** One model id in its canonical form: trimmed, case-folded, route tag (`:free`) dropped. */
const canonicalModel = (id: string): string => {
	const lower = id.trim().toLowerCase();
	const tag = lower.indexOf(":");
	return tag === -1 ? lower : lower.slice(0, tag);
};

/** Do these two ids name the same model? Exact after `canonicalModel` — deliberately not fuzzy.
 *
 *  The rule used to also match a bare tail (`target.endsWith("/" + name)`), so the first run
 *  under a new provider inherited the history of every other provider whose id ended the same
 *  way: `team/deepseek-ai/DeepSeek-V4.1-Flash` reported two other providers' deepseek totals
 *  (29.5M in / 3.2M out / 360.5M cache) as its own (2026-10-17). Two ids that differ are two
 *  routes — billed, rate-limited and counted apart — and only the vendor knows whether a short
 *  id and a path id are the same model, so the tab shows the tokens of the id it names. */
const modelMatches = (mName: string, target: string): boolean => canonicalModel(mName) === canonicalModel(target);

/** All-time usage for one model (same numbers as /usage; the active session is already in its own file). */
export function getModelAllTimeUsage(modelId?: string): { input: number; output: number; cacheRead: number } {
	// An empty target used to match EVERY model -> the Model tab showed the grand total under "No Model".
	if (!modelId) return { input: 0, output: 0, cacheRead: 0 };
	const summary = collectUsageSummary();
	let inp = 0;
	let out = 0;
	let read = 0;

	const target = modelId;
	for (const p of summary.providers) {
		for (const m of p.models) {
			if (modelMatches(m.name, target)) {
				inp += m.input;
				out += m.output;
				read += m.cacheRead;
			}
		}
	}

	return { input: inp, output: out, cacheRead: read };
}

// Self-check: `node lib/usage-store.ts`
if (isMain(import.meta.url)) {
	const NL = String.fromCharCode(10);
	const fixture = mkdtempSync(join(tmpdir(), "arnative-store-"));
	process.env.PI_CODING_AGENT_DIR = fixture;
	const asst = (model: string, input: number, ts: number, cost = 0.02) =>
		JSON.stringify({
			message: {
				role: "assistant",
				provider: "google",
				model,
				timestamp: ts,
				usage: { input, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: cost, totalFromProvider: true } },
			},
		});
	const header = (cwd: string) => JSON.stringify({ type: "session", cwd });
	const tsToday = Date.now();
	const tsYesterday = Date.now() - 86_400_000;
	const today = new Date(tsToday).toISOString().slice(0, 10);
	const yesterday = new Date(tsYesterday).toISOString().slice(0, 10);

	mkdirSync(join(fixture, "sessions", "proj-a"), { recursive: true });
	mkdirSync(join(fixture, "sessions", "proj-b"), { recursive: true });
	// proj-a carries a session header (cwd); proj-b has none, so it must land in "unknown".
	const fileA = join(fixture, "sessions", "proj-a", "a.jsonl");
	writeFileSync(fileA, [header("/repo/alpha"), asst("m1", 100, tsToday), asst("m1", 50, tsYesterday)].join(NL) + NL);
	writeFileSync(join(fixture, "sessions", "proj-b", "b.jsonl"), asst("m2", 7, tsToday) + NL);

	const summary = collectUsageSummary(true);
	assert(summary.projects.length === 2, "one project per cwd plus unknown");
	const alpha = summary.projects.find((p) => p.name === "/repo/alpha")!;
	const unknown = summary.projects.find((p) => p.name === "unknown")!;
	assert(alpha.msgs === 2 && alpha.input === 150 && Math.abs(alpha.cost - 0.04) < 1e-9, "a project row carries its files' totals");
	assert(unknown.msgs === 1 && unknown.input === 7, "a file with no cwd lands in unknown");
	assert(alpha.providers.length === 1 && alpha.providers[0]!.name === "google" && alpha.providers[0]!.models[0]!.name === "m1", "a project trees into its providers and models");
	const sumOf = (f: (p: (typeof summary.projects)[number]) => number) => summary.projects.reduce((n, p) => n + f(p), 0);
	assert(
		sumOf((p) => p.msgs) === summary.totals.msgs &&
			sumOf((p) => p.input) === summary.totals.input &&
			sumOf((p) => p.output) === summary.totals.output &&
			Math.abs(sumOf((p) => p.cost) - summary.totals.cost) < 1e-9,
		"projects totals equal totals",
	);

	// Day buckets: windows come from them, and on disk they sum to the file total.
	assert(summary.totals.today !== undefined && summary.totals.last7d !== undefined && summary.totals.last30d !== undefined, "day buckets produce the today/7d/30d windows");
	assert(summary.totals.today.input === 107 && Math.abs(summary.totals.today.cost - 0.04) < 1e-9, "today sums only today's bucket");
	assert(summary.totals.last7d.input === 157 && Math.abs(summary.totals.last7d.cost - 0.06) < 1e-9, "last7d includes yesterday");
	assert(summary.totals.last30d.input === 157, "last30d includes yesterday too");
	const cachePath = join(fixture, "arnative", "usage-cache.json");
	const disk = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { r: Record<string, number[]>; d?: Record<string, number[]>; w?: string }>;
	const relA = join("proj-a", "a.jsonl");
	const msgsOf = (rows: Record<string, number[]>) => Object.values(rows).reduce((n, a) => n + a[0]!, 0);
	assert(disk[relA]!.w === "/repo/alpha", "v8 stores the session cwd in w");
	assert(disk[relA]!.d !== undefined && msgsOf(disk[relA]!.d!) === msgsOf(disk[relA]!.r), "day buckets sum to the file total on disk");
	const rowA = disk[relA]!.r["google\u0000m1"]!;
	assert(rowA.length === 7 && rowA[4] === 4, "v8 rows carry cacheWrite (two entries x 2)");
	assert(Math.abs(rowA[6]! - 0.04) < 1e-9, "v8 rows carry the billed split of the cost");
	assert(
		Object.keys(disk[relA]!.d!).every((k) => k.startsWith(`${today}\u0000`) || k.startsWith(`${yesterday}\u0000`)) && disk[relA]!.d![`${today}\u0000google\u0000m1`] !== undefined,
		"day keys are the UTC day + provider + model",
	);
	assert(disk[join("proj-b", "b.jsonl")]!.w === undefined, "a file with no cwd stores none (it reads as unknown)");

	// A grown file tail-folds: the cwd stays the cached one (the head is not re-read) and the
	// new entry lands in its day bucket.
	writeFileSync(fileA, asst("m1", 1000, tsToday) + NL, { flag: "a" });
	const grown = collectUsageSummary(true);
	assert(grown.totals.msgs === 4, "an appended record is folded from the tail");
	assert(grown.projects.find((p) => p.name === "/repo/alpha")!.input === 1150, "the tail fold keeps the cached cwd (the project is unchanged)");
	assert(grown.totals.today!.input === 1107, "the appended entry lands in today's bucket");
	const grownDisk = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { w?: string }>;
	assert(grownDisk[relA]!.w === "/repo/alpha", "the cwd survives a tail fold on disk too");

	// A pre-v8 (v5 compact, no `d`) cache item is re-parsed once from its file — not trusted —
	// and re-saved as v8 with its days, cwd, cache writes, billed split and tool-result spend.
	const fileC = join(fixture, "sessions", "proj-b", "c.jsonl");
	writeFileSync(fileC, asst("m2", 11, tsToday) + NL);
	const cStat = statSync(fileC);
	writeFileSync(
		cachePath,
		JSON.stringify({ [join("proj-b", "c.jsonl")]: { m: cStat.mtimeMs, s: cStat.size, c: cStat.size, r: { "google\u0000m2": [99, 999, 1, 1, 9] } } }),
	);
	resetUsageCache();
	const reparsed = collectUsageSummary(true);
	assert(reparsed.totals.msgs === 5 && reparsed.totals.input === 1168, "a v5 cache item is re-parsed from the file (the stale 99 is not counted)");
	const afterDisk = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { d?: Record<string, number[]>; w?: string }>;
	const relC = join("proj-b", "c.jsonl");
	assert(afterDisk[relC]!.d !== undefined && msgsOf(afterDisk[relC]!.d!) === 1, "the re-parsed item is re-saved as v8 with day buckets");

	// A v6 item (day buckets but 5-number rows) is also re-parsed once: its rows carry neither
	// cacheWrite nor the billed split, so it is stamped 6 and not trusted.
	const fileD = join(fixture, "sessions", "proj-b", "d.jsonl");
	writeFileSync(fileD, asst("m2", 13, tsToday) + NL);
	const dStat = statSync(fileD);
	writeFileSync(
		cachePath,
		JSON.stringify({
			[join("proj-b", "d.jsonl")]: {
				m: dStat.mtimeMs,
				s: dStat.size,
				c: dStat.size,
				r: { "google\u0000m2": [99, 999, 1, 1, 9] },
				d: { [`${today}\u0000google\u0000m2`]: [99, 999, 1, 1, 9] },
			},
		}),
	);
	resetUsageCache();
	const reparsed6 = collectUsageSummary(true);
	assert(reparsed6.totals.msgs === 6 && reparsed6.totals.input === 1181, "a v6 cache item is re-parsed from its file (the stale 99 is not counted)");

	// Child spend: pi attaches it to the tool result, but the child also writes its own session
	// file, so the store must not read the tool result — that counts the same tokens twice.
	// Its own fixture, so the totals above stay untouched.
	assert(TOOL_PROVIDER === "tool", "child spend is attributed to the synthetic `tool` provider");
	const toolFixture = mkdtempSync(join(tmpdir(), "arnative-tool-"));
	process.env.PI_CODING_AGENT_DIR = toolFixture;
	resetUsageCache();
	mkdirSync(join(toolFixture, "sessions", "p"), { recursive: true });
	const toolFile = join(toolFixture, "sessions", "p", "t.jsonl");
	const toolResult = (toolName: string, usage?: object) =>
		JSON.stringify({
			message: { role: "toolResult", toolCallId: "c1", toolName, content: [], isError: false, timestamp: tsToday, ...(usage ? { usage } : {}) },
		});
	writeFileSync(
		toolFile,
		[
			header("/repo/alpha"),
			asst("m1", 100, tsToday),
			toolResult("subagent", { input: 40, output: 6, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01, totalFromProvider: true } }),
			toolResult("bash"), // no usage at all
		].join(NL) + NL,
	);
	const parentOnly = collectUsageSummary(true);
	assert(parentOnly.totals.msgs === 1 && parentOnly.totals.input === 100, "a tool result's usage is not read: the child's own session file carries it");
	assert(parentOnly.providers.every((p) => p.name !== TOOL_PROVIDER), "no synthetic `tool` row: /usage never sees child spend twice");

	// A subagent run writes <project>/<parent id>/<run id>/run-N/session.jsonl, and its
	// transcript under <project>/subagent-artifacts/: the child session is real spend, the
	// transcript is the same messages again.
	const childDir = join(toolFixture, "sessions", "p", "parent-1", "run-1", "run-0");
	mkdirSync(childDir, { recursive: true });
	writeFileSync(join(childDir, "session.jsonl"), [header("/repo/alpha"), asst("m1", 40, tsToday)].join(NL) + NL);
	mkdirSync(join(toolFixture, "sessions", "p", SUBAGENT_ARTIFACTS_DIR), { recursive: true });
	writeFileSync(
		join(toolFixture, "sessions", "p", SUBAGENT_ARTIFACTS_DIR, "x_transcript.jsonl"),
		[header("/repo/alpha"), asst("m1", 7, tsToday)].join(NL) + NL,
	);
	resetUsageCache();
	const nested = collectUsageSummary(true);
	assert(nested.totals.msgs === 2 && nested.totals.input === 140, "a child session is counted once (40), its transcript not at all (7)");
	assert(nested.totals.sessions === 2, "the parent session and the child session, not the transcript");

	// A v7 item (7-number rows with day buckets, no `t`) is re-parsed once from its file — not
	// trusted — and re-saved as v8.
	const tStat = statSync(toolFile);
	writeFileSync(
		join(toolFixture, "arnative", "usage-cache.json"),
		JSON.stringify({
			[join("p", "t.jsonl")]: {
				m: tStat.mtimeMs,
				s: tStat.size,
				c: tStat.size,
				r: { "google\u0000m1": [99, 999, 1, 1, 1, 9, 9] },
				d: { [`${today}\u0000google\u0000m1`]: [99, 999, 1, 1, 1, 9, 9] },
			},
		}),
	);
	resetUsageCache();
	const reparsed7 = collectUsageSummary(true);
	assert(reparsed7.totals.msgs === 2 && reparsed7.totals.input === 140, "a v7 cache item is re-parsed from its file (the stale 99 is not counted)");
	const after7 = JSON.parse(readFileSync(join(toolFixture, "arnative", "usage-cache.json"), "utf8")) as Record<string, { t?: number }>;
	assert(after7[join("p", "t.jsonl")]!.t === CACHE_VERSION, "the re-parsed item is re-saved as the current version");

	// A cache written by the build that also stored tool-result rows is stamped `t: 8`: it must
	// be re-parsed, or the child spend it holds is counted a second time next to the child's file.
	const staleDisk = JSON.parse(readFileSync(join(toolFixture, "arnative", "usage-cache.json"), "utf8")) as Record<string, unknown>;
	staleDisk[join("p", "t.jsonl")] = {
		m: tStat.mtimeMs,
		s: tStat.size,
		c: tStat.size,
		t: 8,
		r: { [`${TOOL_PROVIDER}\u0000subagent`]: [1, 40, 6, 2, 1, 0.01, 0.01], "google\u0000m1": [1, 100, 5, 1, 0, 0.02, 0.02] },
	};
	writeFileSync(join(toolFixture, "arnative", "usage-cache.json"), JSON.stringify(staleDisk));
	resetUsageCache();
	const afterStale = collectUsageSummary(true);
	assert(afterStale.providers.every((p) => p.name !== TOOL_PROVIDER), "a `t: 8` item's tool rows are dropped: the item is re-parsed");
	assert(afterStale.totals.input === 140, "the re-parsed item keeps the parent and the child, once each");

	// An empty session (no assistant message) writes `r: {}`: that is a current item, not a
	// pre-v7 one — `some` over an empty map is false, and treating it as old would re-read that
	// file on every start. A tampered row proves the item is trusted rather than re-parsed.
	const emptyFile = join(toolFixture, "sessions", "p", "empty.jsonl");
	writeFileSync(emptyFile, header("/repo/alpha") + NL);
	resetUsageCache();
	collectUsageSummary(true);
	const emptyCachePath = join(toolFixture, "arnative", "usage-cache.json");
	const emptyDisk = JSON.parse(readFileSync(emptyCachePath, "utf8")) as Record<string, { r: Record<string, number[]> }>;
	assert(emptyDisk[join("p", "empty.jsonl")] !== undefined, "an empty session is cached");
	emptyDisk[join("p", "empty.jsonl")]!.r = { "google\u0000m9": [5, 500, 0, 0, 0, 0, 0] };
	writeFileSync(emptyCachePath, JSON.stringify(emptyDisk));
	resetUsageCache();
	assert(collectUsageSummary(true).totals.input === 640, "an empty `r` item is trusted, not re-read on every start");
	rmSync(toolFixture, { recursive: true, force: true });
	process.env.PI_CODING_AGENT_DIR = fixture;
	resetUsageCache();

	// Price table: cacheWrite is priced like the other three, and an unchanged models.json is
	// read once — two loadPriceTable() calls return the same memo object.
	writeFileSync(
		join(fixture, "models.json"),
		JSON.stringify({ providers: { google: { models: [{ id: "m1", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 } }] } } }),
	);
	const table1 = loadPriceTable();
	assert(table1 === loadPriceTable(), "two loadPriceTable() calls with an unchanged file read it once (memo identity)");
	assert(estimateCost(1_000_000, 0, 0, 0, "m1", "google") === 1, "input keeps its own rate");
	assert(estimateCost(0, 0, 0, 1_000_000, "m1", "google") === 3, "cache writes use their own rate");
	assert(Math.abs(estimateCost(0, 0, 1_000_000, 1_000_000, "m1", "google")! - 3.1) < 1e-9, "cache read and cache write add up");
	await new Promise((r) => setTimeout(r, 5)); // mtime granularity: a rewrite must change the memo key
	writeFileSync(
		join(fixture, "models.json"),
		JSON.stringify({ providers: { google: { models: [{ id: "m1", cost: { input: 10, output: 2, cacheRead: 0.1, cacheWrite: 3 } }] } } }),
	);
	const table2 = loadPriceTable();
	assert(table2 !== table1 && estimateCost(1_000_000, 0, 0, 0, "m1", "google") === 10, "a changed models.json is re-read");

	rmSync(fixture, { recursive: true, force: true });
	console.log("usage-store.ts self-check OK");
}
