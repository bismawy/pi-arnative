// The byte ceilings scale with the proxy wall. A fixed 900 KB ceiling caps a
// 1M-token model at roughly 12% of its window, so the wall is a knob:
// PI_ARNATIVE_BYTE_WALL_MB. The constants are read at module load, so each case
// runs in its own process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Windows rejects a bare drive path in a dynamic import, so hand over a file URL.
const file = pathToFileURL(join(root, "extensions", "autocompact.ts")).href;

function limits(mb?: string, storedLimit?: string): { trigger: number; target: number; compactInput: number; active: string } {
	const dir = mkdtempSync(join(tmpdir(), "arnative-bytewall-"));
	try {
		const script = [
			'const m = await import(process.argv[1]);',
			'if (process.argv[2]) m.setPayloadLimit(process.argv[2]);',
			'const c = m.activeByteCeilings();',
			'console.log(JSON.stringify({',
			'  trigger: c ? c.shedTriggerBytes : m.SHED_TRIGGER_BYTES,',
			'  target: c ? c.shedTargetBytes : m.SHED_TARGET_BYTES,',
			'  compactInput: c ? c.compactInputBytes : m.COMPACT_INPUT_BYTES,',
			'  active: m.activePayloadLimit(),',
			'}));',
		].join(" ");
		const out = execFileSync(
			process.execPath,
			["-e", script, file, storedLimit ?? ""],
			{
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: dir,
					...(mb !== undefined ? { PI_ARNATIVE_BYTE_WALL_MB: mb } : { PI_ARNATIVE_BYTE_WALL_MB: "" }),
				},
				encoding: "utf8",
			},
		);
		return JSON.parse(out.trim());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("without the knob the ceilings keep the 1 MB defaults", () => {
	const { trigger, target, compactInput, active } = limits();
	assert.equal(active, "1 MB");
	assert.equal(trigger, 900 * 1024, "trigger stays at the shipped 900 KB");
	assert.equal(target, 760 * 1024, "target stays at the shipped 760 KB");
	assert.equal(compactInput, 720 * 1024, "compaction input stays at 720 KB");
});

test("a 16 MB wall scales every ceiling by 16", () => {
	const { trigger, target, compactInput, active } = limits("16");
	assert.equal(active, "16 MB");
	assert.equal(trigger, 900 * 1024 * 16, "trigger follows the wall");
	assert.equal(target, 760 * 1024 * 16, "target follows the wall");
	assert.equal(compactInput, 720 * 1024 * 16, "compaction input follows the wall");
});

test("a nonsense value falls back to the 1 MB default", () => {
	for (const bad of ["", "0", "-4", "abc"]) {
		const { trigger } = limits(bad);
		assert.equal(trigger, 900 * 1024, `"${bad}" must fall back to 900 KB`);
	}
});

test("stored payloadLimit works without env vars and accepts custom MB or Off", () => {
	const custom = limits(undefined, "11 MB");
	assert.equal(custom.active, "11 MB");
	assert.equal(custom.trigger, 900 * 1024 * 11, "custom 11 MB scales trigger");
	const off = limits(undefined, "Off");
	assert.equal(off.active, "Off");
});
