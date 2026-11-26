/**
 * Arnative Usage Dashboard (/usage): table UI + the /usage command.
 * Data layer (session scan + cache + aggregation) lives in lib/usage-store.ts —
 * shared with the Model tab.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderScreen, screenTitle } from "../box.ts";
import { capitalize } from "../format.ts";
import { thinkingColorOf, softOf, softSecondaryOf } from "../ansi.ts";
import { writeAtomicSync } from "../preset-store.ts";
import { legendUsage, matchesBack, RESET_USAGE, UNDO_USAGE } from "../shortcuts.ts";
import { collectUsageSummary, formatTokens, hasPrice, loadPriceTable, markUsageDirty, resetUsageStats, restoreUsageStats, USAGE_RANGES, type UsageRange, type UsageSummary } from "../usage-store.ts";

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

function formatCount(n: number): string {
	return n > 0 ? n.toLocaleString("en-US") : "-";
}
// =============================================================================
// /usage TUI component
// =============================================================================

interface RowItem {
	type: "project" | "provider" | "model" | "price";
	/** Set on project rows, and on the provider rows nested under one in Project view. */
	projectName?: string;
	providerName: string;
	modelName?: string;
	label: string;
	sessions: number;
	msgs: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	/** Billed cost only; the estimate stays in `estimatedCost`. */
	cost: number;
	/** Catalog totals plus the price-table reconstruction when `cost` is 0 — shown with a `~`. */
	estimatedCost: number;
	expanded?: boolean;
	/** Prices view only: the $/1M rates declared in models.json. */
	rates?: { in: number; out: number; cacheRead: number; cacheWrite: number };
	/** Prices view only: a model used in the sessions but absent from the price table. */
	unpriced?: boolean;
}

/** The stat columns every row shares; each view only adds its type, label and nesting. */
const statsOf = (
	s: { sessions: number; msgs: number; totalTokens: number; input: number; output: number; cacheRead: number; cost: number; estimatedCost: number },
): Pick<RowItem, "sessions" | "msgs" | "tokens" | "input" | "output" | "cacheRead" | "cost" | "estimatedCost"> => ({
	sessions: s.sessions,
	msgs: s.msgs,
	tokens: s.totalTokens,
	input: s.input,
	output: s.output,
	cacheRead: s.cacheRead,
	cost: s.cost,
	estimatedCost: s.estimatedCost,
});

/** The dashboard views, cycled by `v`: Provider → Project → Prices. */
type UsageView = "provider" | "project" | "prices";

/** Labels on the range bar, in tab order. */
const RANGE_LABELS: Record<UsageRange, string> = { all: "All", today: "Today", "7d": "7 day", "30d": "30 day" };
/** The three views `v` cycles, in that order, and the view a press would show next. */
const VIEW_LABELS: Record<UsageView, string> = { provider: "Provider", project: "Project", prices: "Prices" };
const NEXT_VIEW: Record<UsageView, UsageView> = { provider: "project", project: "prices", prices: "provider" };
/** Data rows on screen at once: five reads as a table, sixteen pushed the Total row off. */
const USAGE_VIEWPORT = 5;

export class UsageModalComponent implements Component {
	private expandedProviders = new Set<string>();
	private expandedProjects = new Set<string>();
	private view: UsageView = "provider";
	private selectedIndex = 0;
	private summary: UsageSummary;
	/** Which window the numbers cover. `all` keeps the old dashboard's meaning. */
	private range: UsageRange = "all";
	/** Tab hitboxes of the last render: column span of each range on the bar line. */
	private tabHitboxes: { line: number; start: number; end: number; range: UsageRange }[] = [];

	private theme: { fg(c: string, t: string): string; bold?(t: string): string };
	private onDone: (back: boolean) => void;
	private requestRender: () => void;
	/** Painter for the box border's thinking slot, probed once so a theme without
	 *  `thinking*` falls back to dim. */
	private edgeOf: (s: string) => string;
	/** Row layout of the last render: which table row sits on which screen line. */
	private rowHitboxes: { line: number; index: number }[] = [];
	/** A destructive step waits here until the user answers it. Nothing is touched before. */
	private confirmStep: "reset" | "undo" | null = null;
	/** One line under the table, stating what the last reset changed. */
	private notice: string | null = null;
	/** A wrapper keeps the first reset undoable when no previous baseline existed. */
	private undoBaseline: { previous: string | null } | null = null;

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
		this.summary = collectUsageSummary(true, this.range);
		// Default: expand the first provider when there is one
		if (this.summary.providers.length > 0) {
			this.expandedProviders.add(this.summary.providers[0]!.name);
		}
	}

	invalidate(): void {}

	dispose(): void {}

	private buildFlatRows(): RowItem[] {
		const rows: RowItem[] = [];
		if (this.view === "prices") {
			// Every models.json pair, grouped under its provider like the Provider view: a tree
			// opened one provider at a time. Inside a group the cheapest input rate comes first,
			// and a used model the table does not price ends its group marked `unpriced`.
			const table = loadPriceTable();
			const groups = new Map<string, RowItem[]>();
			const addTo = (provider: string, row: RowItem): void => {
				const list = groups.get(provider) ?? [];
				list.push(row);
				groups.set(provider, list);
			};
			for (const [provider, models] of Object.entries(table)) {
				for (const [model, r] of Object.entries(models)) {
					addTo(provider, {
						type: "price",
						providerName: provider,
						modelName: model,
						label: model,
						sessions: 0,
						msgs: 0,
						tokens: 0,
						input: 0,
						output: 0,
						cacheRead: 0,
						cost: 0,
						estimatedCost: 0,
						rates: { in: r.input ?? 0, out: r.output ?? 0, cacheRead: r.cacheRead ?? 0, cacheWrite: r.cacheWrite ?? 0 },
					});
				}
			}
			for (const p of this.summary.providers) {
				for (const m of p.models) {
					// `models.json` holds the user's custom rates only: a built-in model has no entry
					// yet still reports a cost, so it is priced, not unpriced. Only a model that
					// shows `-` in the table (no rate, no cost) belongs here.
					if (hasPrice(p.name, m.name, table) || m.cost > 0 || m.estimatedCost > 0) continue;
					addTo(p.name, {
						type: "price",
						providerName: p.name,
						modelName: m.name,
						label: m.name,
						...statsOf(m),
						unpriced: true,
					});
				}
			}
			const cheapest = (list: RowItem[]): number => Math.min(...list.map((r) => r.rates?.in ?? Number.POSITIVE_INFINITY));
			const ordered = [...groups.entries()].sort((a, b) => cheapest(a[1]) - cheapest(b[1]) || a[0].localeCompare(b[0]));
			for (const [provider, models] of ordered) {
				const isExpanded = this.expandedProviders.has(provider);
				rows.push({
					type: "provider",
					providerName: provider,
					label: capitalize(provider),
					sessions: 0,
					msgs: 0,
					tokens: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					cost: 0,
					estimatedCost: 0,
					expanded: isExpanded,
				});
				if (!isExpanded) continue;
				models.sort((a, b) => (a.rates?.in ?? Number.POSITIVE_INFINITY) - (b.rates?.in ?? Number.POSITIVE_INFINITY) || a.label.localeCompare(b.label));
				for (const row of models) rows.push(row);
			}
			return rows;
		}
		if (this.view === "project") {
			// Same grid and columns as the Provider view, one level up: Project → Provider.
			for (const proj of this.summary.projects) {
				const isExpanded = this.expandedProjects.has(proj.name);
				rows.push({
					type: "project",
					projectName: proj.name,
					providerName: proj.name,
					label: proj.name,
					...statsOf(proj),
					expanded: isExpanded,
				});
				if (!isExpanded) continue;
				for (const p of proj.providers) {
					rows.push({
						type: "provider",
						projectName: proj.name,
						providerName: p.name,
						label: capitalize(p.name),
						...statsOf(p),
					});
				}
			}
			return rows;
		}
		for (const p of this.summary.providers) {
			const isExpanded = this.expandedProviders.has(p.name);
			rows.push({
				type: "provider",
				providerName: p.name,
				// No marker in the label: the row gutter draws the expand arrow, so a selected
				// provider does not end up with two arrows on one line. Capitalized to match the
				// detail line and the model rows beneath it.
				label: capitalize(p.name),
				...statsOf(p),
				expanded: isExpanded,
			});

			if (isExpanded) {
				for (const m of p.models) {
					rows.push({
						type: "model",
						providerName: p.name,
						modelName: m.name,
						label: m.name,
						...statsOf(m),
					});
				}
			}
		}
		return rows;
	}

	private toggleRow(row: RowItem | undefined): boolean {
		if (!row) return false;
		if (row.type === "project") {
			if (this.expandedProjects.has(row.projectName!)) this.expandedProjects.delete(row.projectName!);
			else this.expandedProjects.add(row.projectName!);
			return true;
		}
		if (row.type !== "provider") return false;
		if (this.expandedProviders.has(row.providerName)) this.expandedProviders.delete(row.providerName);
		else this.expandedProviders.add(row.providerName);
		return true;
	}

	/** Cycle the view: Provider → Project → Prices → Provider. One key, one grid, one legend. */
	private cycleView(): void {
		this.view = this.view === "provider" ? "project" : this.view === "project" ? "prices" : "provider";
		if (this.view === "project" && this.expandedProjects.size === 0 && this.summary.projects.length > 0) {
			this.expandedProjects.add(this.summary.projects[0]!.name);
		}
	}

	/** Refresh every row after a baseline change; the selected provider may disappear. */
	private runConfirm(step: "reset" | "undo"): void {
		if (step === "reset") {
			this.undoBaseline = { previous: resetUsageStats() };
			this.notice = "Usage statistics reset. Sessions kept.";
		} else if (this.undoBaseline) {
			restoreUsageStats(this.undoBaseline.previous);
			this.notice = "Previous statistics restored. Sessions kept.";
			this.undoBaseline = null;
		}
		this.summary = collectUsageSummary(true, this.range);
		this.selectedIndex = 0;
		this.expandedProviders.clear();
		const first = this.summary.providers[0];
		if (first) this.expandedProviders.add(first.name);
		this.requestRender();
	}

	/** Switch the window and re-read the numbers for it. Selection returns to the first row:
	 *  a provider that carried the last 3 months can be absent from today. */
	private setRange(range: UsageRange): void {
		if (range === this.range) return;
		this.range = range;
		this.summary = collectUsageSummary(true, range);
		this.selectedIndex = 0;
		this.expandedProviders.clear();
		const first = this.summary.providers[0];
		if (first) this.expandedProviders.add(first.name);
		this.requestRender();
	}

	handleInput(keyData: string): void {
		const rows = this.buildFlatRows();
		// A pending question owns the keyboard: any key but y answers no, so a stray press
		// can neither delete anything nor navigate.
		if (this.confirmStep) {
			const yes = matchesKey(keyData, "y") || matchesKey(keyData, "Y");
			const step = this.confirmStep;
			this.confirmStep = null;
			if (yes) this.runConfirm(step);
			else this.requestRender();
			return;
		}
		// Esc and ← both step out one level: the dashboard reports it upward so the /arnative
		// menu reopens. q closes outright, for a dashboard opened by /usage on its own.
		if (matchesBack(keyData) || matchesKey(keyData, "escape")) {
			this.onDone(true);
			return;
		}
		if (matchesKey(keyData, "q") || matchesKey(keyData, "shift+q")) {
			this.onDone(false);
			return;
		}
		if (RESET_USAGE.matches(keyData)) {
			this.confirmStep = "reset";
			this.notice = null;
			this.requestRender();
			return;
		}
		if (UNDO_USAGE.matches(keyData) && this.undoBaseline) {
			this.confirmStep = "undo";
			this.requestRender();
			return;
		}
		if (matchesKey(keyData, "tab") || matchesKey(keyData, "shift+tab")) {
			const at = USAGE_RANGES.indexOf(this.range);
			const step = matchesKey(keyData, "shift+tab") ? -1 : 1;
			this.setRange(USAGE_RANGES[(at + step + USAGE_RANGES.length) % USAGE_RANGES.length]!);
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
			if (this.toggleRow(rows[this.selectedIndex])) this.requestRender();
			return;
		}
		if (matchesKey(keyData, "v")) {
			this.cycleView();
			this.requestRender();
		}
	}

	/** A click on a provider row toggles it, using the hitboxes of the last render so a
	 *  scrolled-out row is not clickable. Hover is not tracked: nothing reads it. */
	handleMouse(event: TuiMouseEvent): { handled: boolean; render?: boolean } | undefined {
		if (event.type === "wheel" || event.type === "move" || event.type === "drag" || event.type === "release") {
			return undefined;
		}
		// A click on the range bar picks that window, so the bar is a control, not a label.
		const tab = this.tabHitboxes.find((h) => h.line === event.y && event.x >= h.start && event.x <= h.end);
		if (tab) {
			if (event.type === "click") this.setRange(tab.range);
			return { handled: true, render: event.type === "click" };
		}
		const hit = this.rowHitboxes.find((h) => h.line === event.y);
		if (!hit) {
			// A click outside the table is not ours to consume: let it fall through (text
			// selection, scrollback).
			return undefined;
		}
		if (event.type === "click") {
			this.selectedIndex = hit.index;
			this.toggleRow(this.buildFlatRows()[hit.index]);
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
		// `secondarySoft` is a vars-only token on Pi 1.2+; softSecondaryOf resolves the soft
		// label tier (the border-accent hue) and falls back to the accent tier.
		const soft = softSecondaryOf(th);
		const acc = (s: string) => th.fg("accent", s);
		// Selection follows the menu style: a chosen row takes the soft accent, not the accent
		// that marks the provider level itself. `softOf` resolves the token on Pi <=1.1.0 and
		// derives it from the resolved accent on 1.2+, where `fg("accentSoft")` throws.
		const accSoft = softOf(th);
		const dim = (s: string) => th.fg("dim", s);

		const rows = this.buildFlatRows();
		if (this.selectedIndex >= rows.length) {
			this.selectedIndex = Math.max(0, rows.length - 1);
		}

		// Columns: full header words. `colW.name` is the header's own name column; a data row
		// spends the first two cells on the expand arrow, so its name field is that much
		// shorter and the numeric columns still start on the header's grid.
		const gutter = 2;
		const contentW = boxW - 4;
		const colW = { name: 30, session: 10, messages: 11, tokens: 10, cost: 11 };
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
		// to land on this grid despite their arrow. The header names the tree's two levels;
		// the grid under it never moves between views. The Prices view reuses the same four
		// numeric columns for the $/1M rates.
		const nameHeader = this.view === "project" ? "Project / Provider" : "Provider / Model";
		const [hSess, hMsgs, hToks, hCost] =
			this.view === "prices" ? ["In $/M", "Out $/M", "Read $/M", "Write $/M"] : ["Session", "Messages", "Tokens", "Cost"];
		const headerText =
			formatCol(th.fg("dim", nameHeader), colW.name, false) +
			formatCol(th.fg("dim", hSess), sessionW) +
			formatCol(th.fg("dim", hMsgs), messagesW) +
			formatCol(th.fg("dim", hToks), colW.tokens) +
			formatCol(th.fg("dim", hCost), colW.cost);

		// Body rows only — the frame comes from `renderScreen`, so this dashboard and the
		// /arnative menus cannot drift. No inner `├─┤` rule (skill arnative-pi rule 7).
		const body: string[] = [];
		/** Rows the chrome draws above the body: top edge, title, description, blank. */
		const CHROME_ROWS = 4;
		this.rowHitboxes = [];
		this.tabHitboxes = [];

		// Row 1: the window bar. The active range is the only accented word, so the numbers
		// below are read with the window they cover; the counter on the same line says how many
		// rows exist beyond the viewport.
		const bar: string[] = [];
		let barCol = 0;
		const barRow = CHROME_ROWS + body.length;
		for (const r of USAGE_RANGES) {
			if (bar.length > 0) {
				bar.push(dim(" · "));
				barCol += 3;
			}
			const label = RANGE_LABELS[r];
			const text = r === this.range ? acc(bold(label)) : th.fg("muted", label);
			this.tabHitboxes.push({ line: barRow, start: barCol + 2, end: barCol + label.length + 1, range: r });
			bar.push(text);
			barCol += label.length;
		}
		const counter = `${Math.min(rows.length, USAGE_VIEWPORT)}/${rows.length}`;
		const barLine = bar.join("");
		const counterFits = contentW - barCol - counter.length - 1 >= 0;
		// Blank rows separate the range bar from the description above (via renderScreen) and the
		// table header below — no inner horizontal rules.
		body.push(counterFits ? barLine + " ".repeat(contentW - barCol - counter.length) + dim(counter) : barLine);
		body.push("");
		body.push(headerText);

		// Row 2 onward: the table, windowed so the box keeps one height however long the list
		// of providers and models grows. The line above and below say what is out of sight.
		const maxVisibleRows = USAGE_VIEWPORT;
		let startIdx = 0;
		if (rows.length > maxVisibleRows) {
			startIdx = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisibleRows / 2), rows.length - maxVisibleRows));
		}
		const visibleRows = rows.slice(startIdx, startIdx + maxVisibleRows);
		if (startIdx > 0) body.push(dim(`↑ ${startIdx} more`));

		for (let i = 0; i < visibleRows.length; i++) {
			const item = visibleRows[i]!;
			const actualIdx = startIdx + i;
			const isSelected = actualIdx === this.selectedIndex;

			// Provider and project group rows sit on the plain text color, and the rows beneath
			// them are dim — including the providers nested under a project. The cursor paints
			// any row the soft accent, and the expand arrow alone carries the accent so the eye
			// can find the tree.
			const plain = (s: string) => th.fg("text", s);
			const nested =
				item.type === "model" || item.type === "price" || (this.view === "project" && item.type === "provider");
			const resting = nested ? dim : plain;
			const paintName = isSelected ? accSoft : resting;
			const paintVal = isSelected ? accSoft : resting;
			const isPrice = item.type === "price";
			// A Prices group row names the provider; its rate columns stay blank, so the tree
			// reads as a heading instead of a provider with $0.00 rates.
			const isPriceGroup = this.view === "prices" && item.type === "provider";
			const blank = (w: number) => " ".repeat(w);

			// One indent for the rows under a group (model, price, or the provider under a
			// project): it eats name width so the figures keep their columns.
			const groupType: RowItem["type"] = this.view === "project" ? "project" : "provider";
			const indent = item.type === groupType ? "" : " ";
			const cName = formatCol(paintName(isSelected ? bold(item.label) : item.label), Math.max(10, rowNameW - indent.length), false);
			const cSess = isPriceGroup ? blank(sessionW) : formatCol(paintVal(isPrice ? formatCost(item.rates?.in ?? 0) : formatCount(item.sessions)), sessionW);
			const cMsgs = isPriceGroup ? blank(messagesW) : formatCol(paintVal(isPrice ? formatCost(item.rates?.out ?? 0) : formatCount(item.msgs)), messagesW);
			const cToks = isPriceGroup ? blank(colW.tokens) : formatCol(paintVal(isPrice ? formatCost(item.rates?.cacheRead ?? 0) : formatTokens(item.tokens)), colW.tokens);
			// A row with no billed cost but a rate shows `~$x` in place of `-`, so the guess is
			// visible exactly where it is one; the report line still keeps it out of the headline.
			// The Prices view puts the cache-write rate here, or `unpriced` for a used model the
			// table does not price.
			const costCell = isPrice
				? item.unpriced
					? "unpriced"
					: formatCost(item.rates?.cacheWrite ?? 0)
				: item.cost > 0
					? formatCost(item.cost)
					: item.estimatedCost > 0
						? `~${formatCost(item.estimatedCost)}`
						: "-";
			const cCost = isPriceGroup ? blank(colW.cost) : formatCol(paintVal(costCell), colW.cost);

			// Gutter: the expand arrow carries the accent, blank indent for the rows beneath it.
			const gutterText = item.type === groupType ? acc(item.expanded ? "▾" : "▸") : " ";
			const line = indent + gutterText + " " + cName + cSess + cMsgs + cToks + cCost;
			this.rowHitboxes.push({ line: CHROME_ROWS + body.length, index: actualIdx });
			body.push(line);
		}
		const hiddenBelow = rows.length - (startIdx + visibleRows.length);
		if (hiddenBelow > 0) body.push(dim(`↓ ${hiddenBelow} more`));

		// Blank row separates the table rows from the Total band (no inner rules).
		body.push("");

		if (this.view === "prices") {
			// No Total band for rates: a count of what the table prices, and of the used models
			// it does not, is the honest summary of this view.
			const unpriced = rows.filter((r) => r.unpriced).length;
			const priced = rows.filter((r) => r.type === "price" && !r.unpriced).length;
			body.push(dim(`${priced} priced · ${unpriced} unpriced (models.json)`));
		} else {
			// Total row. Its cost column is the billed total only.
			const t = this.summary.totals;
			const totalName = formatCol(soft(bold("Total")), colW.name, false);
			const totalSess = formatCol(soft(bold(formatCount(t.sessions))), sessionW);
			const totalMsgs = formatCol(soft(bold(formatCount(t.msgs))), messagesW);
			const totalToks = formatCol(soft(bold(formatTokens(t.totalTokens))), colW.tokens);
			// Billed when a provider reported one; otherwise the catalog estimate, marked `~` so
			// the Total row never claims a billed number it does not have.
			const totalValue = t.cost > 0 ? formatCost(t.cost) : t.estimatedCost > 0 ? `~${formatCost(t.estimatedCost)}` : "-";
			const totalCost = formatCol(soft(bold(totalValue)), colW.cost);

			// Same left edge as the header: one table, three bands, one column grid.
			body.push(totalName + totalSess + totalMsgs + totalToks + totalCost);
		}

		// The selected row's detail sits below Total, separated by a blank row.
		body.push("");
		body.push(this.selectedDetail(rows[this.selectedIndex], acc, soft));
		if (this.notice) body.push(th.fg("muted", this.notice));

		const viewName = VIEW_LABELS[this.view];
		return renderScreen(
			th,
			width,
			{
				title: screenTitle("Usage"),
				description: `${viewName} · ${
					this.view === "prices"
						? width >= 70
							? "Rates per 1M tokens from models.json; `unpriced` marks a used model with no rate."
							: "Rates per 1M tokens (models.json)."
						: width >= 70
							? "Token, message & cache usage across all local Pi sessions."
							: "Usage across all local sessions."
				}`,
				legend: this.footer(width, th),
			},
			body,
			edge,
		);
	}

	/** The last row of the box: a pending question, or the keys that are live right now. */
	private footer(width: number, th: { fg(c: string, t: string): string }): string {
		if (this.confirmStep === "reset") {
			return th.fg("accent", "Reset all usage statistics?") + " " + th.fg("muted", "sessions stay") + "  " + th.fg("text", "[y] Yes  [Esc] Cancel");
		}
		if (this.confirmStep === "undo") {
			return (
				th.fg("accent", "Undo the statistics reset?") +
				" " +
				th.fg("muted", "sessions stay") +
				"  " +
				th.fg("text", "[y] Yes  [Esc] Cancel")
			);
		}
		return legendUsage(width, { reset: true, undo: this.undoBaseline !== null, next: VIEW_LABELS[NEXT_VIEW[this.view]] });
	}

	/** Detail for the selected row: icon in `accent`, text and `·` dividers in `accentSoft`. */
	private selectedDetail(
		row: RowItem | undefined,
		accent: (t: string) => string,
		soft: (t: string) => string,
	): string {
		if (!row) return soft("No usage recorded yet.");
		const icon = `${accent("\uf4bc")} `;
		if (row.type === "price") {
			const title = `${row.providerName} · ${row.modelName}`;
			const parts = row.unpriced
				? ["unpriced", `↑${formatTokens(row.input)}`, `↓${formatTokens(row.output)}`]
				: [
						`in ${formatCost(row.rates!.in)}`,
						`out ${formatCost(row.rates!.out)}`,
						`cache read ${formatCost(row.rates!.cacheRead)}`,
						`cache write ${formatCost(row.rates!.cacheWrite)}`,
					];
			if (row.unpriced && row.estimatedCost > 0) parts.push(`${formatCost(row.estimatedCost)} est.`);
			const divider = soft(" · ");
			return `${icon}${soft(capitalize(title))}${divider}${soft(parts.join(" · "))}`;
		}
		const title =
			row.type === "model" ? `${row.providerName} · ${row.modelName}` : row.type === "project" ? row.projectName! : row.providerName;
		const parts = [
			`↑${formatTokens(row.input)}`,
			`↓${formatTokens(row.output)}`,
			`cache ${formatTokens(row.cacheRead)}`,
		];
		if (row.estimatedCost > 0) parts.push(`${formatCost(row.estimatedCost)} est.`);
		const divider = soft(" · ");
		return `${icon}${soft(capitalize(title))}${divider}${soft(parts.join(" · "))}`;
	}
}

/** Open the dashboard. Shared by `/usage` and `/arnative` → Usage, so the two cannot drift. */
export async function openUsage(ctx: ExtensionCommandContext): Promise<boolean> {
	if (!ctx.hasUI) return false;
	// The thinking level colors the box, so read it when the dashboard opens.
	const thinkingLevel = ctx.thinkingLevel;
	const back = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		return new UsageModalComponent(
			theme,
			(wantsBack) => done(wantsBack),
			() => tui.requestRender(),
			thinkingLevel,
		);
	});
	return back === true;
}

/** At most one Prometheus textfile write per minute, whatever the turn rate. */
const EXPORT_THROTTLE_MS = 60_000;
/** `PI_ARNATIVE_EXPORT=0` disables the export (a local file with no network, so it ships on). */
export const EXPORT_ENV = "PI_ARNATIVE_EXPORT";

/** The textfile a collector scrapes: `<agent dir>/arnative/usage.prom`. */
export function promFilePath(): string {
	return join(getAgentDir(), "arnative", "usage.prom");
}

const escapePromLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Render Prometheus exposition text for one summary (pure and deterministic). */
export function renderProm(summary: UsageSummary, now: number): string {
	const lines: string[] = [];
	const sample = (name: string, labels: [string, string][], value: number): string =>
		`${name}${labels.length > 0 ? `{${labels.map(([k, v]) => `${k}="${escapePromLabel(v)}"`).join(",")}}` : ""} ${value}`;
	const gauge = (name: string, help: string, value: number): void => {
		lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, sample(name, [], value));
	};

	const t = summary.totals;
	gauge("arnative_cost_billed_total", "Provider-billed cost in USD across all sessions (totalFromProvider; estimates never mixed in).", t.cost);
	gauge("arnative_cost_estimated_total", "Catalog-estimated cost in USD from models.json rates; never billed.", t.estimatedCost);
	gauge("arnative_cost_today", "Provider-billed cost in USD in the current UTC day (the day buckets).", t.today?.cost ?? 0);
	gauge("arnative_cost_30d", "Provider-billed cost in USD over the last 30 UTC days (the day buckets).", t.last30d?.cost ?? 0);
	lines.push("# HELP arnative_tokens_total Token usage by provider, model and kind.", "# TYPE arnative_tokens_total gauge");
	for (const p of summary.providers) {
		for (const m of p.models) {
			for (const [kind, value] of [["input", m.input], ["output", m.output], ["cache_read", m.cacheRead], ["cache_write", m.cacheWrite]] as const) {
				const labels: [string, string][] = [
					["provider", p.name],
					["model", m.name],
					["kind", kind],
				];
				lines.push(sample("arnative_tokens_total", labels, value));
			}
		}
	}
	gauge("arnative_sessions_total", "Distinct Pi session files scanned.", t.sessions);
	gauge("arnative_usage_last_change_timestamp_seconds", "Unix time this process last saw the usage data change (not the last scrape).", now / 1000);
	return `${lines.join("\n")}\n`;
}

/** Write the exposition atomically with Windows lock fallback. */
export function writePromFile(text: string, path: string, rename: (from: string, to: string) => void = renameSync): void {
	writeAtomicSync(path, text, rename);
}

let lastExportMs = 0;
let lastExportText = "";
let lastSummaryJson = "";
let lastScanAt = 0;

/** One throttled, diff-skipped, non-throwing Prometheus textfile export attempt. */
export function exportProm(now: number, path: string = promFilePath()): boolean {
	try {
		if (process.env[EXPORT_ENV] === "0") return false;
		if (now - lastExportMs < EXPORT_THROTTLE_MS) return false;
		lastExportMs = now;
		const summary = collectUsageSummary(true);
		const key = JSON.stringify(summary);
		if (key !== lastSummaryJson) {
			lastSummaryJson = key;
			lastScanAt = now;
		}
		const text = renderProm(summary, lastScanAt);
		if (text === lastExportText) return false;
		writePromFile(text, path);
		lastExportText = text;
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Arnative token & model usage dashboard",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await openUsage(ctx);
		},
	});
	pi.on("turn_end", () => {
		markUsageDirty();
		exportProm(Date.now());
	});
	pi.on("session_shutdown", () => {
		lastExportMs = 0;
		exportProm(Date.now());
	});
}

export const __test = {
	RANGE_LABELS,
};
