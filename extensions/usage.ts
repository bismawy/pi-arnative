/**
 * Arnative Usage Dashboard (/usage): table UI + the /usage command.
 * Data layer (session scan + cache + aggregation) lives in lib/usage-store.ts —
 * shared with the Model tab; the old API is still re-exported here (compatibility).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { boxEdge, boxRow } from "../lib/box.ts";
import { collectUsageSummary, formatTokens, getModelAllTimeUsage, type UsageSummary } from "../lib/usage-store.ts";
export { collectUsageSummary, formatTokens, getModelAllTimeUsage };
export type { UsageEntry, UsageModelStats, UsageProviderStats, UsageSummary } from "../lib/usage-store.ts";

export function formatCost(n: number): string {
	if (!n || n <= 0) return "-";
	if (n < 0.01) return "<$0.01";
	if (n < 1000) return `$${n.toFixed(2)}`;
	return `$${(n / 1000).toFixed(1)}k`;
}

export function formatCount(n: number): string {
	return n > 0 ? n.toLocaleString("en-US") : "-";
}
// =============================================================================
// /usage TUI component
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
	cost: number;
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
		// Default: expand the first provider when there is one
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
				cost: p.cost,
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
						cost: m.cost,
					});
				}
			}
		}
		return rows;
	}

	handleInput(keyData: string): void {
		const rows = this.buildFlatRows();
		if (matchesKey(keyData, "q") || matchesKey(keyData, "Q") || matchesKey(keyData, "escape")) {
			this.onDone();
			return;
		}
		if (matchesKey(keyData, "up") || matchesKey(keyData, "k")) {
			// Up
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.requestRender();
			}
			return;
		}
		if (matchesKey(keyData, "down") || matchesKey(keyData, "j")) {
			// Down
			if (this.selectedIndex < rows.length - 1) {
				this.selectedIndex++;
				this.requestRender();
			}
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "space")) {
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
		// arnative chat-column box wraps title + table + hint, full width.
		// Round ends (╭─╮ / ╰─╯); sides + divider from lib/box.ts (single definition).
		const boxW = width;
		const tint = (s: string) => th.fg("tint", s);
		const hline = (l: string, r: string) => boxEdge(l, r, boxW, tint);
		const row = (text: string) => boxRow(text, boxW, tint);
		const rule = () => hline("├", "┤");

		const rows = this.buildFlatRows();
		if (this.selectedIndex >= rows.length) {
			this.selectedIndex = Math.max(0, rows.length - 1);
		}

		// Layout columns (character widths) — 89 characters of table content in total
		const colW = {
			name: 28,
			sessions: 8,
			msgs: 8,
			tokens: 9,
			inp: 9,
			out: 8,
			cache: 8,
			cost: 9,
		};

		const formatCol = (text: string, w: number, alignRight = true) => {
			const str = truncateToWidth(text, w);
			const diff = Math.max(0, w - visibleWidth(str));
			return alignRight ? " ".repeat(diff) + str : str + " ".repeat(diff);
		};

		// Table header
		const headerText =
			"  " +
			formatCol(th.fg("dim", "Provider / Model"), colW.name, false) +
			formatCol(th.fg("dim", "Sessions"), colW.sessions) +
			formatCol(th.fg("dim", "Msgs"), colW.msgs) +
			formatCol(th.fg("dim", "Tokens"), colW.tokens) +
			formatCol(th.fg("dim", "↑In"), colW.inp) +
			formatCol(th.fg("dim", "↓Out"), colW.out) +
			formatCol(th.fg("dim", "Cache"), colW.cache) +
			formatCol(th.fg("dim", "Cost"), colW.cost);

		const out: string[] = [];
		out.push(hline("╭", "╮"));
		out.push(row(th.fg("accent", bold("LLM Usage"))));
		out.push(row(th.fg("muted", "Token, message & cache usage across all local Pi sessions.")));
		out.push(row(""));
		out.push(row(headerText));
		out.push(rule());

		// Data rows (with a display height cap so it cannot overflow)
		const maxVisibleRows = 16;
		let startIdx = 0;
		if (rows.length > maxVisibleRows) {
			startIdx = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisibleRows / 2), rows.length - maxVisibleRows));
		}
		const visibleRows = rows.slice(startIdx, startIdx + maxVisibleRows);

		for (let i = 0; i < visibleRows.length; i++) {
			const item = visibleRows[i]!;
			const actualIdx = startIdx + i;
			const isSelected = actualIdx === this.selectedIndex;

			const nameColor = isSelected ? "accent" : item.type === "provider" ? "tint" : "text";
			const valColor = isSelected ? "accent" : "dim";

			const cName = formatCol(th.fg(nameColor, isSelected ? bold(item.label) : item.label), colW.name, false);
			const cSess = formatCol(th.fg(valColor, formatCount(item.sessions)), colW.sessions);
			const cMsgs = formatCol(th.fg(valColor, formatCount(item.msgs)), colW.msgs);
			const cToks = formatCol(th.fg(valColor, formatTokens(item.tokens)), colW.tokens);
			const cInp = formatCol(th.fg(valColor, formatTokens(item.input)), colW.inp);
			const cOut = formatCol(th.fg(valColor, formatTokens(item.output)), colW.out);
			const cCache = formatCol(th.fg(valColor, formatTokens(item.cacheRead)), colW.cache);
			const cCost = formatCol(th.fg(valColor, formatCost(item.cost)), colW.cost);

			const prefix = isSelected ? th.fg("accent", "▸ ") : "  ";
			out.push(row(prefix + cName + cSess + cMsgs + cToks + cInp + cOut + cCache + cCost));
		}

		out.push(rule());

		// Total row
		const t = this.summary.totals;
		const totalName = formatCol(th.fg("tint", bold("Total")), colW.name, false);
		const totalSess = formatCol(th.fg("tint", bold(formatCount(t.sessions))), colW.sessions);
		const totalMsgs = formatCol(th.fg("tint", bold(formatCount(t.msgs))), colW.msgs);
		const totalToks = formatCol(th.fg("tint", bold(formatTokens(t.totalTokens))), colW.tokens);
		const totalInp = formatCol(th.fg("tint", bold(formatTokens(t.input))), colW.inp);
		const totalOut = formatCol(th.fg("tint", bold(formatTokens(t.output))), colW.out);
		const totalCache = formatCol(th.fg("tint", bold(formatTokens(t.cacheRead))), colW.cache);
		const totalCost = formatCol(th.fg("tint", bold(formatCost(t.cost))), colW.cost);

		out.push(row("  " + totalName + totalSess + totalMsgs + totalToks + totalInp + totalOut + totalCache + totalCost));

		out.push(row(""));
		out.push(row(th.fg("dim", "[↑↓] Navigation  [Enter] Open/close  [q/Esc] Exit")));
		out.push(hline("╰", "╯"));

		return out.map((line) => truncateToWidth(line, width, ""));
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
	assert(formatCost(0) === "-", "formatCost 0 = -");
	assert(formatCost(0.004) === "<$0.01", "formatCost 0.004 = <$0.01");
	assert(formatCost(12.345) === "$12.35", "formatCost 12.345 = $12.35");
	assert(formatCost(1234.5) === "$1.2k", "formatCost 1234.5 = $1.2k");

	const summary = collectUsageSummary();
	assert(summary.providers.length > 0, "collectUsageSummary mendeteksi providers");
	assert(summary.totals.sessions > 0, "collectUsageSummary mendeteksi total sessions");
	assert(summary.totals.msgs > 0, "collectUsageSummary mendeteksi total msgs");
	assert(summary.totals.cost >= 0, "collectUsageSummary menghitung cost");

	const modelUsage = getModelAllTimeUsage("gemini-3.8-flash");
	assert(modelUsage.input > 0, "getModelAllTimeUsage mengambil input tokens gemini-3.8-flash");

	const fakeTheme = {
		fg: (_c: string, t: string) => `\x1b[38;2;100;100;100m${t}\x1b[39m`,
		bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	};
	const modal = new UsageModalComponent(fakeTheme, () => {}, () => {});
	const lines = modal.render(100);
	assert(lines.length >= 10, "render modal menghasilkan baris-baris tabel");
	assert(lines[0]!.includes("╭") && lines[0]!.includes("╮"), "border atas membulat");
	assert(visibleWidth(lines[0]!) === 100, "border kotak full width (100 kolom)");
	assert(lines[1]!.includes("LLM Usage"), "judul LLM Usage di dalam kotak");
	assert(lines[2]!.includes("sessions"), "deskripsi di bawah judul");
	assert(lines[lines.length - 1]!.includes("╰") && lines[lines.length - 1]!.includes("╯"), "border bawah membulat");
	assert(
		lines.every((l) => visibleWidth(l) <= 100),
		"semua baris muat dalam lebar 100",
	);
	assert(
		lines.every((l) => ["╭", "│", "├", "╰"].some((c) => l.includes(c))),
		"tidak ada baris tanpa sisi kotak (garis aksen hilang)",
	);

	console.log("usage.ts self-check OK");
}
