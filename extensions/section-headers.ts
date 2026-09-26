/**
 * Arnative Header Box & Tab System:
 * - Gaya box rounded corner (seperti chat/editor).
 * - Logo pi.dev ASCII art (hijau emerald gradasi).
 * - Baris info versi pi & shortcuts: [Esc], [Ctrl+c/d], [/], [!], [Ctrl+o].
 * - Baris model & thinking level: Model: <Nama> (<Provider>) · <Level> Thinking.
 * - Divider box '├────┤'.
 * - Menu Tab interaktif (klik mouse): 󰋖 Context [N] │ 󰰡 Skills [N] │ 󰺨 Extensions [N] │ 󰹲 Themes [N].
 * - Divider box '├────┤'.
 * - Isi data tab aktif (rata tengah, dibungkus rapi, tidak bertumpuk).
 * - Sembunyikan daftar tumpukan bawaan pi di loadedResourcesContainer.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

export type TabKey = "Context" | "Skills" | "Extensions" | "Themes";

export const SECTION_ICONS: Record<TabKey, string> = {
	Context: "\udb84\uddd7",
	Skills: "\uec21",
	Extensions: "\ueea8",
	Themes: "\uee72",
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

export type Themeish = { fg?(color: string, text: string): string; bg?(color: string, text: string): string } | null;

let activeThemeProxy: Themeish = null;

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

export function sectionNameOf(text: string): TabKey | null {
	const nl = text.indexOf("\n");
	const first = (nl === -1 ? text : text.slice(0, nl)).replace(ANSI_RE, "").trim();
	const m = /^\[([A-Za-z]+)\]$/.exec(first);
	const name = m ? m[1] : null;
	if (name === "Context" || name === "Skills" || name === "Extensions" || name === "Themes") {
		return name as TabKey;
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

// Logo pi.dev ASCII art (gradasi hijau pixelated seperti gambar referensi)
const G1 = "\x1b[38;2;74;222;128m";
const G2 = "\x1b[38;2;34;197;94m";
const G3 = "\x1b[38;2;16;185;129m";
const G4 = "\x1b[38;2;52;211;153m";
const R = "\x1b[39m";

export const ASCII_LOGO_LINES = [
	`${G1}████████        ${R}`,
	`${G1}██    ${G2}██        ${R}`,
	`${G2}████████  ${G4}████  ${R}`,
	`${G3}██        ${G3}████  ${R}`,
	`${G3}██        ${G3}████  ${R}`,
];

// Singleton store untuk resource loaded
const STORE_KEY = Symbol.for("pi-arnative.resourceStore");
export const tabStore: Map<TabKey, string[]> =
	(globalThis as Record<symbol, Map<TabKey, string[]>>)[STORE_KEY] ??
	new Map<TabKey, string[]>([
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

export class ArnativeHeader implements Component {
	public activeTab: TabKey = "Extensions";
	private renderedTabLineY = -1;
	private renderedTabRegions: Array<{ key: TabKey; startX: number; endX: number }> = [];

	public tui: TUI;
	public themeProxy: Themeish;
	public ctx?: ExtensionContext;

	constructor(
		tui: TUI,
		themeProxy: Themeish,
		ctx?: ExtensionContext,
	) {
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

	getTabsData(): Array<{ key: TabKey; name: string; icon: string; count: number }> {
		const keys: TabKey[] = ["Context", "Skills", "Extensions", "Themes"];
		return keys.map((key) => ({
			key,
			name: key,
			icon: SECTION_ICONS[key],
			count: tabStore.get(key)?.length ?? 0,
		}));
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

		// 1. Logo pi.dev
		for (const line of ASCII_LOGO_LINES) {
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

		// 3. Baris Model & Thinking Level
		const modelObj = this.ctx?.model;
		const modelName = modelObj?.name || modelObj?.id || "Model";
		const provider = modelObj?.provider ? ` (${capitalize(modelObj.provider)})` : "";
		const fullModel = `${modelName}${provider}`;
		let thinkingLabel = "Thinking";
		const thLvl = this.ctx?.thinkingLevel;
		if (thLvl) {
			thinkingLabel = thLvl === "off" ? "No Thinking" : `${capitalize(thLvl)} Thinking`;
		}
		const modelPrefix = fgFirst(th, ["dim"], "Model: ");
		const modelText = fgFirst(th, ["tint", "text"], `\x1b[1m${fullModel}\x1b[22m`);
		const dot = fgFirst(th, ["dim"], " · ");
		const thinkingText = fgFirst(th, ["accent", "tint"], thinkingLabel);
		out.push(centerLine(`${modelPrefix}${modelText}${dot}${thinkingText}`, width, side));

		// 4. Divider 1
		out.push(div1);

		// 5. Menu Tab
		const tabs = this.getTabsData();
		const sepTab = fgFirst(th, ["dim"], "  │  ");
		const sepTabPlain = "  │  ";
		const tabParts: Array<{ key: TabKey; plain: string; formatted: string }> = [];
		for (const t of tabs) {
			const countStr = `[${t.count}]`;
			const plain = `${t.icon} ${t.name} ${countStr}`;
			const isActive = t.key === this.activeTab;
			const formatted = isActive
				? fgFirst(th, ["accent", "tint"], `\x1b[1m${t.icon} ${t.name} ${countStr}\x1b[22m`)
				: fgFirst(th, ["dim"], `${t.icon} ${t.name} ${countStr}`);
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

		// 6. Divider 2
		out.push(div2);

		// 7. Data tab aktif (rata tengah, dibungkus rapi)
		const activeItems = tabStore.get(this.activeTab) ?? [];
		if (activeItems.length === 0) {
			const emptyMsg = fgFirst(th, ["dim"], "(kosong)");
			out.push(centerLine(emptyMsg, width, side));
		} else {
			const maxDataWidth = Math.max(10, width - 8);
			const lines = wrapCommaItems(activeItems, maxDataWidth);
			for (const line of lines) {
				out.push(centerLine(fgFirst(th, ["dim", "text"], line), width, side));
			}
		}

		// 8. Border bawah
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
	assert(hdr.activeTab === "Extensions", "default tab adalah Extensions");

	const lines100 = hdr.render(100);
	assert(lines100.length > 10, "render 100 menghasilkan baris-baris box");
	assert(lines100.every((l) => visibleWidth(l) === 100), "semua baris render 100 tepat 100 kolom");
	assert(lines100[0]!.includes("╭") && lines100[0]!.includes("╮"), "border atas rounded");
	assert(lines100.some((l) => l.includes("Gemini 3.8 Flash (Antigravity)")), "baris model tampil");
	assert(lines100.some((l) => l.includes("Low Thinking")), "baris thinking tampil");
	assert(lines100.some((l) => l.includes("@bismawy/pi-agentrouter@1.6.1")), "data tab aktif Extensions tampil");

	// Tes klik mouse berganti tab
	const tabY = (hdr as any).renderedTabLineY;
	assert(tabY > 0, "posisi Y baris tab tercatat");
	const tabRegions = (hdr as any).renderedTabRegions as Array<{ key: TabKey; startX: number; endX: number }>;
	assert(tabRegions.length === 4, "ada 4 region tab");

	const skillsRegion = tabRegions.find((r) => r.key === "Skills")!;
	const clickSkills = hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((skillsRegion.startX + skillsRegion.endX) / 2),
		y: tabY,
	} as any);
	assert(clickSkills?.handled === true, "klik mouse pada tab Skills handled");
	assert(hdr.activeTab === "Skills", "activeTab berubah ke Skills setelah klik");
	assert(renderRequested === true, "requestRender dipanggil saat tab berganti");

	const linesSkills = hdr.render(100);
	assert(linesSkills.some((l) => l.includes("agents-sdk, cloudflare")), "data tab Skills tampil");
	assert(!linesSkills.some((l) => l.includes("@bismawy/pi-agentrouter@1.6.1")), "data Extensions tidak tampil di tab Skills");

	// Klik tab Context
	const ctxRegion = tabRegions.find((r) => r.key === "Context")!;
	hdr.handleMouse({
		type: "click",
		button: "left",
		x: Math.floor((ctxRegion.startX + ctxRegion.endX) / 2),
		y: tabY,
	} as any);
	assert(hdr.activeTab === "Context", "activeTab berubah ke Context");
	const linesCtx = hdr.render(100);
	assert(linesCtx.some((l) => l.includes("AGENTS.md")), "data Context tampil");

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
