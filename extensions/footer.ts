/**
 * Arnative footer: timestamp + model, baris 2 info git bila di repo.
 * Clean tanpa emoji. Cache di-refresh di session_start/turn_start,
 * render hanya baca cache tanpa spawn proses.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

type GitInfo = { branch: string; tag: string; commit: string; dirty: number } | null;

let modelId = "no-model";
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model) modelId = ctx.model.id;
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
					const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
					const left = theme.fg("dim", time);
					const right = theme.fg("accent", modelId);
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					const lines = [truncateToWidth(left + pad + right, width)];
					if (git) {
						const suffix = git.dirty > 0 ? ` | ~${git.dirty}` : "";
						const g = `${git.branch} | ${git.tag} | ${git.commit}${suffix}`;
						lines.push(truncateToWidth(theme.fg("dim", g), width));
					}
					return lines;
				},
			};
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		await refreshGit(ctx.cwd);
	});

	pi.on("model_select", async (event) => {
		modelId = event.model.id;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
