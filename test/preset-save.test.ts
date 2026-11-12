import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadChoice, resetPresetCache, saveChoice } from "../lib/preset-store.ts";

function withFixture(t: TestContext, run: (path: string, warnings: string[]) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "arnative-preset-save-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	mkdirSync(join(dir, "arnative"));
	const warnings: string[] = [];
	t.mock.method(process, "emitWarning", (warning: string | Error) => warnings.push(String(warning)));
	resetPresetCache();
	try {
		run(join(dir, "arnative", "config.json"), warnings);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

for (const invalid of ["{not json", "[]", "null", '"not a profile"']) {
	test(`a save preserves an invalid profile: ${invalid}`, (t) => {
		withFixture(t, (path, warnings) => {
			writeFileSync(path, invalid);
			assert.equal(loadChoice("headerPreset", ["a", "b"]), undefined);
			saveChoice("spinnerPreset", "Circle Wave");
			assert.equal(readFileSync(path, "utf8"), invalid);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /not saved|cannot save/i);
		});
	});
}

test("saving a cached choice compares against the current disk value", (t) => {
	withFixture(t, (path, warnings) => {
		writeFileSync(path, JSON.stringify({ layoutVersion: "1", headerPreset: "a" }));
		assert.equal(loadChoice("headerPreset", ["a", "b"]), "a");
		writeFileSync(path, JSON.stringify({ layoutVersion: "1", headerPreset: "b", other: "preserve" }));
		saveChoice("headerPreset", "a");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { headerPreset: "a", layoutVersion: "1", other: "preserve" });
		assert.equal(warnings.length, 0);
	});
});

test("a disk no-op refreshes cached choices without rewriting bytes", (t) => {
	withFixture(t, (path, warnings) => {
		writeFileSync(path, JSON.stringify({ layoutVersion: "1", headerPreset: "a" }));
		loadChoice("headerPreset", ["a", "b"]);
		const current = '{ "layoutVersion": "1", "headerPreset": "b", "footerPreset": "full" }\n';
		writeFileSync(path, current);
		saveChoice("headerPreset", "b");
		assert.equal(readFileSync(path, "utf8"), current);
		assert.equal(loadChoice("headerPreset", ["a", "b"]), "b");
		assert.equal(loadChoice("footerPreset", ["full"]), "full");
		assert.equal(warnings.length, 0);
	});
});

test("a profile corrupted after the cache warmed is not overwritten", (t) => {
	withFixture(t, (path, warnings) => {
		writeFileSync(path, JSON.stringify({ layoutVersion: "1", headerPreset: "a" }));
		loadChoice("headerPreset", ["a", "b"]);
		writeFileSync(path, "{partial");
		saveChoice("headerPreset", "b");
		assert.equal(readFileSync(path, "utf8"), "{partial");
		assert.equal(warnings.length, 1);
	});
});

test("a missing profile is created with ordered keys and a layout stamp", (t) => {
	withFixture(t, (path, warnings) => {
		saveChoice("headerPreset", "a");
		saveChoice("footerPreset", "b");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { headerPreset: "a", footerPreset: "b", layoutVersion: "1" });
		assert.equal(warnings.length, 0);
	});
});
