#!/usr/bin/env node
// READ-ONLY release preflight. Never writes, tags, pushes or publishes.
//
// Three stages, matching the order of the release itself:
//   node scripts/release-check.mjs pre-tag        # before `git tag` — tag free, version unpublished
//   node scripts/release-check.mjs pre-publish    # before `npm publish` — tag pushed, version unpublished
//   node scripts/release-check.mjs post-publish   # after `npm publish` — tag pushed, version live
//
// `pre-publish` is wired to npm's `prepublishOnly`, so a missing or unpushed
// tag aborts the publish instead of relying on a human remembering a numbered
// list. Exit 0 only when every check passes; exit 1 on the first failing run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STAGES = ["pre-tag", "pre-publish", "post-publish"];
const stage = process.argv[2] ?? "pre-publish";
if (!STAGES.includes(stage)) {
	console.error(`usage: release-check.mjs <${STAGES.join("|")}>`);
	process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;

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
	const prs = execFileSync("gh", ["pr", "list", "--state", "open", "--json", "number"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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

if (stage === "pre-tag") {
	tagExists ? bad("tag unused", `${tag} already exists — bump package.json`) : ok("tag unused", `${tag} is free`);
} else {
	tagExists ? ok("tag exists", `${tag} -> ${git("rev-parse", `${tag}^{commit}`).slice(0, 7)}`) : bad("tag exists", `${tag} not created yet`);
	tagPushed ? ok("tag pushed", `origin has ${tag}`) : bad("tag pushed", `${tag} missing on origin — run git push origin ${tag}`);
}

// --- registry: is this version published? --------------------------------
const meta = await fetch(`https://registry.npmjs.org/${pkg.name.replace("/", "%2F")}?ts=${Date.now()}`).then((r) => r.json()).catch(() => null);
if (!meta) {
	bad("registry reachable", "cannot read packument from registry.npmjs.org");
} else if (stage === "post-publish") {
	meta.versions?.[version]
		? ok("registry", `${pkg.name}@${version} is published (immutable)`)
		: bad("registry", `${pkg.name}@${version} missing — run npm publish`);
} else {
	meta.versions?.[version]
		? bad("registry", `${pkg.name}@${version} already published — bump package.json`)
		: ok("registry", `${pkg.name}@${version} is not published yet`);
}

console.log();
if (fails.length) {
	console.log(`release-check FAILED [${stage}] (${fails.length}): ${fails.join(", ")}`);
	process.exit(1);
}
console.log(`release-check OK [${stage}] — ${pkg.name}@${version}`);