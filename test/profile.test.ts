/**
 * The startup record: `config.json` lists every preset in use, not only the ones a user
 * changed. Before this, the header choice never appeared because it never left its default
 * (the picker writes on move, so opening it and pressing Enter wrote nothing).
 *
 * Pointed at a fixture agent dir, so the real one stays clean. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordProfile } from "../extensions/arnative.ts";
import { activeAutoCompact } from "../extensions/autocompact.ts";
import { activeFooterPreset } from "../extensions/footer.ts";
import { activeHeaderPreset } from "../extensions/section-headers.ts";
import { activeSpinnerGradient, activeSpinnerPreset } from "../extensions/animations.ts";
import { activeModelHeal } from "../lib/model-heal.ts";
import { resetPresetCache } from "../lib/preset-store.ts";

/** Fresh fixture per case; the agent dir env var is restored either way. */
function withFixture(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "arnative-profile-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	resetPresetCache();
	try {
		run(dir);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		resetPresetCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

const configOf = (dir: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(dir, "arnative", "config.json"), "utf8")) as Record<string, unknown>;

test("the profile in use is recorded, defaults included", () => {
	withFixture((dir) => {
		recordProfile();
		const stored = configOf(dir);
		// Values come from the same getters the UI reads, so the file cannot drift from the
		// behaviour of this build.
		assert.equal(stored.headerPreset, activeHeaderPreset(), "header preset recorded");
		assert.equal(stored.footerPreset, activeFooterPreset(), "footer preset recorded");
		assert.equal(stored.spinnerPreset, activeSpinnerPreset(), "spinner preset recorded");
		assert.equal(stored.spinnerGradient, activeSpinnerGradient() ? "on" : "off", "spinner gradient recorded");
		assert.equal(stored.autoCompact, activeAutoCompact(), "auto-compact recorded");
		assert.equal(stored.modelHeal, activeModelHeal(), "model heal recorded");
		assert.equal(stored.layoutVersion, "1", "the layout stamp rides along");
		// The default header is the case that used to be missing: it must be present even though
		// the picker never wrote it.
		assert.equal(stored.headerPreset, "Arnative (Full)", "the default header preset is written, not skipped");
	});
});

test("a second record writes nothing", () => {
	withFixture((dir) => {
		recordProfile();
		const path = join(dir, "arnative", "config.json");
		const first = readFileSync(path, "utf8");
		recordProfile();
		assert.equal(readFileSync(path, "utf8"), first, "recording twice leaves the file byte-identical");
	});
});

test("an unreadable config is never replaced by the record", () => {
	withFixture((dir) => {
		const path = join(dir, "arnative", "config.json");
		recordProfile();
		writeFileSync(path, "{not json", "utf8");
		resetPresetCache();
		recordProfile();
		assert.equal(readFileSync(path, "utf8"), "{not json", "a corrupt config stays byte-identical");
	});
});
