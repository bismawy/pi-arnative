/**
 * Git repository status, diff-stat formatting, and cwd shortening for the footer.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type GitInfo = {
	branch: string;
	tag: string | null;
	uncommitted: number | null;
	added: number | null;
	removed: number | null;
	ahead: number;
	behind: number;
} | null;

export type RunResult = { ok: boolean; out: string };

/** Run a subprocess and distinguish exit 0 from failure so callers never invent a clean
 *  tree when git is absent or the repo is not owned by the user. */
export function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		execFile(cmd, args, { cwd, timeout: 2000 }, (err, stdout) => {
			resolvePromise({ ok: !err, out: String(stdout).trim() });
		});
	});
}

/**
 * The branch, straight from `.git/HEAD` — the same trick pi's own footer uses.
 * Reading the ref needs no binary and no ownership check, so a fresh user sees
 * the branch even without git on PATH.
 */
export function branchFromDisk(cwd: string): string | null {
	for (let dir = resolve(cwd); ; ) {
		try {
			const dotGit = join(dir, ".git");
			const gitDir = statSync(dotGit).isDirectory()
				? dotGit
				: resolve(dir, readFileSync(dotGit, "utf8").trim().replace(/^gitdir:\s*/, ""));
			const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
			const ref = /^ref:\s+refs\/heads\/(.+)$/.exec(head);
			return ref ? ref[1]! : "detached";
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Sum `git diff --numstat` output: `added<TAB>removed<TAB>path` per line. A `-`
 *  marks a binary file — skipped, not counted as 0. */
export function sumNumstat(out: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of out.split("\n")) {
		const [a, r] = line.split("\t");
		if (!/^\d+$/.test(a ?? "") || !/^\d+$/.test(r ?? "")) continue;
		added += Number(a);
		removed += Number(r);
	}
	return { added, removed };
}

/** Parsed `git status --porcelain=v2 --branch`: branch, upstream sync, and change count in one call. */
export function parsePorcelainV2(out: string): { ahead: number; behind: number; uncommitted: number } {
	let ahead = 0;
	let behind = 0;
	let uncommitted = 0;
	for (const line of out.split(/\r?\n/)) {
		if (line.startsWith("# branch.ab ")) {
			const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
			if (m) {
				ahead = Number(m[1]);
				behind = Number(m[2]);
			}
		} else if (line.startsWith("# ") || line === "") {
			continue;
		} else {
			uncommitted++;
		}
	}
	return { ahead, behind, uncommitted };
}

/** Row-1 git segment: branch(+sync), tag, worktree state. */
export function gitParts(
	info: GitInfo,
	acc: (t: string) => string,
	soft: (t: string) => string,
): string[] {
	if (!info) return [];
	const branch = `${acc("\uf126")} ${soft(info.branch)}${info.ahead > 0 ? ` ${soft(`↑${info.ahead}`)}` : ""}${info.behind > 0 ? ` ${soft(`↓${info.behind}`)}` : ""}`;
	const parts = [branch];
	if (info.tag !== null) parts.push(`${acc("\uf02b")} ${soft(info.tag)}`);
	if (info.uncommitted !== null) parts.push(`${acc("\uf172")}  ${info.uncommitted > 0 ? soft(`~${info.uncommitted}`) : soft("clean")}`);
	return parts;
}

/** Working-tree diff vs HEAD as `+500 -100`, or `""` when clean or unavailable. */
export function formatDiffStat(
	info: GitInfo,
	acc: (t: string) => string,
	pos: (t: string) => string,
	neg: (t: string) => string,
): string {
	if (!info || info.added === null || info.removed === null) return "";
	if (info.added + info.removed === 0) return "";
	return `${acc("\uf4d2")} ${pos(`+${info.added}`)} ${neg(`-${info.removed}`)}`;
}

/** Keep the last 2 path segments so deep working directories stay single-line. */
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

/** The tag `git describe --tags --abbrev=0` would print for HEAD, or null. Cached per
 *  (cwd, branch): a tag only moves on a checkout or a new tag, so one call per branch
 *  switch is enough — re-running it on every tool call was the most expensive part of the refresh. */
const tagByBranch = new Map<string, string | null>();
async function tagFor(cwd: string, branch: string): Promise<string | null> {
	const key = `${cwd}\0${branch}`;
	if (tagByBranch.has(key)) return tagByBranch.get(key) ?? null;
	const tag = await run("git", ["describe", "--tags", "--abbrev=0"], cwd);
	const value = tag.ok && tag.out ? tag.out : null;
	tagByBranch.set(key, value);
	return value;
}

/** Collect git status, tag, upstream ahead/behind, and working-tree diff stat for `cwd`.
 *  Two git calls per refresh: `status --porcelain=v2 --branch` answers branch sync and the
 *  change count together, `diff --numstat` the line counts; the tag is read once per branch. */
export async function collectGitInfo(cwd: string): Promise<GitInfo> {
	const branch = branchFromDisk(cwd);
	if (!branch) return null;
	const [status, numstat] = await Promise.all([
		run("git", ["status", "--porcelain=v2", "--branch"], cwd),
		run("git", ["diff", "HEAD", "--numstat"], cwd),
	]);
	const parsed = status.ok ? parsePorcelainV2(status.out) : { ahead: 0, behind: 0, uncommitted: null as number | null };
	// An unborn HEAD (a repo with no commit yet) makes `diff HEAD` fail; compare the
	// working tree against the canonical empty tree so a staged first commit still counts.
	const numstat2 = numstat.ok ? numstat : await run("git", ["diff", "--numstat", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"], cwd);
	const { added, removed } = sumNumstat(numstat2.out);
	return {
		branch,
		tag: await tagFor(cwd, branch),
		uncommitted: parsed.uncommitted,
		added: numstat2.ok ? added : null,
		removed: numstat2.ok ? removed : null,
		ahead: parsed.ahead,
		behind: parsed.behind,
	};
}
