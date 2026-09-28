/**
 * Arnative footer (forced to 2 lines) + custom editor.
 * Line 1: cwd | duration | branch/tag/status ...... model + thinking level.
 * Line 2: other extension status (mcp first) ...... tok/s · cache · token.
 *
 * Transcript clock & bubble bg: extensions/timestamps.ts
 * /new header: extensions/section-headers.ts
 * Selection + box reload: extensions/ui-render-tweaks.ts
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, FooterComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { stripAnsi } from "../lib/ansi.ts";
import { assert, isMain } from "../lib/check.ts";
import { capitalize, modelDisplayParts } from "../lib/format.ts";
import { IS_WINDOWS_LIKE, SHORTCUT_RELOAD } from "../lib/shortcuts.ts";
import { formatTokens } from "../lib/usage-store.ts";

// ctrl+alt+r (alt+r on Windows/WSL — see lib/shortcuts.ts).
// The TUI drops key-release events before handleInput, so press+release cannot
// fire this twice even when the terminal reports event types (Kitty flag 2).

// Intercept the built-in FooterComponent to force a pure 2-line footer
const PATCHED_KEY = Symbol.for("pi-arnative.footer2LinesPatched");
if (FooterComponent?.prototype?.render && !(globalThis as Record<symbol, boolean>)[PATCHED_KEY]) {
	(globalThis as Record<symbol, boolean>)[PATCHED_KEY] = true;
	const origRender = FooterComponent.prototype.render;
	FooterComponent.prototype.render = function (width: number): string[] {
		const lines = origRender.call(this, width);
		return lines.length > 2 ? lines.slice(0, 2) : lines;
	};
}

let activeThemeProxy: { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null = null;

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
	const { name, provider } = modelDisplayParts({ id: model.id, name: model.name, provider: model.provider });
	const provStr = provider ? ` ${dim(`(${provider})`)}` : "";
	const capThinking = thinkingLevel && thinkingLevel !== "off" ? capitalize(thinkingLevel) : "";
	const thinkStr = capThinking ? `${acc("\udb80\udf35")} ${tint(capThinking)} ${dim("·")} ` : "";
	return `${thinkStr}${acc(name)}${provStr}`;
}

// Footer is a single line: a deep cwd (`/Users/x/Workspace/personal/proj`)
// pushes git state and the model off screen. Keep the last 2 segments.
export function shortenCwd(raw: string): string {
	const p = (raw || "").trim();
	if (!p) return p;
	const drive = p.match(/^[A-Za-z]:/);
	const body = drive ? p.slice(2) : p;
	const parts = body.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
	if (parts.length <= 2) return p;
	const head = drive ? `${drive[0]}/\u2026/` : p.startsWith("/") ? "\u2026/" : "\u2026";
	return head + parts.slice(-2).join("/");
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

// Full box editor: pi draws only the top/bottom lines (pi-tui editor.js: "no side
// borders, just horizontal lines above and below") and no prompt char, so the `│`
// sides, the round ╭╮╰╯ corners and the `> ` prompt are added here. `lines` are
// already rendered at width - 5 (2 sides + 3 prompt) and the border is patched with
// dashes to match. `visible` = content line count (private `renderedVisibleLineCount`);
// autocomplete lines stay outside the box. JetBrainsMono NF has the round glyphs.
export function boxEditorLines(
	lines: readonly string[],
	visible: number,
	color: (text: string) => string,
	prompt = " > ",
): string[] {
	const inner = lines.length > 0 ? visibleWidth(lines[0]!) : 0;
	const promptWidth = visibleWidth(prompt);
	if (inner < promptWidth + 4 || visible < 1 || lines.length < visible + 2) return [...lines];
	const out = [...lines];
	const side = color("\u2502");
	const indent = " ".repeat(promptWidth);
	for (let i = 1; i <= visible; i++) out[i] = side + (i === 1 ? prompt : indent) + lines[i]! + side;
	const patch = color("\u2500".repeat(promptWidth));
	out[0] = color("\u256d") + lines[0]! + patch + color("\u256e");
	out[visible + 1] = color("\u2570") + lines[visible + 1]! + patch + color("\u256f");
	return out;
}

function parseOptimizer(raw: string | undefined): string | null {
	if (!raw) return null;
	const m = raw.match(/([A-Za-z0-9_-]+)\s+cache\s+(\d+\/\d+)·[^\s]+\s+([\d.]+%)/);
	return m ? `${m[1]} ${m[2]} (${m[3]})` : null;
}

let usageScanAt = 0;
let usageScanLen = -1;
let usageScanNums = { inp: 0, out: 0, read: 0 };

// 2s cache + branch length: the footer renders on every poke/stream tick, so
// without this every frame rescans the whole branch (O(N) per frame).
function getUsage(
	ctx: { sessionManager: { getBranch(): readonly unknown[] }; getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined },
	acc: (t: string) => string,
	tint: (t: string) => string,
): string {
	const branch = ctx.sessionManager.getBranch();
	let inp = 0;
	let out = 0;
	let read = 0;
	if (Date.now() - usageScanAt < 2000 && branch.length === usageScanLen) {
		inp = usageScanNums.inp;
		out = usageScanNums.out;
		read = usageScanNums.read;
	} else {
		for (const e of branch) {
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
		usageScanNums = { inp, out, read };
		usageScanAt = Date.now();
		usageScanLen = branch.length;
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

/**
 * Tool name → active progress text (gerund).
 * Fallback when unregistered: "Working".
 */
// Verb for an MCP sub-action (shared by the `mcp` and `mcp__*` tool names).
function mcpStatusOf(sub: string): string {
	if (sub.includes("search") || sub.includes("find")) return "Searching";
	if (sub.includes("fetch") || sub.includes("get") || sub.includes("read")) return "Fetching";
	if (sub.includes("edit") || sub.includes("write") || sub.includes("patch")) return "Editing";
	return "Executing";
}

export function getToolWorkingMessage(toolName: string, args?: any): string {
	const n = (toolName ?? "").trim();
	if (!n) return "Working";

	// Standard / file tools
	if (n === "edit") return "Editing";
	if (n === "write") return "Writing";
	if (n === "read") return "Reading";
	if (n === "grep" || n === "find" || n === "web_search" || n === "source_check") return "Searching";
	if (n === "bash") return "Executing";
	if (n === "fetch_content") return "Fetching";
	if (n === "get_search_content") return "Reading";
	if (n === "generate_image") return "Generating image";
	if (n === "todo" || n === "scratchpad") return "Updating tasks";
	if (n.startsWith("memory_")) return "Accessing memory";
	if (n.startsWith("lsp_")) return "Checking code";
	if (n.startsWith("chrome_devtools_")) return "Browsing";
	if (n === "ask_user_question" || n === "plan_mode_question") return "Waiting for input";

	// MCP tools (mcp / mcpScript / mcp__*)
	if (n === "mcpScript") return "Running script";
	if (n === "mcp") {
		const sub = typeof args === "object" && args ? (args.tool || args.search || args.describe || args.action) : "";
		return sub ? mcpStatusOf(String(sub).toLowerCase()) : "Executing";
	}
	if (n.startsWith("mcp__")) {
		const sub = typeof args === "object" && args?.tool ? String(args.tool).toLowerCase() : "";
		return mcpStatusOf(sub);
	}

	return "Working";
}

export default function (pi: ExtensionAPI) {
	let runtimeGen = 0;

	// Assistant speed timer (user message timestamps come from extensions/timestamps.ts)
	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
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
		activeThemeProxy = ((ctx as unknown as { ui?: { theme?: typeof activeThemeProxy } }).ui?.theme) ?? activeThemeProxy;

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
						const cwdShort = shortenCwd(cwd);
						let left1 = `${acc("\uf07b")} ${dim(cwdShort)}${sep}${pDuration}`;
						if (git) {
							const gitIcon = acc("\uf172");
							const gitText = git.uncommitted > 0 ? tint(`~${git.uncommitted}`) : tint("clean");
							const pBranch = `${acc("\uf126")} ${tint(git.branch)}${git.ahead > 0 ? ` ${tint(`↑${git.ahead}`)}` : ""}${git.behind > 0 ? ` ${tint(`↓${git.behind}`)}` : ""}`;
							const pTag = `${acc("\uf02b")} ${tint(git.tag)}`;
							const pState = `${gitIcon}  ${gitText}`;
							left1 = `${acc("\uf07b")} ${dim(cwdShort)}${sep}${pDuration}${sep}${pBranch}${sep}${pTag}${sep}${pState}`;
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
								let clean = stripAnsi(s);
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
							let clean = stripAnsi(s);
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
						const speedStr = latestSpeed !== null && latestSpeed > 0 ? `${acc("\udb81\udcc5")} ${tint(`${latestSpeed.toFixed(1)} tok/s`)}` : "";
						const right2 = [speedStr, opt ? `${acc("\udb80\udf5b")} ${tint(opt)}` : "", usageStr].filter(Boolean).join(` ${dim("·")} `);

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

				handleInput(data: string) {
					if (SHORTCUT_RELOAD.matches(data)) {
						this.setText("");
						if (this.onSubmit) {
							this.onSubmit("/reload");
						}
						return;
					}
					super.handleInput(data);
				}

				render(width: number): string[] {
					// The box eats 5 columns: 2 sides + the 3-column " > " prompt, so the
					// content is rendered 5 columns narrower.
					const visible = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount;
					if (typeof visible !== "number" || width < 11) return super.render(width);
					let prompt = " > ";
					try {
						prompt = this.getActiveTheme()?.fg("dim", prompt) ?? prompt;
					} catch {
						// theme not ready -> uncolored prompt
					}
					return boxEditorLines(super.render(width - 5), visible, (t) => this.borderColor(t), prompt);
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
		try {
			ctx.ui?.setWorkingMessage?.();
		} catch {
			// ignore
		}
		void refreshGit(ctx.cwd).then(() => poke());
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		try {
			const msg = getToolWorkingMessage(event.toolName, event.args);
			ctx.ui?.setWorkingMessage?.(msg);
		} catch {
			// ignore
		}
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		try {
			ctx.ui?.setWorkingMessage?.();
		} catch {
			// ignore
		}
	});

	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant") {
			// Timer starts lazily if message_start never fired (fragile event pairing)
			if (assistantStartMs === null) assistantStartMs = Date.now();
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
		if (event.message.role === "assistant") {
			const start = assistantStartMs ?? Date.now();
			const elapsed = (Date.now() - start) / 1000;
			assistantStartMs = null;
			const usageOut = (event.message as AssistantMessage).usage?.output;
			const finalTokens = typeof usageOut === "number" && usageOut > 0 ? usageOut : Math.ceil(assistantChars / 3.8);
			if (finalTokens > 0 && elapsed > 0.2) {
				latestSpeed = finalTokens / elapsed;
			}
		}
		poke();
	});

	pi.on("turn_end", async (_event, ctx) => {
		try {
			ctx.ui?.setWorkingMessage?.();
		} catch {
			// ignore
		}
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
if (isMain(import.meta.url)) {
	assert(shortenCwd("/run/media/bisma/DATA/Pi/pi-arnative") === "\u2026/Pi/pi-arnative", "cwd inside -> last 2 segments");
	assert(shortenCwd("/home/bisma") === "/home/bisma", "shallow cwd left unchanged");
	assert(shortenCwd("D:\\Pi\\a\\pi-arnative") === "D:/\u2026/a/pi-arnative", "long Windows path: drive kept");
	assert(shortenCwd("D:\\Pi\\pi-arnative") === "D:\\Pi\\pi-arnative", "shallow Windows path left unchanged");
	assert(shortenCwd("/a/x/y/z") === "\u2026/y/z", "long path -> tail");
	assert(shortenCwd("") === "", "empty cwd");
	assert(formatDuration(0) === "-", "empty duration = -");
	assert(formatDuration(5_000) === "5s", "seconds only");
	assert(formatDuration(65_000) === "1m 5s", "minutes + seconds");
	assert(formatDuration(3_700_000) === "1h 1m", "hours + minutes");

	const plain = (s: string) => s;
	const D = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"; // 8 columns = content width in this test
	const boxed = boxEditorLines([D, "  hi    ", "  lo    ", D, "  /mo "], 2, plain);
	assert(boxed[0] === `\u256d${D}\u2500\u2500\u2500\u256e`, "editor box: top corner spans the content");
	assert(boxed[1] === "\u2502 >   hi    \u2502", "editor box: ' > ' prompt on the first line");
	assert(boxed[2] === "\u2502     lo    \u2502", "editor box: continuation indented, no second >");
	assert(boxed[3] === `\u2570${D}\u2500\u2500\u2500\u256f`, "editor box: bottom corner");
	assert(boxed[4] === "  /mo ", "autocomplete lines stay outside the box");
	const dimP = (s: string) => `\x1b[2m${s}\x1b[0m`;
	const boxedDim = boxEditorLines([D, "  hi    ", D], 1, plain, dimP(" > "));
	assert(visibleWidth(boxedDim[1]!) === visibleWidth(D) + 5, "ANSI (dim) prompt does not shift the width");
	assert(boxedDim[1]!.startsWith(`\u2502${dimP(" > ")}`), "dim prompt kept as-is");

	// Self-check: getToolWorkingMessage
	assert(getToolWorkingMessage("edit") === "Editing", "edit -> Editing");
	assert(getToolWorkingMessage("write") === "Writing", "write -> Writing");
	assert(getToolWorkingMessage("read") === "Reading", "read -> Reading");
	assert(getToolWorkingMessage("grep") === "Searching", "grep -> Searching");
	assert(getToolWorkingMessage("find") === "Searching", "find -> Searching");
	assert(getToolWorkingMessage("web_search") === "Searching", "web_search -> Searching");
	assert(getToolWorkingMessage("bash") === "Executing", "bash -> Executing");
	assert(getToolWorkingMessage("fetch_content") === "Fetching", "fetch_content -> Fetching");
	assert(getToolWorkingMessage("todo") === "Updating tasks", "todo -> Updating tasks");
	assert(getToolWorkingMessage("unknown_tool") === "Working", "unknown -> Working");
	assert(getToolWorkingMessage("mcp", { tool: "fetch_repo" }) === "Fetching", "mcp fetch -> Fetching");
	assert(boxed.slice(0, 4).every((l) => visibleWidth(l) === visibleWidth(D) + 5), "uniform box width (sides + prompt)");
	assert(boxEditorLines(["\u2500\u2500\u2500\u2500"], 1, plain).length === 1, "too narrow: left unchanged");

	// Guard: the reload shortcut must match every encoding a terminal can deliver,
	// so a typo in the key id fails here instead of silently doing nothing.
	assert(SHORTCUT_RELOAD.matches("\x1b\x12"), "shortcut matches legacy ctrl+alt+r (ESC + 0x12)");
	assert(SHORTCUT_RELOAD.matches("\x1b[114;7u"), "shortcut matches Kitty CSI-u ctrl+alt+r");
	assert(SHORTCUT_RELOAD.matches("\x1br") === IS_WINDOWS_LIKE, "ESC + r triggers reload only where alt+r is bound");
	assert(!SHORTCUT_RELOAD.matches("\x12"), "plain ctrl+r does not trigger reload");
	assert(!SHORTCUT_RELOAD.matches("r"), "bare letter r does not trigger reload");
	console.log("footer.ts self-check OK");
}
