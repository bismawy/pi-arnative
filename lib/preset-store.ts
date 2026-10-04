/**
 * Persist the small UI choices made through `/arnative` (header and footer preset).
 *
 * Why a sidecar and not `settings.json`: pi owns that file through its live `SettingsManager`
 * (queued writes, atomic replace, field-level merge) and exposes no write API to extensions, so
 * editing it directly would race the manager and could drop concurrent changes. The choices here
 * belong to this package, not to pi.
 *
 * The file is read once per process and merged on write, so two extensions writing different
 * keys cannot clobber each other.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { assert, isMain } from "./check.ts";

export const HEADER_PRESET_KEY = "headerPreset";
export const FOOTER_PRESET_KEY = "footerPreset";

// Resolved per call, not at import: the self-check points getAgentDir() at a fixture dir.
const configPath = (): string => join(getAgentDir(), "arnative-config.json");

let memo: Record<string, unknown> | null = null;

function readConfig(): Record<string, unknown> {
	if (memo) return memo;
	memo = {};
	try {
		if (existsSync(configPath())) {
			const raw = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
			if (raw && typeof raw === "object" && !Array.isArray(raw)) memo = raw as Record<string, unknown>;
		}
	} catch {
		// unreadable/corrupt: fall back to defaults rather than crash the header
	}
	return memo;
}

/** The stored value for `key`, or undefined when absent or not one of `allowed`. */
export function loadChoice<T extends string>(key: string, allowed: readonly T[]): T | undefined {
	const value = readConfig()[key];
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Store a choice. Best effort: an unwritable agent dir must not break the TUI. */
export function saveChoice(key: string, value: string): void {
	const current = readConfig();
	if (current[key] === value) return;
	current[key] = value;
	try {
		const dir = dirname(configPath());
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(configPath(), `${JSON.stringify(current, null, 2)}\n`, "utf8");
	} catch {
		// ignore: the choice still applies for this session
	}
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

	// The point of the file: the choice outlives the process (drop the in-memory copy).
	resetPresetCache();
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === "b", "the choice survives a restart (read from disk)");

	// A value no longer in the allowed set (renamed preset) falls back instead of breaking.
	saveChoice(HEADER_PRESET_KEY, "gone");
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === undefined, "an unknown stored value is rejected");

	// A corrupt file must not throw on the header's render path.
	writeFileSync(join(fixture, "arnative-config.json"), "{not json", "utf8");
	resetPresetCache();
	assert(loadChoice(HEADER_PRESET_KEY, ["a", "b"] as const) === undefined, "a corrupt config file reads as empty");

	rmSync(fixture, { recursive: true, force: true });
	console.log("preset-store.ts self-check OK");
}