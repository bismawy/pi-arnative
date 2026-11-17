// Child process for the watcher A/B: drive the REAL extension, then delete the agent dir
// so fs.watch emits an async EPERM 'error' event. Exit 0 only if nothing escapes.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arnative-ab-"));
process.env.PI_CODING_AGENT_DIR = dir;
writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }), "utf8");

const { default: registerModelHeal } = await import("../../extensions/model-heal.ts");

const handlers = new Map();
const fakePi = {
	on: (event, handler) => handlers.set(event, handler),
	registerCommand: () => {},
	setModel: async () => true,
};
registerModelHeal(fakePi);

const ctx = {
	model: undefined,
	modelRegistry: {
		getRegisteredProviderConfig: () => {
			throw new Error("no registry");
		},
	},
	ui: { notify: () => {} },
};

await handlers.get("session_start")?.({}, ctx);

// The trigger: the watched file's parent directory disappears (temp cleanup, a removed
// PI_CODING_AGENT_DIR, or an antivirus quarantine). fs.watch reports EPERM async.
rmSync(dir, { recursive: true, force: true });

// Reaching here means no error escaped to uncaughtException.
setTimeout(() => {
	console.log("SURVIVED");
	process.exit(0);
}, 900);
