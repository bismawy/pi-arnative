/**
 * The todo box as the session draws it: a real `ToolExecutionComponent` with the real tool
 * definition and a real tool result, so the assertion covers the path the terminal takes.
 * `tools.ts` gives the todo tool a dedicated box (`formatTodoRows`), which bypasses the generic
 * title row every other tool uses; a test of the generic path does not reach it.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";

initTheme("arnative-gruvbox");
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "arnative-todo-box-"));
await import("../extensions/tools.ts");

let definition: any;
const pi: any = {
	registerTool: (options: any) => (definition = options),
	on: () => {},
	registerShortcut: () => {},
	registerCommand: () => {},
};
const { default: extension } = await import("../extensions/todos.ts");
await extension(pi);

const ctx: any = {
	sessionManager: { getSessionId: () => "todo-box" },
	thinkingLevel: "high",
	ui: { setWidget: () => {}, notify: () => {} },
};

const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

const render = async (args: unknown, result: unknown): Promise<string[]> => {
	const component: any = new ToolExecutionComponent("todo", "call-1", args, {}, definition, { requestRender() {} }, process.cwd());
	component.updateResult(result, false);
	return (component.render(70) as string[]).map(plain);
};

const run = (args: unknown) => definition.execute("call-1", args, undefined, undefined, ctx);

test("the todo box names the task it changed", async () => {
	await run({ action: "create", tasks: [{ subject: "Rilis 0.9.0" }] });
	const result = await run({ action: "update", id: 1, status: "in_progress" });
	const lines = await render({ action: "update", id: 1, status: "in_progress" }, result);

	assert.ok(lines[1]!.includes("todo · Rilis 0.9.0"), `the title names the task, got ${lines[1]}`);
	assert.ok(lines[2]!.includes("Updated #1"), "the status line keeps the result text");
});

test("a call with no subject keeps a clean title", async () => {
	const result = await run({ action: "clear" });
	const lines = await render({ action: "clear" }, result);

	assert.ok(lines[1]!.includes("todo"), `the title keeps the tool name, got ${lines[1]}`);
	assert.ok(!lines[1]!.includes("·"), `no dangling dot without a task, got ${lines[1]}`);
});
