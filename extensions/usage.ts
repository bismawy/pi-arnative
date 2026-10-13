/**
 * Arnative Usage Dashboard (/usage): table UI + the /usage command.
 * Data layer (session scan + cache + aggregation) lives in lib/usage-store.ts —
 * shared with the Model tab.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderScreen, screenTitle } from "../lib/box.ts";
import { assert, isMain } from "../lib/check.ts";
import { capitalize } from "../lib/format.ts";
import { thinkingColorOf, softOf } from "../lib/ansi.ts";
import { legendUsage, matchesBack } from "../lib/shortcuts.ts";
import { collectUsageSummary, estimateCost, formatTokens, getModelAllTimeUsage, hasPrice, loadPriceTable, type UsageSummary } from "../lib/usage-store.ts";

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
	/** Cost reconstructed from the price table when `cost` is 0 — shown with a `~`. */
	estimatedCost: number;
	expanded?: boolean;
}

export class UsageModalComponent implements Component {
	private expandedProviders = new Set<string>();
	private selectedIndex = 0;
	private summary: UsageSummary;

	private theme: { fg(c: string, t: string): string; bold?(t: string): string };
	private onDone: (back: boolean) => void;
	private requestRender: () => void;
	/** Painter for the box border's thinking slot, probed once so a theme without
	 *  `thinking*` falls back to dim. */
	private edgeOf: (s: string) => string;
	/** Row layout of the last render: which table row sits on which screen line. */
	private rowHitboxes: { line: number; index: number }[] = [];

	constructor(
		theme: { fg(c: string, t: string): string; bold?(t: string): string },
		/** Leave the dashboard. `true` when the user asked to go back (`←`), false for a plain close. */
		onDone: (back: boolean) => void,
		requestRender: () => void,
		thinkingLevel?: string,
	) {
		this.theme = theme;
		this.onDone = onDone;
		this.requestRender = requestRender;
		this.edgeOf = thinkingColorOf(theme, thinkingLevel);
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
				// No marker in the label: the row gutter draws the expand arrow, so a selected
				// provider does not end up with two arrows on one line. Capitalized to match the
				// detail line and the model rows beneath it.
				label: capitalize(p.name),
				sessions: p.sessions,
				msgs: p.msgs,
				tokens: p.totalTokens,
				input: p.input,
				output: p.output,
				cacheRead: p.cacheRead,
				cost: p.cost,
				estimatedCost: p.estimatedCost,
				expanded: isExpanded,
			});

			if (isExpanded) {
				for (const m of p.models) {
					rows.push({
						type: "model",
						providerName: p.name,
						modelName: m.name,
						label: m.name,
						sessions: m.sessions,
						msgs: m.msgs,
						tokens: m.totalTokens,
						input: m.input,
						output: m.output,
						cacheRead: m.cacheRead,
						cost: m.cost,
						estimatedCost: m.estimatedCost,
					});
				}
			}
		}
		return rows;
	}

	private toggleProvider(row: RowItem | undefined): boolean {
		if (!row || row.type !== "provider") return false;
		if (this.expandedProviders.has(row.providerName)) this.expandedProviders.delete(row.providerName);
		else this.expandedProviders.add(row.providerName);
		return true;
	}

	handleInput(keyData: string): void {
		const rows = this.buildFlatRows();
		if (matchesBack(keyData)) {
			this.onDone(true);
			return;
		}
		if (matchesKey(keyData, "q") || matchesKey(keyData, "Q") || matchesKey(keyData, "escape")) {
			this.onDone(false);
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
			if (this.toggleProvider(rows[this.selectedIndex])) this.requestRender();
		}
	}

	/** A click on a provider row toggles it, using the hitboxes of the last render so a
	 *  scrolled-out row is not clickable. Hover is not tracked: nothing reads it. */
	handleMouse(event: TuiMouseEvent): { handled: boolean; render?: boolean } | undefined {
		if (event.type === "wheel" || event.type === "move" || event.type === "drag" || event.type === "release") {
			return undefined;
		}
		const hit = this.rowHitboxes.find((h) => h.line === event.y);
		if (!hit) {
			// A click outside the table is not ours to consume: let it fall through (text
			// selection, scrollback).
			return undefined;
		}
		if (event.type === "click") {
			this.selectedIndex = hit.index;
			this.toggleProvider(this.buildFlatRows()[hit.index]);
			return { handled: true, render: true };
		}
		// Press: claim the row so the terminal tracks it for the follow-up click.
		return { handled: true, render: false };
	}

	render(width: number): string[] {
		const th = this.theme;
		const bold = th.bold ?? ((t: string) => `\x1b[1m${t}\x1b[22m`);
		// The box accent follows the session's thinking level (theme `thinking*` slot), so the
		// dashboard reads as belonging to the model that produced the usage.
		const edge = (t: string) => this.edgeOf(t);
		const boxW = width;
		// `accentSoft` is a vars-only token on Pi 1.2+; softOf resolves the soft accent either way.
		const soft = softOf(th);
		const acc = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const plain = (s: string) => th.fg("text", s);

		const rows = this.buildFlatRows();
		if (this.selectedIndex >= rows.length) {
			this.selectedIndex = Math.max(0, rows.length - 1);
		}

		// Columns: full header words. `colW.name` is the header's own name column; a data row
		// spends the first two cells on the expand arrow, so its name field is that much
		// shorter and the numeric columns still start on the header's grid.
		const gutter = 2;
		const contentW = boxW - 4;
		const colW = { name: 30, session: 9, messages: 10, tokens: 9, cost: 10 };
		const allNumeric = colW.session + colW.messages + colW.tokens + colW.cost;
		// A very narrow terminal drops Session/Messages rather than truncating Tokens or Cost.
		const narrow = contentW - allNumeric < 18;
		const numericW = narrow ? colW.tokens + colW.cost : allNumeric;
		colW.name = Math.max(8, Math.min(colW.name, contentW - numericW));
		const rowNameW = Math.max(4, colW.name - gutter);

		const formatCol = (text: string, w: number, alignRight = true) => {
			const str = truncateToWidth(text, w);
			const diff = Math.max(0, w - visibleWidth(str));
			return alignRight ? " ".repeat(diff) + str : str + " ".repeat(diff);
		};

		const sessionW = narrow ? 0 : colW.session;
		const messagesW = narrow ? 0 : colW.messages;
		// No leading gutter: the header is content, so it starts on the same left edge as the
		// box title, the detail line and the Total row. The rows' numeric columns are measured
		// to land on this grid despite their arrow.
		const headerText =
			formatCol(th.fg("dim", "Provider / Model"), colW.name, false) +
			formatCol(th.fg("dim", "Session"), sessionW) +
			formatCol(th.fg("dim", "Messages"), messagesW) +
			formatCol(th.fg("dim", "Tokens"), colW.tokens) +
			formatCol(th.fg("dim", "Cost"), colW.cost);

		// Body rows only — the frame comes from `renderScreen`, so this dashboard and the
		// /arnative menus cannot drift. No inner `├─┤` rule (skill arnative-pi rule 7).
		const body: string[] = [];
		/** Rows the chrome draws above the body: top edge, title, description, blank. */
		const CHROME_ROWS = 4;
		this.rowHitboxes = [];
		body.push(headerText);

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

			const paintName = isSelected ? acc : item.type === "provider" ? soft : plain;
			const paintVal = isSelected ? acc : dim;

			const cName = formatCol(paintName(isSelected ? bold(item.label) : item.label), rowNameW, false);
			const cSess = formatCol(paintVal(formatCount(item.sessions)), sessionW);
			const cMsgs = formatCol(paintVal(formatCount(item.msgs)), messagesW);
			const cToks = formatCol(paintVal(formatTokens(item.tokens)), colW.tokens);
			// A row with no reported cost but a rate shows `~$x` in place of `-`, so the guess is
			// visible exactly where it is one; the report line still keeps it out of the headline.
			const costCell = item.cost > 0 ? formatCost(item.cost) : item.estimatedCost > 0 ? `~${formatCost(item.estimatedCost)}` : "-";
			const cCost = formatCol(paintVal(costCell), colW.cost);

			// Gutter: expand arrow for provider or blank indent for model.
			const gutterText =
				item.type === "provider" ? (item.expanded ? soft("▾") : dim("▸")) : " ";
			const line = gutterText + " " + cName + cSess + cMsgs + cToks + cCost;
			this.rowHitboxes.push({ line: CHROME_ROWS + body.length, index: actualIdx });
			body.push(line);
		}

		// The selected row's detail sits under the table, where the eye lands after scanning it.
		body.push("");
		body.push(this.selectedDetail(rows[this.selectedIndex], acc, soft));

		// Table-width separator above Total band (skill arnative-pi §6 rule 7).
		const tableW = colW.name + sessionW + messagesW + colW.tokens + colW.cost;
		body.push(th.fg("dim", "─".repeat(Math.max(0, tableW))));

		// Total row
		const t = this.summary.totals;
		const totalName = formatCol(soft(bold("Total")), colW.name, false);
		const totalSess = formatCol(soft(bold(formatCount(t.sessions))), sessionW);
		const totalMsgs = formatCol(soft(bold(formatCount(t.msgs))), messagesW);
		const totalToks = formatCol(soft(bold(formatTokens(t.totalTokens))), colW.tokens);
		const totalCost = formatCol(soft(bold(formatCost(t.cost))), colW.cost);

		// Same left edge as the header: one table, three bands, one column grid.
		body.push(totalName + totalSess + totalMsgs + totalToks + totalCost);

		// Unreported cost estimate displayed separately from verified cost total.
		const est = t.estimatedCost;
		if (est > 0) body.push(th.fg("muted", `~${formatCost(est)} estimated (models.json)`));

		return renderScreen(
			th,
			width,
			{
				title: screenTitle("Usage"),
				description: width >= 70 ? "Token, message & cache usage across all local Pi sessions." : "Usage across all local sessions.",
				legend: this.hintText(width),
			},
			body,
			edge,
		);
	}

	/** Detail for the selected row: icon in `accent`, text and `·` dividers in `accentSoft`. */
	private selectedDetail(
		row: RowItem | undefined,
		accent: (t: string) => string,
		soft: (t: string) => string,
	): string {
		if (!row) return soft("No usage recorded yet.");
		const icon = `${accent("\uf4bc")} `;
		const title = row.type === "provider" ? row.providerName : `${row.providerName} · ${row.modelName}`;
		const parts = [
			`↑${formatTokens(row.input)}`,
			`↓${formatTokens(row.output)}`,
			`cache ${formatTokens(row.cacheRead)}`,
		];
		if (row.estimatedCost > 0) parts.push(`~${formatCost(row.estimatedCost)} est.`);
		const divider = soft(" · ");
		return `${icon}${soft(capitalize(title))}${divider}${soft(parts.join(" · "))}`;
	}

	private hintText(width: number): string {
		return legendUsage(width);
	}
}

/** Open the dashboard. Shared by `/usage` and `/arnative` → Usage, so the two cannot drift. */
export async function openUsage(ctx: ExtensionCommandContext): Promise<boolean> {
	if (!ctx.hasUI) return false;
	// The thinking level colors the box, so read it when the dashboard opens.
	const thinkingLevel = ctx.thinkingLevel;
	const back = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		return new UsageModalComponent(theme, (wantsBack) => done(wantsBack), () => tui.requestRender(), thinkingLevel);
	});
	return back === true;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Arnative token & model usage dashboard",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await openUsage(ctx);
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

	// UI checks need rows of their own: the scratch above ends with an empty, deleted file.
	// These use a provider that reports NO cost (cost.total = 0), which is the case the estimate
	// exists for; `asst` above reports 0.02 per message and would be priced by the provider.
	mkdirSync(join(fixture, "sessions", "ui"), { recursive: true });
	const freeAsst = (model: string, input: number) =>
		JSON.stringify({ message: { role: "assistant", provider: "wally", model, usage: { input, output: 5, cacheRead: 1, cost: { total: 0 } } } });
	writeFileSync(
		join(fixture, "sessions", "ui", "rows.jsonl"),
		[freeAsst("gemini-3.8-flash", 100), freeAsst("other-model", 7)].join(String.fromCharCode(10)),
	);
	collectUsageSummary(true);

	// Cost estimation: unpriced pairs use rates declared automatically in models.json.
	assert(loadPriceTable() !== null && Object.keys(loadPriceTable()).length === 0, "no models.json rates means an empty table");
	assert(!hasPrice("wally", "gemini-3.8-flash"), "a pair absent from models.json has no price");
	assert(estimateCost(1000, 100, 0, "gemini-3.8-flash", "wally") === null, "an unknown pair estimates nothing");
	assert(collectUsageSummary(true).totals.estimatedCost === 0, "nothing is estimated without rates");
	assert(estimateCost(1000, 100, 0, "other-model", "wally") === null, "a second unpriced pair estimates nothing either");

	writeFileSync(
		join(fixture, "models.json"),
		JSON.stringify({
			providers: {
				wally: { models: [{ id: "gemini-3.8-flash", cost: { input: 1, output: 2, cacheRead: 0.1 } }] },
				yarz: { models: [{ id: "gemini-3.8-flash", cost: { input: 10, output: 20 } }] },
			},
		}),
	);
	assert(hasPrice("wally", "gemini-3.8-flash"), "a priced provider+model is found in the table");
	assert(!hasPrice("enclave", "gemini-3.8-flash"), "another provider with no entry is not priced");
	assert(estimateCost(1_000_000, 0, 0, "gemini-3.8-flash", "wally") === 1, "1M input tokens at wally's $1/M costs $1");
	assert(
		estimateCost(1_000_000, 0, 0, "gemini-3.8-flash", "yarz") === 10,
		"the SAME model at yarz costs 10x (rates are per provider, not per model)",
	);
	assert(estimateCost(0, 1_000_000, 0, "gemini-3.8-flash", "wally") === 2, "1M output tokens at $2/M costs $2");
	assert(Math.abs(estimateCost(0, 0, 1_000_000, "gemini-3.8-flash", "wally")! - 0.1) < 1e-9, "cache reads use their own rate");
	assert(estimateCost(1_000_000, 0, 0, "vendor/gemini-3.8-flash", "wally") === 1, "a vendor/my-model id matches the model rate");
	const withPrices = collectUsageSummary(true);
	assert(withPrices.totals.estimatedCost > 0, "models.json rates produce an estimate");
	assert(withPrices.totals.reportedCost === 0, "the reported total stays at the provider's own number");
	assert(withPrices.totals.cost === withPrices.totals.reportedCost, "the headline cost never absorbs the estimate");
	assert(estimateCost(1_000_000, 0, 0, "other-model", "wally") === null, "a pair with no rate stays unpriced even when others are priced");

	const fakeTheme = {
		fg: (_c: string, t: string) => `\x1b[38;2;100;100;100m${t}\x1b[39m`,
		bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	};
	const modal = new UsageModalComponent(fakeTheme, () => {}, () => {});
	const lines = modal.render(100);
	assert(lines.length >= 8, "modal render produces table lines");
	assert(lines[0]!.includes("╭") && lines[0]!.includes("╮"), "round top border");
	assert(visibleWidth(lines[0]!) === 100, "box border full width (100 columns)");
	// The title follows the one arnative shape, `<setting> - <extension>⠙` — the same helper the
	// menus use, so this screen cannot keep an old title of its own.
	assert(lines[1]!.includes(screenTitle("Usage")), "the dashboard title uses the shared <setting> - <extension> shape");
	assert(lines[1]!.includes("Usage - Arnative\u2819"), "the dashboard title carries the arnative brand");
	assert(!lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n").includes("LLM Usage"), "the old one-off title is gone");
	assert(lines[lines.length - 1]!.includes("╰") && lines[lines.length - 1]!.includes("╯"), "round bottom border");
	assert(
		lines.every((l) => visibleWidth(l) <= 100),
		"every line fits within width 100",
	);
	assert(
		lines.every((l) => ["╭", "│", "╰"].some((c) => l.includes(c))),
		"no line missing a box side",
	);

	// Compact layout: the four noisy columns (↑In/↓Out/Cache) are gone from the table; the
	// selected row states them in the detail line instead.
	const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
	const body = lines.map(plain).join("\n");
	assert(body.includes("Tokens"), "compact table keeps the Tokens column");
	assert(body.includes("Cost"), "compact table keeps the Cost column");
	assert(!lines.some((l) => plain(l).includes("↑In")), "compact table drops the ↑In column");
	assert(!lines.some((l) => plain(l).includes("↓Out")), "compact table drops the ↓Out column");
	assert(lines.some((l) => plain(l).includes("↑")), "the selected row still shows its in/out detail");

	// Layout contract: full header words, the detail line UNDER the table (not above it),
	// and the total below the rule that closes the rows.
	assert(body.includes("Session"), "the header spells Session in full");
	assert(body.includes("Messages"), "the header spells Messages in full");
	const at = (needle: string) => lines.findIndex((l) => plain(l).includes(needle));
	const firstRow = lines.findIndex((l) => plain(l).includes("▾") || plain(l).includes("▸"));
	const detailAt = lines.findIndex((l) => plain(l).includes("cache ") && plain(l).includes("↑"));
	assert(detailAt > firstRow, "the detail line sits below the table, not above it");
	assert(at("Total") > detailAt, "the total sits below the detail line");
	assert(at("Provider / Model") < firstRow, "the header sits above the first row");
	// The chrome is the whole chrome: no inner `├─┤` rule (skill arnative-pi rule 7), the sections
	// are separated by blank rows the way every /arnative menu separates them.
	assert(!lines.some((l) => /[├┤]/.test(l)), "the dashboard draws no inner rule");
	assert(
		lines.findIndex((l) => plain(l).includes("across all local Pi sessions")) < firstRow,
		"the description sits above the table",
	);
	assert(plain(lines[detailAt]!).includes("\uf4bc"), "the detail line carries its icon");
	// No rule between the header and its first row (the header labels the rows below it),
	// while the rules after the description and before Total stay.
	const headerAt = lines.findIndex((l) => plain(l).includes("Provider / Model"));
	assert(
		!lines.slice(headerAt + 1, firstRow).some((l) => l.includes("├")),
		"no rule sits between the header and the first row",
	);
	assert(plain(lines[headerAt - 1]!).slice(1, -1).trim() === "", "a blank row separates the description from the header");
	// The header is content: it sits flush with the title, and each column title ends on the
	// same cell its own numbers end on.
	const headerLine = plain(lines[headerAt]!);
	// The Total row always carries a value in every column, so it is the stable ruler to
	// measure the grid against (a provider row can show `-`).
	const dataLine = plain(lines[at("Total")]!);
	// Total sits on the header's grid, one table-width rule above it.
	const totalLine = plain(lines[at("Total")]!);
	assert(
		totalLine.indexOf("Total") === headerLine.indexOf("Provider / Model"),
		`Total is on the header grid (header ${headerLine.indexOf("Provider / Model")}, total ${totalLine.indexOf("Total")})`,
	);
	const totalAt = at("Total");
	const ruleLine = plain(lines[totalAt - 1]!);
	assert(/─{10,}/.test(ruleLine), "a table rule separates the table from Total");
	assert(!/[├┤]/.test(ruleLine), "the table rule is not a full-width frame junction");
	const ruleStart = ruleLine.indexOf("─");
	const ruleEnd = ruleLine.lastIndexOf("─") + 1;
	assert(ruleStart === headerLine.indexOf("Provider / Model"), "the rule starts at the table's left edge");
	assert(ruleEnd <= 100 - 3, `the rule stops at the table's right edge, got ${ruleEnd}`);
	// Every column title ends on the same cell its numbers end on, so the header reads as the
	// table's ruler instead of drifting a column or two to the left of its own data.
	const right = (line: string, text: string) => line.indexOf(text) + text.length;
	assert(headerLine.indexOf("Provider / Model") === dataLine.indexOf("Total"), "the header name column starts over the row names");
	// Flush left with the box title: no screen row is indented into a gutter the header does
	// not use, so the title, the table, the rule and Total share one left edge.
	const titleCol = plain(lines[1]!).indexOf("Usage - Arnative");
	for (const [what, col] of [
		["the header", headerLine.indexOf("Provider / Model")],
		["the table rule", ruleStart],
		["Total", dataLine.indexOf("Total")],
	] as const) {
		assert(col === titleCol, `${what} starts on the title's left edge (${col} vs ${titleCol})`);
	}
	// A right-aligned column ends exactly where its title ends: take the slice of the row up
	// to that boundary and it must be flush against it, never a cell short or a cell over.
	let edge = headerLine.indexOf("Provider / Model");
	for (const title of ["Session", "Messages", "Tokens", "Cost"]) {
		const boundary = right(headerLine, title);
		const cell = dataLine.slice(edge, boundary);
		assert(cell.trim() !== "", `the ${title} cell is not empty`);
		assert(cell === cell.trimEnd(), `the ${title} value is right-aligned to its column edge`);
		edge = boundary;
	}
	// The unpriced notice is gone: the `-` in Cost already says it.
	assert(!body.includes("unpriced"), "the unpriced notice line is removed");
	// Provider rows are capitalized so they read as names, not raw ids.
	assert(plain(lines[firstRow]!).includes("Wally") || plain(lines[firstRow]!).includes("Google"), "provider rows are capitalized");

	// Thinking level -> theme slot is unit-tested in lib/ansi.ts (one definition); here we
	// only prove the box border actually takes its color from that slot at render time.
	const taggedTheme = { fg: (c: string, t: string) => `<${c}>${t}</>`, bold: (t: string) => t };
	// Wide enough that the tagged theme's literal <tag> text does not force truncation.
	const high = new UsageModalComponent(taggedTheme, () => {}, () => {}, "high");
	const highLines = high.render(260);
	assert(highLines[0]!.includes("<thinkingHigh>"), "the box border uses the thinking slot from the session level");
	// The detail line: icon in accent, its text and dividers in accentSoft.
	const detailTagged = highLines.find((l) => l.includes("<accent>\uf4bc</>") || (l.includes("\uf4bc") && l.includes("↑")))!;
	assert(detailTagged.includes("<accent>\uf4bc</>"), "the detail icon is accent-colored");
	assert(!detailTagged.includes("<thinkingHigh>\uf4bc"), "the detail icon is NOT the border/thinking color");
	assert(/<accentSoft>[^<]*↑/.test(detailTagged), "the detail values are accentSoft");
	assert(detailTagged.includes("<accentSoft> · </>"), "the detail divider is accentSoft");
	const offLines = new UsageModalComponent(taggedTheme, () => {}, () => {}, "off").render(260);
	assert(offLines[0]!.includes("<thinkingOff>"), "thinking off colors the border with thinkingOff");
	// Shared chrome (per `renderScreen`): title accent+bold, description muted, legend dim.
	// `taggedTheme.bold` is identity, so only the accent wrapper shows here; the bold half is
	// pinned in lib/box.ts.
	assert(highLines[1]!.includes("<accent>Usage - Arnative"), "the dashboard title is accent-colored");
	assert(highLines[2]!.includes("<muted>Token, message"), "the dashboard description is muted");
	assert(highLines[highLines.length - 2]!.includes("<dim>["), "the dashboard legend is dim");
	assert(!highLines.some((l) => /[├┤]/.test(l)), "the dashboard draws no inner rule");

	// Mouse: a click on a provider row toggles it, a click on empty space is ignored.
	const clickModal = new UsageModalComponent(fakeTheme, () => {}, () => {}, "medium");
	const clickLines = clickModal.render(100);
	const providerLine = clickLines.findIndex((l) => plain(l).includes("▸") || plain(l).includes("▾"));
	assert(providerLine > 0, "a provider row is rendered");
	const before = plain(clickModal.render(100)[providerLine]!);
	const toggled = clickModal.handleMouse!({
		type: "click",
		button: "left",
		x: 3,
		y: providerLine,
		screenX: 3,
		screenY: providerLine,
		width: 100,
		height: clickLines.length,
		shift: false,
		alt: false,
		ctrl: false,
	} as never);
	assert(toggled?.handled === true, "a click on a provider row is handled");
	const after = plain(clickModal.render(100)[providerLine]!);
	assert(before !== after, "clicking the row toggled the provider (marker changed)");
	assert(
		clickModal.handleMouse!({
			type: "click",
			button: "left",
			x: 3,
			y: clickLines.length + 50,
			screenX: 3,
			screenY: clickLines.length + 50,
			width: 100,
			height: clickLines.length,
			shift: false,
			alt: false,
			ctrl: false,
		} as never) === undefined,
		"a click outside any row is ignored",
	);
	// A hover move is not consumed and not repainted: nothing on screen depends on it.
	assert(
		clickModal.handleMouse!({
			type: "move",
			button: "none",
			x: 3,
			y: providerLine,
			screenX: 3,
			screenY: providerLine,
			width: 100,
			height: clickLines.length,
			shift: false,
			alt: false,
			ctrl: false,
		} as never) === undefined,
		"a hover move is passed through, not swallowed",
	);
	// A wheel event must not be swallowed: scrolling belongs to the terminal.
	assert(
		clickModal.handleMouse!({
			type: "wheel",
			button: "left",
			x: 3,
			y: providerLine,
			screenX: 3,
			screenY: providerLine,
			width: 100,
			height: clickLines.length,
			shift: false,
			alt: false,
			ctrl: false,
		} as never) === undefined,
		"a wheel event is left to the terminal",
	);
	// `←` is the arnative-wide "go back" key: the dashboard reports it upward instead of
	// closing, so the /arnative menu can reopen. Esc/q still close it outright.
	const doneArgs: boolean[] = [];
	const nav = new UsageModalComponent(fakeTheme, (back) => doneArgs.push(back), () => {}, "high");
	nav.handleInput("\x1b[D"); // ←
	nav.handleInput("\x1b"); // Esc
	nav.handleInput("q");
	assert(doneArgs.length === 3 && doneArgs[0] === true && doneArgs[1] === false && doneArgs[2] === false, "← reports back, Esc/q close");
	assert(
		new UsageModalComponent(fakeTheme, () => {}, () => {}, "high").render(120).some((l) => l.includes("[←] Back")),
		"the dashboard legend advertises the back key",
	);

	// models.json rates price the provider and models directly.
	writeFileSync(
		join(fixture, "models.json"),
		JSON.stringify({
			providers: {
				wally: { models: [{ id: "gemini-3.8-flash", cost: { input: 0.28, output: 0.42, cacheRead: 0.028 } }] },
				yarz: { models: [{ id: "gemini-3.8-flash" }] },
			},
		}),
	);
	const fromModels = collectUsageSummary(true);
	const wally = fromModels.providers.find((p) => p.name === "wally")!;
	const expected = (100 / 1e6) * 0.28 + (5 / 1e6) * 0.42 + (1 / 1e6) * 0.028;
	assert(Math.abs(wally.estimatedCost - expected) < 1e-12, `models.json cost prices the provider, got ${wally.estimatedCost}`);
	assert(
		Math.abs(wally.models.reduce((n, m) => n + m.estimatedCost, 0) - wally.estimatedCost) < 1e-9,
		"a provider's estimate is the sum of its models' estimates",
	);
	assert(wally.models.find((m) => m.name === "other-model")!.estimatedCost === 0, "a model without a declared cost stays unpriced");
	writeFileSync(join(fixture, "models.json"), "{}", "utf8");
	collectUsageSummary(true);

	// Per-row estimates: a row whose provider reported nothing but has a rate shows `~$x`
	// instead of `-`, while a reported cost is never prefixed. The total line names both
	// sources, since a rate can come from `models.json` or the user's table.
	const estModal = new UsageModalComponent(fakeTheme, () => {}, () => {}, "low");
	(estModal as unknown as { summary: unknown }).summary = {
		providers: [
			{
				name: "wally", sessions: 1, msgs: 2, input: 1_000_000, output: 500_000, cacheRead: 2_000_000,
				totalTokens: 1_500_000, cost: 0, estimatedCost: 0.546,
				models: [{ name: "deepseek-v4.1-flash", sessions: 1, msgs: 2, input: 1_000_000, output: 500_000, cacheRead: 2_000_000, totalTokens: 1_500_000, cost: 0, estimatedCost: 0.546 }],
			},
			{
				name: "antigravity", sessions: 1, msgs: 1, input: 2_200_000, output: 626_000, cacheRead: 0,
				totalTokens: 2_826_000, cost: 0.65, estimatedCost: 0,
				models: [{ name: "gemini-3.8-flash", sessions: 1, msgs: 1, input: 2_200_000, output: 626_000, cacheRead: 0, totalTokens: 2_826_000, cost: 0.65, estimatedCost: 0 }],
			},
		],
		totals: { sessions: 2, msgs: 3, input: 3_200_000, output: 1_126_000, cacheRead: 2_000_000, totalTokens: 4_326_000, cost: 0.65, reportedCost: 0.65, estimatedCost: 0.546 },
	};
	(estModal as unknown as { expandedProviders: Set<string> }).expandedProviders = new Set(["wally"]);
	const estLines = estModal.render(90);
	const estBody = estLines.map(plain).join("\n");
	assert(estBody.includes("~$0.55"), "a row with a rate but no reported cost shows the estimate with `~`");
	assert(estBody.includes("$0.65") && !estBody.includes("~$0.65"), "a reported cost is shown as-is, never with `~`");
	assert(estBody.includes("estimated (models.json)"), "the estimate line names models.json");
	// Only the two table rows — the detail line also carries the estimate.
	const estRows = estLines.map(plain).filter((l) => /^\u2502 [\u25be\u25b8 ] (Wally|deepseek)/.test(l));
	assert(estRows.length === 2 && estRows.every((l) => l.includes("~$0.55")), `the estimate shows on the provider row and its model row, got ${JSON.stringify(estRows)}`);

	// Cost must survive every width: a clipped `$5` is worse than a dropped column.
	for (const w of [60, 64, 78, 82, 90, 120]) {
		const wide = new UsageModalComponent(fakeTheme, () => {}, () => {}, "high");
		const rendered = wide.render(w);
		assert(
			!rendered.some((l) => /\$\d+[^\d.\s]/.test(plain(l))),
			`cost is never clipped at width ${w}`,
		);
	}

	console.log("usage.ts self-check OK");
}
