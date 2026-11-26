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
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeAtomicSync } from "./preset-store.ts";
import {
	USAGE_RANGES,
	dayKey,
	estimateCost,
	formatTokens,
	hasPrice,
	loadPriceTable,
	rangeStart,
	resetPriceMemo,
	type ModelPrices,
	type PriceTable,
	type UsageRange,
} from "./usage-pricing.ts";

export {
	USAGE_RANGES,
	dayKey,
	estimateCost,
	formatTokens,
	hasPrice,
	loadPriceTable,
	rangeStart,
	type ModelPrices,
	type PriceTable,
	type UsageRange,
};

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

// Resolved per call, not at import: the self-check points getAgentDir() at a fixture dir.
// Everything pi-arnative writes lives in one folder (agent dir/arnative); the cache moved
// there from a flat arnative-usage-cache.json, which is migrated in on first read.
const cacheDir = (): string => join(getAgentDir(), "arnative");
const cacheFilePath = (): string => join(cacheDir(), "usage-cache.json");
const legacyCachePath = (): string => join(getAgentDir(), "arnative-usage-cache.json");
/** Dead since pricing moved into `cost` fields in models.json: nothing reads it, so the
 *  first load after the update removes it (layout "1" — see lib/preset-store.ts). */
const legacyPricesPath = (): string => join(getAgentDir(), "arnative-prices.json");
const CACHE_VERSION = 10; // v10: the session cwd (`w`) joined v9, which a build without it already wrote; v9: no tool-result rows (v8: cacheWrite + the billed split, v7: day buckets, v6: the compact rows, v5: model rows only, v4: full rollup)

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
		// Only an item carrying `t`, the day map AND the cwd field is current: a v10 writer always
		// emits `d` and `w` (empty string when the file has no header), so a missing `w` is a
		// cache written before this shape and must be re-read.
		v: d.t === CACHE_VERSION && d.d !== undefined && d.w !== undefined ? CACHE_VERSION : hasDays ? (wide ? 7 : 6) : 5,
		cwd: typeof d.w === "string" && d.w !== "" ? d.w : undefined,
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
	// Always emitted: an empty string says "this file carries no cwd", which is what lets the
	// reader trust a current item without re-reading the head on every scan.
	out.w = item.cwd ?? "";
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
		writeAtomicSync(path, JSON.stringify(out));
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
 * The cwd from the file's first line, without reading the whole file. A re-parse that starts
 * at the baseline offset skips the header, so the cwd would be lost exactly when the cache
 * shape changes. One 64 KB read covers a session header.
 */
function headCwd(filePath: string): string | undefined {
	try {
		const fd = openSync(filePath, "r");
		try {
			const buf = Buffer.alloc(64 * 1024);
			const n = readSync(fd, buf, 0, buf.length, 0);
			return sessionCwdOf(buf.subarray(0, n).toString("utf8").split("\n", 1)[0] ?? "");
		} finally {
			closeSync(fd);
		}
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
let usageGen = 0;
let lastScanGen = -1;

/** Mark the cached usage summary stale after a turn or session switch so the next
 *  non-forced read (`budget`, footer) scans once without forcing redundant rescans. */
export function markUsageDirty(): void {
	usageGen++;
}

/** Drop every in-memory memo so the next scan reads the cache file and the session files
 *  again. The self-check needs this: `forceScan` skips the 5s summary cache but still
 *  trusts the memoized disk cache, so without it a "cold parse" test asserts a value
 *  against itself and can never fail. */
export function resetUsageCache(): void {
	diskMemo = null;
	resetPriceMemo();
	baselineMemo = null;
	cachedSummary = null;
	cachedRange = null;
	lastScanMs = 0;
	lastScanGen = -1;
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
	else writeAtomicSync(path, raw);
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
	const scanGen = usageGen;
	if (!forceScan && cachedSummary && cachedRange === range && lastScanGen === scanGen && now - lastScanMs < 5000) {
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
				cwd: parsed.cwd ?? (offset > 0 ? baselineItem!.cwd ?? headCwd(file) : undefined) ?? cached?.cwd,
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

		foldFileIntoProviderMap(providerMap, file, effective);
		if (Object.keys(effective.providers).length > 0) {
			// A file with no cwd in its cache item lands in "unknown" rather than being re-read.
			const projectName = cached.cwd ?? "unknown";
			let project = projectMap.get(projectName);
			if (!project) projectMap.set(projectName, (project = { sessions: new Set(), providers: new Map() }));
			project.sessions.add(file);
			foldFileIntoProviderMap(project.providers, file, effective);
		}
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
	lastScanGen = scanGen;
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

export const __test = {
	CACHE_VERSION,
	SUBAGENT_ARTIFACTS_DIR,
};
