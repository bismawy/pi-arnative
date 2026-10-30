/**
 * Persist the small UI choices made through `/arnative` (header and footer preset).
 *
 * Why a sidecar and not `settings.json`: pi owns that file through its live `SettingsManager`
 * (queued writes, atomic replace, field-level merge) and exposes no write API to extensions, so
 * editing it directly would race the manager and could drop concurrent changes. The choices here
 * belong to this package, not to pi.
 *
 * Reads are memoised per process; every write re-reads the file and replaces it atomically
 * (temp file + rename), so concurrent pi sessions that write different keys keep both.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { assert, isMain } from "./check.ts";

export const HEADER_PRESET_KEY = "headerPreset";
export const FOOTER_PRESET_KEY = "footerPreset";

// Resolved per call, not at import: the self-check points getAgentDir() at a fixture dir.
// Everything pi-arnative writes lives in one folder (agent dir/arnative); the config moved
// there from a flat arnative-config.json, which is migrated in on first read.
const configDir = (): string => join(getAgentDir(), "arnative");
const configPath = (): string => join(configDir(), "config.json");
const legacyConfigPath = (): string => join(getAgentDir(), "arnative-config.json");

/** Layout "1": every file this package writes lives under `<agent>/arnative` — the flat
 *  `arnative-*.json` files are moved on first read, a leftover a downgrade recreated next
 *  to the folder copy is removed, and `layoutVersion` in config.json records the layout so
 *  the next layout change has one stamp to migrate from. */
const LAYOUT_VERSION = "1";

let memo: Record<string, unknown> | null = null;

function readDisk(): { parsed: boolean; record: Record<string, unknown> } {
	try {
		// One-time move into the arnative folder (was a flat file next to it).
		if (!existsSync(configPath()) && existsSync(legacyConfigPath())) {
			mkdirSync(configDir(), { recursive: true });
			renameSync(legacyConfigPath(), configPath());
		} else if (existsSync(legacyConfigPath())) {
			// Both exist — a downgrade recreated the flat file next to the folder copy. The
			// folder copy belongs to the newer layout, so the flat one is dead.
			rmSync(legacyConfigPath());
		}
		const raw = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) return { parsed: true, record: raw as Record<string, unknown> };
		return { parsed: false, record: {} }; // readable JSON of the wrong shape: read as empty, never rewritten
	} catch {
		// absent, unreadable or corrupt: fall back to defaults rather than crash the header
		return { parsed: false, record: {} };
	}
}

const readConfig = (): Record<string, unknown> => {
	if (memo) return memo;
	const { parsed, record } = readDisk();
	memo = record;
	// Stamp once per layout version (idempotent; saveChoice re-reads and merges, so a
	// concurrent session's keys survive the write) — but only over an absent file or a
	// cleanly parsed one: a corrupt or transiently unreadable config must never be wiped.
	if ((parsed || !existsSync(configPath())) && memo.layoutVersion !== LAYOUT_VERSION) {
		saveChoice("layoutVersion", LAYOUT_VERSION);
	}
	return memo;
};

/** The stored value for `key`, or undefined when absent or not one of `allowed`. */
export function loadChoice<T extends string>(key: string, allowed: readonly T[]): T | undefined {
	const value = readConfig()[key];
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Store a choice. Best effort: an unwritable agent dir must not break the TUI. */
export function saveChoice(key: string, value: string, rename: (from: string, to: string) => void = renameSync): void {
	if (readConfig()[key] === value) return;
	// Re-read: another pi session may have written its own key since this one loaded.
	memo = { ...readDisk().record, [key]: value };
	try {
		const path = configPath();
		const tmp = `${path}.${process.pid}.tmp`;
		mkdirSync(dirname(path), { recursive: true });
		const payload = `${JSON.stringify(memo, null, 2)}\n`;
		writeFileSync(tmp, payload, "utf8");
		try {
			rename(tmp, path);
		} catch (e) {
			// Windows: a running pi session can hold config.json open, and then the atomic
			// replace fails with EPERM while an in-place write still lands. A setting that
			// silently never reaches disk is worse than the small truncation window here.
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "EPERM" && code !== "EBUSY" && code !== "EXDEV") throw e;
			writeFileSync(path, payload, "utf8");
			rmSync(tmp, { force: true });
		}
	} catch {
		// ignore: the choice still applies for this session
	}
}

/** Record the choices in use, so `config.json` names every preset instead of only the ones a
 *  user changed — a fresh install then reads a complete profile instead of an empty file.
 *  Runs at `session_start`; after the first run every key already matches and nothing is
 *  written. A present-but-unreadable config is never replaced by this partial record (the
 *  same rule the layout stamp follows), because that would drop the other keys. */
export function ensureChoices(values: Record<string, string>): void {
	const { parsed } = readDisk();
	if (!parsed && existsSync(configPath())) return;
	for (const [key, value] of Object.entries(values)) saveChoice(key, value);
}

/** Drop the in-memory copy so the next read hits disk (a restart, in a test). */
export function resetPresetCache(): void {
	memo = null;
}

// Self-check: `node lib/preset-store.ts`
if (isMain(import.meta.url)) {
	// The real agent dir must not decide pass/fail, and the test must not touch it.
	const fixture = mkdtempSync(join(tmpdir(), "arnative-preset-"));
	process.env.PI_CODING_AGENT_DIR = fixture;

	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === undefined, "absent key reads as undefined");
	saveChoice(HEADER_PRESET_KEY, "b");
	saveChoice(FOOTER_PRESET_KEY, "a");
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === "b", "a saved choice reads back");
	assert(loadChoice(FOOTER_PRESET_KEY, ["a", "b"] as const) === "a", "a second key is stored without clobbering the first");

	// Another pi session writes its own key after this one loaded; a save must keep it.
	writeFileSync(join(fixture, "arnative", "config.json"), JSON.stringify({ headerPreset: "b", footerPreset: "a", other: "x" }), "utf8");
	saveChoice(FOOTER_PRESET_KEY, "b");
	resetPresetCache();
	assert(loadChoice("other", ["x"] as const) === "x", "a key written by another process survives a save");

	// The point of the file: the choice outlives the process (drop the in-memory copy).
	resetPresetCache();
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === "b", "the choice survives a restart (read from disk)");

	// A value no longer in the allowed set (renamed preset) falls back instead of breaking.
	saveChoice(HEADER_PRESET_KEY, "gone");
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === undefined, "an unknown stored value is rejected");

	// A corrupt file must not throw on the header's render path.
	writeFileSync(join(fixture, "arnative", "config.json"), "{not json", "utf8");
	resetPresetCache();
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === undefined, "a corrupt config file reads as empty");
	assert(readFileSync(join(fixture, "arnative", "config.json"), "utf8") === "{not json", "a corrupt config is left untouched — no stamp over it");

	// The flat pre-folder config is moved into the arnative folder on first read.
	const mig = mkdtempSync(join(tmpdir(), "arnative-preset-mig-"));
	process.env.PI_CODING_AGENT_DIR = mig;
	writeFileSync(join(mig, "arnative-config.json"), JSON.stringify({ headerPreset: "b" }), "utf8");
	resetPresetCache();
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === "b", "a legacy flat config is migrated and read");
	assert(existsSync(join(mig, "arnative", "config.json")), "the migrated config lives in the arnative folder");
	rmSync(mig, { recursive: true, force: true });

	// Layout stamp: the folder copy wins over a stale flat file a downgrade recreated,
	// the stale file is removed, and stamping merges into the config instead of replacing it.
	const stamp = mkdtempSync(join(tmpdir(), "arnative-preset-stamp-"));
	process.env.PI_CODING_AGENT_DIR = stamp;
	mkdirSync(join(stamp, "arnative"), { recursive: true });
	writeFileSync(join(stamp, "arnative", "config.json"), JSON.stringify({ headerPreset: "b" }), "utf8");
	writeFileSync(join(stamp, "arnative-config.json"), JSON.stringify({ headerPreset: "a" }), "utf8"); // stale, from a downgrade
	resetPresetCache();
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === "b", "the folder copy wins over the stale flat file");
	assert(!existsSync(join(stamp, "arnative-config.json")), "the stale flat config is removed");
	assert(loadChoice("layoutVersion", ["1"] as const) === "1", "the layout stamp is written on first read");
	const stamped = JSON.parse(readFileSync(join(stamp, "arnative", "config.json"), "utf8")) as Record<string, unknown>;
	assert(stamped.headerPreset === "b" && stamped.layoutVersion === "1", "stamping merges, it does not replace");
	rmSync(stamp, { recursive: true, force: true });

	// The startup record names every choice, including the ones still at their default.
	const profile = mkdtempSync(join(tmpdir(), "arnative-preset-profile-"));
	process.env.PI_CODING_AGENT_DIR = profile;
	resetPresetCache();
	ensureChoices({ headerPreset: "Arnative (Full)", footerPreset: "Arnative (Full)" });
	assert(loadChoice(HEADER_PRESET_KEY, ["Arnative (Full)"] as const) === "Arnative (Full)", "a default choice is written, not skipped");
	assert(loadChoice(FOOTER_PRESET_KEY, ["Arnative (Full)"] as const) === "Arnative (Full)", "every key in the batch is written");
	const profiled = readFileSync(join(profile, "arnative", "config.json"), "utf8");
	ensureChoices({ headerPreset: "Arnative (Full)", footerPreset: "Arnative (Full)" });
	assert(readFileSync(join(profile, "arnative", "config.json"), "utf8") === profiled, "a second record writes nothing");

	// Windows: a running pi session can hold the file open, so the atomic replace fails
	// while the setting still has to land. The seam stands in for that rename.
	const locked = () => {
		throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
	};
	saveChoice(HEADER_PRESET_KEY, "b", locked);
	resetPresetCache();
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === "b", "a refused rename still writes the choice in place");
	saveChoice(FOOTER_PRESET_KEY, "a", locked);
	resetPresetCache();
	assert(loadChoice(FOOTER_PRESET_KEY, ["a", "b"] as const) === "a" && loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === "b", "the in-place write keeps the other keys");
	assert(!existsSync(join(profile, "arnative")) || readdirSync(join(profile, "arnative")).every((f) => !f.endsWith(".tmp")), "no temp file is left behind");

	writeFileSync(join(profile, "arnative", "config.json"), "{not json", "utf8");
	resetPresetCache();
	ensureChoices({ headerPreset: "b" });
	assert(readFileSync(join(profile, "arnative", "config.json"), "utf8") === "{not json", "the startup record leaves an unreadable config alone");
	rmSync(profile, { recursive: true, force: true });

	process.env.PI_CODING_AGENT_DIR = fixture;
	resetPresetCache();

	rmSync(fixture, { recursive: true, force: true });
	console.log("preset-store.ts self-check OK");
}
