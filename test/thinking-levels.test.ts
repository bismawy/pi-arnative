/**
 * The thinking map the provider wizard writes, read through pi's own level logic. A pinned
 * level is a ceiling: the user can still pick any level below it and turn thinking off.
 * Before this, the map nulled every level but one and the model was stuck on it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { levelToWire } from "../lib/provider.ts";

// pi reads only these fields for thinking levels; the cast skips the rest of the Model type.
const modelFor = (level: Parameters<typeof levelToWire>[0]) => ({ id: "m", provider: "p", ...levelToWire(level) }) as unknown as Parameters<typeof getSupportedThinkingLevels>[0];

test("an xhigh pin keeps every level up to xhigh and off", () => {
	const model = modelFor("xhigh");
	assert.deepEqual(getSupportedThinkingLevels(model), ["off", "minimal", "low", "medium", "high", "xhigh"]);
	assert.equal(clampThinkingLevel(model, "medium"), "medium");
	assert.equal(clampThinkingLevel(model, "off"), "off");
});

test("a high pin stops at high", () => {
	const model = modelFor("high");
	assert.deepEqual(getSupportedThinkingLevels(model), ["off", "minimal", "low", "medium", "high"]);
	assert.equal(clampThinkingLevel(model, "xhigh"), "high");
});

test("a max pin offers the whole scale", () => {
	assert.deepEqual(getSupportedThinkingLevels(modelFor("max")), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("auto keeps pi's default scale", () => {
	assert.deepEqual(getSupportedThinkingLevels(modelFor("auto")), ["off", "minimal", "low", "medium", "high"]);
});
