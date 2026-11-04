/**
 * Token usage data layer — the single source for /usage and the Model tab.
 * - Scans local Pi session history (~/.pi/agent/sessions/*.jsonl).
 * - mtime+size keyed cache in ~/.pi/agent/arnative/usage-cache.json, read into
 *   memory once (parsing 4MB per header frame cost ~50ms and lagged long chats).
 * - No double counting: the active session is already in its own file, so it is
 *   NOT re-added from sessionManager (that inflated the ↑↓ totals).
 * - Rollups also keep per-day buckets (UTC) and the session cwd, so /usage can answer
 *   "today" and "per project" from the cache without a full re-scan.
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
	cost: number;
	/** Message timestamp (ms), kept so entries can be bucketed per day. 0 when absent. */
	ts: number;
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
	cost: number;
}

const emptyRollup = (): Rollup => ({ sessions: 0, msgs: 0, input: 0, output: 0, cacheRead: 0, cost: 0 });

function addToRollup(r: Rollup, e: UsageEntry): void {
	r.msgs++;
	r.input += e.input;
	r.output += e.output;
	r.cacheRead += e.cacheRead;
	r.cost += e.cost;
}

/** UTC day bucket key (`YYYY-MM-DD`) of a timestamp. UTC on purpose: local time would make the
 *  on-disk cache depend on the timezone of the machine that wrote it, so a restore elsewhere
 *  would re-bucket every entry. */
const dayKey = (ts: number): string => new Date(ts > 0 ? ts : 0).toISOString().slice(0, 10);

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
		const day = `${dayKey(e.ts)}\u0000${key}`;
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
	totalTokens: number;
	cost: number;
	/** Cost reconstructed from the price table, only when `cost` is 0. Never folded into `cost`. */
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
	/** Sum of the models' `estimatedCost`, for the same rows this provider could not price. */
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
	cost: number;
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
		cost: number;
		/** Provider-reported cost only (never includes the estimate). */
		reportedCost: number;
		/** Cost reconstructed from `models.json` rates. Shown with a `~`, never folded into `cost`. */
		estimatedCost: number;
		/** Day-bucket windows, present only when the scan saw day buckets (a v6 cache). */
		today?: UsageDayWindow;
		last7d?: UsageDayWindow;
		last30d?: UsageDayWindow;
	};
}

export type ModelPrices = Record<string, { input?: number; output?: number; cacheRead?: number }>;
export type PriceTable = Record<string, ModelPrices>;

const modelsFilePath = (): string => join(getAgentDir(), "models.json");

type ModelsJsonCost = { input?: number; output?: number; cacheRead?: number };

/**
 * Rates declared automatically in pi's `models.json` (`providers.<name>.models[].cost`).
 * Keyed by provider to reconstruct estimates for historical or 0-cost rows.
 */
export function loadPriceTable(): PriceTable {
	const table: PriceTable = {};
	try {
		const raw = JSON.parse(readFileSync(modelsFilePath(), "utf8")) as {
			providers?: Record<string, { models?: { id?: string; cost?: ModelsJsonCost }[] }>;
		};
		for (const [provider, cfg] of Object.entries(raw.providers ?? {})) {
			const models: ModelPrices = {};
			for (const m of cfg?.models ?? []) {
				const c = m?.cost;
				if (!m?.id || !c || typeof c.input !== "number" || typeof c.output !== "number") continue;
				models[m.id] = { input: c.input, output: c.output, cacheRead: typeof c.cacheRead === "number" ? c.cacheRead : 0 };
			}
			if (Object.keys(models).length > 0) table[provider] = models;
		}
	} catch {
		// Malformed or absent models.json means no declared rates.
	}
	return table;
}

/** True when this provider+model has a usable input+output price (cacheRead is optional). */
export function hasPrice(provider: string, modelId: string, table: PriceTable = loadPriceTable()): boolean {
	return findPrice(provider, modelId, table) !== null;
}

/** Rates for one provider+model. The provider's own entry wins over the `*` fallback. */
function findPrice(provider: string, modelId: string, table: PriceTable): { input: number; output: number; cacheRead: number } | null {
	return rateFor(table[provider], modelId) ?? rateFor(table["*"], modelId);
}

function rateFor(entries: ModelPrices | undefined, modelId: string): { input: number; output: number; cacheRead: number } | null {
	if (!entries || typeof entries !== "object") return null;
	const lower = modelId.toLowerCase();
	const keys = Object.keys(entries).filter((k) => !k.startsWith("_"));
	const key =
		keys.find((k) => k.toLowerCase() === lower) ??
		keys.find((k) => lower.endsWith("/" + k.toLowerCase()) || k.toLowerCase().endsWith("/" + lower));
	if (!key) return null;
	const p = entries[key]!;
	if (typeof p.input !== "number" || typeof p.output !== "number") return null;
	return { input: p.input, output: p.output, cacheRead: typeof p.cacheRead === "number" ? p.cacheRead : 0 };
}

/** Cost of one provider+model's token counts from the price table, or null when unpriced. */
export function estimateCost(
	input: number,
	output: number,
	cacheRead: number,
	modelId: string,
	provider: string,
	table: PriceTable = loadPriceTable(),
): number | null {
	const p = findPrice(provider, modelId, table);
	if (!p) return null;
	return (input / 1e6) * p.input + (output / 1e6) * p.output + (cacheRead / 1e6) * p.cacheRead;
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
const CACHE_VERSION = 6; // v6: day buckets + cwd (v5 compact rows, v4 full rollup)

/** The v6 disk shape: one-char keys, model rows in `r`, day rows in `d` (keyed
 *  `YYYY-MM-DD\0provider\0model`), the session cwd in `w` — provider-level and per-day
 *  rollups are derived on load, so every number is stored once. Keys on disk are
 *  paths relative to the sessions dir (the absolute path dominated the old size). */
type DiskItem = {
	m: number;
	s: number;
	c?: number;
	r: Record<string, [number, number, number, number, number]>;
	d?: Record<string, [number, number, number, number, number]>;
	w?: string;
};

/** Decode one disk item (v6 compact, v5 compact or v4 full) into the in-memory shape. */
function decodeDiskItem(raw: unknown): FileCacheItem | null {
	if (!raw || typeof raw !== "object") return null;
	if ("rollup" in raw) {
		const v4 = raw as FileCacheItem;
		// A v4 rollup has no day buckets: default them so the v6 code paths always see the field.
		return v4.rollup ? { ...v4, v: CACHE_VERSION, rollup: { days: {}, ...v4.rollup } } : null;
	}
	const d = raw as Partial<DiskItem>;
	if (typeof d.m !== "number" || typeof d.s !== "number" || !d.r) return null;
	const rollup: FileRollup = { providers: {}, days: {} };
	for (const [pm, a] of Object.entries(d.r)) {
		if (!Array.isArray(a) || a.length < 5) continue;
		const [msgs, input, output, cacheRead, cost] = a as [number, number, number, number, number];
		Object.assign((rollup.providers[pm] ??= emptyRollup()), { sessions: 1, msgs, input, output, cacheRead, cost });
		const p = (rollup.providers[pm.split("\u0000")[0]!] ??= emptyRollup());
		p.sessions = 1;
		p.msgs += msgs;
		p.input += input;
		p.output += output;
		p.cacheRead += cacheRead;
		p.cost += cost;
	}
	// v6 adds the day buckets (`d`) and the cwd (`w`). A compact item without `d` is a pre-v6
	// entry: it decodes the same way, but is stamped v5 so the scan re-parses its file once
	// and re-saves it with its days (that one re-parse is what a version bump costs).
	const hasDays = d.d !== undefined;
	if (hasDays) {
		for (const [dk, a] of Object.entries(d.d!)) {
			if (!Array.isArray(a) || a.length < 5) continue;
			const [msgs, input, output, cacheRead, cost] = a as [number, number, number, number, number];
			Object.assign((rollup.days[dk] ??= emptyRollup()), { sessions: 1, msgs, input, output, cacheRead, cost });
		}
	}
	return {
		mtimeMs: d.m,
		size: d.s,
		v: hasDays ? CACHE_VERSION : 5,
		cwd: typeof d.w === "string" ? d.w : undefined,
		consumed: typeof d.c === "number" ? d.c : d.s,
		rollup,
	};
}

/** Encode an in-memory item as v6: model rows in `r`, day rows in `d`, the cwd in `w`. */
function encodeDiskItem(item: FileCacheItem): DiskItem {
	const r: DiskItem["r"] = {};
	const d: DiskItem["d"] = {};
	for (const [pm, roll] of Object.entries(item.rollup.providers)) {
		if (pm.includes("\u0000")) r[pm] = [roll.msgs, roll.input, roll.output, roll.cacheRead, roll.cost];
	}
	for (const [dk, roll] of Object.entries(item.rollup.days)) {
		d[dk] = [roll.msgs, roll.input, roll.output, roll.cacheRead, roll.cost];
	}
	const out: DiskItem = { m: item.mtimeMs, s: item.size, c: item.consumed ?? item.size, r, d };
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
		const list = readdirSync(dir, { withFileTypes: true });
		for (const ent of list) {
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				files.push(...scanSessionFiles(full));
			} else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
				files.push(full);
			}
		}
	} catch {
		// ignore
	}
	return files;
}

/** Extract a usage entry from one line, or null when it is not an assistant message. */
function entryOfLine(line: string): UsageEntry | null {
	// Loose prefilter (fast path only): exact key would break on JSON formatting changes
	// and silently drop usage. The role is re-checked on the parsed object below.
	if (!line || !line.includes('"role"')) return null;
	try {
		const m = JSON.parse(line)?.message;
		if (m?.role !== "assistant") return null;
		const u = m.usage || {};
		return {
			provider: String(m.provider || "unknown"),
			model: String(m.model || "unknown"),
			input: Number(u.input) || 0,
			output: Number(u.output) || 0,
			cacheRead: Number(u.cacheRead) || 0,
			cost: Number(u.cost?.total) || 0,
			ts: Number(m.timestamp) || 0,
		};
	} catch {
		return null;
	}
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
 * when the buffer starts with the session header, i.e. on a whole-file parse.
 */
function parseBuffer(buf: Buffer): { entries: UsageEntry[]; consumed: number; cwd?: string } {
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
		const entry = entryOfLine(line);
		if (entry) entries.push(entry);
		start = nl + 1;
		consumed = start;
	}
	if (start < buf.length) {
		const tail = buf.toString("utf8", start);
		if (start === 0) cwd = sessionCwdOf(tail) ?? cwd;
		const entry = entryOfLine(tail);
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
let lastScanMs = 0;

/** Drop every in-memory memo so the next scan reads the cache file and the session files
 *  again. The self-check needs this: `forceScan` skips the 5s summary cache but still
 *  trusts the memoized disk cache, so without it a "cold parse" test asserts a value
 *  against itself and can never fail. */
export function resetUsageCache(): void {
	diskMemo = null;
	cachedSummary = null;
	lastScanMs = 0;
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
		cost: number;
		models: Map<string, { sessions: Set<string>; msgs: number; input: number; output: number; cacheRead: number; cost: number }>;
	}
>;

/** Fold one file's rollup rows into a provider map. */
function foldFileIntoProviderMap(map: ProviderMap, file: string, rollup: FileRollup): void {
	for (const [key, r] of Object.entries(rollup.providers)) {
		const sep = key.indexOf("\u0000");
		const pname = sep === -1 ? key : key.slice(0, sep);
		if (!map.has(pname)) {
			map.set(pname, { sessions: new Set(), msgs: 0, input: 0, output: 0, cacheRead: 0, cost: 0, models: new Map() });
		}
		const p = map.get(pname)!;
		p.sessions.add(file);

		if (sep === -1) {
			// Provider-level key: the message totals belong here only.
			p.msgs += r.msgs;
			p.input += r.input;
			p.output += r.output;
			p.cacheRead += r.cacheRead;
			p.cost += r.cost;
			continue;
		}

		const mname = key.slice(sep + 1);
		if (!p.models.has(mname)) {
			p.models.set(mname, { sessions: new Set(), msgs: 0, input: 0, output: 0, cacheRead: 0, cost: 0 });
		}
		const m = p.models.get(mname)!;
		m.sessions.add(file);
		m.msgs += r.msgs;
		m.input += r.input;
		m.output += r.output;
		m.cacheRead += r.cacheRead;
		m.cost += r.cost;
	}
}

/** Build the sorted provider rows (models sorted, estimates filled) from a folded provider
 *  map — used for the global list and for each project's providers, so both read the same
 *  numbers the same way. */
function providerStatsOf(map: ProviderMap, priceTable: PriceTable): UsageProviderStats[] {
	const providers: UsageProviderStats[] = [];

	for (const [pName, pData] of map.entries()) {
		const models: UsageModelStats[] = [];
		for (const [mName, mData] of pData.models.entries()) {
			models.push({
				name: mName,
				sessions: mData.sessions.size,
				msgs: mData.msgs,
				input: mData.input,
				output: mData.output,
				cacheRead: mData.cacheRead,
				totalTokens: mData.input + mData.output,
				cost: mData.cost,
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
			totalTokens: pData.input + pData.output,
			cost: pData.cost,
			models,
		});
	}

	providers.sort((a, b) => b.totalTokens - a.totalTokens);

	// Estimate unpriced pairs from price table. Kept separate in estimatedCost.
	for (const p of providers) {
		let providerEstimate = 0;
		for (const m of p.models) {
			const est = m.cost > 0 ? null : estimateCost(m.input, m.output, m.cacheRead, m.name, p.name, priceTable);
			m.estimatedCost = est ?? 0;
			providerEstimate += m.estimatedCost;
		}
		p.estimatedCost = providerEstimate;
	}

	return providers;
}

export function collectUsageSummary(forceScan = false): UsageSummary {
	const now = Date.now();
	if (!forceScan && cachedSummary && now - lastScanMs < 5000) {
		return cachedSummary;
	}

	const sessionsDir = join(getAgentDir(), "sessions");
	const files = scanSessionFiles(sessionsDir);
	const diskCache = loadDiskCache();
	let cacheDirty = false;

	const priceTable = loadPriceTable();
	const providerMap: ProviderMap = new Map();
	/** Per-project aggregation: a file's project is its cwd, so each file folds into exactly
	 *  one entry, whose providers keep their own model rows for the Project view. */
	const projectMap = new Map<string, { sessions: Set<string>; providers: ProviderMap }>();
	/** Day buckets across all files, keyed by the UTC day (the `day\0provider\0model` prefix). */
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

		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			// Unchanged since the last scan: its rollup already holds everything.
		} else if (cached && (cached.consumed ?? 0) > 0 && stat.size > (cached.consumed ?? 0)) {
			// Grew, and a prefix was already parsed: read only the appended tail and fold it into
			// the existing rollup. (A shrunk file, or one whose size is below the offset,
			// re-parses whole — see the final branch.) The cwd stays the one already stored:
			// the tail does not contain the session header, so the head is not re-read.
			const tail = readTail(file, cached.consumed!);
			const parsed = tail ? parseBuffer(tail) : null;
			if (parsed) {
				foldInto(cached.rollup, parsed.entries);
				cached.consumed = cached.consumed! + parsed.consumed;
				cached.mtimeMs = stat.mtimeMs;
				cached.size = stat.size;
			} else {
				// Unreadable: fall back to whole-file.
				const full = parseBuffer(readFileSync(file));
				cached = { mtimeMs: stat.mtimeMs, size: stat.size, v: CACHE_VERSION, cwd: full.cwd ?? cached.cwd, consumed: full.consumed, rollup: rollupOfFile(full.entries) };
				diskCache.set(file, cached);
			}
			cacheDirty = true;
		} else {
			// Whole-file parse: the session header (first line) carries the cwd.
			const full = parseBuffer(readFileSync(file));
			cached = { mtimeMs: stat.mtimeMs, size: stat.size, v: CACHE_VERSION, cwd: full.cwd ?? cached?.cwd, consumed: full.consumed, rollup: rollupOfFile(full.entries) };
			diskCache.set(file, cached);
			cacheDirty = true;
		}

		// A file with no cwd in its cache item lands in "unknown" rather than being re-read.
		const projectName = cached.cwd ?? "unknown";
		let project = projectMap.get(projectName);
		if (!project) projectMap.set(projectName, (project = { sessions: new Set(), providers: new Map() }));
		project.sessions.add(file);
		foldFileIntoProviderMap(providerMap, file, cached.rollup);
		foldFileIntoProviderMap(project.providers, file, cached.rollup);
		for (const [dk, r] of Object.entries(cached.rollup.days)) {
			// Day keys start with the fixed-width `YYYY-MM-DD`.
			const day = dk.slice(0, 10);
			let t = dayMap.get(day);
			if (!t) dayMap.set(day, (t = emptyRollup()));
			t.msgs += r.msgs;
			t.input += r.input;
			t.output += r.output;
			t.cacheRead += r.cacheRead;
			t.cost += r.cost;
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
			totalTokens: input + output,
			cost,
			estimatedCost: est,
			providers: pStats,
		});
	}
	projects.sort((a, b) => b.totalTokens - a.totalTokens);

	/** Sum of the day buckets over the last `n` UTC days, today included. */
	const windowOf = (n: number): UsageDayWindow => {
		let cost = 0;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		for (let i = 0; i < n; i++) {
			const r = dayMap.get(dayKey(now - i * 86_400_000));
			if (!r) continue;
			cost += r.cost;
			input += r.input;
			output += r.output;
			cacheRead += r.cacheRead;
		}
		return { cost, input, output, cacheRead };
	};

	const totals: UsageSummary["totals"] = {
		sessions: allSessions.size,
		msgs: totalMsgs,
		input: totalInp,
		output: totalOut,
		cacheRead: totalCache,
		totalTokens: totalInp + totalOut,
		cost: totalCost,
		reportedCost: totalCost,
		estimatedCost,
	};
	// The windows exist only when the scan saw day buckets (a cache that is all v6).
	if (dayMap.size > 0) {
		totals.today = windowOf(1);
		totals.last7d = windowOf(7);
		totals.last30d = windowOf(30);
	}

	cachedSummary = { providers, projects, totals };
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
		JSON.stringify({ message: { role: "assistant", provider: "google", model, timestamp: ts, usage: { input, output: 5, cacheRead: 1, cost: { total: cost } } } });
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
	assert(disk[relA]!.w === "/repo/alpha", "v6 stores the session cwd in w");
	assert(disk[relA]!.d !== undefined && msgsOf(disk[relA]!.d!) === msgsOf(disk[relA]!.r), "day buckets sum to the file total on disk");
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

	// A pre-v6 (v5 compact, no `d`) cache item is re-parsed once from its file — not trusted —
	// and re-saved as v6 with its days and cwd, yielding the file's own totals.
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
	assert(afterDisk[relC]!.d !== undefined && msgsOf(afterDisk[relC]!.d!) === 1, "the re-parsed item is re-saved as v6 with day buckets");

	rmSync(fixture, { recursive: true, force: true });
	console.log("usage-store.ts self-check OK");
}
