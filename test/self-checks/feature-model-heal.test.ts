import test from "node:test";
import { assert } from "../helpers/check.ts";
import { depsFor, isRejectedParam, isEffortRejection, healAllowed, deferNotice } from "../../lib/features/model-heal.ts";

test("lib/features/model-heal.ts self-check", async () => {
	assert(isRejectedParam({ role: "assistant", provider: "r", model: "m", errorMessage: "400 invalid reasoning_effort" }), "a rejected effort triggers a re-probe");
	assert(!isRejectedParam({ role: "assistant", provider: "r", model: "m", errorMessage: "401 unauthorized" }), "an auth failure costs no probe");
	assert(!isRejectedParam({ role: "user", provider: "r", model: "m", errorMessage: "bad request" }), "only assistant messages count");
	assert(!isRejectedParam(undefined), "no message, no probe");
	assert(isEffortRejection({ role: "assistant", provider: "r", model: "m", errorMessage: "400 invalid reasoning_effort: medium" }), "an effort rejection drops the level");
	assert(!isEffortRejection({ role: "assistant", provider: "r", model: "m", errorMessage: "400 bad request: context too long" }), "a plain 400 keeps the map");
	assert(healAllowed("Flags", "Full", false) && healAllowed("Full", "Full", false), "Full runs every pass");
	assert(healAllowed("Flags", "Flags", false) && !healAllowed("Full", "Flags", false), "Flags runs only the offline pass");
	assert(!healAllowed("Flags", "Off", false) && !healAllowed("Full", "Off", false), "Off runs nothing");
	assert(!healAllowed("Flags", "Full", true) && !healAllowed("Flags", "Flags", true), "an installed pi-auto-compat owns the file");
	assert(deferNotice("Full", true) && deferNotice("Flags", true), "the hand-over notice shows while heal is wanted");
	assert(!deferNotice("Off", true) && !deferNotice("Full", false), "and stays quiet when Off or nothing to defer to");
	const owned = depsFor({ modelRegistry: { getAll: () => [{ provider: "x", id: "a" }, null], getRegisteredProviderConfig: (p: string) => (p === "ext" ? { refreshModels: () => [] } : undefined) } });
	assert(owned.models().length === 1, "non-object registry entries are dropped");
	assert(owned.ownsModels("ext") && !owned.ownsModels("x"), "an extension list with refreshModels owns its models");
	const throwing = depsFor({ modelRegistry: { getRegisteredProviderConfig: () => { throw new Error("stale"); } } });
	assert(!throwing.ownsModels("x") && throwing.models().length === 0, "a stale registry reads as empty");
});
