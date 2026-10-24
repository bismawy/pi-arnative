/**
 * Token usage data layer — the single source for /usage and the Model tab.
 * - Scans local Pi session history (~/.pi/agent/sessions/*.jsonl).
 * - mtime+size keyed cache in ~/.pi/agent/arnative/usage-cache.json, read into
 *   memory once (parsing 4MB per header frame cost ~50ms and lagged long chats).
 * - No double counting: the active session is already in its own file, so it is
 *   NOT re-added from sessionManager (that inflated the ↑↓ totals).
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface UsageEntry {
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

interface FileCacheItem {
	mtimeMs: number;
	size: number;
	v?: number;
	/** Byte offset of the last complete line parsed. Session files are append-only, so a
	 *  grown file only needs its tail read — re-parsing the whole 1MB+ active session on the
	 *  5s render path cost ~15ms and grew with chat length. */
	consumed?: number;
	/** Per-file rollup, not the raw entries: the summary is rebuilt from these every scan, and
	 *  a long session holds tens of thousands of entries. Storing the rolled-up numbers keeps
	 *  the cache small and makes a refresh cost the size of the *growth*, not the session. */
	rollup: FileRollup;
}

/** Usage totals for one session file, per provider and per provider+model. */
interface FileRollup {
	providers: Record<string, Rollup>;
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

/** Fold entries into an existing file rollup, updating provider and provider+model keys together. */
function foldInto(rollup: FileRollup, entries: UsageEntry[]): void {
	if (entries.length === 0) return;
	for (const e of entries) {
		const key = `${e.provider}\u0000${e.model}`;
		(rollup.providers[e.provider] ??= emptyRollup());
		addToRollup(rollup.providers[e.provider]!, e);
		(rollup.providers[key] ??= emptyRollup());
		addToRollup(rollup.providers[key]!, e);
	}
	// `sessions` counts the file, not the messages, so it is 1 once the file has any use.
	for (const key of Object.keys(rollup.providers)) rollup.providers[key]!.sessions = 1;
}

/** The rollup of a freshly parsed file (a foldInto that starts from nothing). */
function rollupOfFile(entries: UsageEntry[]): FileRollup {
	const rollup: FileRollup = { providers: {} };
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

export interface UsageSummary {
	providers: UsageProviderStats[];
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
const CACHE_VERSION = 4; // v4: per-file rollup (was raw entries in v3)

/** The v5 disk shape: one-char keys, and only provider\0model rows — provider-level
 *  rollups are derived on load, so every number is stored once. Keys on disk are
 *  paths relative to the sessions dir (the absolute path dominated the old size). */
type DiskItem = { m: number; s: number; c?: number; r: Record<string, [number, number, number, number, number]> };

/** Decode one disk item (v5 compact or v4 full) into the in-memory shape. */
function decodeDiskItem(raw: unknown): FileCacheItem | null {
	if (!raw || typeof raw !== "object") return null;
	if ("rollup" in raw) {
		const v4 = raw as FileCacheItem;
		return v4.rollup ? { ...v4, v: CACHE_VERSION } : null;
	}
	const d = raw as Partial<DiskItem>;
	if (typeof d.m !== "number" || typeof d.s !== "number" || !d.r) return null;
	const rollup: FileRollup = { providers: {} };
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
	return { mtimeMs: d.m, size: d.s, v: CACHE_VERSION, consumed: typeof d.c === "number" ? d.c : d.s, rollup };
}

/** Encode an in-memory item as v5: model rows only (see DiskItem). */
function encodeDiskItem(item: FileCacheItem): DiskItem {
	const r: DiskItem["r"] = {};
	for (const [pm, roll] of Object.entries(item.rollup.providers)) {
		if (pm.includes("\u0000")) r[pm] = [roll.msgs, roll.input, roll.output, roll.cacheRead, roll.cost];
	}
	return { m: item.mtimeMs, s: item.size, c: item.consumed ?? item.size, r };
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
		};
	} catch {
		return null;
	}
}

/**
 * Parse newline-terminated lines from a buffer. The returned offset is byte-granular, so it can
 * be fed back to `readSync`; a trailing segment without a newline counts only when it parses, so
 * a write caught mid-flight is left for the next scan rather than dropped.
 */
function parseBuffer(buf: Buffer): { entries: UsageEntry[]; consumed: number } {
	const entries: UsageEntry[] = [];
	let start = 0;
	let consumed = 0;
	for (;;) {
		const nl = buf.indexOf(10, start);
		if (nl === -1) break;
		const entry = entryOfLine(buf.toString("utf8", start, nl));
		if (entry) entries.push(entry);
		start = nl + 1;
		consumed = start;
	}
	if (start < buf.length) {
		const tail = buf.toString("utf8", start);
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
	return { entries, consumed };
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

export function collectUsageSummary(forceScan = false): UsageSummary {
	const now = Date.now();
	if (!forceScan && cachedSummary && now - lastScanMs < 5000) {
		return cachedSummary;
	}

	const sessionsDir = join(getAgentDir(), "sessions");
	const files = scanSessionFiles(sessionsDir);
	const diskCache = loadDiskCache();
	let cacheDirty = false;

	const providerMap = new Map<
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
	>();

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
			// re-parses whole — see the final branch.)
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
				cached = { mtimeMs: stat.mtimeMs, size: stat.size, v: CACHE_VERSION, consumed: full.consumed, rollup: rollupOfFile(full.entries) };
				diskCache.set(file, cached);
			}
			cacheDirty = true;
		} else {
			const full = parseBuffer(readFileSync(file));
			cached = { mtimeMs: stat.mtimeMs, size: stat.size, v: CACHE_VERSION, consumed: full.consumed, rollup: rollupOfFile(full.entries) };
			diskCache.set(file, cached);
			cacheDirty = true;
		}

		for (const [key, r] of Object.entries(cached.rollup.providers)) {
			const sep = key.indexOf("\u0000");
			const pname = sep === -1 ? key : key.slice(0, sep);
			if (!providerMap.has(pname)) {
				providerMap.set(pname, { sessions: new Set(), msgs: 0, input: 0, output: 0, cacheRead: 0, cost: 0, models: new Map() });
			}
			const p = providerMap.get(pname)!;
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

	// Fold per-provider results into totals
	let totalMsgs = 0;
	let totalInp = 0;
	let totalOut = 0;
	let totalCache = 0;
	let totalCost = 0;

	const allSessions = new Set<string>();
	const providers: UsageProviderStats[] = [];

	for (const [pName, pData] of providerMap.entries()) {
		for (const s of pData.sessions) allSessions.add(s);
		totalMsgs += pData.msgs;
		totalInp += pData.input;
		totalOut += pData.output;
		totalCache += pData.cacheRead;
		totalCost += pData.cost;

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
	const priceTable = loadPriceTable();
	let estimatedCost = 0;
	for (const p of providers) {
		let providerEstimate = 0;
		for (const m of p.models) {
			const est = m.cost > 0 ? null : estimateCost(m.input, m.output, m.cacheRead, m.name, p.name, priceTable);
			m.estimatedCost = est ?? 0;
			providerEstimate += m.estimatedCost;
		}
		p.estimatedCost = providerEstimate;
		estimatedCost += providerEstimate;
	}

	cachedSummary = {
		providers,
		totals: {
			sessions: allSessions.size,
			msgs: totalMsgs,
			input: totalInp,
			output: totalOut,
			cacheRead: totalCache,
			totalTokens: totalInp + totalOut,
			cost: totalCost,
			reportedCost: totalCost,
			estimatedCost,
		},
	};
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
 *  way: `river/deepseek-ai/DeepSeek-V4.1-Flash` reported wally+yarz's deepseek totals
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
