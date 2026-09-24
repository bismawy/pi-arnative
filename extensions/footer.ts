/**
 * Arnative footer.
 * Baris 1: 📁 cwd [| branch | tag] ...... model.
 * Baris 2: status extension lain (mcp dulu) ...... cache optimizer.
 * Git via exec langsung, tampil hanya di repo. Saat reload/new: footer
 * default murni dulu, lalu sekali switch ke pi-arnative setelah jeda.
 * Disegarkan tiap turn, pesan, dan ganti model agar status hidup.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";

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
// Generasi pemasangan footer: reload/new beruntun membatalkan jadwal lama
// agar yang tampil murni default dulu, lalu sekali switch ke pi-arnative.
const GEN_KEY = Symbol.for("pi-arnative.footerGen");
let footerGen = (globalThis as Record<symbol, number>)[GEN_KEY] || 0;

// Jeda sebelum pasang footer kustom (riwayat: 250ms di 238ca81).
// 50ms: cukup 1-3 frame agar default sempat tampil, tapi lebih cepat dari
// datangnya status ekstensi (itu yang membentuk frame-3-baris mentah).
// 0 = tanpa kedip default; naikkan hanya bila frame mentah kembali muncul.
const FOOTER_DELAY_MS = 0;

// ponytail: log debug sementara, hapus setelah verifikasi /reload.
const LOG_PATH = "/tmp/pi-arnative-footer.log";
function dlog(...parts: unknown[]): void {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${parts.map(String).join(" ")}\n`);
	} catch {
		// abaikan
	}
}

// Telemetri kecepatan token streaming murni (tok/s)
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
	// sync: "behind ahead"; tanpa upstream -> "" -> 0/0 (disembunyikan)
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

function formatDuration(ms: number): string {
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
		// abaikan: tui bisa sudah dispose saat session tutup
	}
}

export default function (pi: ExtensionAPI) {
	// Generasi milik runtime ini: shutdown lama tidak boleh membatalkan start baru.
	let runtimeGen = 0;
	const rid = Math.random().toString(36).slice(2, 7);
	dlog(rid, "factory-load");
	pi.on("session_start", async (event, ctx) => {
		// reload = sesi yang sama lanjut -> timer jangan reset; new/resume/fork/startup = sesi baru
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

		// Default murni dulu (sekedip), lalu langsung pi-arnative: pasang cepat,
		// git menyusul via background refresh agar jendela default-mentah singkat.
		runtimeGen = ++footerGen;
		(globalThis as Record<symbol, number>)[GEN_KEY] = footerGen;
		const myGen = runtimeGen;
		dlog(rid, "start", event.reason, `myGen=${myGen}`);
		await new Promise((r) => setTimeout(r, FOOTER_DELAY_MS));
		dlog(rid, "wake", `myGen=${myGen}`, `cur=${footerGen}`);
		if (myGen !== footerGen) {
			dlog(rid, "cancelled-stale");
			return;
		}

		try {
			let renderLogged = false;
			const installFooter = (attempt = 0): void => {
				ctx.ui.setFooter((tui, theme, footerData) => {
					if (!renderLogged) {
						renderLogged = true;
						dlog(rid, "render-first");
					}
					rerender = () => tui.requestRender();
					const unsub = footerData.onBranchChange(() => {
						void refreshGit(cwd).then(() => tui.requestRender());
					});
					return {
						dispose() {
							dlog(rid, "footer-disposed", `attempt=${attempt}`);
							rerender = null;
							unsub();
							// Sembuh otomatis: Pi/ekstensi lain me-reset UI -> pasang lagi
							// selama runtime ini masih pemilik footer. Dibatasi 8x.
							if (attempt < 8) {
								setTimeout(() => {
									if (myGen !== footerGen) {
										dlog(rid, "heal-skipped-stale");
										return;
									}
									try {
										installFooter(attempt + 1);
										dlog(rid, "healed", `attempt=${attempt + 1}`);
									} catch (e) {
										dlog(rid, "heal-throw", String(e));
									}
								}, 400);
							}
						},
						invalidate() {},
						render(width: number): string[] {
							const acc = (text: string) => theme.fg("accent", text);
							const dim = (text: string) => theme.fg("dim", text);
							// Ikut tema aktif (dulu RGB cyan hard-code #7DB9CD -> nyangkut saat ganti tema).
							const tint = (text: string) => theme.fg("accent", text);
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
								const pSpeed = latestSpeed !== null && latestSpeed > 0 ? `${sep}${acc("\udb81\udcc5")} ${tint(`${latestSpeed.toFixed(1)} tok/s`)}` : "";
								left1 = `${acc("\uf07b")} ${dim(cwd)}${sep}${pDuration}${sep}${pBranch}${sep}${pTag}${sep}${pState}${pSpeed}`;
							} else if (latestSpeed !== null && latestSpeed > 0) {
								left1 = `${left1}${sep}${acc("\udb81\udcc5")} ${tint(`${latestSpeed.toFixed(1)} tok/s`)}`;
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
									// buang emoji/spinner reconnecting, ikon tetap sama (\uf233)
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
								// ctx basi di jeda reload/new: tampil tanpa usage
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
							return lines;
						},
					};
				});
			};
			installFooter();
			dlog(rid, "installed");
			// Pengaman: bila setFooter diabaikan diam-diam (tanpa render/dispose),
			// tegaskan sekali setelah 2 detik.
			setTimeout(() => {
				if (renderLogged || myGen !== footerGen) return;
				try {
					installFooter(0);
					dlog(rid, "watchdog-installed");
				} catch (e) {
					dlog(rid, "watchdog-throw", String(e));
				}
			}, 2000);
		} catch (e) {
			dlog(rid, "setFooter-throw", String(e));
		}
		void refreshGit(cwd).then(() => {
			dlog(rid, "git-ready");
			poke();
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		currentModel = ctx.model;
		currentThinkingLevel = ctx.thinkingLevel;
		(globalThis as Record<symbol, any>)[MODEL_KEY] = currentModel;
		(globalThis as Record<symbol, any>)[THINKING_KEY] = currentThinkingLevel;
		(globalThis as Record<symbol, any>)[CWD_KEY] = ctx.cwd;
		void refreshGit(ctx.cwd).then(() => poke());
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			assistantStartMs = Date.now();
			assistantChars = 0;
		}
	});

	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant" && assistantStartMs !== null) {
			const streamEvent = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
			if (streamEvent?.delta) {
				assistantChars += streamEvent.delta.length;
			}
			const elapsed = (Date.now() - assistantStartMs) / 1000;
			if (elapsed >= 0.3) {
				// Perkiraan token dari karakter (1 token ≈ 3.8-4 char) atau usage jika tersedia
				const usageOut = (event.message as AssistantMessage).usage?.output;
				const currentTokens = typeof usageOut === "number" && usageOut > 0 ? usageOut : Math.ceil(assistantChars / 3.8);
				if (currentTokens > 0) {
					latestSpeed = currentTokens / elapsed;
					// render storm per-delta streaming: batasi requestRender 2Hz
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
		// Hanya runtime terakhir boleh mereset: shutdown lama yang datang
		// setelah start baru tidak boleh membatalkan/menghapus footer baru.
		rerender = null;
		const cur = ((globalThis as Record<symbol, number>)[GEN_KEY] ?? 0);
		if (cur !== runtimeGen) {
			dlog(rid, "shutdown-skip", `cur=${cur}`, `own=${runtimeGen}`);
			return;
		}
		footerGen++;
		(globalThis as Record<symbol, number>)[GEN_KEY] = footerGen;
		dlog(rid, "shutdown-reset");
		try {
			(ctx as unknown as { ui?: { setFooter?: (f?: undefined) => void } }).ui?.setFooter?.(undefined);
		} catch {
			// abaikan: ui bisa sudah dispose
		}
	});
}
