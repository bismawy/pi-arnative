import test from "node:test";
import { assert } from "../helpers/check.ts";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADER_PRESET_KEY, FOOTER_PRESET_KEY, BUDGET_DAY_KEY, loadChoice, loadNumber, saveChoice, ensureChoices, resetPresetCache, __test } from "../../lib/preset-store.ts";

const { KEY_ORDER } = __test;

test("lib/preset-store.ts self-check", async () => {
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

	// The file keeps one key order whatever order the writes arrived in.
	const keyOrder = () => Object.keys(JSON.parse(readFileSync(join(profile, "arnative", "config.json"), "utf8")) as Record<string, unknown>);
	assert(
		keyOrder().join(",") === "headerPreset,footerPreset,layoutVersion",
		"known keys follow KEY_ORDER, layoutVersion after the presets: " + keyOrder().join(","),
	);
	saveChoice("spinnerPreset", "Circle Wave");
	saveChoice("zzz-other", "x");
	assert(
		keyOrder().join(",") === "headerPreset,footerPreset,spinnerPreset,layoutVersion,zzz-other",
		"a newly written key slots into place, an unknown one goes last: " + keyOrder().join(","),
	);

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

	// loadNumber: amounts are stored as strings ("" = unset); anything that is not a finite
	// number in range reads as unset, so a hand-edited or corrupt value cannot become a cap.
	const nums = mkdtempSync(join(tmpdir(), "arnative-preset-num-"));
	process.env.PI_CODING_AGENT_DIR = nums;
	resetPresetCache();
	const range = { min: 0.01, max: 1_000_000 };
	saveChoice(BUDGET_DAY_KEY, "5");
	assert(loadNumber(BUDGET_DAY_KEY, range) === 5, "a stored amount parses");
	saveChoice(BUDGET_DAY_KEY, "7.50");
	assert(loadNumber(BUDGET_DAY_KEY, range) === 7.5, "a decimal amount parses");
	saveChoice(BUDGET_DAY_KEY, "abc");
	assert(loadNumber(BUDGET_DAY_KEY, range) === undefined, "a non-numeric amount reads as unset");
	saveChoice(BUDGET_DAY_KEY, "0");
	assert(loadNumber(BUDGET_DAY_KEY, range) === undefined, "below the range reads as unset");
	saveChoice(BUDGET_DAY_KEY, "2000000");
	assert(loadNumber(BUDGET_DAY_KEY, range) === undefined, "above the range reads as unset");
	saveChoice(BUDGET_DAY_KEY, "");
	assert(loadNumber(BUDGET_DAY_KEY, range) === undefined, "an empty amount reads as unset");
	writeFileSync(join(nums, "arnative", "config.json"), JSON.stringify({ [BUDGET_DAY_KEY]: 7 }), "utf8");
	resetPresetCache();
	assert(loadNumber(BUDGET_DAY_KEY, range) === 7, "a hand-edited numeric value is accepted");
	rmSync(nums, { recursive: true, force: true });

	process.env.PI_CODING_AGENT_DIR = fixture;
	resetPresetCache();

	rmSync(fixture, { recursive: true, force: true });
});
