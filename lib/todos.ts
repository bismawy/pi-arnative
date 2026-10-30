/**
 * Data model and painted rows for the arnative task list shown by the extension widget and
 * the `/todos` screen. No pi API and no I/O, so `node lib/todos.ts` checks it while
 * `extensions/todos.ts` only wires it to the tool, the widget and the command.
 *
 * Glyphs follow the widget spec: `✓` done, `◉` in progress, `◌` queued. The heading icon is
 * U+F03A (Font Awesome list), so the terminal needs a Nerd Font.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { softOf } from "./ansi.ts";
import { renderBoxLines, renderBoxRows } from "./box.ts";
import { assert, isMain } from "./check.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";
export const LIST_STATUSES = ["pending", "in_progress", "completed"] as const;

export interface Task {
	id: number;
	subject: string;
	/** One line of "what is happening now", shown only while the task is in progress. */
	note?: string;
	status: TodoStatus;
}

export interface TodoState {
	tasks: Task[];
	nextId: number;
}

export type FgTheme = { fg?(color: string, text: string): string; style?(text: string, options: { fg: unknown }): string; colors?: Record<string, { kind?: string; c?: number; h?: number }> } | null;

export const LIST_ICON = "\uf03a";
/** Rows the expanded widget shows before it summarizes the rest. */
export const LIST_ROWS = 5;
export const STATUS_GLYPH: Record<TodoStatus, string> = { pending: "◌", in_progress: "◉", completed: "✓" };
/** Token per status. In progress borrows the footer's model-name token (`mdHeading`), so the
 *  running task is the brightest row in the box, the way the model is the brightest text in
 *  the footer. */
export const STATUS_COLOR: Record<TodoStatus, string> = { pending: "dim", in_progress: "mdHeading", completed: "accent" };
/** Tried when the theme has no such token; pi throws on an unknown color. */
const STATUS_FALLBACK: Record<TodoStatus, string> = { pending: "dim", in_progress: "accent", completed: "accent" };
export const HINT_EXPAND = "[click to expand]";
export const HINT_COLLAPSE = "[click to collapse]";
/** Longest subject or note kept; longer input is cut so one task cannot fill the box. */
const MAX_FIELD = 120;

/** `theme.fg(color, text)`, or the plain text when the theme is absent or rejects the token. */
function fg(theme: FgTheme, color: string, text: string): string {
	try {
		return theme?.fg ? theme.fg(color, text) : text;
	} catch {
		return text;
	}
}

/** The first token the theme knows. A theme that omits `mdHeading` still gets a painted
 *  glyph instead of a plain one, the same way the footer falls back to accent. */
function fgOr(theme: FgTheme, colors: string[], text: string): string {
	for (const color of colors) {
		try {
			if (theme?.fg) return theme.fg(color, text);
		} catch {
			continue;
		}
	}
	return text;
}

/** Every task from a stored file, or `null` when the file is not one. Tolerant on fields,
 *  strict on the shape: a hand-edited or half-written file must not break the widget. */
export function normalizeState(raw: unknown): TaskState | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const tasks = (raw as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return null;
	const kept: Task[] = [];
	for (const item of tasks) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const id = typeof record.id === "number" && Number.isInteger(record.id) && record.id > 0 ? record.id : null;
		const subject = typeof record.subject === "string" ? tidy(record.subject) : "";
		if (id === null || !subject) continue;
		const status = LIST_STATUSES.includes(record.status as TodoStatus) ? (record.status as TodoStatus) : "pending";
		const note = typeof record.note === "string" && record.note.trim() ? tidy(record.note) : undefined;
		kept.push(note ? { id, subject, status, note } : { id, subject, status });
	}
	return { tasks: kept, nextId: kept.reduce((max, task) => Math.max(max, task.id), 0) + 1 };
}

/** One row's worth of text: control characters (an ANSI escape in a subject would break the
 *  frame) become spaces, runs collapse, and the tail is cut. */
export function tidy(text: string): string {
	const clean = text
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > MAX_FIELD ? `${clean.slice(0, MAX_FIELD - 1)}…` : clean;
}

export const emptyTodos = (): TodoState => ({ tasks: [], nextId: 1 });

/** Append a task to the queue. Returns the new state and the id the tool reports back. */
export function addTodo(state: TodoState, subject: string, note?: string): { state: TodoState; id: number } {
	const task: Task = { id: state.nextId, subject: tidy(subject), status: "pending" };
	if (note) task.note = tidy(note);
	return { state: { tasks: [...state.tasks, task], nextId: state.nextId + 1 }, id: task.id };
}

export interface TodoPatch {
	status?: TodoStatus;
	subject?: string;
	/** `null` removes the note; a string replaces it. */
	note?: string | null;
}

/** Change one task, or `null` when the id is unknown (the tool turns that into an error). */
export function patchTodo(state: TodoState, id: number, patch: TodoPatch): TodoState | null {
	const index = state.tasks.findIndex((task) => task.id === id);
	if (index === -1) return null;
	const current = state.tasks[index]!;
	const next: Task = { ...current };
	if (patch.status) next.status = patch.status;
	if (patch.subject !== undefined) next.subject = tidy(patch.subject);
	if (patch.note === null) delete next.note;
	else if (patch.note !== undefined) next.note = tidy(patch.note);
	const tasks = [...state.tasks];
	tasks[index] = next;
	return { ...state, tasks };
}

export function removeTodo(state: TodoState, id: number): TodoState | null {
	if (!state.tasks.some((task) => task.id === id)) return null;
	return { ...state, tasks: state.tasks.filter((task) => task.id !== id) };
}

export const clearTodos = (state: TodoState): TodoState => ({ tasks: [], nextId: state.nextId });

export function countTodos(state: TodoState): { done: number; total: number; doing: number; queued: number } {
	const done = state.tasks.filter((task) => task.status === "completed").length;
	const doing = state.tasks.filter((task) => task.status === "in_progress").length;
	return { done, total: state.tasks.length, doing, queued: state.tasks.length - done - doing };
}

/** The task whose work is happening now, so the collapsed row can name it. */
export const activeTodo = (state: TodoState): Task | undefined => state.tasks.find((task) => task.status === "in_progress");

export const headingText = (state: TodoState): string => {
	const { done, total } = countTodos(state);
	return `Todos (${done}/${total})`;
};

/** `Todos (3/7) · Tulis widget` — the collapsed box, without the hint. */
export function collapsedText(state: TodoState): string {
	const active = activeTodo(state);
	return active ? `${headingText(state)} · ${active.subject}` : headingText(state);
}

export interface TodoWindow {
	visible: Task[];
	/** Tasks hidden above the window. */
	above: number;
	/** Tasks hidden below the window. */
	below: number;
	/** Index of the first visible task, the anchor a scroll moves. */
	start: number;
}

/**
 * The {@link LIST_ROWS} rows the expanded box shows. The window follows the in-progress task
 * and centres it, so the active work is always on screen; with no task in progress it starts
 * at the top. `top` overrides that start after a scroll; it is clamped to the list, so a click
 * past either end parks the window at the edge. `above`/`below` feed the `↑ n more` /
 * `↓ n more` rows.
 */
export function todoWindow(state: TodoState, rows = LIST_ROWS, top: number | null = null): TodoWindow {
	const total = state.tasks.length;
	if (total <= rows) return { visible: state.tasks, above: 0, below: 0, start: 0 };
	const active = state.tasks.findIndex((task) => task.status === "in_progress");
	const centre = Math.floor((rows - 1) / 2);
	const follow = active === -1 ? 0 : Math.min(Math.max(active - centre, 0), total - rows);
	const start = top === null ? follow : Math.min(Math.max(Math.trunc(top), 0), total - rows);
	return { visible: state.tasks.slice(start, start + rows), above: start, below: total - start - rows, start };
}

/** Content rows of the widget box (no frame): one row collapsed, heading + tasks expanded. */
export function widgetRows(theme: FgTheme, state: TodoState, expanded: boolean, width: number, top: number | null = null): string[] {
	const fit = (line: string) => truncateToWidth(line, Math.max(0, width - 4), "…");
	// The hint is how the box gets opened, so it survives and the text before it gives way.
	const withHint = (text: string, hint: string): string => {
		const painted = fg(theme, "dim", hint);
		const room = Math.max(0, width - 4 - visibleWidth(painted) - 1);
		return fit(`${truncateToWidth(text, room, "…")} ${painted}`);
	};
	const icon = fg(theme, "accent", LIST_ICON);
	// The count is a label, so it takes the soft accent tier the footer labels use, while the
	// task name after the dot stays in the text colour.
	const soft = softOf(theme);
	const heading = (state: TodoState): string => `${icon} ${soft(headingText(state))}`;
	const active = activeTodo(state);
	if (!expanded) return [withHint(`${heading(state)}${active ? ` · ${active.subject}` : ""}`, HINT_EXPAND)];

	const { visible, above, below } = todoWindow(state, LIST_ROWS, top);
	const rows = [withHint(heading(state), HINT_COLLAPSE)];
	if (above > 0) rows.push(fg(theme, "dim", `↑ ${above} more`));
	visible.forEach((task, index) => {
		// The last row closes the branch only when nothing is summarized below it.
		const last = index === visible.length - 1 && below === 0;
		const branch = fg(theme, "dim", last ? "└─" : "├─");
		const glyph = fgOr(theme, [STATUS_COLOR[task.status], STATUS_FALLBACK[task.status]], STATUS_GLYPH[task.status]);
		const note = task.note && task.status === "in_progress" ? ` ${fg(theme, "dim", `· ${task.note}`)}` : "";
		rows.push(fit(`${branch} ${glyph} ${task.subject}${note}`));
	});
	if (below > 0) rows.push(fg(theme, "dim", `↓ ${below} more`));
	return rows;
}

/** The widget as pi renders it: the arnative box around {@link widgetRows}. Never taller than
 *  pi's own 10-line widget budget (frame 2 + heading 1 + 5 rows + 2 summary rows). */
export const renderTodoBox = (theme: FgTheme, state: TodoState, expanded: boolean, width: number, top: number | null = null): string[] =>
	renderBoxLines(theme, width, widgetRows(theme, state, expanded, width, top));

export interface TodoLayout {
	/** The whole widget, frame included: what pi paints above the editor. */
	lines: string[];
	/** Row of the `↑ n more` line, or null when nothing is hidden above it. The counters are
	 *  the click targets that scroll the five-row window. */
	up: number | null;
	/** Row of the `↓ n more` line, or null when nothing is hidden below it. */
	down: number | null;
}

/** {@link renderTodoBox} plus the row numbers of the two counter lines. A mouse handler needs
 *  them, since those lines are the click targets that scroll the five-row window; the numbers
 *  come from the box renderer, so a wrapped row cannot shift the hit area. */
export function todoLayout(theme: FgTheme, state: TodoState, expanded: boolean, width: number, top: number | null = null): TodoLayout {
	const { above, below } = todoWindow(state, LIST_ROWS, top);
	const rows = widgetRows(theme, state, expanded, width, top);
	const { lines, starts } = renderBoxRows(theme, width, rows);
	// Content row 1 is `↑ n more`; the last content row is `↓ n more`.
	const at = (contentRow: number): number => starts[contentRow] ?? Math.max(0, lines.length - 1);
	return {
		lines,
		up: expanded && above > 0 ? at(1) : null,
		down: expanded && below > 0 ? at(rows.length - 1) : null,
	};
}

/** The word the widget and the recap use for a status (`pending` reads as `queued`,
 *  the word the summary line counts). */
export const statusText = (status: TodoStatus): string =>
	status === "in_progress" ? "in progress" : status === "pending" ? "queued" : status;

/** `/todos` recap: in progress first, then the queue, then what is done. */
export function recapRows(state: TodoState): { label: string; note: string }[] {
	const order: Record<TodoStatus, number> = { in_progress: 0, pending: 1, completed: 2 };
	return [...state.tasks]
		.sort((a, b) => order[a.status] - order[b.status] || a.id - b.id)
		.map((task) => ({
			label: `${STATUS_GLYPH[task.status]} ${task.subject}`,
			note: task.note && task.status === "in_progress" ? `${statusText(task.status)} · ${task.note}` : statusText(task.status),
		}));
}

/** One line for the recap screen: `1 in progress · 3 queued · 3 done`. */
export function recapSummary(state: TodoState): string {
	const { done, total, doing, queued } = countTodos(state);
	return [`${total} tasks`, `${doing} in progress`, `${queued} queued`, `${done} done`].join(" · ");
}

// Self-check: `node lib/todos.ts`
if (isMain(import.meta.url)) {
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
	assert(headingText(state) === "Todos (1/5)", "heading counts completed over total");
	assert(patchTodo(state, 99, { status: "completed" }) === null, "an unknown id is rejected");
	assert(removeTodo(state, 99) === null, "removing an unknown id is rejected");
	state = removeTodo(state, 5)!;
	assert(countTodos(state).total === 4, "remove drops one task");
	assert(clearTodos(state).tasks.length === 0, "clear empties the list");

	// Five-row window: the active task is centred, and the hidden counts add up.
	state = emptyTodos();
	for (let i = 1; i <= 7; i++) state = addTodo(state, `Task ${i}`).state;
	assert(todoWindow(state).visible.length === 5, "five rows when more exist");
	assert(todoWindow(state).above === 0 && todoWindow(state).below === 2, "nothing hidden above the first five");
	state = patchTodo(state, 5, { status: "in_progress" })!;
	const mid = todoWindow(state);
	assert(mid.visible.map((t) => t.id).join(",") === "3,4,5,6,7", "the window follows the active task");
	assert(mid.above === 2 && mid.below === 0, "two tasks hidden above");
	assert(mid.above + mid.visible.length + mid.below === 7, "the window accounts for every task");
	state = patchTodo(state, 7, { status: "in_progress" })!;
	assert(todoWindow(state).above === 2, "the window stops at the end of the list instead of sliding past it");

	// The box: collapsed 3 lines, expanded never over pi's 10-line widget budget.
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

	console.log("todos.ts self-check OK");
}
