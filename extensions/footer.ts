/**
 * Arnative footer, clean tanpa emoji.
 * Baris 1: cwd.
 * Baris 2: [branch | tag | ]status extension lain (mcp dulu).
 * Branch dan tag diambil via exec git langsung, tampil hanya di repo.
 * Render hanya baca cache, tanpa spawn proses.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

type GitInfo = { branch: string; tag: string } | null;

let git: GitInfo = null;

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
	const t = await run("git", ["describe", "--tags", "--abbrev=0"], cwd);
	git = { branch, tag: t || "-" };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx.cwd;
		await refreshGit(cwd);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => {
				void refreshGit(cwd).then(() => tui.requestRender());
			});
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const lines = [truncateToWidth(theme.fg("dim", cwd), width)];
					const segs: string[] = [];
					if (git) segs.push(git.branch, git.tag);
					const statuses = footerData.getExtensionStatuses();
					const mcp = statuses.get("mcp");
					if (mcp !== undefined) segs.push(mcp);
					for (const [k, s] of statuses) {
						if (k !== "mcp") segs.push(s);
					}
					lines.push(truncateToWidth(theme.fg("dim", segs.join(" | ")), width));
					return lines;
				},
			};
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		await refreshGit(ctx.cwd);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
