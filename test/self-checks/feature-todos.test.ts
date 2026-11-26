import test from "node:test";
import { assert } from "../helpers/check.ts";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textSpans } from "../../lib/box.ts";
import { HINT_COLLAPSE, HINT_EXPAND, allDone } from "../../lib/todos.ts";
import { pruneCompletedTodos, runTodo, __test } from "../../lib/features/todos.ts";

const { store, TODO_PRUNE_AGE_MS, loadState, SUMMARY, refresh } = __test;

test("lib/features/todos.ts self-check", async () => {
	const created = runTodo({ action: "create", tasks: [{ subject: "Satu" }, { subject: "Dua", note: "catatan" }] });
	assert(!("isError" in created) && created.content[0]!.text === "Added 2 tasks: #1, #2", `create reports both ids, got ${created.content[0]!.text}`);
	const patched = runTodo({ action: "update", id: 1, status: "in_progress", note: "sedang jalan" });
	assert(!("isError" in patched) && patched.content[0]!.text === "Updated #1", "update reports the id");
	assert(store().state.tasks[0]!.status === "in_progress" && store().state.tasks[0]!.note === "sedang jalan", "update lands in the store");
	assert(SUMMARY(store().state) === "2 tasks: 1 in progress, 1 queued, 0 done", `summary, got ${SUMMARY(store().state)}`);
	const empty = runTodo({ action: "create", subject: "   " });
	assert("isError" in empty && empty.isError === true, "an empty create is an error, not a task");
	const missing = runTodo({ action: "update", id: 99, status: "completed" });
	assert("isError" in missing && missing.content[0]!.text === "no task with id 99", "an unknown id is reported");
	const listed = runTodo({ action: "list" });
	assert(listed.content[0]!.text.split("\n").length === 2, "list prints one line per task");
	assert(runTodo({ action: "delete", id: 2 }).content[0]!.text === "Removed #2", "delete reports the id");
	assert(runTodo({ action: "clear" }).content[0]!.text === "Cleared 1 task", "clear counts what it removed");
	// The widget's mouse: the hint text expands and folds the box, every other cell is left
	// to pi so the task names can be selected and copied.
	runTodo({ action: "create", tasks: [{ subject: "Satu" }, { subject: "Dua" }] });
	store().expanded = false;
	let factory: any;
	const widgetCtx: any = { ui: { setWidget: (_key: string, f: any) => (factory = f), theme: null }, thinkingLevel: "off" };
	refresh(widgetCtx, true);
	const widget: any = factory(undefined, null);
	const clickAt = (x: number, y: number): void => {
		for (const type of ["press", "release", "click"]) widget.handleMouse({ type, button: "left", x, y });
	};
	widget.render(80);
	const closed = textSpans(widget.render(80), HINT_EXPAND)[0];
	assert(closed?.row === 1, `widget: the collapsed hint sits on the first content row, got ${closed?.row}`);
	clickAt(closed!.start, closed!.row);
	assert(store().expanded === true, "widget: a click on the hint expands");
	widget.render(80);
	const opened = textSpans(widget.render(80), HINT_COLLAPSE)[0];
	assert(opened !== undefined, "widget: the expanded box offers the fold hint");
	clickAt(opened!.start, opened!.row);
	assert(store().expanded === false, "widget: a click on the fold hint collapses");
	// Off the hint nothing is taken, so pi can start a selection over the task rows.
	for (const [x, y] of [[5, 1], [5, 2], [5, 3]] as const) {
		assert(widget.handleMouse({ type: "press", button: "left", x, y }) === undefined, `widget: a press at ${x},${y} is left to pi`);
	}
	// A finished list shows its `All tasks finished` row, then leaves: /todos still lists it.
	process.env.PI_ARNATIVE_TODO_HIDE_MS = "10";
	let lastFactory: any = "untouched";
	const hideCtx: any = { ui: { setWidget: (_key: string, f: any) => (lastFactory = f), theme: null }, thinkingLevel: "off" };
	for (const task of [...store().state.tasks]) runTodo({ action: "update", id: task.id, status: "completed" });
	refresh(hideCtx, true);
	assert(typeof lastFactory === "function", "widget: a finished list keeps its box for the wait");
	assert(allDone(store().state), "widget: the list really is finished");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert(lastFactory === undefined && store().registered === false, "widget: the box leaves once the wait is over");
	// A task reopened during the wait cancels it: the box must not vanish under live work.
	for (const task of [...store().state.tasks]) runTodo({ action: "update", id: task.id, status: "completed" });
	refresh(hideCtx, true);
	const reopened = store().state.tasks[0]!;
	runTodo({ action: "update", id: reopened.id, status: "in_progress" });
	refresh(hideCtx, true);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert(typeof lastFactory === "function" && store().registered === true, "widget: live work cancels the wait");
	delete process.env.PI_ARNATIVE_TODO_HIDE_MS;
	// A new task cancels nothing (the timer already fired) and brings the box back at once.
	runTodo({ action: "create", subject: "Lagi" });
	refresh(hideCtx, true);
	assert(typeof lastFactory === "function", "widget: a new task brings the box back");
	// A new session with no file on disk starts empty instead of inheriting the previous session's list.
	loadState({ sessionManager: { getSessionId: () => `empty-${process.pid}-${Date.now()}` } } as never);
	assert(store().state.tasks.length === 0 && store().expanded === false, "session_start: a fresh session starts with an empty list");
	// Auto-prune removes old completed/empty todo files while keeping open, recent, and active-session files.
	const pruneTmp = mkdtempSync(join(tmpdir(), "arnative-todos-prune-"));
	try {
		const now = Date.now();
		const oldSec = (now - TODO_PRUNE_AGE_MS - 60_000) / 1000;
		const put = (name: string, data: unknown, old: boolean): string => {
			const p = join(pruneTmp, name);
			writeFileSync(p, JSON.stringify(data));
			if (old) utimesSync(p, oldSec, oldSec);
			return p;
		};
		put("old-done.json", { nextId: 2, tasks: [{ id: 1, subject: "a", status: "completed" }] }, true);
		put("old-empty.json", { nextId: 1, tasks: [] }, true);
		put("old-open.json", { nextId: 2, tasks: [{ id: 1, subject: "b", status: "pending" }] }, true);
		put("recent-done.json", { nextId: 2, tasks: [{ id: 1, subject: "c", status: "completed" }] }, false);
		const activePath = put("active-done.json", { nextId: 2, tasks: [{ id: 1, subject: "d", status: "completed" }] }, true);
		const removed = pruneCompletedTodos(pruneTmp, { now, skipFile: activePath });
		const left = readdirSync(pruneTmp).sort();
		assert(removed === 2, `prune: expected 2 removed, got ${removed}`);
		assert(
			left.join(",") === "active-done.json,old-open.json,recent-done.json",
			`prune: expected open/recent/active kept, got ${left.join(",")}`,
		);
	} finally {
		rmSync(pruneTmp, { recursive: true, force: true });
	}
});
