import test from "node:test";
import { assert } from "../helpers/check.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MAX_STATUS_ROWS, statusRows, __test } from "../../lib/status-widget.ts";

const { dim } = __test;

test("lib/status-widget.ts self-check", async () => {
	const tag = (color: string, text: string) => `<${color}>${text}</${color}>`;
	assert(
		JSON.stringify(statusRows({ fg: tag }, ["model-heal: healed"])) === JSON.stringify(["<dim> \ueb1b model-heal: healed</dim>"]),
		"one space before the mark, one after, one dim span for the whole row",
	);
	assert(JSON.stringify(statusRows(null, ["plain"])) === JSON.stringify([" \ueb1b plain"]), "no theme renders the plain line");
	assert(
		JSON.stringify(statusRows(null, ["\u{f06de} model-heal: x", "y"])) === JSON.stringify([" \u{f06de} model-heal: x", "   y"]),
		"a row that opens with its own glyph keeps it as the mark",
	);
	assert(
		JSON.stringify(statusRows({ fg: () => { throw new Error("unknown token"); } }, ["safe"])) === JSON.stringify([" \ueb1b safe"]),
		"a theme that rejects the token does not crash the render",
	);
	assert(
		JSON.stringify(statusRows({ fg: tag }, ["one", "\x1b[31mtwo\x1b[39m"])) ===
			JSON.stringify(["<dim> \ueb1b one</dim>", "<dim>   </dim>\x1b[31mtwo\x1b[39m"]),
		"an already-painted row keeps its own colour, continuation rows align under the text",
	);
	const long = statusRows({ fg: tag }, new Array(20).fill("x"));
	assert(long.length === MAX_STATUS_ROWS + 1 && long.at(-1)!.includes("widget truncated"), "a long block is capped like pi's own");
	assert(statusRows(null, []).length === 0, "an empty block renders nothing");
	// A component owns its width: a line wider than the terminal must be cut, not wrapped.
	const wide = statusRows({ fg: tag }, ["x".repeat(200)], 20);
	assert(wide.length === 1 && visibleWidth(wide[0]!) === 20, "rows are cut to the render width");
});
