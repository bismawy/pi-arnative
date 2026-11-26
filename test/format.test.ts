import test from "node:test";
import assert from "node:assert/strict";
import { modelDisplayParts } from "../lib/format.ts";

test("modelDisplayParts strips verbose Magpie metadata and puts remote backend in provider", () => {
	assert.deepEqual(
		modelDisplayParts({
			id: "remote/agy-cli/gemini-4-neon",
			name: "Gemini 4 Neon · Antigravity (local agy CLI) · Remote",
			provider: "magpie",
		}),
		{ name: "Gemini 4 Neon", provider: "Magpie/agy-cli" },
	);
	assert.deepEqual(
		modelDisplayParts({
			id: "remote/auto/gemini-4-neon",
			name: "Gemini 4 Neon · routing group · Remote",
			provider: "magpie",
		}),
		{ name: "Gemini 4 Neon", provider: "Magpie/auto" },
	);
	assert.deepEqual(
		modelDisplayParts({
			id: "remote/river/deepseek-ai/DeepSeek-V4.1-Flash-1017",
			name: "DeepSeek V4.1 Flash 1017 · River · Remote",
			provider: "magpie",
		}),
		{ name: "DeepSeek V4.1 Flash 1017", provider: "Magpie/river" },
	);
});

test("modelDisplayParts preserves non-remote prefixes and handles flat or unnamed models", () => {
	assert.deepEqual(
		modelDisplayParts({
			id: "local/agy-cli/gemini-4-neon",
			name: "Gemini 4 Neon · Local",
			provider: "magpie",
		}),
		{ name: "Gemini 4 Neon", provider: "Magpie/local/agy-cli" },
	);
	assert.deepEqual(
		modelDisplayParts({ id: "remote/auto/glm-5.3", provider: "magpie" }),
		{ name: "Glm 5.3", provider: "Magpie/auto" },
	);
	assert.deepEqual(
		modelDisplayParts({ id: "gpt-6.1-sol", provider: "agentrouter" }),
		{ name: "Gpt 6.1 Sol", provider: "Agentrouter" },
	);
	assert.deepEqual(
		modelDisplayParts({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (Antigravity)", provider: "antigravity" }),
		{ name: "Gemini 3.8 Flash", provider: "Antigravity" },
	);
	assert.deepEqual(modelDisplayParts(undefined), { name: "No Model", provider: "" });
});
