/**
 * Arnative Header Box & Tab System (horizontal):
 * - Box rounded corner, tinggi tetap 5 baris: logo "pi" 3x6 kolom di kiri,
 *   pembatas vertikal, lalu 3 baris info rata kiri (versi/shortcut, tab, data).
 * - Baris info versi pi & shortcuts: [Esc], [Ctrl+c/d], [/], [!], [Ctrl+o].
 * - Menu Tab interaktif (klik mouse):
 *    Model: <nama model> │ 󰋖 Context [N] │ 󰰡 Skills [N] │ 󰺨 Extensions [N] │ 󰹲 Themes [N].
 *   Icon pada tab = warna aksen, teks tab = warna tint.
 * - Divider box '├────┤'.
 * - Isi data tab aktif (rata tengah, dibungkus rapi, warna tint, tidak bertumpuk).
 * - Sembunyikan daftar tumpukan bawaan pi di loadedResourcesContainer.
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

export type TabKey = "Model" | "Context" | "Skills" | "Extensions" | "Themes";

export const SECTION_ICONS: Record<TabKey, string> = {
	Model: "\uf1b2",
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

// Ambil warna pertama yang benar-benar dipakai tema
export function fgFirst(th: Themeish, names: string[], text: string): string {
	if (!th?.fg) return text;
	for (const name of names) {
		try {
			const out = th.fg(name, text);
			if (typeof out === "string" && out.includes(text)) return out;
		} catch {
			// coba nama warna berikutnya
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

// Logo pi.dev ASCII art: P menggunakan aksen tema, i menggunakan tint tema
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

// Lebar kolom logo, diturunkan dari art-nya supaya tidak magic number.
const LOGO_W = Math.max(...ASCII_LOGO_LINES.map((l) => visibleWidth(l)));
// Kolom awal area info: "│ " (2) + logo (LOGO_W) + " │ " (3).
const INFO_X = LOGO_W + 5;
// Sisa kolom untuk info: width - "│ " - logo - " │ " - info - " │".
const infoWidth = (width: number) => Math.max(8, width - LOGO_W - 7);

// Singleton store untuk resource loaded
const STORE_KEY = Symbol.for("pi-arnative.resourceStore");
export const tabStore: Map<TabKey, string[]> =
	(globalThis as Record<symbol, Map<TabKey, string[]>>)[STORE_KEY] ??
	new Map<TabKey, string[]>([
		["Model", []],
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

// Format nama model persis seperti di footer: Gemini 3.8 Flash (Antigravity), Deepseek V4.1 Flash (Yarz), dsb.
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
		const fullModelName = formatModelDisplayName(modelObj);
		// Pangkas detail bertanda kurung/siku di ekor nama ("... Free (1M) [OpenCode] (Freeflow)"
		// -> "Space Bunny Free"); detailnya tetap tampil di baris data tab Model.
		let modelLabel = `Model: ${fullModelName.replace(/(\s*\([^()]*\)|\s*\[[^[\]]*\])+$/, "").trim()}`;
		// Responsif di layar sedang: pangkas provider jika kolom < 112
		if (width < 112 && modelLabel.includes(" (")) {
			modelLabel = `Model: ${fullModelName.slice(0, fullModelName.indexOf(" (")).trim()}`;
		}
		// Di layar sempit < 88 kolom: ringkas nama model
		if (width < 88 && modelLabel.length > 18) {
			modelLabel = `Model: ${modelLabel.slice(7, 18).trim()}…`;
		}

		return [
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
		];
	}

	// Shortcut didaftarkan lewat pi.registerShortcut (header bukan target input keyboard).

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

		// Kolom kiri memuat logo + pembatas vertikal, jadi area info hanya dapat
		// width - LOGO_W - 7 kolom.
		const infoW = infoWidth(width);
		const infoLine = (text: string): string => {
			const t = truncateToWidth(text, infoW);
			return t + " ".repeat(infoW - visibleWidth(t));
		};

		const out: string[] = [fgFirst(th, ["dim"], `╭${dash}╮`)];
		const infoLines: string[] = [];
		// Kotak dalam: baris menu tab dibingkai, isi(infoW - 2) kolom.
		const innerW = Math.max(1, infoW - 2);

		// 1. Baris versi pi + merek. Selalu utuh.
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
		// Shortcut dipangkas dari kanan (prefix terpanjang yang masih muat) supaya
		// layar sempit tidak memotong tab atau data.
		let scText = "";
		for (let i = 1; i <= shortcutItems.length; i++) {
			const cand = shortcutItems.slice(0, i).join("  ");
			if (visibleWidth(cand) <= infoW) scText = cand;
		}
		infoLines.push(scText);

		// 2. Menu Tab: Icon = warna aksen, Teks = warna tint (bold jika aktif)
		const tabs = this.getTabsData(width);
		const sepTabPlain = " │ ";
		const sepTab = fgFirst(th, ["dim"], sepTabPlain);

		const tabParts: Array<{ key: TabKey; plain: string; formatted: string }> = [];
		for (const t of tabs) {
			const plain = `${t.icon} ${t.label}`;
			const isActive = t.key === this.activeTab;
			const iconStyled = isActive
				? fgFirst(th, ["accent"], t.icon)
				: fgFirst(th, ["dim"], t.icon);
			const labelStyled = isActive
				? fgFirst(th, ["tint", "text"], `\x1b[1m${t.label}\x1b[22m`)
				: fgFirst(th, ["dim"], t.label);
			const formatted = `${iconStyled} ${labelStyled}`;
			tabParts.push({ key: t.key, plain, formatted });
		}

		// Tab yang tak muat di layar sempit dibuang dari kanan (tab aktif selalu ikut).
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
		let curX = INFO_X;
		for (const t of kept) {
			const w = visibleWidth(t.plain);
			this.renderedTabRegions.push({ key: t.key, startX: curX, endX: curX + w - 1 });
			curX += w + visibleWidth(sepTabPlain);
		}
		// Kotak tab selebar isinya, bukan selebar kolom info.
		const tabText = ` ${kept.map((t) => t.formatted).join(sepTab)}`;
		const tabInnerW = Math.min(innerW, visibleWidth(tabText) + 1);
		const tabRow = (text: string): string => {
			const t = truncateToWidth(text, tabInnerW);
			return `${side}${t}${" ".repeat(tabInnerW - visibleWidth(t))}${side}`;
		};
		const tabRule = (l: string, r: string): string => fgFirst(th, ["dim"], `${l}${"─".repeat(tabInnerW)}${r}`);
		infoLines.push(tabRule("╭", "╮"));
		// Satu spasi dari batas kiri, lalu " │ " antar tab.
		infoLines.push(tabRow(tabText));
		// Baris tab = border atas (index 0) + infoLines sebelumnya + baris ini.
		this.renderedTabLineY = infoLines.length;
		infoLines.push(tabRule("╰", "╯"));

		// 3. Data tab aktif (rata kiri, dibungkus rapi, warna tint)
		let activeItems: string[] = [];
		if (this.activeTab === "Model") {
			const modelObj = this.ctx?.model ?? (globalThis as Record<symbol, any>)[MODEL_SNAPSHOT_KEY];
			const fullName = formatModelDisplayName(modelObj);
			const thLvl = this.ctx?.thinkingLevel ?? (globalThis as Record<symbol, any>)[THINKING_SNAPSHOT_KEY];
			const thinkLevel = thLvl && thLvl !== "off" ? capitalize(thLvl) : "Off";
			const sep = fgFirst(th, ["dim"], " · ");
			// Nama model diwarnai tint, ekornya "(Provider)" dim.
			const provSuffix = fullName.match(/(\s*\([^()]*\))$/)?.[1] ?? "";
			const nameMain = provSuffix ? fullName.slice(0, -provSuffix.length) : fullName;
			let line = `${fgFirst(th, ["tint", "text"], nameMain)}${provSuffix ? fgFirst(th, ["dim"], provSuffix) : ""}${sep}${fgFirst(th, ["tint", "text"], `Thinking: ${thinkLevel}`)}`;

			// Total semua penggunaan model itu (all-time seperti di /usage): ↑... ↓...  ...
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

		if (activeItems.length === 0) {
			infoLines.push(fgFirst(th, ["tint"], "(kosong)"));
		} else if (this.activeTab === "Model") {
			// Tab Model sudah memuat styling tint + separator dim
			infoLines.push(...activeItems);
		} else {
			for (const line of wrapCommaItems(activeItems, infoW)) {
				// Poin 5: warna pada data menu yg di select gunakan tint saja
				infoLines.push(fgFirst(th, ["tint", "text"], line));
			}
		}

		// Susun baris: logo di kolom kiri, pembatas vertikal, info rata kiri.
		// Logo lebih tinggi dari info -> sisanya dibiarkan kosong.
		const logoLines = buildLogoLines(th);
		const blankLogo = " ".repeat(LOGO_W);
		for (let i = 0; i < Math.max(logoLines.length, infoLines.length); i++) {
			const logo = logoLines[i] ?? blankLogo;
			out.push(`${side} ${logo} ${side} ${infoLine(infoLines[i] ?? "")} ${side}`);
		}

		// Border bawah
		out.push(fgFirst(th, ["dim"], `╰${dash}╯`));

		return out;
	}
}

// Intercept loadedResourcesContainer: tangkap data untuk Tab dan sembunyikan tampilan lama
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
					// Tandai container ini sebagai loadedResourcesContainer
					(this as Record<string, unknown>)._isLoadedResourcesContainer = true;

					const origCollapsed = child.getCollapsedText.bind(child) as () => string;
					const rawBody = origCollapsed().split("\n").slice(1).join("\n");
					const items = extractItemsFromBody(rawBody, sectionName === "Extensions");
					tabStore.set(sectionName, items);

					// Sembunyikan child ini dari tampilan bawaan agar tidak menumpuk di bawah header
					child.render = () => [];

					// Trigger re-render header bila sudah terpasang
					if (activeHeaderInstance?.tui) {
						activeHeaderInstance.tui.requestRender();
					}
				} else if ((this as Record<string, unknown>)._isLoadedResourcesContainer) {
					// "[Extension issues]" dari pi core -> bungkus kotak ala arnative.
					const text = String(child?.text ?? child?.content ?? (typeof child?.getText === "function" ? child.getText() : ""));
					if (text.includes("[Extension issues]") && typeof child.render === "function") {
						const origRender = child.render.bind(child);
						child.render = (w: number) => renderBoxLines(activeThemeProxy, w, origRender(w), undefined, "warning");
						return origAddChild.call(this, child);
					}
					// Setiap elemen lain di dalam loadedResourcesContainer (misal Spacer) juga disembunyikan
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
	// Ctrl+Shift+T: pindah ke tab berikutnya.
	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Next header tab",
		handler: async () => {
			const hdr = activeHeaderInstance;
			if (!hdr) return;
			const order: TabKey[] = ["Model", "Context", "Skills", "Extensions", "Themes"];
			hdr.activeTab = order[(order.indexOf(hdr.activeTab) + 1) % order.length];
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
	});

	pi.on("turn_end", async () => {
		// Usage dibaca ulang saat render (collectUsageSummary cache 5 dtk), cukup poke render.
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

	const wrapTest = wrapCommaItems(["item1", "item2", "item3", "item4"], 15);
	assert(wrapTest.length >= 2, "wrapCommaItems membungkus baris");
	assert(visibleWidth(wrapTest[0]!) <= 15, "lebar baris wrap sesuai batas");

	const cLine = centerLine("test", 20);
	assert(visibleWidth(cLine) === 20, "centerLine tepat 20 kolom");
	assert(cLine.startsWith("│") && cLine.endsWith("│"), "centerLine diawali dan diakhiri │");

	// Format model name
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

	// Komponen ArnativeHeader & mouse tab click
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
	};

	// Hanya "dim" yang diwarnai, supaya baris garis kotak bisa diuji warnanya.
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
	assert(stripAnsi(lines100[6]!).includes("Gemini 3.8 Flash (Antigravity)"), "data tab aktif Model tampil di baris info terakhir");
	// Garis kotak dalam satu blok dim penuh (garis "─" ikut ter-warnai, bukan hanya sudut).
	for (const i of [3, 5]) {
		assert((lines100[i]!.match(/\x1b\[/g) ?? []).length === 8, `garis kotak dalam baris ${i} = satu blok dim penuh (garis "─" ikut ter-warnai, bukan hanya sudut)`);
	}

	// Tab regions: Model, Context, Skills, Extensions, Themes
	const tabY = (hdr as any).renderedTabLineY;
	assert(tabY > 0, "posisi Y baris tab tercatat");
	const tabRegions = (hdr as any).renderedTabRegions as Array<{ key: TabKey; startX: number; endX: number }>;
	assert(tabRegions.length >= 4, "region tab terisi (tab paling kanan bisa terpotong di 100 kolom)");

	// Klik tab Extensions (kalau terpotong di 100 kolom, pakai tab paling kanan)
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

	// Klik tab Skills
	const skillsRegion = tabRegions.find((r) => r.key === "Skills") ?? tabRegions[0]!;
	hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((skillsRegion.startX + skillsRegion.endX) / 2),
		y: tabY,
	} as any);
	assert(hdr.activeTab === "Skills", "activeTab berubah ke Skills setelah klik");

	const linesSkills = hdr.render(100);
	assert(linesSkills[6]!.includes("agents-sdk, cloudflare"), "data tab Skills tampil di baris info terakhir");
	assert(!linesSkills[6]!.includes("Gemini 3.8 Flash (Antigravity)"), "data Model tidak tampil di konten tab Skills");
	assert(linesSkills[4]!.includes("Model: Gemini 3.8 Flash"), "menu tab tetap tampil saat tab lain aktif");

	// Y baris tab harus menunjuk baris menu tab, bukan baris shortcut di atasnya
	const rowsPlain = lines100.map((l) => stripAnsi(l));
	assert(rowsPlain[tabY]!.includes("Model:"), "renderedTabLineY menunjuk baris menu tab");
	assert(tabRegions.every((r) => rowsPlain[tabY]!.slice(r.startX, r.endX + 1).includes(r.key === "Model" ? "Model:" : r.key)), "region tab rata dengan teks di baris itu");

	// Layar sempit: versi + tab + data harus utuh, shortcut yang dipangkas
	const narrow = hdr.render(60);
	assert(narrow.every((l) => visibleWidth(l) === 60), "baris 60 kolom tetap 60");
	assert(stripAnsi(narrow[1]!).includes("pi v"), "versi tetap utuh di 60 kolom");
	assert(stripAnsi(narrow[1]!).includes("More/expand") === false, "shortcut panjang dibuang di 60 kolom");
	assert(stripAnsi(narrow[4]!).includes("Model:"), "tab Model tetap tampil di 60 kolom");

	// Intercept addChild: data masuk dan child di-suppress
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
