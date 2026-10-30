/**
 * The task list widget and the `todo` tool. Pointed at no files and no pi context: the tool
 * body is pure apart from the module store, so `runTodo` can be driven directly. Run with
 * `npm test`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runTodo } from "../extensions/todos.ts";
import {
	addTodo,
	allDone,
	COLLAPSED_DONE,
	collapsedText,
	emptyTodos,
	HINT_COLLAPSE,
	HINT_EXPAND,
	LIST_ICON,
	normalizeState,
	patchTodo,
	recapRows,
	recapSummary,
	renderTodoBox,
	todoLayout,
	todoWindow,
	widgetRows,
	type FgTheme,
	type TaskState,
} from "../lib/todos.ts";

const plain: FgTheme = { fg: (_color, text) => text };
/** Writes the token down, so a test can name the colour instead of a code. */
const marked: FgTheme = { fg: (color, text) => `[${color}]${text}` };

/** A list of `count` queued tasks, with task `active` in progress. */
function seeded(count: number, active?: number): TaskState {
	let state = emptyTodos();
	for (let i = 1; i <= count; i++) state = addTodo(state, `Task ${i}`).state;
	return active === undefined ? state : patchTodo(state, active, { status: "in_progress", note: "sedang menulis" })!;
}

test("the box follows the five-row window", () => {
	const state = seeded(20, 10);
	const { visible, above, below } = todoWindow(state);
	assert.deepEqual(
		visible.map((task) => task.id),
		[8, 9, 10, 11, 12],
		"the active task is centred in the five visible rows",
	);
	assert.equal(above + visible.length + below, 20, "every task is either shown or counted");

	const box = renderTodoBox(plain, state, true, 80);
	assert.ok(box.length <= 10, `the box stays within pi's 10-line widget budget, got ${box.length}`);
	assert.ok(box.some((line) => line.includes("↑ 7 more")), "tasks above the window are counted");
	assert.ok(box.some((line) => line.includes("↓ 8 more")), "tasks below the window are counted");
	assert.ok(box.some((line) => line.includes("· sedang menulis")), "the in-progress note is rendered");
	assert.ok(box.every((line) => line.startsWith("│") || line.startsWith("╭") || line.startsWith("╰")), "one box");
});

test("collapsed is one boxed row naming the active task", () => {
	const box = renderTodoBox(plain, seeded(7, 3), false, 80);
	assert.equal(box.length, 3, "frame, row, frame");
	const row = box[1]!;
	assert.ok(row.includes(LIST_ICON), "the list icon leads the row");
	assert.ok(row.includes("Todos (0/7)"), "the row carries the count");
	assert.ok(row.includes("Task 3"), "the row names the task in progress");
	assert.ok(row.includes(HINT_EXPAND), "the row says how to open it");
	assert.ok(!row.includes(HINT_COLLAPSE), "the open hint only belongs to the expanded box");
	assert.ok(renderTodoBox(plain, seeded(7, 3), true, 80)[1]!.includes(HINT_COLLAPSE), "expanded says how to close it");
});

test("the icon is accent, and each status has its own token", () => {
	let state = seeded(3);
	state = patchTodo(state, 1, { status: "completed" })!;
	state = patchTodo(state, 2, { status: "in_progress", note: "sedang jalan" })!;
	const rows = widgetRows(marked, state, true, 80);
	assert.ok(rows[0]!.includes(`[accent]${LIST_ICON}`), `the heading icon is accent, got ${rows[0]}`);
	assert.ok(rows[0]!.includes("[accentSoft]Todos (1/3)"), `the count is soft accent, got ${rows[0]}`);
	assert.ok(rows[1]!.includes("[accent]✓"), "a done glyph is accent");
	assert.ok(rows[1]!.includes("[text]Task 1") && !rows[1]!.includes("[accentSoft]Task 1"), `a done subject is plain text, got ${rows[1]}`);
	assert.ok(rows[2]!.includes("[mdHeading]◉"), "the running task borrows the footer model-name colour");
	assert.ok(rows[2]!.includes("[accentSoft]Task 2"), `the running subject takes the soft accent, got ${rows[2]}`);
	assert.ok(rows[2]!.includes("[dim]· sedang jalan"), "its note stays dim");
	assert.ok(rows[3]!.includes("[dim]◌"), "a queued glyph is dim");
	assert.ok(rows[3]!.includes("[dim]Task 3"), "a queued subject is dim too");

	// The frame follows the thinking level, like every other arnative box.
	const framed = renderTodoBox(marked, state, true, 80, null, "high");
	assert.ok(framed[0]!.startsWith("[thinkingHigh]╭"), `the border takes the thinking slot, got ${framed[0]}`);
	assert.ok(framed.at(-1)!.startsWith("[thinkingHigh]╰"), "both edges of the frame");

	// A theme without `mdHeading` (pi throws on an unknown token) still paints the glyph.
	const partial: FgTheme = {
		fg: (color, text) => {
			if (color === "mdHeading") throw new Error("Unknown theme color: mdHeading");
			return `[${color}]${text}`;
		},
	};
	assert.ok(widgetRows(partial, state, true, 80)[2]!.includes("[accent]◉"), "the running task falls back to accent");
});

test("the window scrolls without leaving the list", () => {
	const state = seeded(20, 10);
	assert.equal(todoWindow(state, 5, 0).visible[0]!.id, 1, "top picks the first task");
	assert.equal(todoWindow(state, 5, 0).above, 0, "nothing hidden above the first task");
	assert.equal(todoWindow(state, 5, 99).visible.at(-1)!.id, 20, "past the end parks the window at the end");
	assert.equal(todoWindow(state, 5, 99).below, 0, "nothing hidden below the last window");
	assert.equal(todoWindow(state, 5, -4).visible[0]!.id, 1, "a scroll above the top parks at the top");

	// The counters are click targets, so the layout reports where they landed.
	const follow = todoLayout(marked, state, true, 80);
	assert.deepEqual([follow.up, follow.down], [2, 8], `counter rows, got ${follow.up}, ${follow.down}`);
	const top = todoLayout(marked, state, true, 80, 0);
	assert.deepEqual([top.up, top.down], [null, 7], "no up counter at the top of the list");
	assert.equal(todoLayout(marked, state, false, 80).down, null, "a collapsed box has no counters");
});

test("a finished list folds to one row", () => {
	let state = seeded(3, 2);
	assert.equal(allDone(state), false, "a list with work left is not finished");
	assert.ok(collapsedText(state).endsWith("Task 2"), "the row names the task in progress");
	for (const id of [1, 2, 3]) state = patchTodo(state, id, { status: "completed" })!;
	assert.equal(allDone(state), true, "every task done");
	assert.equal(collapsedText(state), `Todos (3/3) · ${COLLAPSED_DONE}`, "the row says nothing is left");
	const box = renderTodoBox(plain, state, false, 80);
	assert.ok(box[1]!.includes("Todos (3/3) · All tasks finished [click to expand]"), `the collapsed row, got ${box[1]}`);
	assert.ok(box[1]!.includes(HINT_EXPAND), "it still opens on a click");
});

test("the recap groups by status", () => {
	let state = seeded(3);
	state = patchTodo(state, 2, { status: "in_progress", note: "sedang jalan" })!;
	state = patchTodo(state, 3, { status: "completed" })!;
	assert.deepEqual(
		recapRows(state).map((row) => row.label),
		["◉ Task 2", "◌ Task 1", "✓ Task 3"],
		"in progress first, then queued, then done",
	);
	assert.equal(recapRows(state)[0]!.note, "in progress · sedang jalan", "the active row carries its note");
	assert.equal(recapRows(state)[1]!.note, "queued", "a waiting row reads as queued, the word the summary counts");
	assert.equal(recapSummary(state), "3 tasks · 1 in progress · 1 queued · 1 done", "one summary line");
});

test("the tool creates, updates, deletes and clears", () => {
	runTodo({ action: "clear" });
	const created = runTodo({ action: "create", tasks: [{ subject: "Satu" }, { subject: "Dua" }] });
	assert.equal(created.content[0]!.text, "Added 2 tasks: #1, #2", "create reports the ids it assigned");

	const updated = runTodo({ action: "update", id: 1, status: "in_progress", note: "menulis tes" });
	assert.equal(updated.content[0]!.text, "Updated #1", "update reports the id");
	assert.ok(runTodo({ action: "list" }).content[0]!.text.includes("menulis tes"), "the note shows in the list");

	const bad = runTodo({ action: "update", id: 42, status: "completed" });
	assert.equal(bad.content[0]!.text, "no task with id 42", "an unknown id is an error");
	assert.equal(bad.isError, true, "an unknown id is flagged as an error");

	assert.equal(runTodo({ action: "delete", id: 2 }).content[0]!.text, "Removed #2", "delete reports the id");
	assert.equal(runTodo({ action: "clear" }).content[0]!.text, "Cleared 1 task", "clear counts what it removed");
	assert.equal(runTodo({ action: "list" }).content[0]!.text, "The list is empty", "an empty list says so");
});

test("a stored file is read back defensively", () => {
	assert.equal(normalizeState(null), null, "a missing record is rejected");
	assert.equal(normalizeState({ tasks: "nope" }), null, "a non-array tasks field is rejected");
	const loaded = normalizeState({
		tasks: [
			{ id: 3, subject: " Tiga ", status: "in_progress", note: "jalan" },
			{ id: 4, subject: "Empat", status: "selesai" },
			{ id: 0, subject: "nol" },
		],
	});
	assert.deepEqual(loaded?.tasks.map((task) => task.id), [3, 4], "rows without a usable id are dropped");
	assert.equal(loaded?.tasks[0]!.subject, "Tiga", "the subject is trimmed");
	assert.equal(loaded?.tasks[1]!.status, "pending", "an unknown status falls back to pending");
	assert.equal(loaded?.nextId, 5, "the next id follows the highest stored id");
});
