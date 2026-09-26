/**
 * Arnative Header Box & Tab System:
 * - Gaya box rounded corner (seperti chat/editor).
 * - Logo pi.dev ASCII art (hijau emerald pixelated compact, 4 baris).
 * - Baris info versi pi & shortcuts: [Esc], [Ctrl+c/d], [/], [!], [Ctrl+o].
 * - Divider box '├────┤'.
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
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

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
const USAGE_SNAPSHOT_KEY = Symbol.for("pi-arnative.usageSnapshot");

export function formatTokens(n: number): string {
	if (!n || n <= 0) return "0";
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

// Menghitung total semua penggunaan model tertentu (all-time seperti di /usage)
export function getModelAllTimeUsage(
	modelId?: string,
	ctx?: ExtensionContext,
): { input: number; output: number; cacheRead: number } {
	let inp = 0;
	let out = 0;
	let read = 0;

	// 1. Baca cache all-time dari arnative-usage-cache.json atau usage-extension-cache.json
	try {
		const arnativeCache = join(getAgentDir(), "arnative-usage-cache.json");
		if (existsSync(arnativeCache)) {
			const cache = JSON.parse(readFileSync(arnativeCache, "utf8")) as Record<string, { entries?: Array<{ model: string; input: number; output: number; cacheRead: number }> }>;
			const target = (modelId || "").toLowerCase();
			for (const file of Object.values(cache)) {
				if (!file?.entries) continue;
				for (const ent of file.entries) {
					const mName = (ent.model || "").toLowerCase();
					const matches =
						!target ||
						mName === target ||
						mName.endsWith("/" + target) ||
						mName.split(":")[0] === target ||
						target.endsWith("/" + mName);
					if (matches) {
						inp += ent.input || 0;
						out += ent.output || 0;
						read += ent.cacheRead || 0;
					}
				}
			}
		} else {
			const cachePath = join(getAgentDir(), "usage-extension-cache.json");
			if (existsSync(cachePath)) {
				const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
					names?: string[];
					files?: Record<string, { messages?: unknown[][] }>;
				};
				if (cache && Array.isArray(cache.names) && cache.files) {
					const names = cache.names;
					const target = (modelId || "").toLowerCase();
					for (const file of Object.values(cache.files)) {
						if (!file?.messages || !Array.isArray(file.messages)) continue;
						for (const m of file.messages) {
							if (!Array.isArray(m) || m.length < 6) continue;
							const mName = String(names[m[1] as number] || "").toLowerCase();
							const matches =
								!target ||
								mName === target ||
								mName.endsWith("/" + target) ||
								mName.split(":")[0] === target ||
								target.endsWith("/" + mName);
							if (matches) {
								inp += Number(m[3]) || 0;
								out += Number(m[4]) || 0;
								read += Number(m[5]) || 0;
							}
						}
					}
				}
			}
		}
	} catch {
		// ignore
	}

	// 2. Tambahkan token sesi saat ini jika ada
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

export function sectionItemCount(body: string): number {
	const plain = body.replace(ANSI_RE, "").trim();
	return plain ? plain.split(/\n|, /).filter((s) => s.trim() !== "").length : 0;
}

export function rewriteSectionHeader(text: string, count: number, th: Themeish, keepBody = false): string {
	const name = sectionNameOf(text);
	const icon = name ? SECTION_ICONS[name] : undefined;
	if (!name || !icon) return text;
	const label = [
		fgFirst(th, ["accent", "tint"], icon),
		fgFirst(th, ["tint", "text"], name),
		fgFirst(th, ["dim"], `[${count}]`),
	].join(" ");
	const nl = text.indexOf("\n");
	const next = keepBody && nl !== -1 ? label + text.slice(nl) : label;
	return next.includes(name) && next.trim() !== "" ? next : text;
}

function insertAtVisible(s: string, visibleIndex: number, text: string): string {
	let seen = 0;
	for (let i = 0; i < s.length; i += 1) {
		if (seen === visibleIndex) return s.slice(0, i) + text + s.slice(i);
		if (s[i] === "\x1b") {
			const end = s.indexOf("m", i);
			i = end === -1 ? s.length : end;
			continue;
		}
		seen += 1;
	}
	return s + text;
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

export function withExtensionVersions(body: string, resolve: (label: string) => string | null = installedVersion): string {
	return body
		.split(", ")
		.map((label) => {
			const visible = stripAnsi(label);
			const colon = visible.indexOf(":");
			const name = (colon === -1 ? visible : visible.slice(0, colon)).trim();
			const version = name === "" || !packageNameOf(name) ? null : resolve(name);
			if (!version) return label;
			const at = colon === -1 ? visible.trimEnd().length : colon;
			return insertAtVisible(label, at, `@${version}`);
		})
		.join(", ");
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
		let modelLabel = `Model: ${fullModelName}`;
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
		const top = fgFirst(th, ["dim"], `╭${dash}╮`);
		const div1 = fgFirst(th, ["dim"], `├${dash}┤`);
		const div2 = fgFirst(th, ["dim"], `├${dash}┤`);
		const bot = fgFirst(th, ["dim"], `╰${dash}╯`);
		const blank = side + " ".repeat(Math.max(0, width - 2)) + side;

		const out: string[] = [];
		out.push(top);
		out.push(blank);

		// 1. Logo pi.dev ASCII art (P aksen, i tint)
		const logoLines = buildLogoLines(th);
		for (const line of logoLines) {
			out.push(centerLine(line, width, side));
		}
		out.push(blank);

		// 2. Baris versi pi & shortcuts
		const versionStr = VERSION || "0.87.1";
		const piPart = `${fgFirst(th, ["accent", "tint"], "\x1b[1mpi\x1b[22m")} ${fgFirst(th, ["dim"], `v${versionStr}`)}`;
		const sep = fgFirst(th, ["dim"], " │ ");
		const shortcutsFull = [
			piPart,
			`${fgFirst(th, ["tint"], "[Esc]")} ${fgFirst(th, ["dim"], "Interrupt")}`,
			`${fgFirst(th, ["tint"], "[Ctrl+c/d]")} ${fgFirst(th, ["dim"], "Exit")}`,
			`${fgFirst(th, ["tint"], "[/]")} ${fgFirst(th, ["dim"], "Commands")}`,
			`${fgFirst(th, ["tint"], "[!]")} ${fgFirst(th, ["dim"], "Bash")}`,
			`${fgFirst(th, ["tint"], "[Ctrl+o]")} ${fgFirst(th, ["dim"], "More/expand")}`,
		];
		let scText = shortcutsFull.join(sep);
		if (visibleWidth(scText) > width - 4) {
			const shortcutsCompact = [
				piPart,
				`${fgFirst(th, ["tint"], "[Esc]")} ${fgFirst(th, ["dim"], "Interrupt")}`,
				`${fgFirst(th, ["tint"], "[Ctrl+c/d]")} ${fgFirst(th, ["dim"], "Exit")}`,
				`${fgFirst(th, ["tint"], "[/]")} ${fgFirst(th, ["dim"], "Commands")}`,
				`${fgFirst(th, ["tint"], "[!]")} ${fgFirst(th, ["dim"], "Bash")}`,
				`${fgFirst(th, ["tint"], "[Ctrl+o]")} ${fgFirst(th, ["dim"], "More")}`,
			];
			scText = shortcutsCompact.join(sep);
			if (visibleWidth(scText) > width - 4) {
				scText = shortcutsCompact.slice(0, 4).join(sep);
			}
		}
		out.push(centerLine(scText, width, side));

		// 3. Divider 1 (tanpa baris model di atasnya untuk menghindari duplikasi)
		out.push(div1);

		// 4. Menu Tab: Icon = warna aksen, Teks = warna tint (bold jika aktif)
		const tabs = this.getTabsData(width);
		const sepTabPlain = width >= 105 ? "  │  " : " │ ";
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

		const totalTabPlainWidth = tabParts.reduce(
			(acc, t, idx) => acc + visibleWidth(t.plain) + (idx > 0 ? visibleWidth(sepTabPlain) : 0),
			0,
		);
		const leftPadTab = Math.max(0, Math.floor((width - 2 - totalTabPlainWidth) / 2));
		this.renderedTabRegions = [];
		let curX = 1 + leftPadTab;
		for (const t of tabParts) {
			const w = visibleWidth(t.plain);
			this.renderedTabRegions.push({ key: t.key, startX: curX, endX: curX + w });
			curX += w + visibleWidth(sepTabPlain);
		}
		this.renderedTabLineY = out.length;
		const tabsFormattedLine = tabParts.map((t) => t.formatted).join(sepTab);
		out.push(centerLine(tabsFormattedLine, width, side));

		// 5. Divider 2
		out.push(div2);

		// 6. Data tab aktif (rata tengah, dibungkus rapi, warna tint)
		let activeItems: string[] = [];
		if (this.activeTab === "Model") {
			const modelObj = this.ctx?.model ?? (globalThis as Record<symbol, any>)[MODEL_SNAPSHOT_KEY];
			const fullName = formatModelDisplayName(modelObj);
			const thLvl = this.ctx?.thinkingLevel ?? (globalThis as Record<symbol, any>)[THINKING_SNAPSHOT_KEY];
			const thinkLevel = thLvl && thLvl !== "off" ? capitalize(thLvl) : "Off";
			const sep = fgFirst(th, ["dim"], " · ");
			let line = `${fgFirst(th, ["tint", "text"], fullName)}${sep}${fgFirst(th, ["tint", "text"], `Thinking: ${thinkLevel}`)}`;

			// Total semua penggunaan model itu (all-time seperti di /usage): ↑... ↓...  ...
			const usage = getModelAllTimeUsage(modelObj?.id, this.ctx);
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
			const emptyMsg = fgFirst(th, ["tint"], "(kosong)");
			out.push(centerLine(emptyMsg, width, side));
		} else if (this.activeTab === "Model") {
			// Tab Model sudah memuat styling tint + separator dim
			for (const line of activeItems) {
				out.push(centerLine(line, width, side));
			}
		} else {
			const maxDataWidth = Math.max(10, width - 8);
			const lines = wrapCommaItems(activeItems, maxDataWidth);
			for (const line of lines) {
				// Poin 5: warna pada data menu yg di select gunakan tint saja
				out.push(centerLine(fgFirst(th, ["tint", "text"], line), width, side));
			}
		}

		// 7. Border bawah
		out.push(bot);

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

	pi.on("turn_end", async (_event, ctx) => {
		(globalThis as Record<symbol, any>)[USAGE_SNAPSHOT_KEY] = getSessionTokenUsage(ctx);
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
	assert(sectionItemCount("\x1b[2m  a, b, c\x1b[22m") === 3, "body collapsed (koma) = 3");
	assert(sectionItemCount("  a\n  b\n  c") === 3, "body expanded (baris) = 3");
	assert(sectionItemCount("") === 0, "body kosong = 0");

	const fakeTheme = { fg: (c: string, t: string) => `<${c}:${t}>` };
	const collapsedHdr = rewriteSectionHeader("\x1b[33m[Skills]\x1b[39m\n  a, b", 2, fakeTheme);
	assert(collapsedHdr === "<accent:\uec21> <tint:Skills> <dim:[2]>", "tertutup: ikon=aksen, nama=tint, [jumlah]=dim");

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

	const ansiTheme = { fg: (_c: string, t: string) => `\x1b[38;2;100;100;100m${t}\x1b[39m` };
	const hdr = new ArnativeHeader(fakeTui, ansiTheme, fakeCtx);
	assert(hdr.activeTab === "Model", "default tab adalah Model");

	const lines100 = hdr.render(100);
	assert(lines100.length > 10, "render 100 menghasilkan baris-baris box");
	assert(lines100.every((l) => visibleWidth(l) === 100), "semua baris render 100 tepat 100 kolom");
	assert(lines100[0]!.includes("╭") && lines100[0]!.includes("╮"), "border atas rounded");
	assert(lines100.some((l) => l.includes("Model: Gemini 3.8 Flash")), "menu tab Model tampil");
	assert(lines100.some((l) => l.includes("Gemini 3.8 Flash (Antigravity)")), "data tab aktif Model tampil langsung");

	// Tab regions: Model, Context, Skills, Extensions, Themes
	const tabY = (hdr as any).renderedTabLineY;
	assert(tabY > 0, "posisi Y baris tab tercatat");
	const tabRegions = (hdr as any).renderedTabRegions as Array<{ key: TabKey; startX: number; endX: number }>;
	assert(tabRegions.length === 5, "ada 5 region tab (termasuk Model)");

	// Klik tab Extensions
	const extRegion = tabRegions.find((r) => r.key === "Extensions")!;
	const clickExt = hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((extRegion.startX + extRegion.endX) / 2),
		y: tabY,
	} as any);
	assert(clickExt?.handled === true, "klik mouse pada tab Extensions handled");
	assert(hdr.activeTab === "Extensions", "activeTab berubah ke Extensions setelah klik");
	assert(renderRequested === true, "requestRender dipanggil saat tab berganti");

	const linesExt = hdr.render(100);
	assert(linesExt.some((l) => l.includes("@bismawy/pi-agentrouter@1.6.1")), "data tab Extensions tampil");

	// Klik tab Skills
	const skillsRegion = tabRegions.find((r) => r.key === "Skills")!;
	hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((skillsRegion.startX + skillsRegion.endX) / 2),
		y: tabY,
	} as any);
	assert(hdr.activeTab === "Skills", "activeTab berubah ke Skills setelah klik");

	const linesSkills = hdr.render(100);
	assert(linesSkills.some((l) => l.includes("agents-sdk, cloudflare")), "data tab Skills tampil");
	const divIndices = linesSkills.map((l, i) => (l.includes("├") ? i : -1)).filter((i) => i !== -1);
	const contentLines = linesSkills.slice(divIndices[1]! + 1, -1);
	assert(!contentLines.some((l) => l.includes("Gemini 3.8 Flash (Antigravity)")), "data Model tidak tampil di konten tab Skills");

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
