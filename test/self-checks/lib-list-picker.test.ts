import test from "node:test";
import { assert } from "../helpers/check.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { screenTitle } from "../../lib/box.ts";
import { LIST_LEGEND_ROOT, LIST_LEGEND_MOVE, LIST_LEGEND_LIVE, INPUT_LEGEND, nameRows, ListPicker, InputPicker } from "../../lib/list-picker.ts";

test("lib/list-picker.ts self-check", async () => {
	assert(LIST_LEGEND_ROOT === "[↑↓] Move  [Enter] Select  [Esc] Close", "root legend pinned, no ← behind the root menu");
	assert(LIST_LEGEND_MOVE === "[↑↓] Move  [Enter] Select  [Esc] Back", "move legend pinned: Esc is Back where a parent exists");
	assert(LIST_LEGEND_LIVE === "[↑↓] Preview  [Enter] Select  [Esc] Back", "live legend pinned: Esc drops the preview and steps out");
	const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const quiet = (): void => undefined;
	const picker = new ListPicker(fakeTheme, nameRows(["a", "b"]), "a", { preview: quiet, revert: quiet, done: quiet, requestRender: quiet }, { title: screenTitle("Test"), description: "d", legend: "l" }, false);
	const lines = picker.render(50);
	assert(lines[0]!.startsWith("╭") && lines[lines.length - 1]!.startsWith("╰"), "picker framed");
	assert(lines.every((l) => visibleWidth(l) === 50), "picker lines fit width 50");
	assert(lines.some((l) => l.includes("❯ a")), "the cursor marks the selection");

	// The chosen marker: ✓ ends the saved row only, colored by the theme's success slot.
	const chosenPicker = new ListPicker(
		fakeTheme,
		[{ label: "a" }, { label: "b", note: "nb", chosen: true }],
		"b",
		{ preview: quiet, revert: quiet, done: quiet, requestRender: quiet },
		{ title: screenTitle("Test"), description: "d", legend: "l" },
		false,
	);
	const chosenLines = chosenPicker.render(50);
	assert(chosenLines.some((l) => l.includes("nb ✓")), "a chosen row ends with the ✓ marker");
	assert(chosenLines.every((l) => !l.includes("a ✓")), "unchosen rows carry no marker");

	// `←` behavior is owned by the screen: a parent gets the back call, `false` swallows
	// the key (a fill screen keeps its work), and a root menu closes like Esc.
	const keyLeft = "\x1b[D";
	let backCalls = 0;
	let closedByBack = false;
	const backPicker = new ListPicker(fakeTheme, nameRows(["a"]), "a", { preview: quiet, revert: quiet, done: quiet, cancel: quiet, requestRender: quiet, back: () => { backCalls++; } }, { title: screenTitle("Test"), description: "d", legend: "l" }, false);
	backPicker.handleInput(keyLeft);
	assert(backCalls === 1 && closedByBack === false, "a parent screen receives ← as back");
	let closed = "none";
	const noBackPicker = new ListPicker(fakeTheme, nameRows(["a"]), "a", { preview: quiet, revert: quiet, done: () => { closed = "done"; }, cancel: () => { closed = "cancel"; }, requestRender: quiet }, { title: screenTitle("Test"), description: "d", legend: "l" }, false);
	noBackPicker.handleInput(keyLeft);
	assert(closed === "cancel", "a root menu closes on ← like Esc");
	let fillClosed = "none";
	const fillPicker = new ListPicker(fakeTheme, nameRows(["a"]), "a", { preview: quiet, revert: quiet, done: () => { fillClosed = "done"; }, cancel: () => { fillClosed = "cancel"; }, requestRender: quiet, back: false }, { title: screenTitle("Test"), description: "d", legend: "l" }, false);
	fillPicker.handleInput(keyLeft);
	fillPicker.handleInput("\x1bOD");
	assert(fillClosed === "none", "a fill screen swallows ← entirely");

	// A long list scrolls: 10 rows visible, the cursor always inside the window, and one
	// frame height whether the cursor sits at the top or the bottom.
	const many = nameRows(Array.from({ length: 25 }, (_, i) => `m${i}`));
	const scrolled = new ListPicker(fakeTheme, many, "m0", { preview: quiet, revert: quiet, done: quiet, requestRender: quiet }, { title: screenTitle("Test"), description: "d", legend: "l" }, false, undefined, 10);
	const countItems = (ls: string[]): number => ls.filter((l) => /m\d/.test(l)).length;
	let frame = scrolled.render(50);
	assert(countItems(frame) === 10, "a scrolled list shows exactly 10 model rows");
	assert(frame.some((l) => l.includes("↓ 15 more")) && !frame.some((l) => l.includes("↑")), "the top of the list announces only what is below");
	for (let i = 0; i < 14; i++) scrolled.handleInput("\x1b[B");
	frame = scrolled.render(50);
	assert(countItems(frame) === 10, "still 10 rows after scrolling");
	assert(frame.some((l) => l.includes("↑ 9 more")) && frame.some((l) => l.includes("↓ 6 more")), "both ends announce their hidden rows");
	assert(frame.some((l) => l.includes("❯ m14")), "the cursor row stays visible");
	scrolled.handleInput("\x1b[B");
	const frameNext = scrolled.render(50);
	assert(frameNext.length === frame.length && countItems(frameNext) === 10, "the frame height stays constant while scrolling inside the list");
	for (let i = 0; i < 9; i++) scrolled.handleInput("\x1b[B");
	frame = scrolled.render(50);
	assert(frame.some((l) => l.includes("❯ m24")) && frame.some((l) => l.includes("↑ 15 more")) && !frame.some((l) => l.includes("↓")), "the bottom of the list announces only what is above");
	// Wrap at both edges, matching the /jev-eye picker: a held key never sticks.
	scrolled.handleInput("\x1b[B");
	assert(scrolled.render(50).some((l) => l.includes("❯ m0")), "↓ at the last row wraps to the top");
	scrolled.handleInput("\x1b[A");
	assert(scrolled.render(50).some((l) => l.includes("❯ m24")), "↑ at the top row wraps to the last row");
	const short = new ListPicker(fakeTheme, nameRows(["a", "b"]), "a", { preview: quiet, revert: quiet, done: quiet, requestRender: quiet }, { title: screenTitle("Test"), description: "d", legend: "l" }, false, undefined, 10);
	assert(!short.render(50).some((l) => l.includes("more")), "a short list shows no scroll indicators");

	// The text field: the pi-tui editor drives, the arnative box frames it.
	let submitted: string | null | undefined;
	let inputCancelled = false;
	const field = new InputPicker(fakeTheme, { title: screenTitle("Provider"), description: "Endpoint API — the base URL", legend: INPUT_LEGEND }, "", {
		done: (v) => { submitted = v; },
		cancel: () => { inputCancelled = true; },
		requestRender: quiet,
	}, "https://api.example.com/v1");
	field.focused = true;
	const fieldLines = field.render(60);
	// CSI and every APC wrapper (`\x1b_…\x07`): pi-tui 0.87 emitted only `_pi:c`, 1.4 adds
	// `_pi:fc`/`_pi:/fc` around the placeholder — a narrow strip left escapes glued to the
	// text and failed the include on CI's newer version.
	const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b_.*?\x07/g, "");
	assert(fieldLines[0]!.startsWith("╭") && fieldLines[1]!.includes("Provider - Arnative"), "the input renders in the arnative box");
	assert(fieldLines.some((l) => plain(l).includes("> https://api.example.com/v1")), "an empty field shows its dim placeholder");
	assert(fieldLines.some((l) => l.includes(INPUT_LEGEND)), "the input legend is pinned");
	for (const ch of "https://x.io") field.handleInput(ch);
	field.handleInput("\x1b[D");
	field.handleInput("io");
	assert(field.getValue() === "https://x.iioo", "typing with a moved cursor edits at the cursor");
	field.handleInput("\r");
	assert(submitted === "https://x.iioo", "Enter submits the value");
	assert(!inputCancelled, "Enter is not a cancel");
	field.handleInput("\x1b");
	assert(inputCancelled, "Esc cancels the field");
	// The Thinking flow: / starts typing, every key is text, Enter keeps the filter, then commands act on it.
	const hits: string[] = [];
	const filtered = new ListPicker(fakeTheme, [{ label: "river/ds-v4" }, { label: "auto/glm" }], undefined, { preview: () => {}, revert: () => {}, done: () => hits.push("done"), requestRender: () => {}, toggle: () => hits.push("toggle"), press: (k) => { if (/^[0-9]$/.test(k)) hits.push("press " + k); }, search: "models" }, { title: "T", description: "d", legend: "l" }, false);
	filtered.handleInput("r");
	assert(filtered.index === 0, "a letter outside typing does not filter");
	filtered.handleInput("/");
	for (const ch of "River 7") filtered.handleInput(ch);
	assert(hits.join() === "" && filtered.index === -1, "while typing, Space and digits are text");
	filtered.handleInput("\x7f");
	for (const ch of "ds4") filtered.handleInput(ch);
	assert(filtered.index === 0 && hits.join() === "", "the filter is fuzzy and ignores spaces: river ds4 finds river/ds-v4");
	filtered.handleInput("\r");
	filtered.handleInput("0");
	filtered.handleInput(" ");
	assert(hits.join() === "press 0,toggle" && filtered.index === 0, "Enter ends typing without saving, then keys are commands on the match");
	filtered.handleInput("/");
	filtered.handleInput("\x1b");
	assert(hits.join() === "press 0,toggle", "Esc while typing ends typing and keeps the filter, so the screen stays open");
	filtered.handleInput("\x1b");
	assert(hits.join().endsWith("done"), "a second Esc, outside typing, leaves the screen");

	const summarized = new ListPicker(fakeTheme, nameRows(["a", "b"]), "a", { preview: quiet, revert: quiet, done: quiet, requestRender: quiet, summary: () => ["Box · a"] }, { title: "T", description: "d", legend: "l" }, false);
	const sumLines = summarized.render(40).map(plain);
	assert(sumLines.some((l) => l.includes("Box · a")) && sumLines.indexOf(sumLines.find((l) => l.includes("Box · a"))!) < sumLines.indexOf(sumLines.find((l) => l.includes("❯ a"))!), "summary renders above the picker rows");

});
