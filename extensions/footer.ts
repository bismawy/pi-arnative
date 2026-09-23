/**
 * Arnative footer, clean tanpa emoji.
 * Baris 1: [MCP: N | ]branch | tag | hash subject[ | ~dirty] | ctx tok/win pct | status extension lain.
 * Baris 2: cwd (branch).
 * Segmen MCP = jumlah configured di mcp.json, disembunyikan bila 0.
 * Semua data berat di-cache via event, render hanya baca cache.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type GitInfo = { branch: string; tag: string; commit: string; dirty: number } | null;
type CtxInfo = { tokens: number; window: number; percent: number } | null;

let modelId = "no-model";
let git: GitInfo = null;
let mcpCount: number | null = null;
let usage: CtxInfo = null;

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
	const [tag, log, status] = await Promise.all([
		run("git", ["describe", "--tags", "--abbrev=0"], cwd),
		run("git", ["log", "-1", "--format=%h %s"], cwd),
		run("git", ["status", "--porcelain"], cwd),
	]);
	git = {
		branch,
		tag: tag || "-",
		commit: log || "-",
		dirty: status ? status.split("\n").length : 0,
	};
}

// ponytail: homedir tetap, dukung PI_AGENT_DIR bila penempatan config berubah.
async function refreshMcp(): Promise<void> {
	try {
		const raw = await readFile(join(homedir(), ".pi", "agent", "mcp.json"), "utf8");
		const j = JSON.parse(raw) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
		const s = j.mcpServers ?? j.servers ?? {};
		mcpCount = Object.keys(s).length;
	} catch {
		mcpCount = null;
	}
}

function fmt(n: number): string {
	return n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model) modelId = ctx.model.id;
		const cwd = ctx.cwd;
		await Promise.all([refreshGit(cwd), refreshMcp()]);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => {
				void refreshGit(cwd).then(() => tui.requestRender());
			});
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const segs: string[] = [];
					if (mcpCount !== null && mcpCount > 0) segs.push(`MCP: ${mcpCount}`);
					if (git) {
						segs.push(git.branch, git.tag, git.commit);
						if (git.dirty > 0) segs.push(`~${git.dirty}`);
					}
					if (usage) segs.push(`${fmt(usage.tokens)}/${fmt(usage.window)} ${usage.percent.toFixed(1)}%`);
					for (const s of footerData.getExtensionStatuses().values()) segs.push(s);
					const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
					const left = theme.fg("dim", segs.join(" | "));
					const right = `${theme.fg("dim", time)} ${theme.fg("accent", modelId)}`;
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					const lines = [truncateToWidth(left + pad + right, width)];
					const branch = footerData.getGitBranch();
					const loc = branch ? `${cwd} (${branch})` : cwd;
					lines.push(truncateToWidth(theme.fg("dim", loc), width));
					return lines;
				},
			};
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		await Promise.all([refreshGit(ctx.cwd), refreshMcp()]);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const u = ctx.getContextUsage();
		usage = u && u.tokens !== null && u.percent !== null ? { tokens: u.tokens, window: u.contextWindow, percent: u.percent } : null;
	});

	pi.on("message_end", async (_event, ctx) => {
		const u = ctx.getContextUsage();
		usage = u && u.tokens !== null && u.percent !== null ? { tokens: u.tokens, window: u.contextWindow, percent: u.percent } : null;
	});

	pi.on("model_select", async (event) => {
		modelId = event.model.id;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
