#!/usr/bin/env node
// Launches pi with working-tree extensions via absolute paths and -ne (isolated from
// global installs), stamping .git/arnative-preview on clean exit for pre-push verification.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXTENSIONS = ["index.ts"];

// Must stay byte-identical to fingerprint() in the global pre-push hook:
// the same paths in the same order, hashed the same way.
function fingerprint(rev) {
	const tree = execFileSync("git", ["ls-tree", "-r", rev, "--", "extensions", "lib", "themes", "package.json"], {
		cwd: root,
	});
	return createHash("sha256").update(tree).digest("hex");
}

const porcelain = () => execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();

// `pi` is an npm or installer wrapper (sh on POSIX, .cmd/.ps1 on Windows) — and Node's
// spawnSync cannot launch extensionless scripts or .cmd directly on Windows without a shell.
// Resolve the JS launcher next to `where pi` (`pi-launcher.js` for Pi's installer, or the
// global npm `cli.js` entry). Node itself runs either fine.
function resolvePi() {
	const direct = spawnSync("pi", ["--version"], { encoding: "utf8" });
	if (!direct.error) return { file: "pi", prefix: [] };
	if (process.platform !== "win32") {
		throw new Error(`Cannot launch pi: ${direct.error.message}`);
	}
	const where = spawnSync("where", ["pi"], { encoding: "utf8" });
	const lines = where.stdout.trim().split(/\r?\n/).filter(Boolean);
	if (where.status !== 0 || lines.length === 0) {
		throw new Error("Cannot launch pi: 'pi' not found on PATH (spawnSync failed and `where pi` found nothing)");
	}
	const tried = [];
	for (const hit of lines) {
		const dir = dirname(hit);
		for (const candidate of [
			join(dir, "pi-launcher.js"),
			join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
		]) {
			tried.push(candidate);
			if (existsSync(candidate)) return { file: process.execPath, prefix: [candidate] };
		}
	}
	throw new Error(`Cannot launch pi: checked ${tried.join(", ")} from 'where pi', none existed`);
}

// Looking at uncommitted work is allowed and useful. *Certifying* it is not: the stamp is
// keyed to a commit's tree, so a dirty tree can be previewed but never stamped. The push
// gate stays closed until a commit is previewed — which is the rule, enforced at the
// moment it matters rather than blocking the user from seeing their own edit.
const dirtyBefore = porcelain();
if (dirtyBefore) {
	console.log("Uncommitted changes — the preview will run, but it will NOT be stamped:");
	console.log(dirtyBefore.replace(/^/gm, "  "));
	console.log("Commit, then re-run to certify a pushable tree.\n");
}

const args = [
	"-ne",
	"--theme",
	"./themes",
	...EXTENSIONS.flatMap((f) => ["-e", `./extensions/${f}`]),
	...process.argv.slice(2),
];

// Say what is being previewed BEFORE pi takes the screen: a preview run from the wrong
// branch looks identical to a broken one from inside the session (this exact trap: a
// feature "missing" that was simply never in the previewed tree).
const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
const shortRev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
console.log(`Previewing ${branch || "(detached)"} @ ${shortRev} — commit first, or the stamp will not match this tree.\n`);

let launcher;
try {
	launcher = resolvePi();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const run = spawnSync(launcher.file, [...launcher.prefix, ...args], { cwd: root, stdio: "inherit" });
if (run.error) {
	console.error(`Cannot launch pi: ${run.error.message}`);
	process.exit(1);
}
if (run.status !== 0) {
	console.error(`\npi exited with code ${run.status} — nothing stamped, the preview did not complete.`);
	process.exit(run.status ?? 1);
}

// Re-check: editing files while pi was open would certify code nobody saw.
const dirtyAfter = porcelain();
if (dirtyBefore || dirtyAfter) {
	console.error("\nNot stamped — the tree was dirty at some point during the preview.");
	if (dirtyAfter && dirtyAfter !== dirtyBefore) {
		console.error("Files changed while pi was open, so this preview certified nothing:");
		console.error(dirtyAfter.replace(/^/gm, "  "));
	}
	console.error("Commit the changes and run this again to certify a pushable commit.");
	process.exit(1);
}

const rev = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const print = fingerprint(rev);
const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8" }).trim();
writeFileSync(join(gitDir, "arnative-preview"), `${print}\n`);

console.log(`\nPreview stamped: ${print.slice(0, 12)}…  (${rev.slice(0, 7)})`);
console.log("The pre-push hook now accepts this tree. Change extensions/lib/themes/package.json and it will not.");