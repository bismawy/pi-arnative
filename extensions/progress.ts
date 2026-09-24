import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const DURATION_MAP = new Map<string, number>();
const TURN_CALLS_MAP = new Map<number, string[]>();
let currentTurnId = 1;
let requestTuiRender: (() => void) | null = null;

class FramedComponent {
	constructor(private getLines: (width: number) => string[]) {}
	render(width: number): string[] {
		return this.getLines(width);
	}
	invalidate(): void {}
}

const EMPTY_COMPONENT = new FramedComponent(() => []);

function smartTruncate(cmd: string, maxLen: number): string {
	const clean = cmd.replace(/\r?\n/g, " ").trim();
	if (clean.length <= maxLen) return clean;
	return `${clean.slice(0, Math.max(10, maxLen - 3))}...`;
}

function formatDuration(ms?: number): string {
	if (ms === undefined || ms < 0) return "0.1s";
	return `${(ms / 1000).toFixed(1)}s`;
}

function wrapCommand(text: string, maxW: number): string[] {
	if (text.length <= maxW) return [text];
	const words = text.split(" ");
	const lines: string[] = [];
	let cur = "";
	for (const w of words) {
		if ((cur + (cur ? " " : "") + w).length <= maxW) {
			cur += (cur ? " " : "") + w;
		} else {
			if (cur) lines.push(cur);
			cur = w;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}

function getTurnCalls(turnId: number): string[] {
	let list = TURN_CALLS_MAP.get(turnId);
	if (!list) {
		list = [];
		TURN_CALLS_MAP.set(turnId, list);
	}
	return list;
}

function registerTurnCall(turnId: number, toolCallId: string): void {
	const list = getTurnCalls(turnId);
	if (!list.includes(toolCallId)) {
		list.push(toolCallId);
		requestTuiRender?.();
	}
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const originalBash = createBashTool(cwd);

	pi.on("session_start", async (_event, ctx) => {
		requestTuiRender = () => {
			try {
				(ctx.ui as { requestRender?: () => void })?.requestRender?.();
			} catch {
				// ignore
			}
		};
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") {
			currentTurnId++;
			TURN_CALLS_MAP.set(currentTurnId, []);
		}
	});

	pi.registerTool({
		...originalBash,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const start = performance.now();
			try {
				const res = await originalBash.execute(toolCallId, params, signal, onUpdate, ctx);
				const elapsed = Math.round(performance.now() - start);
				DURATION_MAP.set(toolCallId, elapsed);
				return res;
			} catch (err) {
				const elapsed = Math.round(performance.now() - start);
				DURATION_MAP.set(toolCallId, elapsed);
				throw err;
			}
		},

		renderCall(args, theme, context) {
			registerTurnCall(currentTurnId, context.toolCallId);

			if (!context.isPartial) {
				return EMPTY_COMPONENT;
			}

			return new FramedComponent((width: number): string[] => {
				const calls = getTurnCalls(currentTurnId);
				const idx = calls.indexOf(context.toolCallId);
				const isFirst = idx === 0;
				const isLast = idx === calls.length - 1;

				const lines: string[] = [];
				const dim = (s: string) => theme.fg("dim", s);

				if (isFirst) {
					const title = dim("Thinking...");
					const titleHead = `┌─ ${title} `;
					const rem = Math.max(0, width - visibleWidth(titleHead) - 1);
					lines.push(`${dim("┌─ ")}${title} ${dim("─".repeat(rem))}┐`);
				}

				const rawCmd = (args as { command?: string })?.command || "...";
				const icon = theme.fg("warning", "\udb81\udd1f");
				const prompt = theme.bold("$");
				const prefixLen = 6; // "│ ✓ $ "
				const suffixStr = " [running...] │";
				const avail = Math.max(15, width - prefixLen - visibleWidth(suffixStr));
				const shortCmd = smartTruncate(rawCmd, avail);

				const rowContent = `${icon} ${prompt} ${shortCmd} ${dim("[running...]")}`;
				const pad = Math.max(0, width - visibleWidth(rowContent) - 4);
				lines.push(`${dim("│")} ${rowContent}${" ".repeat(pad)} ${dim("│")}`);

				if (isLast) {
					lines.push(dim(`└${"─".repeat(Math.max(0, width - 2))}┘`));
				}
				return lines;
			});
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			registerTurnCall(currentTurnId, context.toolCallId);

			if (isPartial) {
				return EMPTY_COMPONENT;
			}

			return new FramedComponent((width: number): string[] => {
				// Cari turnId yang memiliki toolCallId ini
				let turnId = currentTurnId;
				for (const [tId, calls] of TURN_CALLS_MAP.entries()) {
					if (calls.includes(context.toolCallId)) {
						turnId = tId;
						break;
					}
				}
				const calls = getTurnCalls(turnId);
				const idx = calls.indexOf(context.toolCallId);
				const isFirst = idx <= 0;
				const isLast = idx === -1 || idx === calls.length - 1;

				const lines: string[] = [];
				const dim = (s: string) => theme.fg("dim", s);

				if (isFirst) {
					const title = dim("Thinking...");
					const titleHead = `┌─ ${title} `;
					const rem = Math.max(0, width - visibleWidth(titleHead) - 1);
					lines.push(`${dim("┌─ ")}${title} ${dim("─".repeat(rem))}┐`);
				}

				const textContent = result.content?.find((c) => c.type === "text");
				const rawOutput = textContent && textContent.type === "text" ? textContent.text.trim() : "";
				const isError = Boolean(context.isError || /exit code:\s*[1-9]/i.test(rawOutput));
				const icon = isError ? theme.fg("error", "x") : theme.fg("success", "✓");
				const prompt = theme.bold("$");

				const elapsedMs = DURATION_MAP.get(context.toolCallId);
				const durStr = theme.fg("muted", `Took ${formatDuration(elapsedMs)}`);
				const hint = expanded ? dim("[click to hide]") : dim("[click for show]");

				const rawCmd = (context.args as { command?: string })?.command || "...";

				if (!expanded) {
					// Mode collapsed: smart 1-line
					const prefixLen = 6;
					const suffixStr = ` [click for show] Took ${formatDuration(elapsedMs)} │`;
					const avail = Math.max(15, width - prefixLen - visibleWidth(suffixStr));
					const shortCmd = smartTruncate(rawCmd, avail);

					const rowContent = `${icon} ${prompt} ${shortCmd} ${hint} ${durStr}`;
					const pad = Math.max(0, width - visibleWidth(rowContent) - 4);
					lines.push(`${dim("│")} ${rowContent}${" ".repeat(pad)} ${dim("│")}`);
				} else {
					// Mode expanded: Tampilkan judul lengkap, wrap bila panjang
					const innerWidth = Math.max(20, width - 4);
					const wrapped = wrapCommand(rawCmd.replace(/\r?\n/g, " ").trim(), innerWidth - 8);
					const firstLine = wrapped[0] || rawCmd;
					const headerContent = `${icon} ${prompt} ${firstLine} ${hint} ${durStr}`;
					const hPad = Math.max(0, width - visibleWidth(headerContent) - 4);
					lines.push(`${dim("│")} ${headerContent}${" ".repeat(hPad)} ${dim("│")}`);

					for (let i = 1; i < wrapped.length; i++) {
						const contLine = `    ${wrapped[i]}`;
						const cPad = Math.max(0, width - visibleWidth(contLine) - 4);
						lines.push(`${dim("│")} ${contLine}${" ".repeat(cPad)} ${dim("│")}`);
					}

					if (rawOutput) {
						for (const outLine of rawOutput.split("\n")) {
							const styled = theme.fg("toolOutput", outLine);
							const oPad = Math.max(0, width - visibleWidth(styled) - 4);
							lines.push(`${dim("│")} ${styled}${" ".repeat(oPad)} ${dim("│")}`);
						}
					}
				}

				if (isLast) {
					lines.push(dim(`└${"─".repeat(Math.max(0, width - 2))}┘`));
				}
				return lines;
			});
		},
	});
}
