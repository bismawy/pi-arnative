/**
 * Data layer pemakaian token (satu-satunya sumber untuk /usage + header Model):
 * - Memindai riwayat sesi lokal Pi (~/.pi/agent/sessions/*.jsonl).
 * - Cache cepat berbasis mtime & size di ~/.pi/agent/arnative-usage-cache.json.
 * - Cache disk dibaca SATU KALI ke memori (dulu: readFileSync+JSON.parse 4MB
 *   di setiap frame render header -> ±50ms/frame, biang lag chat panjang).
 * - Tanpa dobel hitung: entri sesi aktif SUDAH ada di file sesinya sendiri,
 *   jadi TIDAK ditambah ulang dari sessionManager (bug angka ↑↓ membengkak).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface UsageEntry {
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

export interface FileCacheItem {
	mtimeMs: number;
	size: number;
	v?: number;
	entries: UsageEntry[];
}

export interface UsageModelStats {
	name: string;
	sessions: number;
	msgs: number;
	input: number;
	output: number;
	cacheRead: number;
	totalTokens: number;
	cost: number;
}

export interface UsageProviderStats {
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

/** Format angka token (satuan k/M/B); 0/negatif = "-". */
export function formatTokens(n: number): string {
	if (!n || n <= 0) return "-";
	if (n < 1000) return String(n);
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
	}
	if (n < 1_000_000_000) {
		const m = n / 1_000_000;
		return `${m.toFixed(1).replace(/\.0$/, "")}M`;
	}
	const b = n / 1_000_000_000;
	return `${b.toFixed(1).replace(/\.0$/, "")}B`;
}

const CACHE_FILE_PATH = join(getAgentDir(), "arnative-usage-cache.json");
const CACHE_VERSION = 2; // v2: menambahkan cost per entri

// Cache disk dimuat sekali ke memori; save menulis memori + disk sekaligus.
let diskMemo: Map<string, FileCacheItem> | null = null;

function loadDiskCache(): Map<string, FileCacheItem> {
	if (diskMemo) return diskMemo;
	diskMemo = new Map<string, FileCacheItem>();
	try {
		if (existsSync(CACHE_FILE_PATH)) {
			const raw = JSON.parse(readFileSync(CACHE_FILE_PATH, "utf8")) as Record<string, FileCacheItem>;
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
		const dir = dirname(CACHE_FILE_PATH);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(CACHE_FILE_PATH, JSON.stringify(obj), "utf8");
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

function parseSessionFile(filePath: string): UsageEntry[] {
	const entries: UsageEntry[] = [];
	try {
		const content = readFileSync(filePath, "utf8");
		const lines = content.split("\n");
		for (const line of lines) {
			if (!line || !line.includes('"role":"assistant"')) continue;
			try {
				const obj = JSON.parse(line);
				const m = obj?.message;
				if (m?.role === "assistant") {
					const provider = String(m.provider || "unknown");
					const model = String(m.model || "unknown");
					const u = m.usage || {};
					entries.push({
						provider,
						model,
						input: Number(u.input) || 0,
						output: Number(u.output) || 0,
						cacheRead: Number(u.cacheRead) || 0,
						cost: Number(u.cost?.total) || 0,
					});
				}
			} catch {
				// ignore line parse error
			}
		}
	} catch {
		// ignore file read error
	}
	return entries;
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

		let fileEntries: UsageEntry[];
		const cached = diskCache.get(file);
		if (cached && cached.v === CACHE_VERSION && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			fileEntries = cached.entries;
		} else {
			fileEntries = parseSessionFile(file);
			diskCache.set(file, {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				v: CACHE_VERSION,
				entries: fileEntries,
			});
			cacheDirty = true;
		}

		for (const ent of fileEntries) {
			if (!providerMap.has(ent.provider)) {
				providerMap.set(ent.provider, {
					sessions: new Set(),
					msgs: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					cost: 0,
					models: new Map(),
				});
			}
			const p = providerMap.get(ent.provider)!;
			p.sessions.add(file);
			p.msgs++;
			p.input += ent.input;
			p.output += ent.output;
			p.cacheRead += ent.cacheRead;
			p.cost += ent.cost;

			if (!p.models.has(ent.model)) {
				p.models.set(ent.model, {
					sessions: new Set(),
					msgs: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					cost: 0,
				});
			}
			const m = p.models.get(ent.model)!;
			m.sessions.add(file);
			m.msgs++;
			m.input += ent.input;
			m.output += ent.output;
			m.cacheRead += ent.cacheRead;
			m.cost += ent.cost;
		}
	}

	if (cacheDirty) {
		saveDiskCache(diskCache);
	}

	// Agregasi hasil dan hitung total
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

// Kecocokan nama model lintas bentuk id ("gemini-3.8-flash", "vendor/gemini-…").
const modelMatches = (mNameLower: string, targetLower: string): boolean =>
	!targetLower ||
	mNameLower === targetLower ||
	mNameLower.endsWith("/" + targetLower) ||
	mNameLower.split(":")[0] === targetLower ||
	targetLower.endsWith("/" + mNameLower);

/**
 * Total penggunaan satu model (all-time, seperti /usage).
 * Sesi aktif sudah termasuk di file sesinya — tanpa koreksi manual.
 */
export function getModelAllTimeUsage(modelId?: string): { input: number; output: number; cacheRead: number } {
	const summary = collectUsageSummary();
	let inp = 0;
	let out = 0;
	let read = 0;

	const target = (modelId || "").toLowerCase();
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
