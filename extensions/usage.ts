/**
 * Arnative Usage Dashboard (/usage):
 * - Memindai langsung riwayat sesi lokal Pi (~/.pi/agent/sessions/*.jsonl).
 * - Cache cepat berbasis mtime & size di ~/.pi/agent/arnative-usage-cache.json.
 * - Zero dependency ke ekstensi luar.
 * - Desain tabel Rounded Box Arnative dengan expandable provider/model.
 * - Mengekspor getModelAllTimeUsage() untuk header dan komponen lainnya.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

export interface UsageEntry {
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
}

export interface FileCacheItem {
	mtimeMs: number;
	size: number;
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
}

export interface UsageProviderStats {
	name: string;
	sessions: number;
	msgs: number;
	input: number;
	output: number;
	cacheRead: number;
	totalTokens: number;
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
	};
}

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

export function formatCount(n: number): string {
	return n > 0 ? n.toLocaleString("en-US") : "-";
}

const CACHE_FILE_PATH = join(getAgentDir(), "arnative-usage-cache.json");

function loadDiskCache(): Map<string, FileCacheItem> {
	const map = new Map<string, FileCacheItem>();
	try {
		if (existsSync(CACHE_FILE_PATH)) {
			const raw = JSON.parse(readFileSync(CACHE_FILE_PATH, "utf8")) as Record<string, FileCacheItem>;
			for (const [k, v] of Object.entries(raw)) {
				map.set(k, v);
			}
		}
	} catch {
		// ignore
	}
	return map;
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
			models: Map<string, { sessions: Set<string>; msgs: number; input: number; output: number; cacheRead: number }>;
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
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			fileEntries = cached.entries;
		} else {
			fileEntries = parseSessionFile(file);
			diskCache.set(file, {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
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
					models: new Map(),
				});
			}
			const p = providerMap.get(ent.provider)!;
			p.sessions.add(file);
			p.msgs++;
			p.input += ent.input;
			p.output += ent.output;
			p.cacheRead += ent.cacheRead;

			if (!p.models.has(ent.model)) {
				p.models.set(ent.model, {
					sessions: new Set(),
					msgs: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
				});
			}
			const m = p.models.get(ent.model)!;
			m.sessions.add(file);
			m.msgs++;
			m.input += ent.input;
			m.output += ent.output;
			m.cacheRead += ent.cacheRead;
		}
	}

	if (cacheDirty) {
		saveDiskCache(diskCache);
	}

	// Agregasi hasil dan hitung total
	let totalSessions = 0;
	let totalMsgs = 0;
	let totalInp = 0;
	let totalOut = 0;
	let totalCache = 0;

	const allSessions = new Set<string>();
	const providers: UsageProviderStats[] = [];

	for (const [pName, pData] of providerMap.entries()) {
		for (const s of pData.sessions) allSessions.add(s);
		totalMsgs += pData.msgs;
		totalInp += pData.input;
		totalOut += pData.output;
		totalCache += pData.cacheRead;

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
			models,
		});
	}

	totalSessions = allSessions.size;
	providers.sort((a, b) => b.totalTokens - a.totalTokens);

	cachedSummary = {
		providers,
		totals: {
			sessions: totalSessions,
			msgs: totalMsgs,
			input: totalInp,
			output: totalOut,
			cacheRead: totalCache,
			totalTokens: totalInp + totalOut,
		},
	};
	lastScanMs = now;
	return cachedSummary;
}

// API Publik untuk header dan ekstensi lain
export function getModelAllTimeUsage(
	modelId?: string,
	ctx?: ExtensionContext,
): { input: number; output: number; cacheRead: number } {
	const summary = collectUsageSummary();
	let inp = 0;
	let out = 0;
	let read = 0;

	const target = (modelId || "").toLowerCase();
	for (const p of summary.providers) {
		for (const m of p.models) {
			const mName = m.name.toLowerCase();
			const matches =
				!target ||
				mName === target ||
				mName.endsWith("/" + target) ||
				mName.split(":")[0] === target ||
				target.endsWith("/" + mName);
			if (matches) {
				inp += m.input;
				out += m.output;
				read += m.cacheRead;
			}
		}
	}

	// Tambahkan penggunaan dari sesi saat ini jika ada
	try {
		const entries = (ctx?.sessionManager as any)?.getBranch?.() ?? (ctx?.sessionManager as any)?.getEntries?.() ?? [];
		for (const e of entries) {
			if (e && typeof e === "object" && "type" in e && e.type === "message") {
				const m = (e as { message?: unknown }).message;
				if (m && typeof m === "object" && "role" in m && (m as any).role === "assistant" && "usage" in m) {
					const u = (m as any).usage;
					if (u) {
						inp += u.input || 0;
						out += u.output || 0;
						read += u.cacheRead || 0;
					}
				}
			}
		}
	} catch {
		// ignore
	}

	return { input: inp, output: out, cacheRead: read };
}

// =============================================================================
// Komponen TUI /usage
// =============================================================================

export interface RowItem {
	type: "provider" | "model";
	providerName: string;
	modelName?: string;
	label: string;
	sessions: number;
	msgs: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	expanded?: boolean;
}

export class UsageModalComponent implements Component {
	private expandedProviders = new Set<string>();
	private selectedIndex = 0;
	private summary: UsageSummary;

	private theme: { fg(c: string, t: string): string; bold?(t: string): string };
	private onDone: () => void;
	private requestRender: () => void;

	constructor(
		theme: { fg(c: string, t: string): string; bold?(t: string): string },
		onDone: () => void,
		requestRender: () => void,
	) {
		this.theme = theme;
		this.onDone = onDone;
		this.requestRender = requestRender;
		this.summary = collectUsageSummary(true);
		// Default: expand provider pertama jika ada
		if (this.summary.providers.length > 0) {
			this.expandedProviders.add(this.summary.providers[0]!.name);
		}
	}

	invalidate(): void {}

	dispose(): void {}

	private buildFlatRows(): RowItem[] {
		const rows: RowItem[] = [];
		for (const p of this.summary.providers) {
			const isExpanded = this.expandedProviders.has(p.name);
			rows.push({
				type: "provider",
				providerName: p.name,
				label: `${isExpanded ? "▾" : "▸"} ${p.name}`,
				sessions: p.sessions,
				msgs: p.msgs,
				tokens: p.totalTokens,
				input: p.input,
				output: p.output,
				cacheRead: p.cacheRead,
				expanded: isExpanded,
			});

			if (isExpanded) {
				for (const m of p.models) {
					rows.push({
						type: "model",
						providerName: p.name,
						modelName: m.name,
						label: `    ${m.name}`,
						sessions: m.sessions,
						msgs: m.msgs,
						tokens: m.totalTokens,
						input: m.input,
						output: m.output,
						cacheRead: m.cacheRead,
					});
				}
			}
		}
		return rows;
	}

	handleInput(keyData: string): void {
		const rows = this.buildFlatRows();
		if (keyData === "q" || keyData === "Q" || keyData === "\x1b") {
			this.onDone();
			return;
		}
		if (keyData === "\x1b[A" || keyData === "k") {
			// Up
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.requestRender();
			}
			return;
		}
		if (keyData === "\x1b[B" || keyData === "j") {
			// Down
			if (this.selectedIndex < rows.length - 1) {
				this.selectedIndex++;
				this.requestRender();
			}
			return;
		}
		if (keyData === "\r" || keyData === " ") {
			// Toggle expand provider
			const row = rows[this.selectedIndex];
			if (row && row.type === "provider") {
				if (this.expandedProviders.has(row.providerName)) {
					this.expandedProviders.delete(row.providerName);
				} else {
					this.expandedProviders.add(row.providerName);
				}
				this.requestRender();
			}
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const bold = th.bold ?? ((t: string) => `\x1b[1m${t}\x1b[22m`);
		const boxW = Math.max(60, Math.min(width, 100));
		const innerW = boxW - 2;

		const dash = "─".repeat(innerW);
		const topBorder = th.fg("dim", `╭${dash}╮`);
		const divBorder = th.fg("dim", `├${dash}┤`);
		const botBorder = th.fg("dim", `╰${dash}╯`);
		const side = th.fg("dim", "│");

		const rows = this.buildFlatRows();
		if (this.selectedIndex >= rows.length) {
			this.selectedIndex = Math.max(0, rows.length - 1);
		}

		// Kolom tata letak (lebar karakter)
		// Provider / Model: 30, Sessions: 8, Msgs: 8, Tokens: 9, ↑In: 9, ↓Out: 8, Cache: 8
		const colW = {
			name: 28,
			sessions: 8,
			msgs: 8,
			tokens: 9,
			inp: 9,
			out: 8,
			cache: 8,
		};

		const formatCol = (text: string, w: number, alignRight = true) => {
			const str = truncateToWidth(text, w);
			const diff = Math.max(0, w - visibleWidth(str));
			return alignRight ? " ".repeat(diff) + str : str + " ".repeat(diff);
		};

		const out: string[] = [];
		out.push(topBorder);

		// Header Table
		const headerText =
			"  " +
			formatCol(th.fg("dim", "Provider / Model"), colW.name, false) +
			formatCol(th.fg("dim", "Sessions"), colW.sessions) +
			formatCol(th.fg("dim", "Msgs"), colW.msgs) +
			formatCol(th.fg("dim", "Tokens"), colW.tokens) +
			formatCol(th.fg("dim", "↑In"), colW.inp) +
			formatCol(th.fg("dim", "↓Out"), colW.out) +
			formatCol(th.fg("dim", "Cache"), colW.cache);

		const padHdr = Math.max(0, innerW - visibleWidth(headerText));
		out.push(side + headerText + " ".repeat(padHdr) + side);
		out.push(divBorder);

		// Baris data (dengan batas tinggi tampilan agar tidak overflow)
		const maxVisibleRows = 16;
		let startIdx = 0;
		if (rows.length > maxVisibleRows) {
			startIdx = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisibleRows / 2), rows.length - maxVisibleRows));
		}
		const visibleRows = rows.slice(startIdx, startIdx + maxVisibleRows);

		for (let i = 0; i < visibleRows.length; i++) {
			const row = visibleRows[i]!;
			const actualIdx = startIdx + i;
			const isSelected = actualIdx === this.selectedIndex;

			const nameColor = isSelected ? "accent" : row.type === "provider" ? "tint" : "text";
			const valColor = isSelected ? "accent" : "dim";

			const cName = formatCol(th.fg(nameColor, isSelected ? bold(row.label) : row.label), colW.name, false);
			const cSess = formatCol(th.fg(valColor, formatCount(row.sessions)), colW.sessions);
			const cMsgs = formatCol(th.fg(valColor, formatCount(row.msgs)), colW.msgs);
			const cToks = formatCol(th.fg(valColor, formatTokens(row.tokens)), colW.tokens);
			const cInp = formatCol(th.fg(valColor, formatTokens(row.input)), colW.inp);
			const cOut = formatCol(th.fg(valColor, formatTokens(row.output)), colW.out);
			const cCache = formatCol(th.fg(valColor, formatTokens(row.cacheRead)), colW.cache);

			const prefix = isSelected ? th.fg("accent", "▸ ") : "  ";
			const rowLine = prefix + cName + cSess + cMsgs + cToks + cInp + cOut + cCache;
			const padRow = Math.max(0, innerW - visibleWidth(rowLine));
			out.push(side + rowLine + " ".repeat(padRow) + side);
		}

		out.push(divBorder);

		// Total Row
		const t = this.summary.totals;
		const totalName = formatCol(th.fg("tint", bold("Total")), colW.name, false);
		const totalSess = formatCol(th.fg("tint", bold(formatCount(t.sessions))), colW.sessions);
		const totalMsgs = formatCol(th.fg("tint", bold(formatCount(t.msgs))), colW.msgs);
		const totalToks = formatCol(th.fg("tint", bold(formatTokens(t.totalTokens))), colW.tokens);
		const totalInp = formatCol(th.fg("tint", bold(formatTokens(t.input))), colW.inp);
		const totalOut = formatCol(th.fg("tint", bold(formatTokens(t.output))), colW.out);
		const totalCache = formatCol(th.fg("tint", bold(formatTokens(t.cacheRead))), colW.cache);

		const totalLine = "  " + totalName + totalSess + totalMsgs + totalToks + totalInp + totalOut + totalCache;
		const padTotal = Math.max(0, innerW - visibleWidth(totalLine));
		out.push(side + totalLine + " ".repeat(padTotal) + side);

		out.push(botBorder);

		// Footer Petunjuk Navigasi
		const hint = th.fg("dim", "[↑↓] navigasi  │  [Enter] buka/tutup  │  [q/Esc] tutup");
		const hintPad = Math.max(0, Math.floor((boxW - visibleWidth(hint)) / 2));
		out.push(" ".repeat(hintPad) + hint);

		return out;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Dashboard penggunaan token & model Arnative",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return new UsageModalComponent(theme, () => done(), () => tui.requestRender());
			});
		},
	});
}

// Self-check: `node extensions/usage.ts`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"));
if (isMain) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};

	assert(formatTokens(0) === "-", "formatTokens 0 = -");
	assert(formatTokens(500) === "500", "formatTokens 500 = 500");
	assert(formatTokens(2500) === "2.5k", "formatTokens 2500 = 2.5k");
	assert(formatTokens(2900000) === "2.9M", "formatTokens 2900000 = 2.9M");
	assert(formatTokens(1863163057) === "1.9B", "formatTokens 1.86B = 1.9B");

	const summary = collectUsageSummary();
	assert(summary.providers.length > 0, "collectUsageSummary mendeteksi providers");
	assert(summary.totals.sessions > 0, "collectUsageSummary mendeteksi total sessions");
	assert(summary.totals.msgs > 0, "collectUsageSummary mendeteksi total msgs");

	const modelUsage = getModelAllTimeUsage("gemini-3.8-flash");
	assert(modelUsage.input > 0, "getModelAllTimeUsage mengambil input tokens gemini-3.8-flash");

	const fakeTheme = {
		fg: (_c: string, t: string) => `\x1b[38;2;100;100;100m${t}\x1b[39m`,
		bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	};
	const modal = new UsageModalComponent(fakeTheme, () => {}, () => {});
	const lines = modal.render(100);
	assert(lines.length >= 10, "render modal menghasilkan baris-baris tabel");
	assert(lines[0]!.includes("╭") && lines[0]!.includes("╮"), "top border rounded");

	console.log("usage.ts self-check OK");
}
