/**
 * Task list for the agent: the `todo` tool, the boxed widget above the editor, the `/todos`
 * recap screen and the expand shortcut. Replaces `@juicesharp/rpiv-todo`, which registered the
 * same tool name, so only one of the two may be installed.
 *
 * State lives in `<agent>/arnative/todos/<session id>.json`, so `/reload` and a resumed session
 * keep the list; every mutation rewrites the file.
 */
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { writeJsonAtomicSync } from "../preset-store.ts";
import { getRuntime } from "../runtime.ts";
import { createHoldRepeat, inSpans, screenTitle, type TextSpan, textSpans } from "../box.ts";
import { ListPicker, type ListPickerText } from "../list-picker.ts";
import { LEGEND_READ_ONLY, SHORTCUT_SCROLL_TODOS_DOWN, SHORTCUT_SCROLL_TODOS_UP, SHORTCUT_TOGGLE_TODOS } from "../shortcuts.ts";
import {
	HINT_COLLAPSE,
	HINT_EXPAND,
	LIST_STATUSES,
	addTodo,
	allDone,
	clearTodos,
	countTodos,
	emptyTodos,
	actionWord,
	listRowsFor,
	normalizeState,
	patchTodo,
	recapRows,
	recapSummary,
	removeTodo,
	renderTodoBox,
	todoLayout,
	todoWindow,
	type TaskState,
	type TodoStatus,
} from "../todos.ts";

/** pi widget key; the extension owns it, so a reload replaces its own box. */
export const TODO_WIDGET_KEY = "arnative-todos";

interface WidgetStore {
	state: TaskState;
	expanded: boolean;
	/** First visible task after a scroll; null follows the active task. */
	top: number | null;
	/** False until the widget is registered with this session's `ctx.ui`. */
	registered: boolean;
	/** The TUI handle from the widget factory, for a redraw after a shortcut or a mutation. */
	tui?: { requestRender(force?: boolean): void };
	/** Pending removal of a finished list's box; see {@link doneHideMs}. */
	hideTimer?: ReturnType<typeof setTimeout>;
}

/** How long the finished box stays: long enough to read `All tasks finished`, short enough
 *  that the screen clears itself. `PI_ARNATIVE_TODO_HIDE_MS` overrides it (0 removes at once). */
function doneHideMs(): number {
	const raw = Number(process.env.PI_ARNATIVE_TODO_HIDE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

/** Module state on RuntimeState so `/reload` keeps the list and expanded flag. */
function store(): WidgetStore {
	const rt = getRuntime();
	rt.todosWidget ??= { state: emptyTodos(), expanded: false, top: null, registered: false } satisfies WidgetStore;
	return rt.todosWidget as WidgetStore;
}

/** Completed/empty session todo files older than this are pruned on session start. */
const TODO_PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const todosDir = (): string => join(getAgentDir(), "arnative", "todos");

/** `<agent>/arnative/todos/<session id>.json` — one file per session, so two sessions in the
 *  same checkout never overwrite each other's list. */
const stateFile = (ctx: ExtensionContext): string =>
	join(todosDir(), `${ctx.sessionManager.getSessionId()}.json`);

/** Remove old todo files whose tasks are all completed (or empty) so `todos/` does not grow unbounded. */
export function pruneCompletedTodos(
	dir: string = todosDir(),
	opts: { maxAgeMs?: number; now?: number; skipFile?: string } = {},
): number {
	const maxAgeMs = opts.maxAgeMs ?? TODO_PRUNE_AGE_MS;
	const now = opts.now ?? Date.now();
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		const full = join(dir, name);
		if (opts.skipFile && (full === opts.skipFile || name === opts.skipFile)) continue;
		try {
			if (now - statSync(full).mtimeMs < maxAgeMs) continue;
			const parsed = normalizeState(JSON.parse(readFileSync(full, "utf8")) as unknown);
			if (!parsed) continue;
			if (parsed.tasks.length === 0 || allDone(parsed)) {
				unlinkSync(full);
				removed++;
			}
		} catch {
			// leave unreadable or locked files alone
		}
	}
	return removed;
}

function loadState(ctx: ExtensionContext, reload = false): void {
	const s = store();
	cancelHide(s);
	if (!reload) {
		s.expanded = false;
		s.top = null;
	}
	try {
		s.state = normalizeState(JSON.parse(readFileSync(stateFile(ctx), "utf8")) as unknown) ?? emptyTodos();
	} catch {
		// absent, unreadable or not JSON: the session starts with an empty list
		s.state = emptyTodos();
	}
	if (allDone(s.state)) s.expanded = false;
}

function saveState(ctx: ExtensionContext): void {
	try {
		writeJsonAtomicSync(stateFile(ctx), store().state);
	} catch {
		// ignore: the list still renders from memory
	}
}

const PARAMS = {
	type: "object",
	required: ["action"],
	properties: {
		action: {
			type: "string",
			enum: ["create", "update", "delete", "clear", "list"],
			description: "create adds tasks, update changes one, delete removes one, clear empties the list, list reads it back",
		},
		id: {
			type: "number",
			description: "Task id: required by update and delete, ignored by the other actions",
		},
		subject: {
			type: "string",
			description: "Task title: the new task on create, the new title on update",
		},
		status: {
			type: "string",
			enum: [...LIST_STATUSES],
			description: "New status of the task named by id",
		},
		note: {
			type: "string",
			description: "One short line about what is happening now; shown while the task is in progress",
		},
		activeForm: {
			type: "string",
			description: "Alias for note, kept for existing sessions",
		},
		tasks: {
			type: "array",
			description: "Several tasks to add at once",
			items: {
				type: "object",
				required: ["subject"],
				properties: {
					subject: { type: "string" },
					note: { type: "string" },
				},
			},
		},
	},
} as never;

const SUMMARY = (state: TaskState): string => {
	const { done, total, doing, queued } = countTodos(state);
	return `${total} tasks: ${doing} in progress, ${queued} queued, ${done} done`;
};

/** The `todo` tool body: mutate the store and answer the model. Persisting and redrawing are
 *  the caller's job, so a failed action cannot leave a half-saved file behind. */
export function runTodo(params: Record<string, unknown>) {
	const s = store();
	const action = String(params.action ?? "");
	const id = typeof params.id === "number" ? params.id : undefined;
	// `activeForm` is the field name older sessions used for the same line.
	const note = typeof params.note === "string" ? params.note : typeof params.activeForm === "string" ? params.activeForm : undefined;
	const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: { state: s.state }, isError: true });

	if (action === "create") {
		const batch = Array.isArray(params.tasks) ? (params.tasks as { subject?: unknown; note?: unknown }[]) : [];
		const queue = batch.length > 0 ? batch : typeof params.subject === "string" ? [{ subject: params.subject, note }] : [];
		const added: number[] = [];
		for (const item of queue) {
			const subject = typeof item.subject === "string" ? item.subject.trim() : "";
			if (!subject) continue;
			const result = addTodo(s.state, subject, typeof item.note === "string" ? item.note : undefined);
			s.state = result.state;
			added.push(result.id);
		}
		if (added.length === 0) return fail("create needs a subject or a non-empty tasks list");
		const label = added.length === 1 ? "task" : "tasks";
		return {
			content: [{ type: "text" as const, text: `Added ${added.length} ${label}: #${added.join(", #")}` }],
			details: { state: s.state, detail: actionWord(action) },
		};
	}

	if (action === "update") {
		if (id === undefined) return fail("update needs id");
		const status = LIST_STATUSES.includes(params.status as TodoStatus) ? (params.status as TodoStatus) : undefined;
		const patch: Parameters<typeof patchTodo>[2] = {};
		if (status) patch.status = status;
		if (typeof params.subject === "string") patch.subject = params.subject;
		if (note !== undefined) patch.note = note;
		if (Object.keys(patch).length === 0) return fail("update needs status, subject or note");
		const next = patchTodo(s.state, id, patch);
		if (!next) return fail(`no task with id ${id}`);
		s.state = next;
		return {
			content: [{ type: "text" as const, text: `Updated #${id}` }],
			details: { state: s.state, detail: actionWord(action, status) },
		};
	}

	if (action === "delete") {
		if (id === undefined) return fail("delete needs id");
		const next = removeTodo(s.state, id);
		if (!next) return fail(`no task with id ${id}`);
		s.state = next;
		return { content: [{ type: "text" as const, text: `Removed #${id}` }], details: { state: s.state, detail: actionWord(action) } };
	}

	if (action === "clear") {
		const removed = s.state.tasks.length;
		s.state = clearTodos(s.state);
		const label = removed === 1 ? "task" : "tasks";
		return { content: [{ type: "text" as const, text: `Cleared ${removed} ${label}` }], details: { state: s.state, detail: actionWord(action) } };
	}

	if (action === "list") {
		const lines = s.state.tasks.map((task) => {
			const note = task.note && task.status === "in_progress" ? ` · ${task.note}` : "";
			return `#${task.id} [${task.status}] ${task.subject}${note}`;
		});
		return { content: [{ type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "The list is empty" }], details: { state: s.state, detail: actionWord(action) } };
	}

	return fail(`unknown action: ${action}`);
}

/** Queue the removal of a finished list's box. Idempotent: a redraw or a click must not
 *  restart the wait, or the box could outlive the interest in it. */
function scheduleHide(ctx: ExtensionContext, s: WidgetStore): void {
	if (s.hideTimer) return;
	s.hideTimer = setTimeout(() => {
		s.hideTimer = undefined;
		ctx.ui?.setWidget?.(TODO_WIDGET_KEY, undefined);
		s.registered = false;
		s.tui = undefined;
	}, doneHideMs());
	// Never hold pi's process open for a cosmetic row.
	s.hideTimer.unref?.();
}

function cancelHide(s: WidgetStore): void {
	if (!s.hideTimer) return;
	clearTimeout(s.hideTimer);
	s.hideTimer = undefined;
}

/** Register the widget with this session, or redraw it. `force` re-registers after `/reload`,
 *  where pi keeps the key but the old component is gone. */
function refresh(ctx: ExtensionContext, force = false): void {
	const s = store();
	if (s.state.tasks.length === 0) {
		cancelHide(s);
		ctx.ui?.setWidget?.(TODO_WIDGET_KEY, undefined);
		s.registered = false;
		return;
	}
	// Work left keeps the box; a finished list folds to its `All tasks finished` row and
	// leaves after {@link doneHideMs}, unless the user opened the box to read it.
	if (allDone(s.state) && !s.expanded) scheduleHide(ctx, s);
	else cancelHide(s);
	if (!force && s.registered) {
		s.tui?.requestRender(true);
		return;
	}
	ctx.ui?.setWidget?.(
		TODO_WIDGET_KEY,
		(tui: WidgetStore["tui"], factoryTheme: Parameters<typeof renderTodoBox>[0]) => {
			s.tui = tui;
			let height = 0;
			let layout: ReturnType<typeof todoLayout> = { lines: [], up: null, down: null };
			/** Cells of the hint in the drawn box: the only place a press expands or folds it. */
			let spans: TextSpan[] = [];
			/** Swallows the follow-up release/click after a press on the hint or a counter, because
			 *  the re-render between press and click can remove `↑ 1 more` / `↓ 1 more` at that row. */
			let swallowClick = false;
			const hold = createHoldRepeat();
			const stopHold = (): void => hold.stop();
			const toggleExpanded = (): { handled: true; render: true } => {
				s.expanded = !s.expanded;
				s.top = null;
				if (allDone(s.state) && !s.expanded) scheduleHide(ctx, s);
				else cancelHide(s);
				s.tui?.requestRender(true);
				return { handled: true, render: true };
			};
			/** Move the five-row window by `delta` rows and repaint. `top` stays absolute, so the
			 *  window parks at the end of the list instead of drifting. */
			const scroll = (delta: number): void => {
				const { start } = todoWindow(s.state, listRowsFor(process.stdout.rows), s.top);
				s.top = start + delta;
				s.tui?.requestRender(true);
			};
			const startHold = (delta: -1 | 1): void => {
				hold.start(() => {
					if (!s.expanded) return false;
					const win = todoWindow(s.state, listRowsFor(process.stdout.rows), s.top);
					if ((delta < 0 && win.above <= 0) || (delta > 0 && win.below <= 0)) return false;
					scroll(delta);
					const next = todoWindow(s.state, listRowsFor(process.stdout.rows), s.top);
					return (delta < 0 && next.above > 0) || (delta > 0 && next.below > 0);
				});
			};
			return {
				render: (width: number): string[] => {
					// The live theme, so a theme switch repaints without re-registering.
					const theme = (ctx.ui?.theme ?? factoryTheme) as Parameters<typeof renderTodoBox>[0];
					layout = todoLayout(theme, s.state, s.expanded, width, {
						top: s.top,
						rows: listRowsFor(process.stdout.rows),
						thinking: ctx.thinkingLevel,
					});
					height = layout.lines.length;
					spans = textSpans(layout.lines, s.expanded ? HINT_COLLAPSE : HINT_EXPAND);
					return layout.lines;
				},
				invalidate: (): void => {},
				// Two click targets, both drawn as affordances: the hint text expands or folds the
				// box, and the counter rows scroll the window. Every other cell is left to pi, so
				// the task names stay selectable and copyable. The work is done on the press: pi
				// only synthesizes a click when the pointer did not move at all.
				handleMouse: (event: TuiMouseEvent) => {
					if (event.button !== "left") return undefined;
					if (event.type === "press") {
						stopHold();
						swallowClick = false;
					}
					if (swallowClick && event.type !== "press") {
						if (event.type === "release" || event.type === "click") stopHold();
						if (event.type === "click") swallowClick = false;
						return { handled: true, render: false };
					}
					if (event.y >= height) return undefined;
					const onHint = inSpans(spans, event.y, event.x);
					const onCounter = event.y === layout.up || event.y === layout.down;
					if (!onHint && !onCounter) {
						if (event.type === "click" && (event.clickCount ?? 1) === 1) return toggleExpanded();
						return undefined;
					}
					// The press already did it, so the release and the click that may follow are
					// swallowed: toggling again on the click would undo the press.
					if (event.type !== "press") return { handled: true, render: false };
					swallowClick = true;
					if (onCounter) {
						const delta: -1 | 1 = event.y === layout.up ? -1 : 1;
						scroll(delta);
						startHold(delta);
						return { handled: true, render: true };
					}
					return toggleExpanded();
				},
				dispose: (): void => {
					stopHold();
				},
			};
		},
		{ placement: "aboveEditor" },
	);
	s.registered = true;
}

/** Scroll the expanded box from the keyboard: the counters are mouse-only in fullscreen mode,
 *  and pi leaves mouse input to the terminal everywhere else. */
function scrollKeyboard(ctx: ExtensionContext, delta: number): void {
	const s = store();
	if (!s.expanded || s.state.tasks.length <= listRowsFor(process.stdout.rows)) return;
	const { start } = todoWindow(s.state, listRowsFor(process.stdout.rows), s.top);
	s.top = start + delta;
	refresh(ctx);
}

/** Expand or collapse, then redraw. This is the keyboard path in regular mode, where pi leaves
 *  mouse input to the terminal and the click never arrives. */
function toggle(ctx: ExtensionContext): void {
	const s = store();
	if (s.state.tasks.length === 0) return;
	s.expanded = !s.expanded;
	// Opening or closing shows the active task again, so a scroll never outlives the view.
	s.top = null;
	refresh(ctx);
}

const RECAP_TEXT: ListPickerText = {
	title: screenTitle("Tasks"),
	description: "",
	legend: LEGEND_READ_ONLY,
};

/** `/todos`: the whole list in the arnative screen chrome, in progress first. */
async function openRecap(ctx: ExtensionCommandContext): Promise<void> {
	const s = store();
	if (s.state.tasks.length === 0) {
		ctx.ui.notify("No tasks yet. Ask the agent to add some.", "info");
		return;
	}
	const rows = recapRows(s.state);
	if (ctx.mode !== "tui") {
		ctx.ui.notify([recapSummary(s.state), ...rows.map((row) => `${row.label} · ${row.note}`)].join("\n"), "info");
		return;
	}
	// The in-progress row is the one the list marks as current.
	const active = rows.find((row) => row.note.startsWith("in progress"))?.label;
	await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) =>
		new ListPicker(
			theme,
			rows,
			active,
			{ preview: () => {}, revert: () => {}, done: () => done(false), requestRender: () => tui.requestRender() },
			{ ...RECAP_TEXT, description: recapSummary(s.state) },
			false,
			ctx.thinkingLevel,
			12,
		),
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage the task list shown above the editor. Actions: create (one subject or tasks[]), update (id + status/subject/note), delete (id), clear, list. Status: pending, in_progress, completed. Exactly one task is in progress at a time.",
		promptGuidelines: [
			"Mark a task in_progress before starting it and completed immediately when it is done, never in batches.",
			"Set note to a short line about what you are doing now; the widget shows it in dim next to the in-progress task.",
		],
		parameters: PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// A mutation brings the view back to the active task; a scroll should not hide the row
			// that just changed.
			const s = store();
			s.top = null;
			const result = runTodo(params as unknown as Record<string, unknown>);
			// Nothing left to watch: the widget folds away, and the next task opens folded.
			if (allDone(s.state)) s.expanded = false;
			saveState(ctx);
			refresh(ctx);
			return result;
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const reload = (event as { reason?: string } | undefined)?.reason === "reload";
		loadState(ctx, reload);
		if (!reload) pruneCompletedTodos(todosDir(), { skipFile: stateFile(ctx) });
		refresh(ctx, true);
	});

	pi.registerCommand("todos", {
		description: "Show every task in this session, in progress first",
		handler: (_args, ctx) => openRecap(ctx),
	});

	for (const key of SHORTCUT_TOGGLE_TODOS.keys) {
		pi.registerShortcut(key, {
			description: "Expand or collapse the task list",
			handler: (ctx: ExtensionContext) => toggle(ctx),
		});
	}

	for (const key of SHORTCUT_SCROLL_TODOS_DOWN.keys) {
		pi.registerShortcut(key, {
			description: "Scroll the task list down one task",
			handler: (ctx: ExtensionContext) => scrollKeyboard(ctx, 1),
		});
	}

	for (const key of SHORTCUT_SCROLL_TODOS_UP.keys) {
		pi.registerShortcut(key, {
			description: "Scroll the task list up one task",
			handler: (ctx: ExtensionContext) => scrollKeyboard(ctx, -1),
		});
	}
}

export const __test = {
	store,
	TODO_PRUNE_AGE_MS,
	loadState,
	SUMMARY,
	refresh,
};
