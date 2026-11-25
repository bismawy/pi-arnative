import test from "node:test";
import { assert } from "../helpers/check.ts";
import { parseOklch, oklchToRgb, toHex, rgbToAnsi256, hexToRgb, contrast, hexToOklch, __test } from "../../lib/color.ts";

const { oklchToHex } = __test;

test("lib/color.ts self-check", async () => {
	// Test vectors, not styling: the hex parser is under test, so these must stay hex.
	const FIXTURE = {
		white: "#ffffff",
		black: "#000000",
		short: "#0af",
		shortExpanded: "#00aaff",
		cyan: "#00d7ff",
	};
	const o = parseOklch("oklch(62% 0.1 200)");
	assert(o !== null && Math.abs(o.L - 0.62) < 1e-9 && o.C === 0.1 && o.H === 200, "parseOklch reads percent L");
	assert(parseOklch("oklch(0.62 0.1 200)")?.L === 0.62, "parseOklch reads fractional L");
	assert(parseOklch(FIXTURE.short) === null, "parseOklch rejects hex");
	assert(toHex(FIXTURE.short) === FIXTURE.shortExpanded, "toHex expands #rgb");
	assert(toHex("oklch(100% 0 0)") === FIXTURE.white, "toHex converts oklch to hex");
	assert(oklchToHex(1, 0, 0) === FIXTURE.white, "oklch L=1 is white");
	assert(oklchToHex(0, 0, 0) === FIXTURE.black, "oklch L=0 is black");
	assert(contrast(FIXTURE.white, FIXTURE.black) === 21, "white on black = 21:1");
	assert(Math.abs(contrast(FIXTURE.black, FIXTURE.white) - 21) < 1e-9, "contrast is order-independent");
	const back = hexToOklch(FIXTURE.cyan);
	assert(Math.abs(back.H - 218) < 6, `hexToOklch hue of ${FIXTURE.cyan} ~218 (got ${back.H.toFixed(1)})`);
	assert(oklchToRgb(0.7, 0.4, 145).chroma < 0.4, "out-of-gamut chroma is reduced");
	// Quantizer vectors taken from pi-tui's own table: cube black, the teal panel pi's
	// dark theme uses, and a near-neutral that must fall on the grey ramp.
	assert(rgbToAnsi256({ r: 0, g: 24, b: 23 }) === 16, "near-black quantizes to cube black (index 16)");
	assert(rgbToAnsi256({ r: 33, g: 59, b: 73 }) === 23, "pi dark panel quantizes to 23");
	assert(rgbToAnsi256({ r: 200, g: 200, b: 200 }) >= 232, "neutral grey uses the grey ramp");
	assert(hexToRgb("#1c3f3d").g === 0x3f, "hexToRgb reads channels");
});
