/**
 * Arnative header box & horizontal tab system:
 * - Round-corner box, fixed height 5 lines: "pi" 3x6 logo on the left, a vertical
 *   divider, then 3 left-aligned info lines (greeting/brand, tab menu, tab data).
 * - Greeting = OS account name; brand line = pi + Arnative with versions. The tab
 *   box labels itself on its top border ("╭─ Menu ───╮").
 * - Interactive tab menu (mouse click): Model + Context/Skills/Extensions/Themes/Shortcut
 *   with item counts. Icon = accent, text = tint. The key cheatsheet lives in the
 *   Shortcut tab, not in a header line.
 * - Box divider '├────┤'. Active tab content is left-aligned, wrapped, tint.
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
	Key,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { renderBoxLines } from "../lib/box.ts";
import { stripAnsi, themeOf } from "../lib/ansi.ts";
import { assert, isMain } from "../lib/check.ts";
import { capitalize, modelDisplayParts } from "../lib/format.ts";
import { formatTokens, getModelAllTimeUsage } from "../lib/usage-store.ts";

export type TabKey = "Model" | "Directory" | "Context" | "Skills" | "Extensions" | "Themes" | "Shortcut";

// Tab order for Ctrl+Alt+T and for the menu line.
export const TAB_ORDER: TabKey[] = ["Directory", "Model", "Context", "Skills", "Extensions", "Themes", "Shortcut"];

export const SECTION_ICONS: Record<TabKey, string> = {
	Model: "\uf1b2",
	Directory: "\uf07b",
	Context: "\udb84\uddd7",
	Skills: "\uec21",
	Extensions: "\ueea8",
	Themes: "\uee72",
	Shortcut: "\uf11c", // nf-fa-keyboard_o
};

export type Themeish = { fg?(color: string, text: string): string; bg?(color: string, text: string): string } | null;

let activeThemeProxy: Themeish = null;

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

export function sectionNameOf(text: string): "Context" | "Skills" | "Extensions" | "Themes" | null {
	const nl = text.indexOf("\n");
	const first = stripAnsi(nl === -1 ? text : text.slice(0, nl)).trim();
	const m = /^\[([A-Za-z]+)\]$/.exec(first);
	const name = m ? m[1] : null;
	if (name === "Context" || name === "Skills" || name === "Extensions" || name === "Themes") {
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
	"[Ctrl+alt+t] Next tab",
	"[Ctrl+alt+n] New",
	"[Ctrl+alt+r] Reload",
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

// pi.dev ASCII logo: P in the theme accent, i in the theme tint
export function buildLogoLines(th: Themeish): string[] {
	const p = (s: string) => fgFirst(th, ["accent"], s);
	const i = (s: string) => fgFirst(th, ["tint", "text"], s);

	return [
		`${p("██████████")}   `,
		`${p("██████████")}   `,
		`${p("████   ███")}   `,
		`${p("███████")}   ${i("███")}`,
		`${p("███")}       ${i("███")}`,
		`${p("███")}       ${i("███")}`,
	];
}

export const ASCII_LOGO_LINES = buildLogoLines(null);

// Logo column width, derived from the art so it is not a magic number.
const LOGO_W = Math.max(...ASCII_LOGO_LINES.map((l) => visibleWidth(l)));
// Info area starts at column: "│ " (2) + logo (LOGO_W) + " │ " (3).
const INFO_X = LOGO_W + 5;
// Columns left for info: width - "│ " - logo - " │ " - info - " │".
const infoWidth = (width: number) => Math.max(8, width - LOGO_W - 7);

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
		["Themes", []],
	]);
(globalThis as Record<symbol, Map<TabKey, string[]>>)[STORE_KEY] = tabStore;

let activeHeaderInstance: ArnativeHeader | null = null;

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
		activeHeaderInstance = this;
	}

	invalidate(): void {}

	dispose(): void {
		if (activeHeaderInstance === this) {
			activeHeaderInstance = null;
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
				label: `Context [${tabStore.get("Context")?.length ?? 0}]`,
			},
			{
				key: "Skills",
				name: "Skills",
				icon: SECTION_ICONS.Skills,
				count: tabStore.get("Skills")?.length ?? 0,
				label: `Skills [${tabStore.get("Skills")?.length ?? 0}]`,
			},
			{
				key: "Extensions",
				name: "Extensions",
				icon: SECTION_ICONS.Extensions,
				count: tabStore.get("Extensions")?.length ?? 0,
				label: `Extensions [${tabStore.get("Extensions")?.length ?? 0}]`,
			},
			{
				key: "Themes",
				name: "Themes",
				icon: SECTION_ICONS.Themes,
				count: tabStore.get("Themes")?.length ?? 0,
				label: `Themes [${tabStore.get("Themes")?.length ?? 0}]`,
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
		const th = this.themeProxy || (activeThemeProxy as Themeish);
		const side = fgFirst(th, ["dim"], "│");
		const dash = "─".repeat(Math.max(0, width - 2));

		// The left column holds the logo + vertical divider, so the info area only
		// gets width - LOGO_W - 7 columns.
		const infoW = infoWidth(width);
		const infoLine = (text: string): string => {
			const t = truncateToWidth(text, infoW);
			return t + " ".repeat(infoW - visibleWidth(t));
		};

		const out: string[] = [fgFirst(th, ["dim"], `╭${dash}╮`)];
		const infoLines: string[] = [];
		// Inner box: the tab menu line is framed, content is (infoW - 2) columns.
		const innerW = Math.max(1, infoW - 2);
		const brand = (name: string) => fgFirst(th, ["accent", "tint"], `\x1b[1m${name}\x1b[22m`);
		const dim = (text: string) => fgFirst(th, ["dim"], text);

		// 1. Greeting: device username, accent like the brand names below it.
		infoLines.push(`${dim("Welcome back,")} ${brand(deviceUser())}`);

		// 2. Brand line: pi · Arnative, both in the theme accent, versions dim.
		const versionStr = VERSION || "0.87.1";
		infoLines.push(
			`${brand("pi")} ${dim(`v${versionStr}`)}${dim(" · ")}${brand("Arnative")}${ARNATIVE_VERSION ? ` ${dim(`v${ARNATIVE_VERSION}`)}` : ""}`,
		);

		// 2. Tab menu: icon = accent, text = tint (bold when active)
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
				? fgFirst(th, ["tint", "text"], `\x1b[1m${label}\x1b[22m`)
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
		let curX = INFO_X + 2;
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
		const tabRule = (l: string, r: string, label = ""): string => {
			// Label rides on the top border ("╭─ Menu ───╮") so no extra text line is spent; the
			// word is tint so it reads as a label instead of a dimmer stretch of border.
			const lead = label.length + 1;
			if (label && tabInnerW - lead > 1) {
				return `${fgFirst(th, ["dim"], `${l}─`)}${fgFirst(th, ["tint", "text"], label)}${fgFirst(th, ["dim"], `${"─".repeat(tabInnerW - lead)}${r}`)}`;
			}
			return fgFirst(th, ["dim"], `${l}${"─".repeat(tabInnerW)}${r}`);
		};
		infoLines.push(tabRule("╭", "╮", " Menu "));
		// One space from the left border, then " │ " between tabs.
		infoLines.push(tabRow(tabText));
		// Tab line = top border (index 0) + the infoLines above + this line.
		this.renderedTabLineY = infoLines.length;
		infoLines.push(tabRule("╰", "╯"));

		// 3. Active tab data (left-aligned, neatly wrapped, tint)
		let activeItems: string[] = [];
		if (this.activeTab === "Model") {
			const modelObj = this.ctx?.model ?? (globalThis as Record<symbol, any>)[MODEL_SNAPSHOT_KEY];
			const fullName = formatModelDisplayName(modelObj);
			const thLvl = this.ctx?.thinkingLevel ?? (globalThis as Record<symbol, any>)[THINKING_SNAPSHOT_KEY];
			const thinkLevel = thLvl && thLvl !== "off" ? capitalize(thLvl) : "Off";
			const sep = fgFirst(th, ["dim"], " · ");
			// Model name in tint, its "(Provider)" tail dim.
			const provSuffix = fullName.match(/(\s*\([^()]*\))$/)?.[1] ?? "";
			const nameMain = provSuffix ? fullName.slice(0, -provSuffix.length) : fullName;
			let line = `${fgFirst(th, ["tint", "text"], nameMain)}${provSuffix ? fgFirst(th, ["dim"], provSuffix) : ""}${sep}${fgFirst(th, ["tint", "text"], `Thinking: ${thinkLevel}`)}`;

			// All-time usage of that model (same as /usage): ↑... ↓...  ...
			const usage = getModelAllTimeUsage(modelObj?.id);
			const tokenParts: string[] = [];
			if (usage.input > 0) {
				tokenParts.push(`${fgFirst(th, ["accent"], "↑")}${fgFirst(th, ["tint", "text"], formatTokens(usage.input))}`);
			}
			if (usage.output > 0) {
				tokenParts.push(`${fgFirst(th, ["accent"], "↓")}${fgFirst(th, ["tint", "text"], formatTokens(usage.output))}`);
			}
			if (usage.cacheRead > 0) {
				tokenParts.push(`${fgFirst(th, ["accent"], "\uf49b ")}${fgFirst(th, ["tint", "text"], formatTokens(usage.cacheRead))}`);
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
				infoLines.push(fgFirst(th, ["tint", "text"], line));
			}
		} else if (this.activeTab === "Shortcut") {
			for (const line of wrapTokens(SHORTCUTS, infoW)) {
				infoLines.push(fgFirst(th, ["tint", "text"], line));
			}
		} else if (activeItems.length === 0) {
			infoLines.push(fgFirst(th, ["tint"], "(empty)"));
		} else if (this.activeTab === "Model") {
			// The Model tab already carries tint styling + a dim separator
			infoLines.push(...activeItems);
		} else {
			for (const line of wrapCommaItems(activeItems, infoW)) {
				// Point 5: selected menu data uses tint only
				infoLines.push(fgFirst(th, ["tint", "text"], line));
			}
		}

		// Compose lines: logo in the left column, vertical divider, left-aligned info.
		// The logo is taller than the info -> the rest is left blank.
		const logoLines = buildLogoLines(th);
		const blankLogo = " ".repeat(LOGO_W);
		for (let i = 0; i < Math.max(logoLines.length, infoLines.length); i++) {
			const logo = logoLines[i] ?? blankLogo;
			out.push(`${side} ${logo} ${side} ${infoLine(infoLines[i] ?? "")} ${side}`);
		}

		// Bottom border
		out.push(fgFirst(th, ["dim"], `╰${dash}╯`));

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
			try {
				const sectionName = sectionNameOf(String(child?.getCollapsedText?.() ?? ""));
				const isSection =
					child &&
					typeof child.getCollapsedText === "function" &&
					typeof child.getExpandedText === "function" &&
					typeof child.setText === "function" &&
					(sectionName === null ? false : SECTION_ICONS[sectionName] !== undefined);

				if (isSection && sectionName) {
					// Mark this container as the loadedResourcesContainer
					(this as Record<string, unknown>)._isLoadedResourcesContainer = true;

					const origCollapsed = child.getCollapsedText.bind(child) as () => string;
					const rawBody = origCollapsed().split("\n").slice(1).join("\n");
					const items = extractItemsFromBody(rawBody, sectionName === "Extensions");
					tabStore.set(sectionName, items);

					// Hide this child from the built-in display so it does not stack under the header
					child.render = () => [];

					// Re-render the header when it is already installed
					if (activeHeaderInstance?.tui) {
						activeHeaderInstance.tui.requestRender();
					}
				} else if ((this as Record<string, unknown>)._isLoadedResourcesContainer) {
					// pi core's "[Extension issues]" -> wrap in an arnative box.
					const text = String(child?.text ?? child?.content ?? (typeof child?.getText === "function" ? child.getText() : ""));
					if (text.includes("[Extension issues]") && typeof child.render === "function") {
						const origRender = child.render.bind(child);
						child.render = (w: number) => renderBoxLines(activeThemeProxy, w, origRender(w), undefined, "warning");
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
	// ctrl+alt+t: next tab.
	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Next header tab",
		handler: async () => {
			const hdr = activeHeaderInstance;
			if (!hdr) return;
			const order = TAB_ORDER;
			hdr.activeTab = order[(order.indexOf(hdr.activeTab) + 1) % order.length]!;
			hdr.tui?.requestRender?.();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeThemeProxy = themeOf<Themeish>(ctx) ?? activeThemeProxy;
		// Register the custom header
		ctx.ui?.setHeader?.((tui, theme) => {
			return new ArnativeHeader(tui, theme, ctx);
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		(globalThis as Record<symbol, any>)[MODEL_SNAPSHOT_KEY] = ctx.model;
		(globalThis as Record<symbol, any>)[THINKING_SNAPSHOT_KEY] = ctx.thinkingLevel;
		if (ctx.cwd) (globalThis as Record<symbol, any>)[CWD_SNAPSHOT_KEY] = ctx.cwd;
	});

	pi.on("turn_end", async () => {
		// Usage is re-read at render time (collectUsageSummary caches 5s), so poking a render is enough.
		if (activeHeaderInstance?.tui) {
			activeHeaderInstance.tui.requestRender();
		}
	});
}

// Self-check: `node extensions/section-headers.ts`
if (isMain(import.meta.url)) {

	assert(sectionNameOf("\x1b[33m[Skills]\x1b[39m\n  a, b") === "Skills", "header [Skills] detected");
	assert(sectionNameOf("pi v0.87.1") === null, "non-section text is not detected");

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
	tabStore.set("Themes", ["arnative", "dark"]);

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
	const hdr = new ArnativeHeader(fakeTui, ansiTheme, fakeCtx);
	assert(hdr.activeTab === "Directory", "default tab is Directory");

	// Default view: the working directory path, shown on open
	const linesDefault = hdr.render(100);
	assert(stripAnsi(linesDefault[6]!).includes("/run/media/bisma/DATA/Pi/pi-arnative"), "directory path shown as soon as the first tab opens");

	hdr.activeTab = "Model";
	const lines100 = hdr.render(100);
	assert(lines100.length === 8, "render 100 = border + 6 logo lines + border (3 info lines fill 3 logo lines)");
	assert(lines100.every((l) => visibleWidth(l) === 100), "every line at width 100 is exactly 100 columns");
	assert(lines100[0]!.includes("╭") && lines100[0]!.includes("╮"), "round top border");
	assert(lines100[7]!.includes("╰") && lines100[7]!.includes("╯"), "round bottom border");
	const logoPlain = buildLogoLines(null);
	assert(logoPlain.length === 6 && visibleWidth(logoPlain[0]!) === 13, "real Pi ascii intact (6 lines x 13 columns)");
	assert(
		lines100.slice(1, 7).every((l, i) => stripAnsi(l).slice(2, 15) === logoPlain[i]),
		"real Pi ascii in the left column, 6 lines",
	);
	assert(
		/Welcome back, \S/.test(stripAnsi(lines100[1]!)) && !stripAnsi(lines100[1]!).includes("pi v"),
		"line 1: greeting uses the device username",
	);
	assert(
		stripAnsi(lines100[2]!).includes("pi v") && /Arnative v\d+\.\d+\.\d+/.test(stripAnsi(lines100[2]!)),
		"line 2: pi + Arnative + the Arnative build version",
	);
	assert(/╭─ Menu ─+╮/.test(stripAnsi(lines100[3]!)), "tab box top border carries the Menu label");
	assert(!stripAnsi(lines100[1]!).includes("Interrupt"), "shortcut legend no longer on the top line");
	// Both brand names use the theme accent, not only "pi".
	const accentTheme = {
		fg: (c: string, t: string) => (c === "accent" ? `<A>${t}</A>` : c === "dim" ? `<D>${t}</D>` : t),
	};
	const accentHeader = new ArnativeHeader(fakeTui, accentTheme as any, fakeCtx);
	const accentLine = accentHeader.render(100)[2]!;
	assert(accentLine.includes("<A>\x1b[1mpi"), "the pi name uses the theme accent");
	assert(accentLine.includes("<A>\x1b[1mArnative"), "the Arnative name uses the same theme accent");
	const greetLine = accentHeader.render(100)[1]!;
	assert(greetLine.includes("<D>Welcome back,"), "greeting text uses the dim color");
	assert(greetLine.includes(`<A>\x1b[1m${deviceUser()}`), "device username uses the theme accent");
	assert(stripAnsi(lines100[4]!).includes("Model [Gemini 3.8 Flash]"), "Model tab in the menu (Model [name])");
	// Directory tab: name only in the menu, whole path in the content line below
	hdr.activeTab = "Directory";
	hdr.render(100);
	assert(stripAnsi(lines100[4]!).includes("Directory"), "Directory tab shown in the menu");
	assert(!stripAnsi(lines100[4]!).includes("Directory: /"), "Directory menu entry has no path (detail only on click)");
	assert(stripAnsi(lines100[4]!).indexOf("Directory") < stripAnsi(lines100[4]!).indexOf("Model ["), "Directory tab is leftmost");
	hdr.activeTab = "Model";
	hdr.render(100);
	assert(stripAnsi(lines100[6]!).includes("Gemini 3.8 Flash (Antigravity)"), "active Model tab data on the last info line");
	// Directory tab content: full path, wrapped, nothing lost
	hdr.activeTab = "Directory";
	const linesDir = hdr.render(100);
	const dirContent = stripAnsi(linesDir[6]!);
	assert(dirContent.includes("/run/media/bisma"), "full Directory tab path (start) shown");
	assert(dirContent.includes("pi-arnative"), "full Directory tab path (end) shown — no truncation");
	hdr.activeTab = "Model";
	hdr.render(100);
	// Inner box rules: bottom line is one fully dimmed block (the "─" runs are colored too, not
	// just the corners); the top one is the same except it carries the tinted " Menu " label.
	assert((lines100[5]!.match(/\x1b\[/g) ?? []).length === 8, 'bottom box line (row 5) = one fully dimmed block');
	assert(
		lines100[3]!.includes("\x1b[2m╭─\x1b[22m Menu \x1b[2m─") && lines100[3]!.includes("╮\x1b[22m"),
		'tab box top border = two dim blocks with the " Menu " label between them',
	);

	// Tab regions: Model, Context, Skills, Extensions, Themes
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
	assert(stripAnsi(linesExt[6]!).includes(extRegion.key === "Extensions" ? "@bismawy/pi-agentrouter@1.6.1" : ""), "active tab data on the last info line");

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
	assert(wideRegions.length === 6, "width 140: first 6 tabs shown (rightmost Shortcut dropped too)");
	if (skillsRegion.key === "Skills") {
		assert(linesSkills[6]!.includes("agents-sdk, cloudflare"), "Skills tab data on the last info line");
		assert(!linesSkills[6]!.includes("Gemini 3.8 Flash (Antigravity)"), "Model data not shown in the Skills tab content");
		assert(linesSkills[4]!.includes("Model [Gemini 3.8 Flash]"), "tab menu still shown while another tab is active");
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
	const scContent = stripAnsi(linesShortcut.slice(6).join(" "));
	assert(scContent.includes("[Esc] Interrupt"), "Shortcut tab: legend moved into the content");
	assert(scContent.includes("[Ctrl+alt+r] Reload"), "Shortcut tab: reload shortcut present in the content");
	assert(stripAnsi(linesShortcut[2]!).includes("Arnative v"), "line 2 keeps the Arnative brand while the Shortcut tab is active");
	hdr.activeTab = "Model";
	hdr.render(140);

	// Narrow screen: brand lines + tabs + data stay intact, rightmost tabs are dropped
	const narrow = hdr.render(60);
	assert(narrow.every((l) => visibleWidth(l) === 60), "lines at 60 columns stay 60");
	assert(stripAnsi(narrow[1]!).includes("Welcome back,"), "greeting stays intact at 60 columns");
	assert(stripAnsi(narrow[2]!).includes("Arnative v"), "pi + Arnative brand intact at 60 columns");
	assert(stripAnsi(narrow[2]!).includes("Interrupt") === false, "legend does not come back to the top line");
	assert(
		!((hdr as any).renderedTabRegions as Array<{ key: TabKey }>).some((r) => r.key === "Shortcut"),
		"rightmost tab dropped at 60 columns",
	);
	assert(stripAnsi(narrow[4]!).includes("Model ["), "Model tab still shown at 60 columns");

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

	console.log("section-headers.ts self-check OK");
}
