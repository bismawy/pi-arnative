/**
 * Arnative footer & transcript timestamp enhancer.
 * Baris 1:  cwd [| branch | tag] ...... model.
 * Baris 2: status extension lain (mcp dulu) ...... cache optimizer.
 *
 * Transkrip timestamp:
 * - User: jam rata kanan sejajar kolom paling kanan, warna aksen, tanpa background.
 *   Konten tidak pernah dipotong; bila baris pertama penuh, jam turun ke baris
 *   padding bawah bubble.
 * - Assistant: jam hanya pada respons akhir (pesan tanpa toolCall), bukan di
 *   Thinking... atau giliran perantara.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomEditor,
	FooterComponent,
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

// Intercept built-in FooterComponent agar murni 2 baris
const PATCHED_KEY = Symbol.for("pi-arnative.footer2LinesPatched");
if (FooterComponent?.prototype?.render && !(globalThis as Record<symbol, boolean>)[PATCHED_KEY]) {
	(globalThis as Record<symbol, boolean>)[PATCHED_KEY] = true;
	const origRender = FooterComponent.prototype.render;
	FooterComponent.prototype.render = function (width: number): string[] {
		const lines = origRender.call(this, width);
		return lines.length > 2 ? lines.slice(0, 2) : lines;
	};
}

const USER_TIMESTAMPS_MAP = new Map<string, number>();
let activeThemeProxy: { fg(color: string, text: string): string } | null = null;

function formatClock(timestamp?: number): string {
	const d = timestamp && timestamp > 0 ? new Date(timestamp) : new Date();
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}

export function formatTimeBadge(timeStr: string, th: { fg(color: string, text: string): string } | null): string {
	if (th) {
		try {
			return th.fg("accent", timeStr);
		} catch {
			// fallback
		}
	}
	return `\x1b[36m${timeStr}\x1b[39m`;
}

// Kode pembuka bg bubble user (tanpa reset penutup) - probe dari tema aktif.
export function bubbleBgOpen(th: { bg?(c: string, t: string): string } | null): string {
	if (!th?.bg) return "";
	try {
		const probe = th.bg("userMessageBg", "");
		const reset = "\x1b[49m";
		return probe.endsWith(reset) ? probe.slice(0, -reset.length) : probe;
	} catch {
		return "";
	}
}

// Akar "block hitam" saat chat penuh: teks Markdown membawa \x1b[0m (reset semua)
// di dalam baris -> spasi padding SETELAH reset kehilangan bg bubble dan tampil
// gelap selebar sisa baris. Pasang ulang bg bubble setelah tiap reset, tutup bg
// di akhir baris agar tidak bocor. Pola sama InputBgEditor di bawah.
export function repairBubbleBg(line: string, bgOpen: string): string {
	if (!bgOpen) return line;
	const patched = line.split("\x1b[0m").join(`\x1b[0m${bgOpen}`).split("\x1b[49m").join(`\x1b[49m${bgOpen}`);
	return patched.endsWith(bgOpen) ? `${patched}\x1b[49m` : patched;
}

/**
 * Tempel jam di ujung kanan sebuah baris.
 * Jika `stripBg` true, background baris dibuang khusus di area jam sehingga
 * jam tampil dengan warna teks polos (tanpa background bubble).
 */
export function placeTimeAtRight(
	line: string,
	width: number,
	timeBadge: string,
	timeW: number,
	stripBg = false,
): string {
	const targetCol = Math.max(0, width - timeW);
	const leftPart = sliceByColumn(line, 0, targetCol, true);
	const leftW = visibleWidth(leftPart);
	const pad = " ".repeat(Math.max(0, targetCol - leftW));
	const reset = stripBg ? "\x1b[49m" : "";
	return `${leftPart}${pad}${reset}${timeBadge}${reset}`;
}

const CHAT_TIMESTAMP_PATCHED = Symbol.for("pi-arnative.chatTimestampPatched");
if (!(globalThis as Record<symbol, boolean>)[CHAT_TIMESTAMP_PATCHED]) {
	(globalThis as Record<symbol, boolean>)[CHAT_TIMESTAMP_PATCHED] = true;

	if (UserMessageComponent?.prototype?.render) {
		const origRender = UserMessageComponent.prototype.render;
		UserMessageComponent.prototype.render = function (width: number): string[] {
			const lines = origRender.call(this, width);
			if (lines.length < 2) return lines;

			// Perbaiki bg bubble dulu (baris Markdown ber-reset bikin padding gelap),
			// baru tempel jam (yang sengaja membuang bg di area badge).
			const bgOpen = bubbleBgOpen(activeThemeProxy);
			for (let i = 0; i < lines.length; i++) lines[i] = repairBubbleBg(lines[i], bgOpen);

			const textKey = (this as { text?: string }).text?.trim() ?? "";
			const ts = (this as { _arnativeTimestamp?: number })._arnativeTimestamp ?? USER_TIMESTAMPS_MAP.get(textKey);
			const timeStr = formatClock(ts);
			const badge = formatTimeBadge(timeStr, activeThemeProxy);
			const timeW = visibleWidth(timeStr);

			// Baris teks pertama ada di index 1 (di bawah top-padding box)
			const contentLine = lines[1];
			const cleanContent = contentLine.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
			const contentW = visibleWidth(cleanContent);
			const minGap = 2;

			if (contentW + minGap + timeW <= width) {
				// Muat di baris teks pertama: tempel rata kanan persis, tanpa memotong konten
				lines[1] = placeTimeAtRight(contentLine, width, badge, timeW, true);
			} else {
				// Baris teks pertama terlalu panjang: JANGAN potong konten!
				// Pindahkan jam ke baris padding bawah bubble (selalu ada dan kosong)
				const lastIdx = lines.length - 1;
				lines[lastIdx] = placeTimeAtRight(lines[lastIdx], width, badge, timeW, true);
			}
			return lines;
		};
	}

	if (AssistantMessageComponent?.prototype?.render) {
		const origRender = AssistantMessageComponent.prototype.render;
		AssistantMessageComponent.prototype.render = function (width: number): string[] {
			const lines = origRender.call(this, width);
			const lastMsg = (this as { lastMessage?: AssistantMessage }).lastMessage;

			// Jam hanya ditampilkan di respons akhir (pesan yang tidak memiliki toolCall)
			const hasToolCalls = lastMsg?.content?.some((c) => c.type === "toolCall");
			if (hasToolCalls) return lines;

			// Dan hanya jika ada teks jawaban yang nyata (bukan hanya thinking)
			const hasText = lastMsg?.content?.some((c) => c.type === "text" && c.text.trim());
			if (!hasText || lines.length === 0) return lines;

			const timeStr = formatClock(lastMsg?.timestamp);
			const badge = formatTimeBadge(timeStr, activeThemeProxy);
			const timeW = visibleWidth(timeStr);

			// Cari baris teks pertama yang bukan zona OSC dan bukan header thinking
			let targetIdx = -1;
			for (let i = 0; i < lines.length; i++) {
				const cleaned = lines[i].replace(/^(\x1b\]133;[A-Z]\x07)+/, "").trim();
				// Jangan tempel di baris "Thinking..."
				if (cleaned.length > 0 && !/^thinking\b/i.test(cleaned)) {
					targetIdx = i;
					break;
				}
			}

			if (targetIdx !== -1) {
				let prefix = "";
				let rest = lines[targetIdx];
				const oscMatch = rest.match(/^(\x1b\]133;[A-Z]\x07)+/);
				if (oscMatch) {
					prefix = oscMatch[0];
					rest = rest.slice(prefix.length);
				}

				const cleanText = rest.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
				const textW = visibleWidth(cleanText);
				const minGap = 2;

				if (textW + minGap + timeW <= width) {
					lines[targetIdx] = `${prefix}${placeTimeAtRight(rest, width, badge, timeW, false)}`;
				}
			}
			return lines;
		};
	}
}

type GitInfo = { branch: string; tag: string; uncommitted: number; ahead: number; behind: number } | null;
let gitRefreshInFlight = false;

let git: GitInfo = null;
let currentThinkingLevel: string | undefined = undefined;
let currentModel: { id: string; name?: string; provider?: string } | undefined = undefined;
let rerender: (() => void) | null = null;
let lastPokeMs = 0;

const SESSION_START_KEY = Symbol.for("pi-arnative.sessionStartMs");
let sessionStartMs: number = (globalThis as Record<symbol, number>)[SESSION_START_KEY] || Date.now();
(globalThis as Record<symbol, number>)[SESSION_START_KEY] = sessionStartMs;

const MODEL_KEY = Symbol.for("pi-arnative.currentModel");
const THINKING_KEY = Symbol.for("pi-arnative.currentThinking");
const CWD_KEY = Symbol.for("pi-arnative.lastCwd");
const GIT_KEY = Symbol.for("pi-arnative.lastGit");
const GEN_KEY = Symbol.for("pi-arnative.footerGen");
let footerGen = (globalThis as Record<symbol, number>)[GEN_KEY] || 0;

let assistantStartMs: number | null = null;
let assistantChars = 0;
let latestSpeed: number | null = null;

function run(cmd: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout: 2000 }, (err, stdout) => {
			resolve(err ? "" : String(stdout).trim());
		});
	});
}

async function refreshGit(cwd: string): Promise<void> {
	if (gitRefreshInFlight) return;
	gitRefreshInFlight = true;
	const branch = await run("git", ["branch", "--show-current"], cwd);
	if (!branch) {
		git = null;
		gitRefreshInFlight = false;
		return;
	}
	const [tag, status, sync] = await Promise.all([
		run("git", ["describe", "--tags", "--abbrev=0"], cwd),
		run("git", ["status", "--porcelain"], cwd),
		run("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"], cwd),
	]);
	const uncommitted = status ? status.split("\n").filter((l) => l.trim().length > 0).length : 0;
	const parts = sync.trim() === "" ? [] : sync.trim().split(/\s+/).map(Number);
	const behind = parts.length > 0 && parts[0] > 0 ? parts[0] : 0;
	const ahead = parts.length > 1 && parts[1] > 0 ? parts[1] : 0;
	git = {
		branch,
		tag: tag || "-",
		uncommitted,
		ahead,
		behind,
	};
	(globalThis as Record<symbol, any>)[GIT_KEY] = git;
	gitRefreshInFlight = false;
}

function formatModelName(
	model: { id: string; name?: string; provider?: string } | undefined,
	thinkingLevel: string | undefined,
	acc: (t: string) => string,
	tint: (t: string) => string,
	dim: (t: string) => string,
): string {
	if (!model) return dim("No Model");
	let name = model.name || model.id;
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
	const provStr = provider ? ` ${dim(`(${provider})`)}` : "";
	const capThinking = thinkingLevel && thinkingLevel !== "off" ? thinkingLevel.charAt(0).toUpperCase() + thinkingLevel.slice(1) : "";
	const thinkStr = capThinking ? `${acc("\udb80\udf35")} ${tint(capThinking)} ${dim("·")} ` : "";
	return `${thinkStr}${acc(name)}${provStr}`;
}

export function formatDuration(ms: number): string {
	if (!ms || ms <= 0) return "-";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatTokens(n: number): string {
	if (!n || n <= 0) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
	}
	const m = n / 1_000_000;
	return `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

function parseOptimizer(raw: string | undefined): string | null {
	if (!raw) return null;
	const m = raw.match(/([A-Za-z0-9_-]+)\s+cache\s+(\d+\/\d+)·[^\s]+\s+([\d.]+%)/);
	return m ? `${m[1]} ${m[2]} (${m[3]})` : null;
}

function getUsage(
	ctx: { sessionManager: { getBranch(): readonly unknown[] }; getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined },
	acc: (t: string) => string,
	tint: (t: string) => string,
): string {
	let inp = 0;
	let out = 0;
	let read = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e && typeof e === "object" && "type" in e && e.type === "message") {
			const m = (e as { message?: unknown }).message;
			if (m && typeof m === "object" && "role" in m && m.role === "assistant" && "usage" in m) {
				const u = (m as AssistantMessage).usage;
				if (u) {
					inp += u.input || 0;
					out += u.output || 0;
					read += u.cacheRead || 0;
				}
			}
		}
	}
	const parts: string[] = [];
	if (inp > 0) parts.push(`${acc("↑")}${tint(formatTokens(inp))}`);
	if (out > 0) parts.push(`${acc("↓")}${tint(formatTokens(out))}`);
	if (read > 0) parts.push(`${acc("\uf49b")} ${tint(formatTokens(read))}`);
	const u = ctx.getContextUsage();
	if (u && u.percent !== null && u.tokens !== null) {
		parts.push(`${acc("\udb81\udfaf")} ${tint(`${u.percent.toFixed(1)}%/${formatTokens(u.contextWindow)}`)}`);
	}
	return parts.join(" ");
}

function poke(): void {
	try {
		rerender?.();
	} catch {
		// ignore
	}
}

export default function (pi: ExtensionAPI) {
	let runtimeGen = 0;

	// Catat timestamp pesan user ke map; mulai timer kecepatan asisten
	pi.on("message_start", async (event) => {
		if (event.message.role === "user") {
			const text = typeof event.message.content === "string"
				? event.message.content
				: event.message.content?.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("") ?? "";
			if (text.trim()) {
				USER_TIMESTAMPS_MAP.set(text.trim(), event.message.timestamp || Date.now());
			}
		} else if (event.message.role === "assistant") {
			assistantStartMs = Date.now();
			assistantChars = 0;
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "reload") {
			sessionStartMs = Date.now();
			(globalThis as Record<symbol, number>)[SESSION_START_KEY] = sessionStartMs;
			currentModel = ctx.model;
			currentThinkingLevel = ctx.thinkingLevel;
			git = null;
		} else {
			currentModel = (globalThis as Record<symbol, any>)[MODEL_KEY] ?? ctx.model;
			currentThinkingLevel = (globalThis as Record<symbol, any>)[THINKING_KEY] ?? ctx.thinkingLevel;
			git = (globalThis as Record<symbol, any>)[GIT_KEY] ?? null;
		}
		(globalThis as Record<symbol, any>)[MODEL_KEY] = currentModel;
		(globalThis as Record<symbol, any>)[THINKING_KEY] = currentThinkingLevel;
		(globalThis as Record<symbol, any>)[GIT_KEY] = git;

		const cwd = (event.reason === "reload" && (globalThis as Record<symbol, any>)[CWD_KEY])
			? (globalThis as Record<symbol, any>)[CWD_KEY]
			: ctx.cwd;
		(globalThis as Record<symbol, any>)[CWD_KEY] = cwd;

		runtimeGen = ++footerGen;
		(globalThis as Record<symbol, number>)[GEN_KEY] = footerGen;

		try {
			ctx.ui.setFooter((tui, theme, footerData) => {
				activeThemeProxy = theme;
				rerender = () => tui.requestRender();
				const unsub = footerData.onBranchChange(() => {
					void refreshGit(cwd).then(() => tui.requestRender());
				});
				return {
					dispose() {
						rerender = null;
						unsub();
					},
					invalidate() {},
					render(width: number): string[] {
						const acc = (text: string) => theme.fg("accent", text);
						const dim = (text: string) => theme.fg("dim", text);
						const fgAny = theme.fg.bind(theme) as (color: string, text: string) => string;
						let tintName = "accent";
						try {
							fgAny("tint", "");
							tintName = "tint";
						} catch {
							// fallback
						}
						const tint = (text: string) => fgAny(tintName, text);
						const sep = dim(" | ");

						const durationStr = formatDuration(Date.now() - sessionStartMs);
						const pDuration = `${acc("\uf017")} ${tint(durationStr)}`;
						let left1 = `${acc("\uf07b")} ${dim(cwd)}${sep}${pDuration}`;
						if (git) {
							const gitIcon = acc("\uf172");
							const gitText = git.uncommitted > 0 ? tint(`~${git.uncommitted}`) : tint("clean");
							const pBranch = `${acc("\uf126")} ${tint(git.branch)}${git.ahead > 0 ? ` ${tint(`↑${git.ahead}`)}` : ""}${git.behind > 0 ? ` ${tint(`↓${git.behind}`)}` : ""}`;
							const pTag = `${acc("\uf02b")} ${tint(git.tag)}`;
							const pState = `${gitIcon}  ${gitText}`;
							left1 = `${acc("\uf07b")} ${dim(cwd)}${sep}${pDuration}${sep}${pBranch}${sep}${pTag}${sep}${pState}`;
						}
						const right1 = formatModelName(currentModel, currentThinkingLevel, acc, tint, dim);
						const pad1 = " ".repeat(Math.max(1, width - visibleWidth(left1) - visibleWidth(right1)));
						const lines = [truncateToWidth(left1 + pad1 + right1, width)];

						const statuses: ReadonlyMap<string, string> = (() => {
							try {
								return footerData.getExtensionStatuses();
							} catch {
								return new Map<string, string>();
							}
						})();
						const rawCache = statuses.get("pi-cache-stats");
						const segs: string[] = [];
						const cleanStatus = (s: string) => {
							if (s.includes("MCP:")) {
								let clean = s.replace(/\x1b\[[0-9;]*m/g, "").replace(/^[0-9;]+m/, "");
								const idx = clean.indexOf("MCP:");
								let rest = (idx >= 0 ? clean.slice(idx) : clean).replace(/\uFFFD/g, "").trim();
								rest = rest.replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u2800-\u28FF]/gu, "").replace(/\s{2,}/g, " ").trim();
								const m = rest.match(/MCP:\s*\d+\s*servers?\s*enabled/i);
								return `${acc("\uf233")} ${tint(m ? m[0] : rest || "MCP")}`;
							}
							if (s.includes("ponytail")) {
								const isActive = s.includes("●");
								const bullet = isActive ? acc("●") : dim("○");
								let mode = "FULL";
								if (/LITE/i.test(s)) mode = "LITE";
								else if (/ULTRA/i.test(s)) mode = "ULTRA";
								else if (/FULL/i.test(s)) mode = "FULL";
								return `${acc("\uef04")}  ${tint("ponytail:")} ${bullet} ${tint(mode)}`;
							}
							if (s.includes("jev-eye")) {
								const isOff = s.includes("OFF") || s.includes("○");
								const isReview = /REVIEW/i.test(s);
								let bullet = isOff ? dim("○") : acc("●");
								if (isReview) {
									try {
										bullet = theme.fg("warning", "●");
									} catch {
										bullet = acc("●");
									}
								}
								const label = isOff ? "OFF" : isReview ? "REVIEW" : "ON";
								return `${acc("\uedcf")}  ${tint("Jev:")} ${bullet} ${tint(label)}`;
							}
							let clean = s.replace(/\x1b\[[0-9;]*m/g, "").replace(/^[0-9;]+m/, "");
							clean = clean.replace(/\uFFFD/g, "").replace(/\?{1,2}\s*/g, "");
							return tint(clean.trim());
						};

						const mcp = statuses.get("mcp");
						if (mcp !== undefined) segs.push(cleanStatus(mcp));
						for (const [k, s] of statuses) {
							if (k !== "mcp" && k !== "pi-cache-stats") segs.push(cleanStatus(s));
						}
						const left2 = segs.join(sep);

						const opt = parseOptimizer(rawCache);
						let usageStr = "";
						try {
							usageStr = getUsage(ctx, acc, tint);
						} catch {
							// fallback
						}
						let right2 = "";
						if (opt && usageStr) {
							right2 = `${tint(opt)} ${dim("·")} ${usageStr}`;
						} else if (opt) {
							right2 = tint(opt);
						} else if (usageStr) {
							right2 = usageStr;
						}

						if (!right2) {
							lines.push(truncateToWidth(left2, width));
						} else {
							const pad2 = " ".repeat(Math.max(1, width - visibleWidth(left2) - visibleWidth(right2)));
							lines.push(truncateToWidth(left2 + pad2 + right2, width));
						}

						const right3 = latestSpeed !== null && latestSpeed > 0 ? `${acc("\udb81\udcc5")} ${tint(`${latestSpeed.toFixed(1)} tok/s`)}` : "";
						if (right3) {
							const pad3 = " ".repeat(Math.max(1, width - visibleWidth(right3)));
							lines.push(truncateToWidth(pad3 + right3, width));
						}
						return lines;
					},
				};
			});

			class ArnativeEditor extends CustomEditor {
				constructor(tui: any, editorTheme: any, keybindings: any, options?: any) {
					super(tui, editorTheme, keybindings, { ...options, embedWorkingStatus: true });
				}

				private getActiveTheme() {
					return ctx.ui?.theme ?? activeThemeProxy;
				}

				private applyFixedIndicatorColors(indicator: any) {
					if (!indicator) return;
					indicator.spinnerColorFn = (text: string) => {
						try {
							const th = this.getActiveTheme();
							return th ? th.fg("accent", text) : text;
						} catch {
							return text;
						}
					};
					indicator.messageColorFn = (text: string) => {
						try {
							const th = this.getActiveTheme();
							if (!th) return text;
							try {
								return th.fg("tint", text);
							} catch {
								return th.fg("muted", text);
							}
						} catch {
							return text;
						}
					};
				}

				setWorkingStatusIndicator(indicator: any) {
					this.applyFixedIndicatorColors(indicator);
					indicator?.updateDisplay?.();
					super.setWorkingStatusIndicator(indicator);
				}

				renderTopBorder(width: number, hiddenLineCount: number): string {
					this.applyFixedIndicatorColors((this as any).workingStatusIndicator);
					return super.renderTopBorder(width, hiddenLineCount);
				}
			}
			ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new ArnativeEditor(tui, editorTheme, keybindings));
		} catch {
			// fallback
		}
		void refreshGit(cwd).then(() => poke());
	});

	pi.on("turn_start", async (_event, ctx) => {
		currentModel = ctx.model;
		currentThinkingLevel = ctx.thinkingLevel;
		(globalThis as Record<symbol, any>)[MODEL_KEY] = currentModel;
		(globalThis as Record<symbol, any>)[THINKING_KEY] = currentThinkingLevel;
		(globalThis as Record<symbol, any>)[CWD_KEY] = ctx.cwd;
		void refreshGit(ctx.cwd).then(() => poke());
	});

	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant" && assistantStartMs !== null) {
			const streamEvent = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
			if (streamEvent?.delta) {
				assistantChars += streamEvent.delta.length;
			}
			const elapsed = (Date.now() - assistantStartMs) / 1000;
			if (elapsed >= 0.3) {
				const usageOut = (event.message as AssistantMessage).usage?.output;
				const currentTokens = typeof usageOut === "number" && usageOut > 0 ? usageOut : Math.ceil(assistantChars / 3.8);
				if (currentTokens > 0) {
					latestSpeed = currentTokens / elapsed;
					const now = Date.now();
					if (now - lastPokeMs >= 500) {
						lastPokeMs = now;
						poke();
					}
				}
			}
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant" && assistantStartMs !== null) {
			const elapsed = (Date.now() - assistantStartMs) / 1000;
			assistantStartMs = null;
			const usageOut = (event.message as AssistantMessage).usage?.output;
			const finalTokens = typeof usageOut === "number" && usageOut > 0 ? usageOut : Math.ceil(assistantChars / 3.8);
			if (finalTokens > 0 && elapsed > 0.2) {
				latestSpeed = finalTokens / elapsed;
			}
		}
		poke();
	});

	pi.on("turn_end", async () => {
		poke();
	});

	pi.on("model_select", async (event) => {
		currentModel = event.model;
		(globalThis as Record<symbol, any>)[MODEL_KEY] = currentModel;
		poke();
	});

	pi.on("thinking_level_select", async (event) => {
		currentThinkingLevel = event.level;
		(globalThis as Record<symbol, any>)[THINKING_KEY] = currentThinkingLevel;
		poke();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		rerender = null;
		const cur = ((globalThis as Record<symbol, number>)[GEN_KEY] ?? 0);
		if (cur !== runtimeGen) return;
		footerGen++;
		(globalThis as Record<symbol, number>)[GEN_KEY] = footerGen;
		try {
			(ctx as unknown as { ui?: { setFooter?: (f?: undefined) => void } }).ui?.setFooter?.(undefined);
		} catch {
			// ignore
		}
	});
}

// Self-check: `node extensions/footer.ts`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"));
if (isMain) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};
	const badge = "\x1b[36m17:09\x1b[39m";
	const badgeW = 5;

	// Penempatan jam persis rata kanan
	const res1 = placeTimeAtRight("Short text", 30, badge, badgeW, false);
	assert(visibleWidth(res1) === 30, "panjang baris pas selebar terminal");
	assert(res1.endsWith(badge), "badge di ujung kanan");

	// Dengan stripBg (untuk bubble user)
	const bg = "\x1b[48;2;52;53;61m";
	const res2 = placeTimeAtRight(`${bg}Short text`, 30, badge, badgeW, true);
	assert(res2.includes("\x1b[49m" + badge + "\x1b[49m"), "background di-reset di area jam");
	assert(visibleWidth(res2) === 30, "panjang baris tetap pas lebar");

	// repair bg bubble: spasi setelah [0m] wajib ber-bg, baris ditutup [49m]
	const dirty = `${bg}Hello\x1b[0m${" ".repeat(5)}\x1b[49m`;
	const clean = repairBubbleBg(dirty, bg);
	assert(clean.includes(`\x1b[0m${bg}`), "bg dipasang ulang setelah reset");
	assert(clean.endsWith("\x1b[49m"), "bg bubble ditutup di akhir baris");
	assert(repairBubbleBg("plain", "") === "plain", "tanpa bgOpen: tanpa perubahan");
	assert(bubbleBgOpen(null) === "", "tanpa tema: bgOpen kosong");
	assert(
		bubbleBgOpen({ bg: (_c, t) => `\x1b[48;2;52;53;61m${t}\x1b[49m` }) === "\x1b[48;2;52;53;61m",
		"bgOpen terambil dari probe tema",
	);

	// Teks panjang: sliceByColumn tidak merusak lebar
	const longLine = "a".repeat(40);
	const res3 = placeTimeAtRight(longLine, 30, badge, badgeW, false);
	assert(visibleWidth(res3) === 30, "teks panjang dipotong pas di targetCol");

	console.log("footer.ts self-check OK");
}
