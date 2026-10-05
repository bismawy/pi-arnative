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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir, userInfo } from "node:os";
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
import { renderBoxLines } from "../lib/box.ts";
import { getActiveTheme, setActiveTheme, stripAnsi, themeOf } from "../lib/ansi.ts";
import { assert, isMain } from "../lib/check.ts";
import { capitalize, markedLabels, modelDisplayParts } from "../lib/format.ts";
import { SHORTCUT_NEW_SESSION, SHORTCUT_NEXT_TAB, SHORTCUT_RELOAD } from "../lib/shortcuts.ts";
import { HEADER_PRESET_KEY as HEADER_PRESET_CONFIG_KEY, loadChoice, resetPresetCache, saveChoice } from "../lib/preset-store.ts";
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
						child.render = (w: number) => renderBoxLines(getActiveTheme<Themeish>(), w, origRender(w), undefined, "warning");
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

// Self-check: `node extensions/section-headers.ts`
if (isMain(import.meta.url)) {

	assert(sectionNameOf("\x1b[33m[Skills]\x1b[39m\n  a, b") === "Skills", "header [Skills] detected");
	assert(sectionNameOf("pi v0.87.1") === null, "non-section text is not detected");

	// Header presets: Arnative (Full) is the default; Pi (system) hands the header slot back to pi.
	assert(DEFAULT_HEADER_PRESET === "Arnative (Full)" && HEADER_PRESETS.length === 2, "Arnative (Full) is the default header preset");
	assert(HEADER_PRESETS.join(" | ") === "Pi (system) | Arnative (Full)", "built-in preset is listed first");
	assert(markedLabels(HEADER_PRESETS, "Arnative (Full)").join(" | ") === "  Pi (system) | ● Arnative (Full)", "preset labels mark the active one");
	// Persisting a preset writes a config file: point it at a fixture so the real agent dir stays clean.
	const presetFixture = mkdtempSync(join(tmpdir(), "arnative-hdr-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = presetFixture;
	resetPresetCache();
	let installed: unknown = "untouched";
	const presetCtx: any = { ui: { setHeader: (factory: unknown) => { installed = factory; } } };
	setHeaderPreset("Pi (system)", presetCtx);
	assert(installed === undefined && activeHeaderPreset() === "Pi (system)", "Pi (system) clears the custom header");
	setHeaderPreset("Arnative (Full)", presetCtx);
	assert(typeof installed === "function" && activeHeaderPreset() === "Arnative (Full)", "Arnative (Full) installs the header factory");
	// Persist a NON-default value: asserting the default survives proves nothing.
	setHeaderPreset("Pi (system)", presetCtx);
	assert(loadChoice(HEADER_PRESET_CONFIG_KEY, HEADER_PRESETS) === "Pi (system)", "the header preset is persisted to disk");
	delete (globalThis as Record<symbol, unknown>)[HEADER_PRESET_KEY];
	resetPresetCache();
	assert(activeHeaderPreset() === "Pi (system)", "a restart reads the non-default preset back from disk");
	rmSync(presetFixture, { recursive: true, force: true });
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	resetPresetCache();

	// Parsing & wrapping
	assert(extractItemsFromBody("  a, b, c").length === 3, "extractItemsFromBody splits 3 comma items");
	assert(extractItemsFromBody("  x\n  y\n  z").length === 3, "extractItemsFromBody returns 3 lines");

	// Directory path wrapping: never truncated, always the full path
	const wp = wrapPath("/run/media/bisma/DATA/Pi/pi-arnative", 20);
	assert(wp.join("") === "/run/media/bisma/DATA/Pi/pi-arnative", "wrapPath drops no segment");
	assert(wp.every((l) => visibleWidth(l) <= 20), "wrapPath respects the width");
	assert(wrapPath("D:\\Pi\\pi-arnative", 80).join("") === "D:/Pi/pi-arnative", "wrapPath normalizes backslashes");
	assert(wrapPath("/a/very-long-segment-name", 6).every((l) => visibleWidth(l) <= 6), "long segment is sliced");

	const wrapTest = wrapCommaItems(["item1", "item2", "item3", "item4"], 15);
	assert(wrapTest.length >= 2, "wrapCommaItems wraps into lines");
	assert(visibleWidth(wrapTest[0]!) <= 15, "wrapped line width within the limit");

	const cLine = centerLine("test", 20);
	assert(visibleWidth(cLine) === 20, "centerLine is exactly 20 columns");
	assert(cLine.startsWith("│") && cLine.endsWith("│"), "centerLine starts and ends with │");

	// Model name formatting
	assert(
		formatModelDisplayName({ name: "Gemini 3.8 Flash", provider: "antigravity" }) ===
			"Gemini 3.8 Flash (Antigravity)",
		"formatModelDisplayName with name and provider",
	);
	assert(
		formatModelDisplayName({ id: "deepseek-v4.1-flash", provider: "yarz" }) ===
			"Deepseek V4.1 Flash (Yarz)",
		"formatModelDisplayName converts id to titlecase",
	);

	// Package & version resolver
	assert(packageNameOf("@bismawy/pi-agentrouter") === "@bismawy/pi-agentrouter", "plain npm label");
	assert(packageNameOf("footer.ts") === "footer.ts", "local label");

	const gitTmp = mkdtempSync(join(tmpdir(), "pi-ver-"));
	mkdirSync(join(gitTmp, "git", "github.com", "test/arnative"), { recursive: true });
	writeFileSync(join(gitTmp, "git", "github.com", "test/arnative", "package.json"), JSON.stringify({ version: "9.9.9" }));
	assert(installedVersion("test/arnative", join(gitTmp, "npm"), join(gitTmp, "git")) === "9.9.9", "version from the git clone");
	rmSync(gitTmp, { recursive: true, force: true });

	// ArnativeHeader component & mouse tab click
	tabStore.set("Context", ["AGENTS.md"]);
	tabStore.set("Skills", ["agents-sdk", "cloudflare"]);
	tabStore.set("Extensions", ["@bismawy/pi-agentrouter@1.6.1", "footer.ts"]);

	let renderRequested = false;
	const fakeTui: any = {
		requestRender: () => {
			renderRequested = true;
		},
	};
	const fakeCtx: any = {
		model: { name: "Gemini 3.8 Flash", provider: "antigravity" },
		thinkingLevel: "low",
		cwd: "/run/media/bisma/DATA/Pi/pi-arnative",
	};

	// Only "dim" is colored, so the box line colors can be asserted.
	const ansiTheme = { fg: (c: string, t: string) => (c === "dim" ? `\x1b[2m${t}\x1b[22m` : t) };

	// Counts come from pi's loaded-resource listing. With `quietStartup: true | "header"`
	// pi skips that listing, so the counts are unknown — shown as "—", never a misleading 0.
	resourcesListingShown(false);
	tabStore.set("Context", []);
	tabStore.set("Skills", []);
	tabStore.set("Extensions", []);
	const hdrQuiet = new ArnativeHeader(fakeTui, ansiTheme, fakeCtx);
	assert(hdrQuiet.getTabsData(120).map((t) => t.label).join("|").includes("Skills [—]"), "hidden listing: counts render as —, not 0");
	hdrQuiet.activeTab = "Skills";
	assert(
		hdrQuiet.render(120).some((l) => stripAnsi(l).includes("(not tracked")),
		"hidden listing: empty tab explains itself instead of a bare (empty)",
	);
	resourcesListingShown(true);
	assert(new ArnativeHeader(fakeTui, ansiTheme, fakeCtx).getTabsData(120).some((t) => t.label === "Skills [0]"), "shown listing: 0 is a real count again");
	tabStore.set("Context", ["AGENTS.md"]);
	tabStore.set("Skills", ["agents-sdk", "cloudflare"]);
	tabStore.set("Extensions", ["@bismawy/pi-agentrouter@1.6.1", "footer.ts"]);
	const hdr = new ArnativeHeader(fakeTui, ansiTheme, fakeCtx);
	assert(hdr.activeTab === "Directory", "default tab is Directory");

	// Default view: the working directory path, shown on open
	const linesDefault = hdr.render(100);
	assert(stripAnsi(linesDefault[5]!).includes("/run/media/bisma/DATA/Pi/pi-arnative"), "directory path shown as soon as the first tab opens");

	hdr.activeTab = "Model";
	const lines100 = hdr.render(100);
	assert(lines100.length === 7, "render 100 = border + 5 rows + border (left: mark + gap + pi version; info: brand line + tab box + data)");
	assert(lines100.every((l) => visibleWidth(l) === 100), "every line at width 100 is exactly 100 columns");
	assert(lines100[0]!.includes("╭") && lines100[0]!.includes("╮"), "round top border");
	assert(lines100[6]!.includes("╰") && lines100[6]!.includes("╯"), "round bottom border");
	// The column divider joins the frame: full-height split, no gap at the borders.
	const jx = stripAnsi(lines100[0]!).indexOf("┬");
	assert(jx > 0 && stripAnsi(lines100[6]!).indexOf("┴") === jx, "┬/┴ junctions sit on the border at the divider column");
	assert(
		lines100.slice(1, 6).every((l) => stripAnsi(l)[jx] === "│"),
		"the divider sits in the same column on every row",
	);
	const logoPlain = buildLogoLines(null);
	assert(logoPlain.length === 4 && visibleWidth(logoPlain[0]!) === 8, "pi block mark intact (4 lines x 8 columns)");
	// P (columns 0-2) accent, i (the right bar) soft — the old wordmark's two-tone.
	const logoTagged = buildLogoLines({
		fg: (c: string, t: string) => (c === "accent" ? `<A>${t}</A>` : c === "accentSoft" ? `<T>${t}</T>` : t),
	} as any);
	assert(logoTagged[0] === "<A>██████</A>  ", "mark top row: P in the theme accent");
	assert(logoTagged[2] === "<A>████</A>  <T>██</T>", "mark lower rows: P accent + i (right bar) soft");
	assert(
		lines100.slice(1, 5).every((l, i) => stripAnsi(l).slice(2, 10) === logoPlain[i]),
		"pi block mark in the left column, 4 lines",
	);
	assert(
		/Welcome back, \S/.test(stripAnsi(lines100[1]!)) && !stripAnsi(lines100[1]!).includes("pi v"),
		"line 1: greeting uses the device username",
	);
	// Left column: the pi version sits directly under the mark (no gap).
	assert(stripAnsi(lines100[5]!).slice(2, 12).includes("pi v"), "pi version sits under the mark in the left column");
	// Info column: brand + greeting, then the tab box straight away (no blank line).
	assert(/Arnative v\d+\.\d+\.\d+ · Welcome back, \S/.test(stripAnsi(lines100[1]!)), "info line 1: Arnative version · Welcome back, user");
	assert(!stripAnsi(lines100[2]!).includes("Menu"), "tab box border carries no label");
	// Tab box separators join its borders: ┬ above and ┴ below each "│". Compare by display
	// column, not string index: the tab icons are astral (2 code units, 1 column).
	const atColumn = (line: string, col: number): string | undefined => {
		let c = 0;
		for (const ch of stripAnsi(line)) {
			const w = visibleWidth(ch);
			if (col >= c && col < c + w) return ch;
			c += w;
		}
		return undefined;
	};
	const tabSepCols = [...stripAnsi(lines100[2]!).matchAll(/┬/g)].map((m) => visibleWidth(stripAnsi(lines100[2]!).slice(0, m.index)));
	assert(tabSepCols.length >= 2, "tab box top border has ┬ at each column divider");
	assert(
		tabSepCols.every((c) => atColumn(lines100[3]!, c) === "│" && atColumn(lines100[4]!, c) === "┴"),
		"each tab divider is full height (┬ / │ / ┴ in the same column)",
	);
	assert(!stripAnsi(lines100[1]!).includes("Interrupt"), "shortcut legend no longer on the top line");
	// Both brand names use the theme accent, not only "pi".
	const accentTheme = {
		fg: (c: string, t: string) => (c === "accent" ? `<A>${t}</A>` : c === "dim" ? `<D>${t}</D>` : t),
	};
	const accentHeader = new ArnativeHeader(fakeTui, accentTheme as any, fakeCtx);
	// The marker theme returns literal "<A>" text (not ANSI), so the measured width is
	// inflated — render wide enough that the brand/greeting line is not truncated.
	const accentLines = accentHeader.render(140);
	assert(accentLines[5]!.includes("<A>\x1b[1mpi"), "the pi name uses the theme accent");
	assert(accentLines[1]!.includes("<A>\x1b[1mArnative"), "the Arnative name uses the same theme accent");
	const greetLine = accentHeader.render(140)[1]!;
	assert(greetLine.includes("<D>Welcome back,"), "greeting text uses the dim color");
	assert(greetLine.includes(`<A>\x1b[1m${capitalize(deviceUser())}`), "device username uses the theme accent, first letter capitalized");
	assert(stripAnsi(lines100[3]!).includes("Model [Gemini 3.8 Flash]"), "Model tab in the menu (Model [name])");
	// Directory tab: name only in the menu, whole path in the content line below
	hdr.activeTab = "Directory";
	hdr.render(100);
	assert(stripAnsi(lines100[3]!).includes("Directory"), "Directory tab shown in the menu");
	assert(!stripAnsi(lines100[3]!).includes("Directory: /"), "Directory menu entry has no path (detail only on click)");
	assert(stripAnsi(lines100[3]!).indexOf("Directory") < stripAnsi(lines100[3]!).indexOf("Model ["), "Directory tab is leftmost");
	hdr.activeTab = "Model";
	hdr.render(100);
	assert(stripAnsi(lines100[5]!).includes("Gemini 3.8 Flash (Antigravity)"), "active Model tab data on the last info line");
	// Directory tab content: full path, wrapped, nothing lost
	hdr.activeTab = "Directory";
	const linesDir = hdr.render(100);
	const dirContent = stripAnsi(linesDir[5]!);
	assert(dirContent.includes("/run/media/bisma"), "full Directory tab path (start) shown");
	assert(dirContent.includes("pi-arnative"), "full Directory tab path (end) shown — no truncation");
	hdr.activeTab = "Model";
	hdr.render(100);
	// Tab box borders are a single fully dimmed block (the "─"/"┬"/"┴" runs are colored too).
	assert((lines100[4]!.match(/\x1b\[/g) ?? []).length === 8, "bottom box line (row 4) = one fully dimmed block");
	assert(
		lines100[2]!.includes("\x1b[2m╭─") && lines100[2]!.includes("┬") && lines100[2]!.includes("╮\x1b[22m"),
		"tab box top border = one dim block carrying the ┬ junctions",
	);

	// Tab regions: Model, Context, Skills, Extensions
	const tabY = (hdr as any).renderedTabLineY;
	assert(tabY > 0, "tab line Y position recorded");
	const tabRegions = (hdr as any).renderedTabRegions as Array<{ key: TabKey; startX: number; endX: number }>;
	assert(tabRegions.length >= 3, "tab regions filled (right tabs may be cut at 100 columns)");
	assert(tabRegions.some((r) => r.key === "Directory"), "Directory tab present in the menu (width 100)");

	// Click the Extensions tab (when truncated at 100 columns, use the rightmost tab)
	const extRegion = tabRegions.find((r) => r.key === "Extensions") ?? tabRegions[tabRegions.length - 1]!;
	const clickExt = hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((extRegion.startX + extRegion.endX) / 2),
		y: tabY,
	} as any);
	assert(clickExt?.handled === true, "mouse click on the tab is handled");
	assert(hdr.activeTab === extRegion.key, "activeTab switches to the clicked tab");
	assert(renderRequested === true, "requestRender called when the tab switches");

	const linesExt = hdr.render(100);
	assert(stripAnsi(linesExt[5]!).includes(extRegion.key === "Extensions" ? "@bismawy/pi-agentrouter@1.6.1" : ""), "active tab data on the last info line");

	// Click the Skills tab (measured at a width where every tab fits)
	const wide = hdr.render(140);
	const wideRegions = (hdr as any).renderedTabRegions as Array<{ key: TabKey; startX: number; endX: number }>;
	const skillsRegion = wideRegions.find((r) => r.key === "Skills") ?? wideRegions[wideRegions.length - 1]!;
	hdr.activeTab = "Model";
	hdr.render(140);
	const skillsY = (hdr as any).renderedTabLineY;
	hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((skillsRegion.startX + skillsRegion.endX) / 2),
		y: skillsY,
	} as any);
	assert(hdr.activeTab === skillsRegion.key, `activeTab switches to ${skillsRegion.key} after the click`);

	const linesSkills = hdr.render(140);
	assert(wide.every((l) => visibleWidth(l) === 140), "lines at 140 columns stay 140");
	assert(wideRegions.length === 6, "width 140: all 6 tabs shown (Shortcut included)");
	if (skillsRegion.key === "Skills") {
		assert(linesSkills[5]!.includes("agents-sdk, cloudflare"), "Skills tab data on the last info line");
		assert(!linesSkills[5]!.includes("Gemini 3.8 Flash (Antigravity)"), "Model data not shown in the Skills tab content");
		assert(linesSkills[3]!.includes("Model [Gemini 3.8 Flash]"), "tab menu still shown while another tab is active");
	}

	// The Y of a tab must point at the tab menu line, not the line above
	const rowsPlain = lines100.map((l) => stripAnsi(l));
	assert(rowsPlain[tabY]!.includes("Model ["), "renderedTabLineY points at the tab menu line");
	assert(tabRegions.every((r) => rowsPlain[tabY]!.slice(r.startX, r.endX + 1).includes(r.key === "Model" ? "Model [" : r.key)), "tab regions align with the text on that line");

	// Shortcut tab: the key cheatsheet lives in the tab content, not in a header line
	hdr.activeTab = "Shortcut";
	const linesShortcut = hdr.render(170);
	assert(
		((hdr as any).renderedTabRegions as Array<{ key: TabKey }>).some((r) => r.key === "Shortcut"),
		"width 170: Shortcut tab shown (not dropped)",
	);
	const scContent = stripAnsi(linesShortcut.slice(5).join(" "));
	assert(scContent.includes("[Esc] Interrupt"), "Shortcut tab: legend moved into the content");
	assert(
		scContent.includes(`[${SHORTCUT_RELOAD.label}] Reload`),
		`Shortcut tab: reload shortcut present in the content (${SHORTCUT_RELOAD.label})`,
	);
	assert(stripAnsi(linesShortcut[1]!).includes("Arnative v"), "the Arnative brand stays on line 1 while the Shortcut tab is active");
	hdr.activeTab = "Model";
	hdr.render(140);

	// Narrow screen: brand lines + tabs + data stay intact, rightmost tabs are dropped
	const narrow = hdr.render(60);
	assert(narrow.every((l) => visibleWidth(l) === 60), "lines at 60 columns stay 60");
	assert(stripAnsi(narrow[1]!).includes("Welcome back,"), "greeting stays intact at 60 columns");
	assert(stripAnsi(narrow[1]!).includes("Arnative v"), "Arnative brand intact at 60 columns");
	assert(stripAnsi(narrow[1]!).includes("Interrupt") === false, "legend does not come back to the top line");
	assert(
		!((hdr as any).renderedTabRegions as Array<{ key: TabKey }>).some((r) => r.key === "Shortcut"),
		"rightmost tab dropped at 60 columns",
	);
	assert(stripAnsi(narrow[3]!).includes("Model ["), "Model tab still shown at 60 columns");

	// Intercept addChild: capture the data and suppress the child
	const proto = Object.getPrototypeOf(UserMessageComponent.prototype) as { addChild?: unknown };
	const container: any = { children: [] as any[], addChild: proto.addChild as (c: any) => unknown };
	const fakeSection = {
		getCollapsedText: () => "[Skills]\n  new-skill-1, new-skill-2",
		getExpandedText: () => "[Skills]\n  new-skill-1, new-skill-2",
		setText: () => {},
		render: (_w: number) => ["should be hidden"],
	};
	container.addChild(fakeSection);
	assert(fakeSection.render(80).length === 0, "child of loadedResourcesContainer suppressed (render = [])");
	assert(tabStore.get("Skills")?.includes("new-skill-1") === true, "new data lands in tabStore");

	// pi 0.99 ExpandableText shape: `build` callback + `state` object, no getters.
	const modernSection = {
		state: { expanded: false },
		build: () => "[Context]\n  AGENTS.md, MEMORY.md",
		setText: () => {},
		render: (_w: number) => ["should be hidden"],
	};
	container.addChild(modernSection);
	assert(modernSection.render(80).length === 0, "pi 0.99 section suppressed (build + state shape)");
	assert(tabStore.get("Context")?.includes("MEMORY.md") === true, "pi 0.99 section data lands in tabStore");

	// Startup help block is not a resource section and must survive untouched.
	const helpBlock = { build: () => "\u2580\u2580\u2588  v0.99.1\n\u2588\u2580 \u2588 escape interrupt", state: { expanded: false }, render: () => ["help"] };
	container.addChild(helpBlock);
	assert(sectionBodyOf(helpBlock) === "\u2580\u2580\u2588  v0.99.1\n\u2588\u2580 \u2588 escape interrupt", "sectionBodyOf reads the build shape");
	assert(sectionNameOf(sectionBodyOf(helpBlock)!) === null, "startup help block is not a resource section");

	// pi's "[Extension issues]" diagnostic renders while the installing module's theme is
	// still null (a `/reload` copy never saw session_start). The box must draw uncolored,
	// not deref null — that crash was reported in the wild.
	setActiveTheme(null);
	const issuesChild = {
		build: () => "[Extension issues]\n  extension \"x\" failed",
		render: (_w: number) => ["[Extension issues]", '  extension "x" failed'],
	};
	container.addChild(issuesChild);
	const issuesLines = issuesChild.render(80);
	assert(issuesLines[0]!.startsWith("\u256d") && issuesLines.at(-1)!.startsWith("\u2570"), "extension-issues box renders without a theme");

	// The theme proxy is globalThis-backed, so the copy that owns the addChild patch still
	// paints once the other copy's session_start has stored the theme.
	setActiveTheme({ fg: (c: string, t: string) => `<${c}>${t}</${c}>` });
	const coloredChild = {
		build: () => "[Extension issues]\n  extension \"x\" failed",
		render: (_w: number) => ["[Extension issues]", '  extension "x" failed'],
	};
	container.addChild(coloredChild);
	assert(coloredChild.render(80)[0]!.includes("<warning>"), "shared theme proxy colors the box even in the patched copy");

	console.log("section-headers.ts self-check OK");
}
