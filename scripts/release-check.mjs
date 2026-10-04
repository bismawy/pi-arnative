#!/usr/bin/env node
// READ-ONLY release preflight. Never writes, tags, pushes or publishes.
//
// Run this before `git tag` and again before `npm publish`:
//   node scripts/release-check.mjs
//
// Exit 0 only when every check passes. Exit 1 on the first failing check,
// so a stale tree, an unmerged PR, or a version/tag/registry mismatch blocks
// the release instead of relying on a human remembering a numbered list.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const isTagMode = process.argv.includes("--tag");

const fails = [];
const ok = (label, detail) => console.log(`  ok   ${label.padEnd(22)} ${detail}`);
const bad = (label, detail) => {
	fails.push(label);
	console.log(`  FAIL ${label.padEnd(22)} ${detail}`);
};

// --- workspace hygiene ---------------------------------------------------
git("status", "--porcelain")
	? bad("clean tree", "uncommitted changes")
	: ok("clean tree", "no uncommitted changes");
git("branch", "--show-current") === "main"
	? ok("on main", "release lands on main")
	: bad("on main", `on ${git("branch", "--show-current")}`);
try {
	const local = git("rev-parse", "HEAD");
	const remote = git("rev-parse", "origin/main");
	local === remote ? ok("in sync", `origin/main == ${local.slice(0, 7)}`) : bad("in sync", `origin/main is ${remote.slice(0, 7)}`);
} catch {
	bad("in sync", "cannot resolve origin/main (fetch first)");
}

// --- open pull requests --------------------------------------------------
try {
	const prs = execFileSync("gh", ["pr", "list", "--state", "open", "--json", "number"], { cwd: root, encoding: "utf8" });
	const n = JSON.parse(prs || "[]").length;
	n === 0 ? ok("no open PRs", "gh pr list --state open is empty") : bad("no open PRs", `${n} still open`);
} catch {
	bad("no open PRs", "gh unavailable (run `gh auth status`)");
}

// --- version surfaces must agree ----------------------------------------
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
changelog.includes(`## [${version}]`)
	? ok("changelog entry", `## [${version}] present`)
	: bad("changelog entry", `CHANGELOG.md has no ## [${version}] section`);

const tagExists = Boolean(git("tag", "-l", tag));
const tagPushed = (() => {
	try {
		return git("ls-remote", "--tags", "origin", `refs/tags/${tag}`).length > 0;
	} catch {
		return false;
	}
})();

if (isTagMode) {
	// stage 2: tag must exist locally and on the remote, pointing at the release commit
	tagExists ? ok("tag exists", `${tag} -> ${git("rev-parse", `${tag}^{commit}`).slice(0, 7)}`) : bad("tag exists", `${tag} not created yet`);
	tagPushed ? ok("tag pushed", `origin has ${tag}`) : bad("tag pushed", `${tag} missing on origin`);
} else {
	// stage 1: tag must NOT exist yet, otherwise the version was already released
	tagExists ? bad("tag unused", `${tag} already exists — bump package.json`) : ok("tag unused", `${tag} is free`);
}

// --- registry: is this version already published? ------------------------
const meta = await fetch(`https://registry.npmjs.org/${pkg.name.replace("/", "%2F")}?ts=${Date.now()}`).then((r) => r.json()).catch(() => null);
if (!meta) {
	bad("registry reachable", "cannot read packument from registry.npmjs.org");
} else if (meta.versions?.[version]) {
	// already published: only acceptable in --tag mode (verifying an existing release)
	isTagMode
		? ok("registry", `${pkg.name}@${version} is published (immutable)`)
		: bad("registry", `${pkg.name}@${version} already published — bump package.json`);
} else if (!isTagMode) {
	ok("registry", `${pkg.name}@${version} is not published yet`);
} else {
	bad("registry", `${pkg.name}@${version} missing after publish — run npm publish`);
}

console.log();
if (fails.length) {
	console.log(`release-check FAILED (${fails.length}): ${fails.join(", ")}`);
	process.exit(1);
}
console.log(`release-check OK — ${pkg.name}@${version} ${isTagMode ? "verified" : "ready to tag"}`);