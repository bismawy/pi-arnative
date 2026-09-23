/**
 * Arnative footer, clean tanpa emoji.
 * Baris 1: [branch | tag | ]ctx tok/win pct | status extension lain (mcp dulu).
 * Baris 2: cwd (branch).
 * Segmen git tampil hanya di dalam repo; tag di-cache via event.
 * Render hanya baca cache, tanpa spawn proses.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

type CtxInfo = { tokens: number; window: number; percent: number } | null;

let modelId = "no-model";
let tag: string | null = null;
let usage: CtxInfo = null;

function run(cmd: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout: 5000 }, (err, stdout) => {
			resolve(err ? "" : String(stdout).trim());
		});
	});
}

async function refreshTag(cwd: string): Promise<void> {
	const inRepo = await run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	if (inRepo !== "true") {
		tag = null;
		return;
	}
	const t = await run("git", ["describe", "--tags", "--abbrev=0"], cwd);
	tag = t || "-";
}

function fmt(n: number): string {
	return n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}

function refreshUsage(ctx: { getContextUsage(): CtxInfo | undefined }): void {
	const u = ctx.getContextUsage();
	usage = u && u.tokens !== null && u.percent !== null ? { tokens: u.tokens, window: u.contextWindow, percent: u.percent } : null;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model) modelId = ctx.model.id;
		const cwd = ctx.cwd;
		await refreshTag(cwd);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => {
				void refreshTag(cwd).then(() => tui.requestRender());
			});
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const segs: string[] = [];
					const branch = footerData.getGitBranch();
					if (branch) {
						segs.push(branch, tag ?? "-");
					}
					if (usage) segs.push(`${fmt(usage.tokens)}/${fmt(usage.window)} ${usage.percent.toFixed(1)}%`);
					const statuses = footerData.getExtensionStatuses();
					const mcp = statuses.get("mcp");
					if (mcp !== undefined) segs.push(mcp);
					for (const [k, s] of statuses) {
						if (k !== "mcp") segs.push(s);
					}
					const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
					const left = theme.fg("dim", segs.join(" | "));
					const right = `${theme.fg("dim", time)} ${theme.fg("accent", modelId)}`;
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					const lines = [truncateToWidth(left + pad + right, width)];
					const loc = branch ? `${cwd} (${branch})` : cwd;
					lines.push(truncateToWidth(theme.fg("dim", loc), width));
					return lines;
				},
			};
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		await refreshTag(ctx.cwd);
	});

	pi.on("turn_end", async (_event, ctx) => {
		refreshUsage(ctx);
	});

	pi.on("message_end", async (_event, ctx) => {
		refreshUsage(ctx);
	});

	pi.on("model_select", async (event) => {
		modelId = event.model.id;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
