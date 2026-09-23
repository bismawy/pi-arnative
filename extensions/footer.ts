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

type GitInfo = { branch: string; tag: string; uncommitted: number } | null;

let git: GitInfo = null;
let currentModelDisplay = "No Model";
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
	if (name === model.id) {
		name = name
			.split(/[-_]/)
			.map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
			.join(" ");
	}
	const provider = model.provider ? model.provider.charAt(0).toUpperCase() + model.provider.slice(1) : "";
	const provStr = provider ? ` (${provider})` : "";
	const thinkStr = thinkingLevel && thinkingLevel !== "off" ? ` | ${thinkingLevel}` : "";
	return `${name}${provStr}${thinkStr}`;
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
		currentModelDisplay = formatModelName(ctx.model, ctx.thinkingLevel);
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
					let loc = `📁 ${cwd}`;
					if (git) {
						const gitState = git.uncommitted > 0 ? `~${git.uncommitted}` : "clean";
						loc = `📁 ${cwd} | ${git.branch} | ${git.tag} | ${gitState}`;
					}
					const left1 = theme.fg("dim", loc);
					const right1 = theme.fg("accent", currentModelDisplay);
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
		currentModelDisplay = formatModelName(ctx.model, ctx.thinkingLevel);
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
		currentModelDisplay = formatModelName(event.model);
		poke();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
