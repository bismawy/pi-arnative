/**
 * Arnative header box & horizontal tab system:
 * - Round-corner box, fixed height 5 lines: "pi" 3x6 logo on the left, a vertical
 *   divider, then 3 left-aligned info lines (version/shortcuts, tabs, data).
 * - Info line 1: pi version & shortcuts [Esc], [Ctrl+c/d], [/], [!], [Ctrl+o].
 * - Interactive tab menu (mouse click): Model + Context/Skills/Extensions/Themes
 *   with item counts. Tab icon = accent, tab text = tint.
 * - Box divider '├────┤'.
 * - Active tab content (left-aligned, neatly wrapped, tint, never stacked).
 * - Hides pi's built-in stacked list in loadedResourcesContainer.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { formatTokens, getModelAllTimeUsage } from "../lib/usage-store.ts";

export type TabKey = "Model" | "Directory" | "Context" | "Skills" | "Extensions" | "Themes";

// Tab order for Ctrl+Alt+T and for the menu line.
export const TAB_ORDER: TabKey[] = ["Model", "Directory", "Context", "Skills", "Extensions", "Themes"];

export const SECTION_ICONS: Record<TabKey, string> = {
	Model: "\uf1b2",
	Directory: "\uf07b",
	Context: "\udb84\uddd7",
	Skills: "\uec21",
	Extensions: "\ueea8",
	Themes: "\uee72",
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

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
	const first = (nl === -1 ? text : text.slice(0, nl)).replace(ANSI_RE, "").trim();
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

export function wrapCommaItems(items: string[], maxWidth: number): string[] {
	const lines: string[] = [];
	let cur = "";
	for (const item of items) {
		if (!cur) {
			cur = item;
		} else if (visibleWidth(cur) + 2 + visibleWidth(item) <= maxWidth) {
			cur += ", " + item;
		} else {
			lines.push(cur + ",");
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

function capitalize(s: string): string {
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

// Model name formatted exactly like in the footer: Gemini 3.8 Flash (Antigravity), Deepseek V4.1 Flash (Yarz), etc.
export function formatModelDisplayName(model?: { id?: string; name?: string; provider?: string }): string {
	if (!model) return "No Model";
	let name = model.name || model.id || "Model";
	const provider = model.provider ? model.provider.charAt(0).toUpperCase() + model.provider.slice(1) : "";
	if (name === model.id) {
		name = name
			.split(/[-_]/)
			.map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
			.join(" ");
	}
	if (provider && name.toLowerCase().endsWith(`(${provider.toLowerCase()})`)) {
		name = name.slice(0, name.lastIndexOf("(")).trim();
	}
	const provStr = provider ? ` (${provider})` : "";
	return `${name}${provStr}`;
}

// Full working directory for the Directory tab. ctx.cwd is authoritative; the
// snapshot survives header re-creation when ctx is missing.
const CWD_SNAPSHOT_KEY = Symbol.for("pi-arnative.lastCwd");
export function getCwd(ctx?: { cwd?: string }): string {
	return ctx?.cwd || (globalThis as Record<symbol, any>)[CWD_SNAPSHOT_KEY] || "";
}

export class ArnativeHeader implements Component {
	public activeTab: TabKey = "Model";
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
		const cwd = getCwd(this.ctx);
		// Tab row stays compact (basename only): the full path is in the content
		// line below, and render() expands this label when every tab still fits.
		const dirBase = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || cwd;
		const dirLabel = dirBase ? `Directory: ${dirBase}` : "Directory";
		const fullModelName = formatModelDisplayName(modelObj);
		// Drop bracketed details from the tail of the name ("... Free (1M) [OpenCode] (Freeflow)"
		// -> "Space Bunny Free"); the details still show in the Model tab data line.
		let modelLabel = `Model: ${fullModelName.replace(/(\s*\([^()]*\)|\s*\[[^[\]]*\])+$/, "").trim()}`;
		// Responsive on medium screens: drop the provider when columns < 112
		if (width < 112 && modelLabel.includes(" (")) {
			modelLabel = `Model: ${fullModelName.slice(0, fullModelName.indexOf(" (")).trim()}`;
		}
		// Below 88 columns: shorten the model name
		if (width < 88 && modelLabel.length > 18) {
			modelLabel = `Model: ${modelLabel.slice(7, 18).trim()}…`;
		}

		return [
			{ key: "Model", name: "Model", icon: SECTION_ICONS.Model, count: 0, label: modelLabel },
			{ key: "Directory", name: "Directory", icon: SECTION_ICONS.Directory, count: 0, label: dirLabel },
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

		// 1. pi version + brand line. Always intact.
		const versionStr = VERSION || "0.87.1";
		const piPart = `${fgFirst(th, ["accent", "tint"], "\x1b[1mpi\x1b[22m")} ${fgFirst(th, ["dim"], `v${versionStr}`)}`;
		infoLines.push(`${piPart}${fgFirst(th, ["dim"], " · ")}${fgFirst(th, ["dim"], "Arnative")}`);
		const shortcutItems = [
			`${fgFirst(th, ["tint"], "[Esc]")} ${fgFirst(th, ["dim"], "Interrupt")}`,
			`${fgFirst(th, ["tint"], "[Ctrl+c/d]")} ${fgFirst(th, ["dim"], "Exit")}`,
			`${fgFirst(th, ["tint"], "[/]")} ${fgFirst(th, ["dim"], "Commands")}`,
			`${fgFirst(th, ["tint"], "[!]")} ${fgFirst(th, ["dim"], "Bash")}`,
			`${fgFirst(th, ["tint"], "[Ctrl+o]")} ${fgFirst(th, ["dim"], "More/expand")}`,
			`${fgFirst(th, ["tint"], "[Ctrl+alt+t]")} ${fgFirst(th, ["dim"], "Next tab")}`,
		];
		// Shortcut list is trimmed from the right (longest prefix that still fits) so
		// narrow screens never clip the tabs or the data.
		let scText = "";
		for (let i = 1; i <= shortcutItems.length; i++) {
			const cand = shortcutItems.slice(0, i).join("  ");
			if (visibleWidth(cand) <= infoW) scText = cand;
		}
		infoLines.push(scText);

		// 2. Tab menu: icon = accent, text = tint (bold when active)
		const tabs = this.getTabsData(width);
		const sepTabPlain = " │ ";
		const sepTab = fgFirst(th, ["dim"], sepTabPlain);

		const tabParts: Array<{ key: TabKey; plain: string; formatted: string }> = [];
		const makeTabPart = (t: { key: TabKey; icon: string; label: string }, label = t.label) => {
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
		// All tabs fit? Then the Directory tab may show the whole path instead of the
		// basename. Skipped when it would push another tab off the menu.
		if (kept.length === tabParts.length) {
			const i = kept.findIndex((t) => t.key === "Directory");
			const cwdFull = getCwd(this.ctx);
			const dirTab = tabs[i];
			if (i >= 0 && dirTab && cwdFull) {
				const full = makeTabPart(dirTab, `Directory: ${cwdFull}`);
				if (usedWidth - visibleWidth(kept[i]!.plain) + visibleWidth(full.plain) <= innerW) {
					kept[i] = full;
					usedWidth += visibleWidth(full.plain) - visibleWidth(tabParts[i]!.plain);
				}
			}
		}
		this.renderedTabRegions = [];
		let curX = INFO_X;
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
		const tabRule = (l: string, r: string): string => fgFirst(th, ["dim"], `${l}${"─".repeat(tabInnerW)}${r}`);
		infoLines.push(tabRule("╭", "╮"));
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
		} else if (activeItems.length === 0) {
			infoLines.push(fgFirst(th, ["tint"], "(kosong)"));
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
		activeThemeProxy = (ctx as unknown as { ui?: { theme?: typeof activeThemeProxy } }).ui?.theme ?? activeThemeProxy;
		// Daftarkan Custom Header
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
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"));
if (isMain) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};

	assert(sectionNameOf("\x1b[33m[Skills]\x1b[39m\n  a, b") === "Skills", "header [Skills] terdeteksi");
	assert(sectionNameOf("pi v0.87.1") === null, "teks non-seksi tak terdeteksi");

	// Parsing & wrapping
	assert(extractItemsFromBody("  a, b, c").length === 3, "extractItemsFromBody koma = 3");
	assert(extractItemsFromBody("  x\n  y\n  z").length === 3, "extractItemsFromBody baris = 3");

	// Directory path wrapping: never truncated, always the full path
	const wp = wrapPath("/run/media/bisma/DATA/Pi/pi-arnative", 20);
	assert(wp.join("") === "/run/media/bisma/DATA/Pi/pi-arnative", "wrapPath tak menghilangkan segmen");
	assert(wp.every((l) => visibleWidth(l) <= 20), "wrapPath hormati lebar");
	assert(wrapPath("D:\\Pi\\pi-arnative", 80).join("") === "D:/Pi/pi-arnative", "wrapPath normalisasi backslash");
	assert(wrapPath("/a/very-long-segment-name", 6).every((l) => visibleWidth(l) <= 6), "segmen panjang diiris");

	const wrapTest = wrapCommaItems(["item1", "item2", "item3", "item4"], 15);
	assert(wrapTest.length >= 2, "wrapCommaItems membungkus baris");
	assert(visibleWidth(wrapTest[0]!) <= 15, "lebar baris wrap sesuai batas");

	const cLine = centerLine("test", 20);
	assert(visibleWidth(cLine) === 20, "centerLine tepat 20 kolom");
	assert(cLine.startsWith("│") && cLine.endsWith("│"), "centerLine diawali dan diakhiri │");

	// Model name formatting
	assert(
		formatModelDisplayName({ name: "Gemini 3.8 Flash", provider: "antigravity" }) ===
			"Gemini 3.8 Flash (Antigravity)",
		"formatModelDisplayName dengan name dan provider",
	);
	assert(
		formatModelDisplayName({ id: "deepseek-v4.1-flash", provider: "yarz" }) ===
			"Deepseek V4.1 Flash (Yarz)",
		"formatModelDisplayName konversi id jadi titlecase",
	);

	// Package & version resolver
	assert(packageNameOf("@bismawy/pi-agentrouter") === "@bismawy/pi-agentrouter", "label npm polos");
	assert(packageNameOf("footer.ts") === "footer.ts", "label lokal");

	const gitTmp = mkdtempSync(join(tmpdir(), "pi-ver-"));
	mkdirSync(join(gitTmp, "git", "github.com", "uji/arnative"), { recursive: true });
	writeFileSync(join(gitTmp, "git", "github.com", "uji/arnative", "package.json"), JSON.stringify({ version: "9.9.9" }));
	assert(installedVersion("uji/arnative", join(gitTmp, "npm"), join(gitTmp, "git")) === "9.9.9", "versi dari klon git");
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
	assert(hdr.activeTab === "Model", "default tab adalah Model");

	const lines100 = hdr.render(100);
	assert(lines100.length === 8, "render 100 = border + 6 baris logo + border (3 baris info mengisi 3 baris logo)");
	assert(lines100.every((l) => visibleWidth(l) === 100), "semua baris render 100 tepat 100 kolom");
	assert(lines100[0]!.includes("╭") && lines100[0]!.includes("╮"), "border atas rounded");
	assert(lines100[7]!.includes("╰") && lines100[7]!.includes("╯"), "border bawah rounded");
	const logoPlain = buildLogoLines(null);
	assert(logoPlain.length === 6 && visibleWidth(logoPlain[0]!) === 13, "ascii Pi asli utuh (6 baris x 13 kolom)");
	assert(
		lines100.slice(1, 7).every((l, i) => stripAnsi(l).slice(2, 15) === logoPlain[i]),
		"ascii Pi asli di kolom kiri, 6 baris",
	);
	assert(stripAnsi(lines100[1]!).includes("pi v") && stripAnsi(lines100[1]!).includes("Arnative"), "baris versi + merek");
	assert(stripAnsi(lines100[4]!).includes("Model: Gemini 3.8 Flash"), "menu tab Model tampil");
	// Directory tab: whole path in the content line, no truncation
	hdr.activeTab = "Directory";
	hdr.render(100);
	assert(stripAnsi(lines100[4]!).includes("Directory:"), "tab Directory tampil di menu");
	hdr.activeTab = "Model";
	hdr.render(100);
	assert(stripAnsi(lines100[6]!).includes("Gemini 3.8 Flash (Antigravity)"), "data tab aktif Model tampil di baris info terakhir");
	// Directory tab content: full path, wrapped, nothing lost
	hdr.activeTab = "Directory";
	const linesDir = hdr.render(100);
	const dirContent = stripAnsi(linesDir[6]!);
	assert(dirContent.includes("/run/media/bisma"), "path lengkap tab Directory (awal) tampil");
	assert(dirContent.includes("pi-arnative"), "path lengkap tab Directory (akhir) tampil — tanpa truncate");
	hdr.activeTab = "Model";
	hdr.render(100);
	// The inner box lines are one fully dimmed block (the "─" runs are colored too, not just the corners).
	for (const i of [3, 5]) {
		assert((lines100[i]!.match(/\x1b\[/g) ?? []).length === 8, `garis kotak dalam baris ${i} = satu blok dim penuh (garis "─" ikut ter-warnai, bukan hanya sudut)`);
	}

	// Tab regions: Model, Context, Skills, Extensions, Themes
	const tabY = (hdr as any).renderedTabLineY;
	assert(tabY > 0, "posisi Y baris tab tercatat");
	const tabRegions = (hdr as any).renderedTabRegions as Array<{ key: TabKey; startX: number; endX: number }>;
	assert(tabRegions.length >= 3, "region tab terisi (tab kanan bisa terpotong di 100 kolom)");
	assert(tabRegions.some((r) => r.key === "Directory"), "tab Directory ada di menu (lebar 100)");

	// Click the Extensions tab (when truncated at 100 columns, use the rightmost tab)
	const extRegion = tabRegions.find((r) => r.key === "Extensions") ?? tabRegions[tabRegions.length - 1]!;
	const clickExt = hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((extRegion.startX + extRegion.endX) / 2),
		y: tabY,
	} as any);
	assert(clickExt?.handled === true, "klik mouse pada tab handled");
	assert(hdr.activeTab === extRegion.key, "activeTab berubah ke tab yang diklik");
	assert(renderRequested === true, "requestRender dipanggil saat tab berganti");

	const linesExt = hdr.render(100);
	assert(stripAnsi(linesExt[6]!).includes(extRegion.key === "Extensions" ? "@bismawy/pi-agentrouter@1.6.1" : ""), "data tab aktif tampil di baris info terakhir");

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
	assert(hdr.activeTab === skillsRegion.key, `activeTab berubah ke ${skillsRegion.key} setelah klik`);

	const linesSkills = hdr.render(140);
	assert(wide.every((l) => visibleWidth(l) === 140), "baris 140 kolom tetap 140");
	assert(wideRegions.length === 6, "lebar 140: semua 6 tab tampil");
	if (skillsRegion.key === "Skills") {
		assert(linesSkills[6]!.includes("agents-sdk, cloudflare"), "data tab Skills tampil di baris info terakhir");
		assert(!linesSkills[6]!.includes("Gemini 3.8 Flash (Antigravity)"), "data Model tidak tampil di konten tab Skills");
		assert(linesSkills[4]!.includes("Model: Gemini 3.8 Flash"), "menu tab tetap tampil saat tab lain aktif");
	}

	// The Y of a tab must point at the tab menu line, not the shortcut line above
	const rowsPlain = lines100.map((l) => stripAnsi(l));
	assert(rowsPlain[tabY]!.includes("Model:"), "renderedTabLineY menunjuk baris menu tab");
	assert(tabRegions.every((r) => rowsPlain[tabY]!.slice(r.startX, r.endX + 1).includes(r.key === "Model" ? "Model:" : r.key)), "region tab rata dengan teks di baris itu");

	// Narrow screen: version + tabs + data stay intact, shortcuts get trimmed
	const narrow = hdr.render(60);
	assert(narrow.every((l) => visibleWidth(l) === 60), "baris 60 kolom tetap 60");
	assert(stripAnsi(narrow[1]!).includes("pi v"), "versi tetap utuh di 60 kolom");
	assert(stripAnsi(narrow[1]!).includes("More/expand") === false, "shortcut panjang dibuang di 60 kolom");
	assert(stripAnsi(narrow[4]!).includes("Model:"), "tab Model tetap tampil di 60 kolom");

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
	assert(fakeSection.render(80).length === 0, "child di loadedResourcesContainer di-suppress (render = [])");
	assert(tabStore.get("Skills")?.includes("new-skill-1") === true, "data baru masuk ke tabStore");

	console.log("section-headers.ts self-check OK");
}
