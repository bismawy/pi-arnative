/**
 * Arnative header box & horizontal tab system:
 * - Round-corner box: left column = the pi block mark (4x8, P accent / i soft) with
 *   "pi vX" under it; a vertical divider; then the info column = "Arnative vY
 *   · Welcome back, <User>", the tab menu, the tab data.
 * - Greeting = OS account name (first letter capitalized). The tab box has no label;
 *   its column dividers join the borders with ┬/┴ (full height).
 * - Interactive tab menu (mouse click): Model + Context/Skills/Extensions/Shortcut
 *   with item counts. Icon = accent, text = soft. The key cheatsheet lives in the
 *   Shortcut tab, not in a header line.
 * - Box divider '├────┤'. Active tab content is left-aligned, wrapped, soft.
 * - Hides pi's built-in stacked list in loadedResourcesContainer.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
	UserMessageComponent,
	getAgentDir,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { BoxTheme } from "../lib/box.ts";
import { renderBoxLines } from "../lib/box.ts";
import { getActiveTheme, setActiveTheme, stripAnsi, themeOf } from "../lib/ansi.ts";
import { capitalize, expandKeyName, modelDisplayParts } from "../lib/format.ts";
import { SHORTCUT_NEW_SESSION, SHORTCUT_NEXT_TAB, SHORTCUT_RELOAD } from "../lib/shortcuts.ts";
import { HEADER_PRESET_KEY as HEADER_PRESET_CONFIG_KEY, loadChoice, saveChoice } from "../lib/preset-store.ts";
import { formatTokens, getModelAllTimeUsage } from "../lib/usage-store.ts";

export type TabKey = "Model" | "Directory" | "Context" | "Skills" | "Extensions" | "Shortcut";

// Tab order for the next-tab shortcut and for the menu line.
export const TAB_ORDER: TabKey[] = ["Directory", "Model", "Context", "Skills", "Extensions", "Shortcut"];

export const SECTION_ICONS: Record<TabKey, string> = {
	Model: "\uf1b2",
	Directory: "\uf07b",
	Context: "\udb84\uddd7",
	Skills: "\uec21",
	Extensions: "\ueea8",
	Shortcut: "\uf11c", // nf-fa-keyboard_o
};

// nf-cod-warning, width 1 — prefixes a pi diagnostic block's compact header.
const DIAGNOSTIC_ICON = "\uea6c";

export type Themeish = { fg?(color: string, text: string): string; bg?(color: string, text: string): string } | null;

const MODEL_SNAPSHOT_KEY = Symbol.for("pi-arnative.currentModel");
const THINKING_SNAPSHOT_KEY = Symbol.for("pi-arnative.currentThinking");

// First theme color that the theme really defines
export function fgFirst(th: Themeish, names: string[], text: string): string {
	if (!th?.fg) return text;
	for (const name of names) {
		try {
			const out = th.fg(name, text);
			if (typeof out === "string" && out.includes(text)) return out;
		} catch {
			// try the next color name
		}
	}
	return text;
}

/**
 * Collapsed body of a pi startup section ("[Skills]\n  a, b"). pi 0.99 dropped
 * ExpandableText's own getCollapsedText/getExpandedText fields for a `build` callback
 * plus a `state` object, so both shapes are read here and older pi keeps working.
 * Returns null when the child is not an expandable section.
 */
export function sectionBodyOf(child: any): string | null {
	if (typeof child?.getCollapsedText === "function") return String(child.getCollapsedText());
	if (typeof child?.build === "function" && child?.state && typeof child.state === "object") {
		return String(child.build());
	}
	return null;
}

/** Text of a themed text line, whichever pi version built it (pi 0.99 defers it to `build`). */
export function themedTextOf(child: any): string {
	if (typeof child?.build === "function") return String(child.build());
	const direct = child?.text ?? child?.content;
	if (typeof direct === "string" && direct !== "") return direct;
	return typeof child?.getText === "function" ? String(child.getText()) : "";
}

export function sectionNameOf(text: string): "Context" | "Skills" | "Extensions" | null {
	const nl = text.indexOf("\n");
	const first = stripAnsi(nl === -1 ? text : text.slice(0, nl)).trim();
	const m = /^\[([A-Za-z]+)\]$/.exec(first);
	const name = m ? m[1] : null;
	if (name === "Context" || name === "Skills" || name === "Extensions") {
		return name;
	}
	return null;
}

export function packageNameOf(label: string): string | null {
	const base = label.split(":")[0].trim();
	if (base === "") return null;
	const at = base.lastIndexOf("@");
	if (at > 0 && /^\d/.test(base.slice(at + 1))) return null;
	return /^[\w.@/-]+$/.test(base) ? base : null;
}

/**
 * OS account name of whoever is running pi, for the header greeting. Falls back to the
 * usual env vars, then to a neutral word so the line is never empty.
 */
export function deviceUser(): string {
	try {
		const u = userInfo().username;
		if (u) return u;
	} catch {
		/* no passwd entry (some containers) — fall through to env */
	}
	const u = process.env.USER ?? process.env.USERNAME ?? "";
	return u || "there";
}

const versionCache = new Map<string, string | null>();

export function readVersion(dir: string): string | null {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : null;
	} catch {
		return null;
	}
}

export function installedVersion(
	label: string,
	root = join(getAgentDir(), "npm", "node_modules"),
	gitRoot = join(getAgentDir(), "git"),
): string | null {
	const name = packageNameOf(label);
	if (!name) return null;
	if (versionCache.has(name)) return versionCache.get(name) ?? null;
	let version = readVersion(join(root, name));
	if (!version && name.includes("/")) {
		try {
			for (const host of readdirSync(gitRoot)) {
				version = readVersion(join(gitRoot, host, name));
				if (version) break;
			}
		} catch {
			version = null;
		}
	}
	versionCache.set(name, version);
	return version;
}

// Arnative build actually running: package.json one level above this extension file.
// Reading the module's own package beats reading the npm-installed copy, which lags
// behind whenever the local clone (or a hand-copied extensions/) is what pi loaded.
const ARNATIVE_VERSION = readVersion(fileURLToPath(new URL("..", import.meta.url)));

export function extractItemsFromBody(body: string, isExtensions = false): string[] {
	const plain = stripAnsi(body).trim();
	if (!plain) return [];
	const lines = plain.split("\n").map((l) => l.trim()).filter(Boolean);
	const items: string[] = [];
	for (const line of lines) {
		if (line.includes(", ")) {
			items.push(...line.split(", ").map((s) => s.trim()).filter(Boolean));
		} else {
			items.push(line);
		}
	}
	if (!isExtensions) return items;
	return items.map((item) => {
		const colon = item.indexOf(":");
		const name = (colon === -1 ? item : item.slice(0, colon)).trim();
		const ver = installedVersion(name);
		if (!ver) return item;
		const at = colon === -1 ? item.length : colon;
		return item.slice(0, at) + `@${ver}` + item.slice(at);
	});
}

// Cheatsheet for the Shortcut tab. Mirrors README "Shortcuts" plus the bindings the
// extensions themselves own (footer.ts). Kept as plain text so the data line can wrap it.
export const SHORTCUTS: string[] = [
	"[Esc] Interrupt",
	"[Ctrl+c/d] Exit",
	"[/] Commands",
	"[!] Bash",
	"[Ctrl+o] More/expand",
	`[${SHORTCUT_NEXT_TAB.label}] Next tab`,
	`[${SHORTCUT_NEW_SESSION.label}] New`,
	`[${SHORTCUT_RELOAD.label}] Reload`,
];

export function wrapCommaItems(items: string[], maxWidth: number): string[] {
	return wrapTokens(items, maxWidth, ", ", ",");
}

export function wrapTokens(items: string[], maxWidth: number, sep = "  ", trailing = ""): string[] {
	const lines: string[] = [];
	let cur = "";
	for (const item of items) {
		if (!cur) {
			cur = item;
		} else if (visibleWidth(cur) + visibleWidth(sep) + visibleWidth(item) <= maxWidth) {
			cur += sep + item;
		} else {
			lines.push(cur + trailing);
			cur = item;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}

// Full path, hard-wrapped at "/" so the Directory tab never truncates it
// (a single long segment is sliced as a last resort).
export function wrapPath(path: string, maxWidth: number): string[] {
	const p = (path || "").replace(/\\/g, "/");
	if (!p) return [p];
	if (maxWidth < 1) return [p];
	const abs = p.startsWith("/");
	const segs = p.replace(/^\/+/, "").split("/").filter(Boolean);
	const lines: string[] = [];
	let cur = abs ? "/" : "";
	for (const seg of segs) {
		const tok = cur === "/" ? seg : abs || cur ? `/${seg}` : seg;
		if (visibleWidth(cur) + visibleWidth(tok) <= maxWidth) {
			cur += tok;
			continue;
		}
		if (cur) lines.push(cur);
		if (visibleWidth(tok) <= maxWidth) {
			cur = abs ? `/${seg}` : tok;
			continue;
		}
		let rest = seg;
		while (visibleWidth(rest) > maxWidth) {
			lines.push(rest.slice(0, maxWidth));
			rest = rest.slice(maxWidth);
		}
		cur = rest;
	}
	if (cur) lines.push(cur);
	return lines.length > 0 ? lines : [p];
}

export function centerLine(text: string, width: number, side = "│"): string {
	const sideW = visibleWidth(side);
	const innerW = Math.max(0, width - sideW * 2);
	const textW = visibleWidth(text);
	if (textW >= innerW) {
		return side + truncateToWidth(text, innerW) + side;
	}
	const left = Math.floor((innerW - textW) / 2);
	const right = innerW - textW - left;
	return side + " ".repeat(left) + text + " ".repeat(right) + side;
}

// pi.dev block mark: the logo grid at terminal aspect (2 chars per column), 4 lines.
// P (the salmon/blue structure, columns 0-2) in the theme accent; i (the yellow
// bar, column 3) in the theme soft — same P/i split as the old wordmark.
export function buildLogoLines(th: Themeish): string[] {
	const a = (s: string) => fgFirst(th, ["accent"], s);
	const t = (s: string) => fgFirst(th, ["accentSoft", "text"], s);
	return [
		`${a("██████")}  `,
		`${a("██  ██")}  `,
		`${a("████")}  ${t("██")}`,
		`${a("██")}    ${t("██")}`,
	];
}


// Singleton store for loaded resources
const STORE_KEY = Symbol.for("pi-arnative.resourceStore");
export const tabStore: Map<TabKey, string[]> =
	(globalThis as Record<symbol, Map<TabKey, string[]>>)[STORE_KEY] ??
	new Map<TabKey, string[]>([
		["Model", []],
		["Directory", []],
		["Context", []],
		["Skills", []],
		["Extensions", []],
	]);
(globalThis as Record<symbol, Map<TabKey, string[]>>)[STORE_KEY] = tabStore;

// Header preset chosen through `/arnative headers`. "Arnative (Full)" = this extension's
// header; "Pi (system)" = pi's built-in header. The picker lives in arnative.ts, so the
// choice is shared through globalThis like the other cross-module state.
// Listed built-in-first: the `(Full)` suffix is rendered dim, so the plain row reads cleaner on top.
export const HEADER_PRESETS = ["Pi (system)", "Arnative (Full)"] as const;
export type HeaderPreset = (typeof HEADER_PRESETS)[number];
export const DEFAULT_HEADER_PRESET: HeaderPreset = "Arnative (Full)";
const HEADER_PRESET_KEY = Symbol.for("pi-arnative.headerPreset");

export function activeHeaderPreset(): HeaderPreset {
	const stored = (globalThis as Record<symbol, unknown>)[HEADER_PRESET_KEY] ?? loadChoice(HEADER_PRESET_CONFIG_KEY, HEADER_PRESETS);
	return HEADER_PRESETS.includes(stored as HeaderPreset) ? (stored as HeaderPreset) : DEFAULT_HEADER_PRESET;
}

/** Hand the header slot to the active preset: arnative's box, or pi's built-in ("Pi (system)"). */
export function applyHeaderPreset(ctx: ExtensionContext): void {
	if (activeHeaderPreset() === "Pi (system)") {
		ctx.ui?.setHeader?.(undefined);
	} else {
		ctx.ui?.setHeader?.((tui, theme) => new ArnativeHeader(tui, theme, ctx));
	}
}

/** Select a preset and apply it immediately (real-time: the header swaps on the spot). */
export function setHeaderPreset(name: HeaderPreset, ctx: ExtensionContext): void {
	(globalThis as Record<symbol, unknown>)[HEADER_PRESET_KEY] = name;
	saveChoice(HEADER_PRESET_CONFIG_KEY, name);
	applyHeaderPreset(ctx);
}

// Counts are captured from pi's loaded-resource listing, which pi skips entirely under
// `quietStartup: true | "header"` (docs/settings.md). Without the listing, [Context]/
// [Skills]/[Extensions] are never built, so the store can only answer "unknown" — not 0.
// That state is tracked globally because the header renders long after `session_start`.
let countsKnown = true;
export function resourcesListingShown(current?: boolean): boolean {
	if (current !== undefined) countsKnown = current;
	return countsKnown;
}

// The installed header instance. globalThis-backed because `/reload` re-imports the
// extension modules and arnative.ts imports this file, so two copies can coexist.
const HEADER_INSTANCE_KEY = Symbol.for("pi-arnative.headerInstance");
function headerInstance(): ArnativeHeader | null {
	return (globalThis as Record<symbol, ArnativeHeader | undefined>)[HEADER_INSTANCE_KEY] ?? null;
}
function setHeaderInstance(instance: ArnativeHeader | null): void {
	if (instance) (globalThis as Record<symbol, ArnativeHeader>)[HEADER_INSTANCE_KEY] = instance;
	else delete (globalThis as Record<symbol, ArnativeHeader | undefined>)[HEADER_INSTANCE_KEY];
}

// Model name formatted exactly like in the footer: Gemini 3.8 Flash (Antigravity), Deepseek V4.1 Flash (Yarz), etc.
export function formatModelDisplayName(model?: { id?: string; name?: string; provider?: string }): string {
	const { name, provider } = modelDisplayParts(model);
	return provider ? `${name} (${provider})` : name;
}

// Full working directory for the Directory tab. ctx.cwd is authoritative; the
// snapshot survives header re-creation when ctx is missing.
const CWD_SNAPSHOT_KEY = Symbol.for("pi-arnative.lastCwd");
export function getCwd(ctx?: { cwd?: string }): string {
	return ctx?.cwd || (globalThis as Record<symbol, any>)[CWD_SNAPSHOT_KEY] || "";
}

export class ArnativeHeader implements Component {
	public activeTab: TabKey = "Directory";
	private renderedTabLineY = -1;
	private renderedTabRegions: Array<{ key: TabKey; startX: number; endX: number }> = [];

	public tui: TUI;
	public themeProxy: Themeish;
	public ctx?: ExtensionContext;

	constructor(tui: TUI, themeProxy: Themeish, ctx?: ExtensionContext) {
		this.tui = tui;
		this.themeProxy = themeProxy;
		this.ctx = ctx;
		setHeaderInstance(this);
	}

	invalidate(): void {}

	dispose(): void {
		if (headerInstance() === this) {
			setHeaderInstance(null);
		}
	}

	setExpanded(_expanded: boolean): void {}

	getTabsData(width: number): Array<{ key: TabKey; name: string; icon: string; count: number; label: string }> {
		const modelObj = this.ctx?.model ?? (globalThis as Record<symbol, any>)[MODEL_SNAPSHOT_KEY];
		// Tab row stays compact: the Directory tab shows just its name, the full path
		// lives in the content line below.
		const dirLabel = "Directory";
		const fullModelName = formatModelDisplayName(modelObj);
		// Drop bracketed details from the tail of the name ("... Free (1M) [OpenCode] (Freeflow)"
		// -> "Space Bunny Free"); the details still show in the Model tab data line.
		let modelLabel = `Model [${fullModelName.replace(/(\s*\([^()]*\)|\s*\[[^[\]]*\])+$/, "").trim()}]`;
		// Responsive on medium screens: drop the provider when columns < 112
		if (width < 112 && modelLabel.includes(" (")) {
			modelLabel = `Model [${fullModelName.slice(0, fullModelName.indexOf(" (")).trim()}]`;
		}
		// Below 88 columns: shorten the model name
		if (width < 88 && modelLabel.length > 18) {
			modelLabel = `Model [${modelLabel.slice(7, 18).trim()}…]`;
		}

		return [
			{ key: "Directory", name: "Directory", icon: SECTION_ICONS.Directory, count: 0, label: dirLabel },
			{ key: "Model", name: "Model", icon: SECTION_ICONS.Model, count: 0, label: modelLabel },
			{
				key: "Context",
				name: "Context",
				icon: SECTION_ICONS.Context,
				count: tabStore.get("Context")?.length ?? 0,
				label: countsKnown ? `Context [${tabStore.get("Context")?.length ?? 0}]` : "Context [—]",
			},
			{
				key: "Skills",
				name: "Skills",
				icon: SECTION_ICONS.Skills,
				count: tabStore.get("Skills")?.length ?? 0,
				label: countsKnown ? `Skills [${tabStore.get("Skills")?.length ?? 0}]` : "Skills [—]",
			},
			{
				key: "Extensions",
				name: "Extensions",
				icon: SECTION_ICONS.Extensions,
				count: tabStore.get("Extensions")?.length ?? 0,
				label: countsKnown ? `Extensions [${tabStore.get("Extensions")?.length ?? 0}]` : "Extensions [—]",
			},
			{
				key: "Shortcut",
				name: "Shortcut",
				icon: SECTION_ICONS.Shortcut,
				count: SHORTCUTS.length,
				label: `Shortcut [${SHORTCUTS.length}]`,
			},
		];
	}

	// Shortcuts are registered through pi.registerShortcut (the header is not a keyboard input target).

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event?.type !== "click" || event?.button !== "left") return undefined;
		if (event.y === this.renderedTabLineY && this.renderedTabRegions.length > 0) {
			let selected: TabKey | null = null;
			for (const r of this.renderedTabRegions) {
				if (event.x >= r.startX && event.x <= r.endX) {
					selected = r.key;
					break;
				}
			}
			if (!selected) {
				let minDist = Infinity;
				for (const r of this.renderedTabRegions) {
					const dist = Math.min(Math.abs(event.x - r.startX), Math.abs(event.x - r.endX));
					if (dist < minDist) {
						minDist = dist;
						selected = r.key;
					}
				}
			}
			if (selected && selected !== this.activeTab) {
				this.activeTab = selected;
				this.tui?.requestRender?.();
				return { handled: true, render: true };
			}
		}
		return undefined;
	}

	render(width: number): string[] {
		if (width < 36) {
			return [centerLine(`pi v${VERSION}`, width)];
		}
		const th = this.themeProxy || getActiveTheme<Themeish>();
		const side = fgFirst(th, ["dim"], "│");

		const infoLines: string[] = [];
		const brand = (name: string) => fgFirst(th, ["accent", "accentSoft"], `\x1b[1m${name}\x1b[22m`);
		const dim = (text: string) => fgFirst(th, ["dim"], text);

		// Left column: the mark with the pi version under it (no gap). The column is as
		// wide as the widest of them.
		const versionStr = VERSION || "0.87.1";
		const leftLines = [
			...buildLogoLines(th),
			`${brand("pi")} ${dim(`v${versionStr}`)}`,
		];
		const colW = Math.max(...leftLines.map((l) => visibleWidth(l)));
		const padLeft = (text: string) => text + " ".repeat(Math.max(0, colW - visibleWidth(text)));
		// Columns left for info: width - "│ " - left column - " │ " - info - " │".
		const infoW = Math.max(8, width - colW - 7);
		const infoLine = (text: string): string => {
			const t = truncateToWidth(text, infoW);
			return t + " ".repeat(infoW - visibleWidth(t));
		};
		// Inner box: the tab menu line is framed, content is (infoW - 2) columns.
		const innerW = Math.max(1, infoW - 2);

		// The column divider runs the full height: it joins the top/bottom borders with
		// ┬/┴ so there is no gap between the split and the frame.
		const jx = colW + 3;
		const border = (l: string, mid: string, r: string) =>
			fgFirst(th, ["dim"], `${l}${"─".repeat(jx - 1)}${mid}${"─".repeat(Math.max(0, width - jx - 2))}${r}`);
		const out: string[] = [border("╭", "┬", "╮")];

		// 1. Brand + greeting on one line ("Arnative vX · Welcome back, <User>"; the username
		// is capitalized), then a blank line before the tab box.
		const arnVer = ARNATIVE_VERSION ? ` ${dim(`v${ARNATIVE_VERSION}`)}` : "";
		infoLines.push(`${brand("Arnative")}${arnVer}${dim(" · ")}${dim("Welcome back,")} ${brand(capitalize(deviceUser()))}`);

		// 2. Tab menu: icon = accent, text = soft (bold when active)
		const tabs = this.getTabsData(width);
		const sepTabPlain = " │ ";
		const sepTab = fgFirst(th, ["dim"], sepTabPlain);

		const tabParts: Array<{ key: TabKey; plain: string; formatted: string }> = [];
		const makeTabPart = (t: { key: TabKey; icon: string; label: string }) => {
			const { label } = t;
			const plain = `${t.icon} ${label}`;
			const isActive = t.key === this.activeTab;
			const iconStyled = isActive ? fgFirst(th, ["accent"], t.icon) : fgFirst(th, ["dim"], t.icon);
			const labelStyled = isActive
				? fgFirst(th, ["accentSoft", "text"], `\x1b[1m${label}\x1b[22m`)
				: fgFirst(th, ["dim"], label);
			return { key: t.key, plain, formatted: `${iconStyled} ${labelStyled}` };
		};
		for (const t of tabs) tabParts.push(makeTabPart(t));

		// Tabs that don't fit on narrow screens are dropped from the right (the active tab always stays).
		const kept: typeof tabParts = [];
		let usedWidth = 0;
		for (const t of tabParts) {
			const w = visibleWidth(t.plain) + (kept.length > 0 ? visibleWidth(sepTabPlain) : 0);
			if (kept.length === 0 || usedWidth + w <= innerW) {
				kept.push(t);
				usedWidth += w;
			}
		}
		this.renderedTabRegions = [];
		// The tab row has its own left border + a leading space before the first tab.
		let curX = colW + 7;
		for (const t of kept) {
			const w = visibleWidth(t.plain);
			this.renderedTabRegions.push({ key: t.key, startX: curX, endX: curX + w - 1 });
			curX += w + visibleWidth(sepTabPlain);
		}
		// The tab box is as wide as its content, not as wide as the info column.
		const tabText = ` ${kept.map((t) => t.formatted).join(sepTab)}`;
		const tabInnerW = Math.min(innerW, visibleWidth(tabText) + 1);
		const tabRow = (text: string): string => {
			const t = truncateToWidth(text, tabInnerW);
			return `${side}${t}${" ".repeat(tabInnerW - visibleWidth(t))}${side}`;
		};
		// Columns of the " │ " separators inside the tab row, so the borders can join them
		// with ┬/┴ and every divider runs the full height of the box.
		const tabSeps: number[] = [];
		for (let i = 0, acc = 1; i < kept.length; i++) {
			acc += visibleWidth(kept[i]!.plain);
			if (i < kept.length - 1) {
				tabSeps.push(acc + 1);
				acc += 3;
			}
		}
		const tabRule = (l: string, r: string, junction: string): string => {
			const inner = new Array<string>(tabInnerW).fill("─");
			for (const s of tabSeps) if (s >= 0 && s < tabInnerW) inner[s] = junction;
			return fgFirst(th, ["dim"], `${l}${inner.join("")}${r}`);
		};
		infoLines.push(tabRule("╭", "╮", "┬"));
		// One space from the left border, then " │ " between tabs.
		infoLines.push(tabRow(tabText));
		// Tab line = top border (index 0) + the infoLines above + this line.
		this.renderedTabLineY = infoLines.length;
		infoLines.push(tabRule("╰", "╯", "┴"));

		// 3. Active tab data (left-aligned, neatly wrapped, soft)
		let activeItems: string[] = [];
		if (this.activeTab === "Model") {
			const modelObj = this.ctx?.model ?? (globalThis as Record<symbol, any>)[MODEL_SNAPSHOT_KEY];
			const fullName = formatModelDisplayName(modelObj);
			const thLvl = this.ctx?.thinkingLevel ?? (globalThis as Record<symbol, any>)[THINKING_SNAPSHOT_KEY];
			const thinkLevel = thLvl && thLvl !== "off" ? capitalize(thLvl) : "Off";
			const sep = fgFirst(th, ["dim"], " · ");
			// Model name in soft, its "(Provider)" tail dim.
			const provSuffix = fullName.match(/(\s*\([^()]*\))$/)?.[1] ?? "";
			const nameMain = provSuffix ? fullName.slice(0, -provSuffix.length) : fullName;
			let line = `${fgFirst(th, ["accentSoft", "text"], nameMain)}${provSuffix ? fgFirst(th, ["dim"], provSuffix) : ""}${sep}${fgFirst(th, ["accentSoft", "text"], `Thinking: ${thinkLevel}`)}`;

			// All-time usage of that model (same as /usage): ↑... ↓...  ...
			const usage = getModelAllTimeUsage(modelObj?.id);
			const tokenParts: string[] = [];
			if (usage.input > 0) {
				tokenParts.push(`${fgFirst(th, ["accent"], "↑")}${fgFirst(th, ["accentSoft", "text"], formatTokens(usage.input))}`);
			}
			if (usage.output > 0) {
				tokenParts.push(`${fgFirst(th, ["accent"], "↓")}${fgFirst(th, ["accentSoft", "text"], formatTokens(usage.output))}`);
			}
			if (usage.cacheRead > 0) {
				tokenParts.push(`${fgFirst(th, ["accent"], "\uf49b ")}${fgFirst(th, ["accentSoft", "text"], formatTokens(usage.cacheRead))}`);
			}
			if (tokenParts.length > 0) {
				line += `${sep}${tokenParts.join(" ")}`;
			}

			activeItems = [line];
		} else {
			activeItems = tabStore.get(this.activeTab) ?? [];
		}

		if (this.activeTab === "Directory") {
			for (const line of wrapPath(getCwd(this.ctx), infoW)) {
				infoLines.push(fgFirst(th, ["accentSoft", "text"], line));
			}
		} else if (this.activeTab === "Shortcut") {
			for (const line of wrapTokens(SHORTCUTS, infoW)) {
				infoLines.push(fgFirst(th, ["accentSoft", "text"], line));
			}
		} else if (activeItems.length === 0) {
			infoLines.push(
				fgFirst(th, ["dim"], countsKnown ? "(empty)" : "(not tracked — quietStartup hides the listing)"),
			);
		} else if (this.activeTab === "Model") {
			// The Model tab already carries soft styling + a dim separator
			infoLines.push(...activeItems);
		} else {
			for (const line of wrapCommaItems(activeItems, infoW)) {
				// Point 5: selected menu data uses soft only
				infoLines.push(fgFirst(th, ["accentSoft", "text"], line));
			}
		}

		// Compose lines: left column (mark + brand), vertical divider, left-aligned info.
		// Whichever column is shorter is padded with blanks.
		const rows = Math.max(leftLines.length, infoLines.length);
		for (let i = 0; i < rows; i++) {
			out.push(`${side} ${padLeft(leftLines[i] ?? "")} ${side} ${infoLine(infoLines[i] ?? "")} ${side}`);
		}

		// Bottom border
		out.push(border("╰", "┴", "╯"));

		return out;
	}
}

// Arnative box for pi's `[Extension issues]` diagnostic: exactly two rows, the title
// (warning icon + section name, brackets dropped, + expand hint) over the extension's
// source path. pi's extra diagnostic lines are dropped — the expand hint stands in for
// them. Uses only `warning` + `dim`, both defined by every pi theme, so it draws the
// same under any theme; `rows` is pi's own render output, row 0 being the title.
export function extensionIssuesLines(th: BoxTheme | null, width: number, rows: string[], hint: string): string[] {
	const paint = (color: string, text: string) => {
		try {
			return th?.fg ? th.fg(color, text) : text;
		} catch {
			return text;
		}
	};
	// Rows are plain text: ANSI inside would break the width math of renderBoxLines.
	const title = stripAnsi(rows[0] ?? "").trim().replace(/^\[(.+)\]$/, "$1");
	const hintPlain = stripAnsi(hint).trim();
	const detail = stripAnsi(rows[1] ?? "").trim();
	const header = `${paint("warning", `${DIAGNOSTIC_ICON} ${title}`)}${hintPlain ? `  ${paint("dim", hintPlain)}` : ""}`;
	return renderBoxLines(th, width, [header, detail], undefined, "warning");
}

// Hooks the shared `app.tools.expand` key: `ctrl+o to expand` -> `[ctrl+o to expand]`.
const wrapHint = (key: string): string => `[${key} to expand]`;

// Intercept loadedResourcesContainer: capture data for the tabs and hide pi's own display
const SECTION_HEADER_KEY = Symbol.for("pi-arnative.sectionHeadersRewritten");
if (UserMessageComponent?.prototype && !(globalThis as Record<symbol, boolean>)[SECTION_HEADER_KEY]) {
	(globalThis as Record<symbol, boolean>)[SECTION_HEADER_KEY] = true;
	const containerProto = Object.getPrototypeOf(UserMessageComponent.prototype) as {
		addChild?: (child: unknown) => unknown;
	};
	if (typeof containerProto?.addChild === "function") {
		const origAddChild = containerProto.addChild;
		containerProto.addChild = function (child: any): unknown {
			// "Pi (system)" preset = pi's own header, so leave pi's startup list untouched.
			if (activeHeaderPreset() === "Pi (system)") return origAddChild.call(this, child);
			try {
				const body = sectionBodyOf(child);
				const sectionName = body === null ? null : sectionNameOf(body);
				const isSection =
					body !== null &&
					typeof child.setText === "function" &&
					typeof child.render === "function" &&
					(sectionName === null ? false : SECTION_ICONS[sectionName] !== undefined);

				if (isSection && sectionName && body !== null) {
					// Mark this container as the loadedResourcesContainer
					(this as Record<string, unknown>)._isLoadedResourcesContainer = true;

					countsKnown = true;
					const rawBody = body.split("\n").slice(1).join("\n");
					const items = extractItemsFromBody(rawBody, sectionName === "Extensions");
					tabStore.set(sectionName, items);

					// Hide this child from the built-in display so it does not stack under the header
					child.render = () => [];

					// Re-render the header when it is already installed
					const hdr = headerInstance();
					if (hdr?.tui) {
						hdr.tui.requestRender();
					}
				} else if ((this as Record<string, unknown>)._isLoadedResourcesContainer) {
					// pi core's "[Extension issues]" -> wrap in an arnative box.
					const text = themedTextOf(child);
					if (text.includes("[Extension issues]") && typeof child.render === "function") {
						const origRender = child.render.bind(child);
						// Shortcut hint only when the shortcut registry is reachable; otherwise just the
						// two-line compact block.
						const rawHint = wrapHint(expandKeyName());
						child.render = (w: number) =>
							extensionIssuesLines(getActiveTheme<BoxTheme>(), w, origRender(w), rawHint);
						return origAddChild.call(this, child);
					}
					// Any other element inside loadedResourcesContainer (e.g. Spacer) is hidden too
					if (child && typeof child.render === "function") {
						child.render = () => [];
					}
				}
			} catch {
				// fail-safe
			}
			return origAddChild.call(this, child);
		};
	}
}

export default function (pi: ExtensionAPI) {
	// Next header tab — every platform variant of the shortcut (lib/shortcuts.ts).
	const nextTab = async () => {
		const hdr = headerInstance();
		if (!hdr) return;
		const order = TAB_ORDER;
		hdr.activeTab = order[(order.indexOf(hdr.activeTab) + 1) % order.length]!;
		hdr.tui?.requestRender?.();
	};
	for (const key of SHORTCUT_NEXT_TAB.keys) {
		pi.registerShortcut(key, { description: "Next header tab", handler: nextTab });
	}

	// pi renders the resource listing after this event, so a session that starts
	// with it disabled leaves the store empty. That is "not tracked", not "none".
	pi.on("session_start", async (_event, ctx) => {
		let quiet: boolean | "header" = false;
		try {
			quiet = pi.getSettings().quietStartup ?? false;
		} catch {
			/* older pi without getSettings: keep pi's default (listing shown) */
		}
		resourcesListingShown(quiet === false);
		for (const key of ["Context", "Skills", "Extensions"] as const) tabStore.set(key, []);
		// A context without a theme (project-trust prompt) must not drop the one we have.
		const th = themeOf<Themeish>(ctx);
		if (th) setActiveTheme(th);
		// Register the header for the active preset
		applyHeaderPreset(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		(globalThis as Record<symbol, any>)[MODEL_SNAPSHOT_KEY] = ctx.model;
		(globalThis as Record<symbol, any>)[THINKING_SNAPSHOT_KEY] = ctx.thinkingLevel;
		if (ctx.cwd) (globalThis as Record<symbol, any>)[CWD_SNAPSHOT_KEY] = ctx.cwd;
	});

	pi.on("turn_end", async () => {
		// Usage is re-read at render time (collectUsageSummary caches 5s), so poking a render is enough.
		const hdr = headerInstance();
		if (hdr?.tui) {
			hdr.tui.requestRender();
		}
	});
}
