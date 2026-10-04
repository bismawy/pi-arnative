/**
 * Token usage data layer — the single source for /usage and the Model tab.
 * - Scans local Pi session history (~/.pi/agent/sessions/*.jsonl).
 * - mtime+size keyed cache in ~/.pi/agent/arnative-usage-cache.json, read into
 *   memory once (parsing 4MB per header frame cost ~50ms and lagged long chats).
 * - No double counting: the active session is already in its own file, so it is
 *   NOT re-added from sessionManager (that inflated the ↑↓ totals).
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	};
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
const cacheFilePath = (): string => join(getAgentDir(), "arnative-usage-cache.json");
const CACHE_VERSION = 4; // v4: per-file rollup (was raw entries in v3)

// Disk cache is memoized; save writes memory + disk together.
let diskMemo: Map<string, FileCacheItem> | null = null;

function loadDiskCache(): Map<string, FileCacheItem> {
	if (diskMemo) return diskMemo;
	diskMemo = new Map<string, FileCacheItem>();
	try {
		if (existsSync(cacheFilePath())) {
			const raw = JSON.parse(readFileSync(cacheFilePath(), "utf8")) as Record<string, FileCacheItem>;
			for (const [k, v] of Object.entries(raw)) {
				diskMemo.set(k, v);
			}
		}
	} catch {
		// ignore
	}
	return diskMemo;
}

function saveDiskCache(map: Map<string, FileCacheItem>): void {
	try {
		const obj: Record<string, FileCacheItem> = {};
		for (const [k, v] of map.entries()) {
			obj[k] = v;
		}
		const dir = dirname(cacheFilePath());
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(cacheFilePath(), JSON.stringify(obj), "utf8");
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
 * Parse newline-terminated lines from a buffer. Byte granularity, so the returned offset can be
 * fed back to `readSync`. A trailing segment with no newline is parsed (the last record of a file
 * not ending in `\n`) but only consumed when it is valid JSON — a write caught mid-flight is left
 * for the next scan instead of being dropped or truncated into a bad entry.
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
		},
	};
	lastScanMs = now;
	return cachedSummary;
}

// Match model names across id shapes ("gemini-3.8-flash", "vendor/gemini-…").
const modelMatches = (mNameLower: string, targetLower: string): boolean =>
	mNameLower === targetLower ||
	mNameLower.endsWith("/" + targetLower) ||
	mNameLower.split(":")[0] === targetLower ||
	targetLower.endsWith("/" + mNameLower);

/** All-time usage for one model (same numbers as /usage; the active session is already in its own file). */
export function getModelAllTimeUsage(modelId?: string): { input: number; output: number; cacheRead: number } {
	// An empty target used to match EVERY model -> the Model tab showed the grand total under "No Model".
	if (!modelId) return { input: 0, output: 0, cacheRead: 0 };
	const summary = collectUsageSummary();
	let inp = 0;
	let out = 0;
	let read = 0;

	const target = modelId.toLowerCase();
	for (const p of summary.providers) {
		for (const m of p.models) {
			if (modelMatches(m.name.toLowerCase(), target)) {
				inp += m.input;
				out += m.output;
				read += m.cacheRead;
			}
		}
	}

	return { input: inp, output: out, cacheRead: read };
}
