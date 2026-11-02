#!/usr/bin/env node
// Local overlay for looking at a change before it is published: copy this checkout's
// runtime sources into the INSTALLED npm package, then press `/reload` in pi. pi
// re-evaluates extension TypeScript in the same process, so the reload loads the copy —
// no reinstall, no restart, and the package stays an npm install (nothing points pi at
// this directory).
//
//   npm run overlay              # copy extensions/ lib/ themes/ into the installed package
//   npm run overlay -- --dry-run # list what would move, write nothing
//
// Point PI_CODING_AGENT_DIR at a test agent dir to overlay that install instead.
// `pi update --extensions` puts the published code back once a higher version exists.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The directories pi loads at runtime: `pi.extensions` globs `./extensions/*.ts`,
 *  `pi.themes` globs `./themes/*.json`, and every extension imports `../lib/*.ts`. */
const RUNTIME_DIRS = ["extensions", "lib", "themes"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.slice(2).includes("--dry-run");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** pi's own default: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const installed = join(agentDir, "npm", "node_modules", ...pkg.name.split("/"));

const fail = (message) => {
	console.error(`overlay: ${message}`);
	process.exit(1);
};

if (installed === root) fail("the destination is this checkout — pick the installed copy, not the source");
if (!existsSync(installed)) fail(`${installed} does not exist. Install it first: pi install npm:${pkg.name}`);
if (!existsSync(join(installed, "package.json"))) fail(`${installed} has no package.json — not an installed package`);
const installedVersion = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version;
if (installedVersion !== pkg.version) {
	console.log(`overlay: version differs (source ${pkg.version} · installed ${installedVersion}) — copying anyway`);
}

/** Every file under `dir`, as paths relative to it; [] when the directory is absent. */
const walk = (dir) =>
	!existsSync(dir)
		? []
		: readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const path = join(dir, entry.name);
				return entry.isDirectory() ? walk(path).map((file) => join(entry.name, file)) : [entry.name];
			});

const added = [];
const changed = [];
const removed = [];
const same = [];

for (const name of RUNTIME_DIRS) {
	const from = join(root, name);
	const to = join(installed, name);
	const sources = walk(from);
	const wanted = new Set(sources);
	for (const rel of sources) {
		const target = join(to, rel);
		if (!existsSync(target)) added.push(join(name, rel));
		else if (readFileSync(target).equals(readFileSync(join(from, rel)))) same.push(join(name, rel));
		else changed.push(join(name, rel));
	}
	// A module deleted here must not linger in the installed copy: `pi.extensions` globs
	// the directory, so a stale entry point would keep loading after the reload.
	for (const rel of walk(to)) if (!wanted.has(rel)) removed.push(join(name, rel));
}

for (const file of added) console.log(`  + ${file}`);
for (const file of changed) console.log(`  ~ ${file}`);
for (const file of removed) console.log(`  - ${file}`);

if (dryRun) {
	console.log(`overlay: dry run — ${added.length} new, ${changed.length} changed, ${removed.length} stale, ${same.length} unchanged`);
	process.exit(0);
}

/** `<installed>/<rel>` and `<root>/<rel>` for one repo-relative file. */
const pair = (rel) => {
	const parts = rel.split(sep);
	return [join(root, ...parts), join(installed, ...parts)];
};

for (const rel of [...added, ...changed]) {
	const [source, target] = pair(rel);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, readFileSync(source));
}
for (const rel of removed) rmSync(pair(rel)[1], { force: true });

// Report the outcome from disk, not from the plan: the copy is what the next `/reload` loads.
const drifted = [...added, ...changed].filter((rel) => {
	const [source, target] = pair(rel);
	return !readFileSync(target).equals(readFileSync(source));
});
if (drifted.length > 0) fail(`copy did not land for: ${drifted.join(", ")}`);

console.log(
	`overlay: ${added.length + changed.length} written, ${removed.length} removed, ${same.length} unchanged → ${installed} (${pkg.name}@${pkg.version})`,
);
console.log("overlay: press /reload inside pi to load this copy");
