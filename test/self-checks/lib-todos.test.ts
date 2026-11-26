import test from "node:test";
import { assert } from "../helpers/check.ts";
import { LIST_ICON, LIST_ROWS, listRowsFor, HINT_EXPAND, normalizeState, emptyTodos, addTodo, patchTodo, removeTodo, clearTodos, countTodos, activeTodo, allDone, COLLAPSED_DONE, headingText, collapsedText, todoWindow, widgetRows, renderTodoBox, actionWord, recapRows, recapSummary, type Task, type FgTheme, __test } from "../../lib/todos.ts";

const { fg } = __test;

test("lib/todos.ts self-check", async () => {
	const th: FgTheme = { fg: (_color, text) => text };
	// Writes the token down, so the self-check can name the colour a piece was painted with.
	const marked: FgTheme = { fg: (color, text) => `[${color}]${text}` };

	let state = emptyTodos();
	assert(headingText(state) === "Todos (0/0)", "empty heading");
	assert(collapsedText(state) === "Todos (0/0)", "empty collapsed row carries no task name");
	assert(widgetRows(marked, state, false, 80)[0]!.startsWith(`[accent]${LIST_ICON} [accentSoft]Todos (0/0)`), "icon accent, count soft accent");

	let added = addTodo(state, "Siapkan rencana");
	state = added.state;
	assert(added.id === 1 && state.nextId === 2, "first id is 1, next id advances");
	for (const subject of ["Tulis widget", "Tulis layar /todos", "Uji fullscreen", "Rilis"]) state = addTodo(state, subject).state;
	assert(countTodos(state).total === 5 && countTodos(state).queued === 5, "five queued tasks");

	const patched = patchTodo(state, 2, { status: "in_progress", note: "Memproses bug ABC.txt" });
	assert(patched !== null, "patch a known id");
	state = patched!;
	assert(activeTodo(state)?.subject === "Tulis widget", "the active task is the in-progress one");
	assert(collapsedText(state) === "Todos (0/5) · Tulis widget", `collapsed names the active task, got ${collapsedText(state)}`);

	state = patchTodo(state, 2, { status: "completed" })!;
	assert(activeTodo(state) === undefined, "no active task after completing the only one");
	// The extension folds the widget away once the list is done, yet the renderer still
	// describes that state: it is a pure function of the list, not of who paints it.
	const doneState = { ...state, tasks: state.tasks.map((task) => ({ ...task, status: "completed" as const })) };
	assert(allDone(doneState) && collapsedText(doneState).endsWith(COLLAPSED_DONE), "a finished list names its end");
	assert(headingText(state) === "Todos (1/5)", "heading counts completed over total");
	assert(patchTodo(state, 99, { status: "completed" }) === null, "an unknown id is rejected");
	assert(removeTodo(state, 99) === null, "removing an unknown id is rejected");
	state = removeTodo(state, 5)!;
	assert(countTodos(state).total === 4, "remove drops one task");
	assert(clearTodos(state).tasks.length === 0, "clear empties the list");

	// Five-row window: the active task is centred, and the hidden counts add up.
	state = emptyTodos();
	for (let i = 1; i <= 7; i++) state = addTodo(state, `Task ${i}`).state;
	// Adaptive height: the window grows with the terminal, bounded at three and nine.
	assert(listRowsFor(24) === 5 && listRowsFor(30) === 9 && listRowsFor(10) === 3, "listRowsFor bounds");
	assert(listRowsFor(undefined) === LIST_ROWS, "unknown height falls back to the default");

	assert(todoWindow(state).visible.length === 5, "five rows when more exist");
	assert(todoWindow(state).above === 0 && todoWindow(state).below === 2, "nothing hidden above the first five");
	state = patchTodo(state, 5, { status: "in_progress" })!;
	const mid = todoWindow(state);
	assert(mid.visible.map((t) => t.id).join(",") === "3,4,5,6,7", "the window follows the active task");
	assert(mid.above === 2 && mid.below === 0, "two tasks hidden above");
	assert(mid.above + mid.visible.length + mid.below === 7, "the window accounts for every task");
	state = patchTodo(state, 7, { status: "in_progress" })!;
	assert(todoWindow(state).above === 2, "the window stops at the end of the list instead of sliding past it");

	// The box: collapsed 3 lines, expanded at most 10 (frame, heading, five rows, two counters).
	state = emptyTodos();
	for (let i = 1; i <= 20; i++) state = addTodo(state, `Task ${i}`).state;
	state = patchTodo(state, 10, { status: "in_progress", note: "sedang menulis" })!;
	const collapsedBox = renderTodoBox(th, state, false, 80);
	assert(collapsedBox.length === 3, `collapsed box is frame+row+frame, got ${collapsedBox.length}`);
	assert(collapsedBox[1]!.includes("Todos (0/20)"), "collapsed box carries the heading");
	assert(collapsedBox[1]!.includes("Task 10"), "collapsed box names the active task");
	assert(collapsedBox[1]!.includes(HINT_EXPAND), "collapsed box carries the expand hint");
	// Narrow terminal: the task name gives way, the hint that opens the box does not.
	const narrow = renderTodoBox(th, state, false, 40);
	assert(narrow[1]!.includes(HINT_EXPAND), "the expand hint survives a narrow box");
	assert(narrow.every((line) => line.length > 0), "a narrow box still renders every line");

	const expandedBox = renderTodoBox(th, state, true, 40);
	assert(expandedBox.length <= 10, `expanded box stays within the widget budget, got ${expandedBox.length}`);
	assert(expandedBox.some((line) => line.includes("↑ 7 more")), "hidden tasks above are counted");
	assert(expandedBox.some((line) => line.includes("↓ 8 more")), "hidden tasks below are counted");
	assert(expandedBox.some((line) => line.includes("· sedang menulis")), "the in-progress note is rendered");
	assert(!expandedBox.some((line) => line.includes("└─")), "an open branch stays ├─ while rows remain below");
	// With nothing below the window the last row closes the branch.
	const tail = renderTodoBox(th, patchTodo(patchTodo(state, 10, { status: "pending" })!, 20, { status: "in_progress" })!, true, 80);
	assert(tail.some((line) => line.includes("└─")), "the last row closes the branch at the end of the list");
	assert(
		expandedBox.every((line) => line.startsWith("│") || line.startsWith("╭") || line.startsWith("╰")),
		"every line belongs to the box",
	);

	// A note only belongs to the task being worked on.
	state = patchTodo(state, 10, { status: "pending" })!;
	assert(!renderTodoBox(th, state, true, 40).some((line) => line.includes("sedang menulis")), "a queued task hides its note");

	// Hostile input: an escape sequence in a subject must not break the frame.
	state = addTodo(emptyTodos(), "bad \u001b[31mred\u001b[0m subject").state;
	const hostile = renderTodoBox(th, state, true, 40);
	assert(!hostile.some((line) => line.includes("\u001b[31m")), "control characters are stripped from a subject");
	assert(hostile.every((line) => line.length > 0), "a stripped subject still renders a row");

	// Recap order and summary.
	state = emptyTodos();
	state = addTodo(state, "Antre A").state;
	state = addTodo(state, "Jalan B").state;
	state = patchTodo(state, 2, { status: "in_progress" })!;
	state = addTodo(state, "Selesai C").state;
	state = patchTodo(state, 3, { status: "completed" })!;
	assert(recapRows(state).map((r) => r.label).join(" | ") === "◉ Jalan B | ◌ Antre A | ✓ Selesai C", "recap groups by status");
	assert(recapSummary(state) === "3 tasks · 1 in progress · 1 queued · 1 done", `recap summary, got ${recapSummary(state)}`);

	// A stored file: broken rows go, fields are tidied, nextId follows the highest id.
	const loaded = normalizeState({
		tasks: [
			{ id: 2, subject: " Kedua ", status: "in_progress", note: "sedang jalan" },
			{ id: 5, subject: "Kelima", status: "selesai" },
			{ id: "x", subject: "rusak" },
			{ id: 7, subject: "   " },
			{ id: 9, subject: "Ketiga", status: "completed" },
		],
		nextId: 1,
	});
	assert(loaded !== null, "a valid record loads");
	assert(normalizeState(null) === null && normalizeState({ tasks: "no" }) === null, "a broken record is rejected");
	assert(loaded!.tasks.map((task) => task.id).join(",") === "2,5,9", "broken rows are dropped");
	assert(loaded!.tasks[0]!.subject === "Kedua" && loaded!.tasks[0]!.note === "sedang jalan", "fields are tidied");
	assert(loaded!.tasks[1]!.status === "pending", "an unknown status falls back to pending");
	assert(loaded!.nextId === 10, "nextId follows the highest stored id");

	// The tool box title: status when a task moved, action word otherwise.
	assert(actionWord("update", "completed") === "completed", "a known status wins over the action word");
	assert(actionWord("update", "selesai") === "updated", "an unknown status falls back to the action");
	assert(actionWord("create") === "created" && actionWord("delete") === "removed", "create and delete read as past tense");
	assert(actionWord("list") === "list" && actionWord("nonsense") === "", "list keeps its name, an unknown action says nothing");

});
