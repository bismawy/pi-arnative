import test from "node:test";
import { assert } from "../helpers/check.ts";
import { ansiBgOpen, stripAnsi, themeOf, getActiveTheme, setActiveTheme, softOf, softSecondaryOf, thinkingColorOf, __test } from "../../lib/ansi.ts";

const { thinkingColorSlot } = __test;

test("lib/ansi.ts self-check", async () => {
	assert(ansiBgOpen(null, "selectedBg") === "", "no theme: empty");
	assert(ansiBgOpen({ bg: (_c, t) => `\x1b[48;2;9;9;9m${t}\x1b[49m` }, "selectedBg") === "\x1b[48;2;9;9;9m", "bg probe without reset");
	assert(stripAnsi("\x1b[2mA\x1b[22m") === "A", "stripAnsi removes SGR colors");
	assert(stripAnsi("x\x1b[K") === "x", "stripAnsi removes non-SGR CSI too");
	assert(themeOf({ ui: { theme: "T" } }) === "T", "themeOf reads ctx.ui.theme");
	assert(themeOf(null) === null, "themeOf tolerates a missing ctx");

	setActiveTheme({ fg: (c, t) => `<${c}>${t}</${c}>` });
	assert(getActiveTheme<object>() !== null, "active theme round-trips through globalThis");
	setActiveTheme(null);
	assert(getActiveTheme<object>() === null, "clearing the active theme leaves no stale slot");

	const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
	assert(softOf(tag)("x") === "<accentSoft>x</accentSoft>", "softOf uses accentSoft when the theme defines it");
	const noSoft = {
		fg: (c: string, t: string) => {
			if (c === "accentSoft") throw new Error("Unknown theme color: accentSoft");
			return `<${c}>${t}</${c}>`;
		},
	};
	assert(softOf(noSoft)("x") === "<muted>x</muted>", "softOf falls back to muted without the token or colors");
	assert(softOf(null)("x") === "x", "softOf without a theme is identity");
	// Pi 1.2.0: accentSoft is rejected, so the soft tint is derived from `colors.accent`.
	const modern = {
		fg: (c: string, t: string) => {
			throw new Error(`Unknown theme color: ${c}`);
		},
		style: (t: string, o: { fg: unknown }) => `<soft:${JSON.stringify(o.fg)}>${t}</soft>`,
		colors: { accent: { kind: "oklch", c: 0.2, h: 355 }, borderAccent: { kind: "oklch", c: 0.1, h: 200 } },
	};
	const modernOut = softOf(modern)("x");
	assert(
		Math.abs(JSON.parse(modernOut.match(/<soft:(.*)>x<\/soft>/)[1]!).c - 0.07) < 1e-9 &&
			modernOut.includes('"l":0.9'),
		"softOf derives the soft tint from accent (l=0.9, c=accent*0.35)",
	);
	assert(modernOut.includes("x"), "softOf keeps the text");
	// The label tier softens `borderAccent`, NOT `accent`: that is what keeps footer text
	// on the blue tier instead of inheriting the pink accent hue.
	const labelOut = softSecondaryOf(modern)("x");
	assert(
		Math.abs(JSON.parse(labelOut.match(/<soft:(.*)>x<\/soft>/)[1]!).c - 0.035) < 1e-9 &&
			labelOut.includes('"l":0.9') &&
			labelOut.includes('"h":200'),
		"softSecondaryOf softens borderAccent (l=0.9, c=borderAccent*0.35, same hue)",
	);
	assert(labelOut !== modernOut, "the soft label tier differs from the soft accent tier");
	assert(softSecondaryOf({ fg: () => "", style: (t) => `<x>${t}</x>`, colors: {} })("x") === softOf({ fg: () => "", style: (t) => `<x>${t}</x>`, colors: {} })("x"), "softSecondaryOf falls back to softOf without a borderAccent");

	assert(thinkingColorSlot("off") === "thinkingOff", "thinking off maps to thinkingOff");
	assert(thinkingColorSlot(undefined) === "thinkingOff", "missing level falls back to thinkingOff");
	assert(thinkingColorSlot("HIGH") === "thinkingHigh", "matching is case-insensitive");
	assert(thinkingColorSlot("xhigh") === "thinkingXhigh", "xhigh has its own slot");
	assert(thinkingColorSlot("max") === "thinkingMax", "max maps to thinkingMax");
	assert(thinkingColorSlot("nonsense") === "thinkingOff", "an unknown level degrades to thinkingOff");
	assert(thinkingColorOf(tag, "high")("x") === "<thinkingHigh>x</thinkingHigh>", "thinkingColorOf paints the level's slot");
	assert(thinkingColorOf(tag, undefined)("x") === "<thinkingOff>x</thinkingOff>", "thinkingColorOf defaults to thinkingOff");
	assert(thinkingColorOf(null, "high")("x") === "x", "thinkingColorOf without a theme is identity");
	const noThinking = {
		fg: (c: string, t: string) => {
			if (c.startsWith("thinking")) throw new Error(`Unknown theme color: ${c}`);
			return `<${c}>${t}</${c}>`;
		},
	};
	assert(thinkingColorOf(noThinking, "max")("x") === "<dim>x</dim>", "thinkingColorOf falls back to dim without the slot");
});
