/**
 * Arnative footer.
 * Baris 1: 📁 cwd [| branch | tag] ...... model.
 * Baris 2: status extension lain (mcp dulu) ...... cache optimizer.
 * Git via exec langsung, tampil hanya di repo. Render baca cache,
 * disegarkan tiap turn, pesan, dan ganti model agar status hidup.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

type GitInfo = { branch: string; tag: string } | null;

let git: GitInfo = null;
let modelId = "no-model";
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
	const t = await run("git", ["describe", "--tags", "--abbrev=0"], cwd);
	git = { branch, tag: t || "-" };
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
		if (ctx.model) modelId = ctx.model.id;
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
					const loc = git ? `📁 ${cwd} | ${git.branch} | ${git.tag}` : `📁 ${cwd}`;
					const left1 = theme.fg("dim", loc);
					const right1 = theme.fg("accent", modelId);
					const pad1 = " ".repeat(Math.max(1, width - visibleWidth(left1) - visibleWidth(right1)));
					const lines = [truncateToWidth(left1 + pad1 + right1, width)];

					const statuses = footerData.getExtensionStatuses();
					const cache = statuses.get("pi-cache-stats");
					const segs: string[] = [];
					const mcp = statuses.get("mcp");
					if (mcp !== undefined) segs.push(mcp);
					for (const [k, s] of statuses) {
						if (k !== "mcp" && k !== "pi-cache-stats") segs.push(s);
					}
					const left2 = theme.fg("dim", segs.join(" | "));
					if (cache === undefined) {
						lines.push(truncateToWidth(left2, width));
					} else {
						const right2 = theme.fg("dim", cache);
						const pad2 = " ".repeat(Math.max(1, width - visibleWidth(left2) - visibleWidth(right2)));
						lines.push(truncateToWidth(left2 + pad2 + right2, width));
					}
					return lines;
				},
			};
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
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
		modelId = event.model.id;
		poke();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
