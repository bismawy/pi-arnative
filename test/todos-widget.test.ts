/**
 * The task list end to end, without a terminal: the extension is registered against stub
 * `pi` and `ctx` objects, then driven through the tool, a click, the shortcut, a reload and
 * `/todos`. State goes to a throwaway agent dir, so a test run never touches the real list.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "arnative-todos-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// The finished box waits 30s in real use; a test needs the wait, not the 30s.
process.env.PI_ARNATIVE_TODO_HIDE_MS = "20";

const { default: extension } = await import("../extensions/todos.ts");

const palette: string[] = [];
const theme = {
	fg: (color: string, text: string): string => {
		palette.push(color);
		return text;
	},
};

const widgets = new Map<string, { content: unknown; placement?: string }>();
const shortcuts = new Map<string, { handler: (ctx: unknown) => void }>();
const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
let registered: { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> } | undefined;

const pi = {
	registerTool: (options: { execute: unknown }) => (registered = options as typeof registered),
	on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(event, handler),
	registerShortcut: (key: string, options: { handler: (ctx: unknown) => void }) => shortcuts.set(key, options),
	registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, options),
};

const notices: string[] = [];
let screen: { render(width: number): string[] } | undefined;
const ctx = {
	mode: "tui",
	sessionManager: { getSessionId: () => "widget-test" },
	ui: {
		theme,
		notify: (text: string) => notices.push(text),
		setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, { content, placement: options?.placement });
		},
		custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => { render(width: number): string[] }) => {
			screen = factory({ requestRender: () => {} }, theme, {}, () => {});
			return true;
		},
	},
};

extension(pi as never);

const call = (params: unknown) =>
	registered!.execute("call-1", params, undefined, undefined, ctx) as Promise<{ content: { text: string }[]; isError?: boolean }>;

/** The widget component as pi would build it, plus a redraw helper. */
function widget() {
	const entry = widgets.get("arnative-todos");
	assert.ok(entry, "the widget is registered");
	return {
		placement: entry!.placement,
		component: (entry!.content as (tui: unknown, theme: unknown) => { render(width: number): string[]; handleMouse(event: unknown): { handled?: boolean } | undefined })(
			{ requestRender: () => {} },
			theme,
		),
	};
}

const click = (component: { render(width: number): string[]; handleMouse(event: unknown): unknown }, y: number, x = 4) => {
	component.handleMouse({ type: "press", button: "left", x, y, width: 80, height: 10 });
	return component.handleMouse({ type: "click", button: "left", x, y, width: 80, height: 10 });
};

/** Click the hint text itself: the box takes a press only there, so the task rows stay
 *  selectable and copyable. */
const clickHint = (component: { render(width: number): string[]; handleMouse(event: unknown): unknown }, text: string) => {
	const lines = component.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	const row = lines.findIndex((line) => line.includes(text));
	assert.ok(row >= 0, `the hint "${text}" is on screen`);
	return click(component, row, lines[row]!.indexOf(text));
};

test.after(() => rmSync(agentDir, { recursive: true, force: true }));

test("an empty list shows no widget", async () => {
	await handlers.get("session_start")!(undefined, ctx);
	await call({ action: "list" });
	assert.equal(widgets.size, 0, "nothing to show before the first task");
});

test("the tool fills the list and registers the box above the editor", async () => {
	const created = await call({ action: "create", tasks: [{ subject: "Satu" }, { subject: "Dua" }, { subject: "Tiga" }] });
	assert.equal(created.content[0]!.text, "Added 3 tasks: #1, #2, #3", "create reports the ids");
	await call({ action: "update", id: 2, status: "in_progress", note: "menulis tes" });

	const { placement, component } = widget();
	assert.equal(placement, "aboveEditor", "the box sits above the editor");
	const collapsed = component.render(80);
	assert.equal(collapsed.length, 3, "collapsed is frame, row, frame");
	assert.ok(collapsed[1]!.includes("Todos (0/3)"), "the row counts the tasks");
	assert.ok(collapsed[1]!.includes("Dua"), "the row names the task in progress");
});

test("a click on the hint expands the box, the next click collapses it", () => {
	const { component } = widget();
	const collapsed = component.render(80);
	assert.equal(clickHint(component, "[click to expand]")?.handled, true, "the hint takes the click");
	const expanded = component.render(80);
	assert.ok(expanded.length > collapsed.length, "the click expanded the box");
	assert.ok(expanded.some((line) => line.includes("· menulis tes")), "the note shows while expanded");
	clickHint(component, "[click to collapse]");
	assert.equal(component.render(80).length, collapsed.length, "a second click collapses it");
});

test("a press on a task row is left to pi for selection", () => {
	const { component } = widget();
	const before = component.render(80).length;
	assert.equal(click(component, 1)?.handled, undefined, "the row beside the hint stays selectable");
	assert.equal(component.render(80).length, before, "and nothing toggled");
});

test("a click below the box belongs to the editor", () => {
	const { component } = widget();
	const before = component.render(80).length;
	click(component, 40);
	assert.equal(component.render(80).length, before, "a click outside the box does nothing");
});

test("the shortcut is the keyboard path", () => {
	const { component } = widget();
	const keys = [...shortcuts.keys()];
	assert.deepEqual(
		keys,
		["ctrl+alt+o", "alt+o", "ctrl+alt+j", "alt+j", "ctrl+alt+k", "alt+k"],
		`shortcut keys, got ${keys}`,
	);
	const collapsed = component.render(80).length;
	shortcuts.get("alt+o")!.handler(ctx);
	assert.ok(component.render(80).length > collapsed, "the shortcut expands the box");
	shortcuts.get("alt+o")!.handler(ctx);
	assert.equal(component.render(80).length, collapsed, "the shortcut collapses it");
});

test("the list survives a reload", async () => {
	const file = join(agentDir, "arnative", "todos", "widget-test.json");
	assert.ok(existsSync(file), `the state file is at ${file}`);
	const stored = JSON.parse(readFileSync(file, "utf8")) as { tasks: { subject: string }[]; nextId: number };
	assert.equal(stored.tasks.length, 3, "every task is stored");
	assert.equal(stored.nextId, 4, "the next id is stored");

	// A reload re-imports the module: drop the module state, then start the session again.
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-arnative.todos.widget")];
	widgets.clear();
	await handlers.get("session_start")!(undefined, ctx);
	assert.ok(widgets.has("arnative-todos"), "the widget comes back from the file");
	assert.ok(widget().component.render(80)[1]!.includes("Dua"), "the active task is the one that was active");
});

test("the counters scroll the window, by click and by key", async () => {
	// Six more tasks, so the five-row window has to leave something out.
	await call({ action: "create", tasks: [4, 5, 6, 7, 8, 9].map((n) => ({ subject: `Task ${n}` })) });
	const { component } = widget();
	shortcuts.get("alt+o")!.handler(ctx);

	// The subjects of the five rows on screen, in order.
	const shown = (lines: string[]): string[] =>
		lines
			.map((line) => line.match(/[├└]─ . (.+)$/)?.[1]?.replace(/[\s│]+$/, ""))
			.filter((subject): subject is string => Boolean(subject));
	const top = component.render(80);
	const down = top.findIndex((line) => line.includes("↓"));
	assert.ok(down > 0, "the box counts the tasks below it");
	assert.deepEqual(shown(top).map((s) => s.split(" ·")[0]), ["Satu", "Dua", "Tiga", "Task 4", "Task 5"], "the window starts at the top");

	click(component, down);
	const scrolled = component.render(80);
	assert.deepEqual(
		shown(scrolled).map((s) => s.split(" ·")[0]),
		["Dua", "Tiga", "Task 4", "Task 5", "Task 6"],
		"a click on ↓ moved the window down one task",
	);

	// The keyboard path, for regular mode where pi hands the mouse to the terminal.
	shortcuts.get("alt+j")!.handler(ctx);
	assert.equal(shown(component.render(80))[0]!.split(" ·")[0], "Tiga", "alt+j scrolls down");
	shortcuts.get("alt+k")!.handler(ctx);
	assert.deepEqual(shown(component.render(80)), shown(scrolled), "alt+k scrolls back up");

	// Clicking ↑ works too, and parks at the top instead of running off it.
	click(component, component.render(80).findIndex((line) => line.includes("↑")));
	assert.deepEqual(shown(component.render(80)).map((s) => s.split(" ·")[0]), ["Satu", "Dua", "Tiga", "Task 4", "Task 5"], "a click on ↑ moved back");
	assert.ok(!component.render(80).some((line) => line.includes("↑")), "at the top there is no ↑ counter left to click");

	// Past the end the window parks instead of drifting, so the last task stays visible.
	for (let i = 0; i < 20; i++) shortcuts.get("alt+j")!.handler(ctx);
	const tail = component.render(80);
	assert.ok(tail.some((line) => line.includes("Task 9")), "the last task is reachable");
	assert.ok(!tail.some((line) => line.includes("↓")), "nothing is left below the last window");

	// A mutation brings the view back to the active task.
	await call({ action: "update", id: 2, status: "in_progress" });
	assert.ok(component.render(80).some((line) => line.includes("Dua")), "the active task is back on screen");
});

test("a finished box waits, then leaves the screen on its own", async () => {
	if (widget().component.render(80).length === 3) shortcuts.get("alt+o")!.handler(ctx);
	assert.ok(widget().component.render(80).length > 3, "the box is open before the last update");
	for (let id = 1; id <= 8; id++) await call({ action: "update", id, status: "completed" });
	assert.ok(widgets.get("arnative-todos"), "work is left, so the box stays");
	await call({ action: "update", id: 9, status: "completed" });
	// Folded to one row first: the row says nothing is left, and it stays readable for the wait.
	const folded = widget().component.render(80);
	assert.equal(folded.length, 3, "a finished list folds to one row");
	assert.ok(folded[1]!.includes("Todos (9/9) · All tasks finished"), `the folded row, got ${folded[1]}`);
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(widgets.get("arnative-todos"), undefined, "the box leaves after the wait");
	// The list survives: a task that reopens brings the box back at once, no stale timer.
	await call({ action: "update", id: 9, status: "in_progress" });
	assert.ok(widgets.get("arnative-todos"), "live work brings the box back");
});

test("a task reopened during the wait keeps the box", async () => {
	for (let id = 1; id <= 9; id++) await call({ action: "update", id, status: "completed" });
	assert.ok(widgets.get("arnative-todos"), "the finished box is still on screen");
	// Opening the finished box to read it cancels the wait; closing it starts the wait again.
	clickHint(widget().component, "[click to expand]");
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.ok(widgets.get("arnative-todos"), "an expanded box stays on screen while the user reads it");
	clickHint(widget().component, "[click to collapse]");
	await call({ action: "update", id: 1, status: "in_progress" });
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.ok(widgets.get("arnative-todos"), "the wait was cancelled, the box stays");
	// Done again: a fresh wait, and this time it runs out.
	await call({ action: "update", id: 1, status: "completed" });
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(widgets.get("arnative-todos"), undefined, "the box leaves once the wait is over");
});

test("/todos shows the recap in the screen chrome", async () => {
	screen = undefined;
	await commands.get("todos")!.handler("", ctx);
	assert.ok(screen, "the recap screen opens");
	assert.equal(notices.length, 0, "the TUI path shows a screen, not a notice");
	const box = screen!.render(80);
	assert.ok(box.some((line) => line.includes("9 tasks · 0 in progress · 0 queued · 9 done")), "the summary line counts every state");
	assert.ok(box.some((line) => line.includes("✓ Satu")), "with nothing running, the done tasks lead the screen");
	// Colour goes through the theme object, never a hardcoded escape: the tokens above are the ones
	// the picker asks for, so a theme switch repaints the screen.
	assert.ok(palette.length >= 3, `the screen paints through the theme, got ${palette.length} calls`);
});

test("a new session with no stored file starts with an empty list", async () => {
	const freshCtx = { ...ctx, sessionManager: { getSessionId: () => "widget-fresh-session" } };
	await handlers.get("session_start")!({ reason: "new" }, freshCtx);
	assert.equal(widgets.get("arnative-todos"), undefined, "the old session's widget is cleared");
	const listed = await registered!.execute("call-1", { action: "list" }, undefined, undefined, freshCtx) as { content: { text: string }[] };
	assert.equal(listed.content[0]!.text, "The list is empty", "the previous session's tasks do not leak into the new session");
});
