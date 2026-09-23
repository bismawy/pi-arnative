/**
 * Arnative footer.
 * Baris 1: 📁 cwd [| branch | tag] ...... model.
 * Baris 2: status extension lain (mcp dulu) ...... cache optimizer.
 * Git via exec langsung, tampil hanya di repo. Render baca cache,
 * disegarkan tiap turn, pesan, dan ganti model agar status hidup.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

type GitInfo = { branch: string; tag: string; uncommitted: number } | null;

let git: GitInfo = null;
let currentThinkingLevel: string | undefined = undefined;
let currentModel: { id: string; name?: string; provider?: string } | undefined = undefined;
let rerender: (() => void) | null = null;

function run(cmd: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout: 5000 }, (err, stdout) => {
			resolve(err ? "" : String(stdout).trim());
		});
	});
}

async function refreshGit(cwd: string): Promise<void> {
	const branch = await run("git", ["branch", "--show-current"], cwd);
	if (!branch) {
		git = null;
		return;
	}
	const [tag, status] = await Promise.all([
		run("git", ["describe", "--tags", "--abbrev=0"], cwd),
		run("git", ["status", "--porcelain"], cwd),
	]);
	const uncommitted = status ? status.split("\n").filter((l) => l.trim().length > 0).length : 0;
	git = {
		branch,
		tag: tag || "-",
		uncommitted,
	};
}

function formatModelName(model: { id: string; name?: string; provider?: string } | undefined, thinkingLevel?: string): string {
	if (!model) return "No Model";
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
	const provStr = provider ? ` (${provider})` : "";
	const capThinking = thinkingLevel && thinkingLevel !== "off" ? thinkingLevel.charAt(0).toUpperCase() + thinkingLevel.slice(1) : "";
	const thinkStr = capThinking ? `\udb80\udf35 ${capThinking} | ` : "";
	return `${thinkStr}${name}${provStr}`;
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

function getUsage(ctx: { sessionManager: { getBranch(): readonly unknown[] }; getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined }): string {
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
	if (inp > 0) parts.push(`↑${formatTokens(inp)}`);
	if (out > 0) parts.push(`↓${formatTokens(out)}`);
	if (read > 0) parts.push(` ${formatTokens(read)}`);
	const u = ctx.getContextUsage();
	if (u && u.percent !== null && u.tokens !== null) {
		parts.push(`\udb81\udfaf ${u.percent.toFixed(1)}%/${formatTokens(u.contextWindow)}`);
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
	pi.on("session_start", async (_event, ctx) => {
		currentModel = ctx.model;
		currentThinkingLevel = ctx.thinkingLevel;
		const cwd = ctx.cwd;
		await refreshGit(cwd);
		ctx.ui.setFooter((tui, theme, footerData) => {
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
					let loc = `\uf07b ${cwd}`;
					if (git) {
						const gitState = git.uncommitted > 0 ? `~${git.uncommitted}` : "\uf172  clean";
						loc = `\uf07b ${cwd} | \uf126 ${git.branch} | \uf02b ${git.tag} | ${gitState}`;
					}
					const right1Text = formatModelName(currentModel, currentThinkingLevel);
					const left1 = theme.fg("dim", loc);
					const right1 = theme.fg("accent", right1Text);
					const pad1 = " ".repeat(Math.max(1, width - visibleWidth(left1) - visibleWidth(right1)));
					const lines = [truncateToWidth(left1 + pad1 + right1, width)];

					const statuses = footerData.getExtensionStatuses();
					const rawCache = statuses.get("pi-cache-stats");
					const segs: string[] = [];
					const cleanStatus = (s: string) => {
						let clean = s.replace(/\x1b\[[0-9;]*m/g, "").replace(/^[0-9;]+m/, "");
						clean = clean.replace(/\uFFFD/g, "").replace(/\?{1,2}\s*/g, "");
						if (clean.includes("MCP:")) {
							const m = clean.match(/MCP:\s*\d+\s*servers?\s*enabled/i);
							if (m) return `\uf233 ${m[0]}`;
						}
						if (clean.includes("ponytail:")) {
							const bullet = clean.includes("○") ? "○ " : "";
							const p = clean.replace(/.*ponytail:\s*/, "").replace(/⚡\s+FULL/g, "⚡FULL");
							return `${bullet}\uef04  ponytail: ${p.trim()}`;
						}
						return clean.trim();
					};

					const mcp = statuses.get("mcp");
					if (mcp !== undefined) segs.push(cleanStatus(mcp));
					for (const [k, s] of statuses) {
						if (k !== "mcp" && k !== "pi-cache-stats") segs.push(cleanStatus(s));
					}
					const left2 = theme.fg("dim", segs.join(" | "));

					const opt = parseOptimizer(rawCache);
					const usageStr = getUsage(ctx);
					let right2Text = "";
					if (opt && usageStr) {
						right2Text = `${opt} · ${usageStr}`;
					} else {
						right2Text = opt || usageStr;
					}

					if (!right2Text) {
						lines.push(truncateToWidth(left2, width));
					} else {
						const right2 = theme.fg("dim", right2Text);
						const pad2 = " ".repeat(Math.max(1, width - visibleWidth(left2) - visibleWidth(right2)));
						lines.push(truncateToWidth(left2 + pad2 + right2, width));
					}
					return lines;
				},
			};
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		currentModel = ctx.model;
		currentThinkingLevel = ctx.thinkingLevel;
		await refreshGit(ctx.cwd);
		poke();
	});

	pi.on("turn_end", async () => {
		poke();
	});

	pi.on("message_end", async () => {
		poke();
	});

	pi.on("model_select", async (event) => {
		currentModel = event.model;
		poke();
	});

	pi.on("thinking_level_select", async (event) => {
		currentThinkingLevel = event.level;
		poke();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
