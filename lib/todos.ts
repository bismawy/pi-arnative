/**
 * Data model and painted rows for the arnative task list shown by the extension widget and
 * the `/todos` screen. No pi API and no I/O, so `node lib/todos.ts` checks it while
 * `extensions/todos.ts` only wires it to the tool, the widget and the command.
 *
 * Glyphs follow the widget spec: `✓` done, `◉` in progress, `◌` queued. The heading icon is
 * U+F03A (Font Awesome list), so the terminal needs a Nerd Font.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { softOf, thinkingColorOf } from "./ansi.ts";
import { renderBoxLines, renderBoxRows } from "./box.ts";

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
/** Task rows the expanded widget shows when the terminal height is unknown. */
export const LIST_ROWS = 5;
/** Bounds of the adaptive window: fewer than three rows says nothing, more than nine eats the
 *  chat area even on a tall terminal. */
const MIN_LIST_ROWS = 3;
const MAX_LIST_ROWS = 9;
/** Lines the box spends on everything that is not a task: frame, heading, two counters. */
const BOX_CHROME = 5;
/** Lines kept for the editor, the footer and a usable chat area above the box. */
const SCREEN_RESERVE = 14;

/**
 * Task rows a terminal of `terminalRows` lines can show: the box is `rows + BOX_CHROME` lines
 * tall, and what is left has to hold the editor, the footer and a chat area. Unknown height
 * (a pipe, a test) falls back to {@link LIST_ROWS}, so the widget never guesses wildly.
 */
export function listRowsFor(terminalRows: number | undefined): number {
	if (!terminalRows || !Number.isFinite(terminalRows) || terminalRows <= 0) return LIST_ROWS;
	const fit = Math.floor(terminalRows) - BOX_CHROME - SCREEN_RESERVE;
	return Math.min(MAX_LIST_ROWS, Math.max(MIN_LIST_ROWS, fit));
}
const STATUS_GLYPH: Record<TodoStatus, string> = { pending: "◌", in_progress: "◉", completed: "✓" };
/** Token for the task text itself. Queued recedes to dim and a done task reads as ordinary
 *  text; the task in progress takes the soft accent, which is derived rather than a token (see
 *  `softOf`), so it is painted separately. */
const STATUS_TEXT: Record<TodoStatus, string> = { pending: "dim", in_progress: "text", completed: "text" };
/** Token per status. In progress borrows the footer's model-name token (`mdHeading`), so the
 *  running task is the brightest row in the box, the way the model is the brightest text in
 *  the footer. */
const STATUS_COLOR: Record<TodoStatus, string> = { pending: "dim", in_progress: "mdHeading", completed: "accent" };
/** Tried when the theme has no such token; pi throws on an unknown color. */
const STATUS_FALLBACK: Record<TodoStatus, string> = { pending: "dim", in_progress: "accent", completed: "accent" };
export const HINT_EXPAND = "[show]";
export const HINT_COLLAPSE = "[hide]";
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
export function normalizeState(raw: unknown): TodoState | null {
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
function tidy(text: string): string {
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

/** True when every task is done, the state that folds the box back to one row. */
export const allDone = (state: TodoState): boolean => state.tasks.length > 0 && state.tasks.every((task) => task.status === "completed");

/** What the collapsed row says after the count: the task in progress, or that nothing is left. */
export const COLLAPSED_DONE = "All tasks finished";

export const headingText = (state: TodoState): string => {
	const { done, total } = countTodos(state);
	return `Todos (${done}/${total})`;
};

/** ` · Tulis widget`, or ` · All tasks finished` once nothing is left (empty when idle). */
function collapsedSuffix(state: TodoState): string {
	if (allDone(state)) return ` · ${COLLAPSED_DONE}`;
	const active = activeTodo(state);
	return active ? ` · ${active.subject}` : "";
}

/** `Todos (3/7) · Tulis widget` — the collapsed box, without the hint. */
export const collapsedText = (state: TodoState): string => `${headingText(state)}${collapsedSuffix(state)}`;

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

/** How the widget draws itself: what a scroll moved, how many task rows fit, and the thinking
 *  level whose slot paints the frame. Every field is optional, so a caller that only cares
 *  about the layout can omit it. */
export interface TodoView {
	/** First visible task after a scroll; null (the default) follows the active task. */
	top?: number | null;
	/** Task rows to show. Defaults to {@link LIST_ROWS}; the widget passes
	 *  `listRowsFor(process.stdout.rows)`, so a tall terminal shows more of the list. */
	rows?: number;
	/** Thinking level name (`low`, `high`…), for the frame colour. */
	thinking?: string;
}

/** Content rows of the widget box (no frame): one row collapsed, heading + tasks expanded. */
export function widgetRows(theme: FgTheme, state: TodoState, expanded: boolean, width: number, view: TodoView = {}): string[] {
	const fit = (line: string) => truncateToWidth(line, Math.max(0, width - 4), "…");
	// The hint is how the box gets opened, so it survives and the text before it gives way.
	const withHint = (text: string, hint: string): string => {
		const painted = fg(theme, "dim", hint);
		const inner = Math.max(0, width - 4);
		const room = Math.max(0, inner - visibleWidth(painted) - 1);
		const left = truncateToWidth(text, room, "…");
		const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(painted));
		return fit(`${left}${" ".repeat(gap)}${painted}`);
	};
	const icon = fg(theme, "accent", LIST_ICON);
	// The count is a label, so it takes the soft accent tier the footer labels use, while the
	// task name after the dot stays in the text colour.
	const soft = softOf(theme);
	const heading = (state: TodoState): string => `${icon} ${soft(headingText(state))}`;
	if (!expanded) return [withHint(`${heading(state)}${collapsedSuffix(state)}`, HINT_EXPAND)];

	const { visible, above, below } = todoWindow(state, view.rows ?? LIST_ROWS, view.top ?? null);
	const rows = [withHint(heading(state), HINT_COLLAPSE)];
	if (above > 0) rows.push(fg(theme, "dim", `↑ ${above} more`));
	visible.forEach((task, index) => {
		// The last row closes the branch only when nothing is summarized below it.
		const last = index === visible.length - 1 && below === 0;
		const branch = fg(theme, "dim", last ? "└─" : "├─");
		const glyph = fgOr(theme, [STATUS_COLOR[task.status], STATUS_FALLBACK[task.status]], STATUS_GLYPH[task.status]);
		// The subject carries the state too: the work in progress takes the soft accent, queued
		// recedes into dim, and a finished task reads as plain text.
		const subject = task.status === "in_progress" ? soft(task.subject) : fg(theme, STATUS_TEXT[task.status], task.subject);
		const note = task.note && task.status === "in_progress" ? ` ${fg(theme, "dim", `· ${task.note}`)}` : "";
		rows.push(fit(`${branch} ${glyph} ${subject}${note}`));
	});
	if (below > 0) rows.push(fg(theme, "dim", `↓ ${below} more`));
	return rows;
}

/** The widget as pi renders it: the arnative box around {@link widgetRows}. The border follows
 *  the session's thinking level, like every other arnative box. Expanded it is at most 10
 *  lines (frame 2 + heading 1 + {@link LIST_ROWS} rows + both counters), the size pi caps a
 *  plain string widget at; a component widget is not truncated, so this is the size that keeps
 *  the chat area usable on a 24-row terminal, not a limit pi enforces. */
export const renderTodoBox = (theme: FgTheme, state: TodoState, expanded: boolean, width: number, view: TodoView = {}): string[] =>
	renderBoxLines(theme, width, widgetRows(theme, state, expanded, width, view), undefined, thinkingColorOf(theme, view.thinking));

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
export function todoLayout(
	theme: FgTheme,
	state: TodoState,
	expanded: boolean,
	width: number,
	view: TodoView = {},
): TodoLayout {
	const { above, below } = todoWindow(state, view.rows ?? LIST_ROWS, view.top ?? null);
	const rows = widgetRows(theme, state, expanded, width, view);
	const { lines, starts } = renderBoxRows(theme, width, rows, undefined, thinkingColorOf(theme, view.thinking));
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
const statusText = (status: TodoStatus): string =>
	status === "in_progress" ? "in progress" : status === "pending" ? "queued" : status;

/** The word after `todo ·` in the tool box title: the status a task moved to, or the action when
 *  the call changed no status (`created`, `removed`, `cleared`, `list`, `updated`). Empty when
 *  neither is known, so the title keeps a clean `todo`. */
export function actionWord(action: unknown, status?: unknown): string {
	if (typeof status === "string" && LIST_STATUSES.includes(status as TodoStatus)) return status;
	switch (action) {
		case "create":
			return "created";
		case "update":
			return "updated";
		case "delete":
			return "removed";
		case "clear":
			return "cleared";
		case "list":
			return "list";
		default:
			return "";
	}
}

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

export const __test = {
	fg,
};
