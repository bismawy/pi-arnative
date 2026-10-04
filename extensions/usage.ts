/**
 * Arnative Usage Dashboard (/usage): table UI + the /usage command.
 * Data layer (session scan + cache + aggregation) lives in lib/usage-store.ts —
 * shared with the Model tab.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { boxEdge, boxRow } from "../lib/box.ts";
import { assert, isMain } from "../lib/check.ts";
import { collectUsageSummary, formatTokens, getModelAllTimeUsage, type UsageSummary } from "../lib/usage-store.ts";

export function formatCost(n: number): string {
	if (!n || n <= 0) return "-";
	if (n < 0.01) return "<$0.01";
	if (n < 1000) {
		// Rounding at the boundary used to print "$1000.00" instead of "$1.0k".
		const s = n.toFixed(2);
		return s === "1000.00" ? "$1.0k" : `$${s}`;
	}
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
		const soft = (s: string) => th.fg("accentSoft", s);
		const hline = (l: string, r: string) => boxEdge(l, r, boxW, soft);
		const row = (text: string) => boxRow(text, boxW, soft);
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

			const nameColor = isSelected ? "accent" : item.type === "provider" ? "accentSoft" : "text";
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
		const totalName = formatCol(th.fg("accentSoft", bold("Total")), colW.name, false);
		const totalSess = formatCol(th.fg("accentSoft", bold(formatCount(t.sessions))), colW.sessions);
		const totalMsgs = formatCol(th.fg("accentSoft", bold(formatCount(t.msgs))), colW.msgs);
		const totalToks = formatCol(th.fg("accentSoft", bold(formatTokens(t.totalTokens))), colW.tokens);
		const totalInp = formatCol(th.fg("accentSoft", bold(formatTokens(t.input))), colW.inp);
		const totalOut = formatCol(th.fg("accentSoft", bold(formatTokens(t.output))), colW.out);
		const totalCache = formatCol(th.fg("accentSoft", bold(formatTokens(t.cacheRead))), colW.cache);
		const totalCost = formatCol(th.fg("accentSoft", bold(formatCost(t.cost))), colW.cost);

		out.push(row("  " + totalName + totalSess + totalMsgs + totalToks + totalInp + totalOut + totalCache + totalCost));

		out.push(row(""));
		out.push(row(th.fg("dim", "[↑↓] Navigation  [Enter] Open/close  [q/Esc] Exit")));
		out.push(hline("╰", "╯"));

		return out.map((line) => truncateToWidth(line, width, ""));
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Arnative token & model usage dashboard",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return new UsageModalComponent(theme, () => done(), () => tui.requestRender());
			});
		},
	});
}

// Self-check: `node extensions/usage.ts`
if (isMain(import.meta.url)) {

	assert(formatTokens(0) === "-", "formatTokens 0 = -");
	assert(formatTokens(500) === "500", "formatTokens 500 = 500");
	assert(formatTokens(2500) === "2.5k", "formatTokens 2500 = 2.5k");
	assert(formatTokens(2900000) === "2.9M", "formatTokens 2900000 = 2.9M");
	assert(formatTokens(1863163057) === "1.9B", "formatTokens 1.86B = 1.9B");
	assert(formatCost(0) === "-", "formatCost 0 = -");
	assert(formatCost(0.004) === "<$0.01", "formatCost 0.004 = <$0.01");
	assert(formatCost(12.345) === "$12.35", "formatCost 12.345 = $12.35");
	assert(formatCost(1234.5) === "$1.2k", "formatCost 1234.5 = $1.2k");
	// Boundary regressions: rounding used to print "1000k" / "$1000.00".
	assert(formatTokens(999_500) === "999.5k", "formatTokens stays k below 1M");
	assert(formatTokens(999_999) === "1M", "formatTokens promotes a k value that rounds to 1000");
	assert(formatTokens(999_999_999) === "1B", "formatTokens promotes an M value that rounds to 1000");
	assert(formatTokens(9_999) === "10k", "formatTokens strips a .0 k tail");
	assert(formatCost(999.996) === "$1.0k", "formatCost rolls over at $1000");

	// Fixture agent dir: the real history (and cache) must not decide pass/fail.
	const fixture = mkdtempSync(join(tmpdir(), "arnative-usage-"));
	process.env.PI_CODING_AGENT_DIR = fixture;
	mkdirSync(join(fixture, "sessions", "proj"), { recursive: true });
	const asst = (model: string, input: number) => JSON.stringify({ message: { role: "assistant", provider: "google", model, usage: { input, output: 5, cacheRead: 1, cost: { total: 0.02 } } } });
	writeFileSync(
		join(fixture, "sessions", "proj", "a.jsonl"),
		[JSON.stringify({ message: { role: "user", content: "hi" } }), asst("gemini-3.8-flash", 100), asst("gemini-3.8-flash", 50), asst("other-model", 7)].join(String.fromCharCode(10)),
	);

	const summary = collectUsageSummary(true);
	assert(summary.providers.length === 1, "collectUsageSummary detects providers");
	assert(summary.totals.sessions === 1, "collectUsageSummary detects total sessions");
	assert(summary.totals.msgs === 3, "collectUsageSummary counts assistant messages only");
	assert(Math.abs(summary.totals.cost - 0.06) < 1e-9, "collectUsageSummary counts cost");

	const modelUsage = getModelAllTimeUsage("gemini-3.8-flash");
	assert(modelUsage.input === 150 && modelUsage.output === 10 && modelUsage.cacheRead === 2, "getModelAllTimeUsage sums one model across messages");
	assert(
		getModelAllTimeUsage(undefined).input === 0 && getModelAllTimeUsage(undefined).output === 0,
		"getModelAllTimeUsage without a model id matches nothing (no grand total)",
	);

	// A session file that grows is parsed from the tail only (byte offset in the cache), not re-read.
	const file = join(fixture, "sessions", "proj", "a.jsonl");
	const cachedBefore = JSON.parse(readFileSync(join(fixture, "arnative-usage-cache.json"), "utf8")) as Record<string, { consumed: number; size: number }>;
	assert(cachedBefore[file]!.consumed === cachedBefore[file]!.size, "cache records the full parsed offset");
	writeFileSync(file, asst("gemini-3.8-flash", 1000) + String.fromCharCode(10), { flag: "a" });
	const grown = collectUsageSummary(true);
	assert(grown.totals.msgs === 4, "an appended record is picked up from the tail");
	assert(
		getModelAllTimeUsage("gemini-3.8-flash").input === 1150,
		"the appended record adds to the existing totals (no duplicate, no drop)",
	);

	// The per-file rollup is what makes a refresh cheap: folding a tail must reproduce the same
	// totals as parsing the whole file from scratch. Compare the incremental answer to a cold one.
	const incremental = JSON.stringify(getModelAllTimeUsage("gemini-3.8-flash"));
	const cacheRaw = JSON.parse(readFileSync(join(fixture, "arnative-usage-cache.json"), "utf8")) as Record<string, unknown>;
	// Drop the cache (as a fresh machine, or a version bump, would) and rescan the whole file.
	writeFileSync(join(fixture, "arnative-usage-cache.json"), "{}", "utf8");
	collectUsageSummary(true);
	assert(
		JSON.stringify(getModelAllTimeUsage("gemini-3.8-flash")) === incremental,
		"an incremental tail fold equals a full cold parse of the same file",
	);
	assert(Object.keys(cacheRaw).length === 1, "one session file produces exactly one cache entry");

	// A half-written trailing record must not be counted, then must appear once completed in place.
	const pending = asst("other-model", 5);
	writeFileSync(file, pending.slice(0, 40), { flag: "a" });
	assert(collectUsageSummary(true).totals.msgs === 4, "a half-written trailing record is not counted");
	writeFileSync(file, pending.slice(40) + String.fromCharCode(10), { flag: "a" });
	assert(collectUsageSummary(true).totals.msgs === 5, "the record is counted once the write completes");

	// Disk cache pruning: no cache key may point at a session file that is gone.
	rmSync(join(fixture, "sessions", "proj", "a.jsonl"));
	collectUsageSummary(true);
	const raw = JSON.parse(readFileSync(join(fixture, "arnative-usage-cache.json"), "utf8")) as Record<string, unknown>;
	assert(Object.keys(raw).length === 0, "usage disk cache prunes deleted session files");
	rmSync(fixture, { recursive: true, force: true });

	const fakeTheme = {
		fg: (_c: string, t: string) => `\x1b[38;2;100;100;100m${t}\x1b[39m`,
		bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	};
	const modal = new UsageModalComponent(fakeTheme, () => {}, () => {});
	const lines = modal.render(100);
	assert(lines.length >= 10, "modal render produces table lines");
	assert(lines[0]!.includes("╭") && lines[0]!.includes("╮"), "round top border");
	assert(visibleWidth(lines[0]!) === 100, "box border full width (100 columns)");
	assert(lines[1]!.includes("LLM Usage"), "LLM Usage title inside the box");
	assert(lines[2]!.includes("sessions"), "description below the title");
	assert(lines[lines.length - 1]!.includes("╰") && lines[lines.length - 1]!.includes("╯"), "round bottom border");
	assert(
		lines.every((l) => visibleWidth(l) <= 100),
		"every line fits within width 100",
	);
	assert(
		lines.every((l) => ["╭", "│", "├", "╰"].some((c) => l.includes(c))),
		"no line missing a box side (accent line gone)",
	);

	console.log("usage.ts self-check OK");
}
