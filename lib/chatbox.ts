/**
 * Chatbox editor border, prompt styling, scroll border, and working-status dialog placement.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "./ansi.ts";
import { patchOnce } from "./patch.ts";
import {
	CHATBOX_DIALOG_KEY as CHATBOX_DIALOG_CONFIG_KEY,
	CHATBOX_PRESET_KEY as CHATBOX_PRESET_CONFIG_KEY,
	CHATBOX_PROMPT_KEY as CHATBOX_PROMPT_CONFIG_KEY,
	choiceSetting,
} from "./preset-store.ts";
import { getRuntime } from "./runtime.ts";

export const CHATBOX_PRESETS = ["Pi (system)", "Arnative"] as const;
export type ChatboxPreset = (typeof CHATBOX_PRESETS)[number];
export const DEFAULT_CHATBOX_PRESET: ChatboxPreset = "Arnative";
const chatboxPreset = choiceSetting(CHATBOX_PRESET_CONFIG_KEY, CHATBOX_PRESETS, DEFAULT_CHATBOX_PRESET);
export const CHATBOX_PRESET_KEY = chatboxPreset.slot;

export const CHATBOX_PROMPTS = ["❯", ">", "›", "▸", "→", "\uf44f", "\udb82\udf79", "\uf51b", "\udb80\udf7d", "\uf120", "\uf489", "\udb80\udd7a"] as const;
export type ChatboxPrompt = (typeof CHATBOX_PROMPTS)[number];
export const DEFAULT_CHATBOX_PROMPT: ChatboxPrompt = "❯";
const chatboxPrompt = choiceSetting(CHATBOX_PROMPT_CONFIG_KEY, CHATBOX_PROMPTS, DEFAULT_CHATBOX_PROMPT);
export const CHATBOX_PROMPT_KEY = chatboxPrompt.slot;

export const CHATBOX_DIALOGS = ["Left", "Center", "Right", "Inside", "Outside"] as const;
export type ChatboxDialog = (typeof CHATBOX_DIALOGS)[number];
export const DEFAULT_CHATBOX_DIALOG: ChatboxDialog = "Left";
const chatboxDialog = choiceSetting(CHATBOX_DIALOG_CONFIG_KEY, CHATBOX_DIALOGS, DEFAULT_CHATBOX_DIALOG);
export const CHATBOX_DIALOG_KEY = chatboxDialog.slot;

export const PROMPT_IDLE_MS = 3_000;

let chatboxPoke: () => void = () => {};

/** Register the repaint callback invoked when chatbox presets or prompt idle state change. */
export function bindChatboxPoke(fn: () => void): void {
	chatboxPoke = fn;
}

export const activeChatboxPreset = (): ChatboxPreset => chatboxPreset.get();
export function setChatboxPreset(name: ChatboxPreset): void {
	chatboxPreset.set(name);
	chatboxPoke();
}

export const activeChatboxPrompt = (): ChatboxPrompt => chatboxPrompt.get();
export function setChatboxPrompt(prompt: ChatboxPrompt): void {
	chatboxPrompt.set(prompt);
	chatboxPoke();
}

export function nextChatboxPrompt(current: ChatboxPrompt = activeChatboxPrompt()): ChatboxPrompt {
	const idx = CHATBOX_PROMPTS.indexOf(current);
	return CHATBOX_PROMPTS[(idx + 1) % CHATBOX_PROMPTS.length]!;
}

export const activeChatboxDialog = (): ChatboxDialog => chatboxDialog.get();
export function setChatboxDialog(dialog: ChatboxDialog): void {
	chatboxDialog.set(dialog);
	chatboxPoke();
}

export function nextChatboxDialog(current: ChatboxDialog = activeChatboxDialog()): ChatboxDialog {
	const idx = CHATBOX_DIALOGS.indexOf(current);
	return CHATBOX_DIALOGS[(idx + 1) % CHATBOX_DIALOGS.length]!;
}

export function isPromptActive(
	now: number = Date.now(),
	lastTyped: number = getRuntime().promptTypedAt,
): boolean {
	return lastTyped > 0 && now - lastTyped <= PROMPT_IDLE_MS;
}

export function stopPromptIdle(): void {
	const rt = getRuntime();
	if (rt.promptIdleTimer) clearTimeout(rt.promptIdleTimer);
	rt.promptIdleTimer = null;
}

export function markPromptTyped(now: number = Date.now()): void {
	const rt = getRuntime();
	rt.promptTypedAt = now;
	stopPromptIdle();
	const timer = setTimeout(() => {
		getRuntime().promptIdleTimer = null;
		chatboxPoke();
	}, PROMPT_IDLE_MS + 25);
	timer.unref?.();
	rt.promptIdleTimer = timer;
	chatboxPoke();
}

export function chatboxPrimaryPaint(
	th: { fg?(color: string, text: string): string } | null | undefined,
): (text: string) => string {
	if (!th?.fg) return (t) => t;
	for (const token of ["mdHeading", "accent"]) {
		try {
			const probe = th.fg(token, "x");
			if (typeof probe === "string" && probe.includes("x")) return (t) => th.fg!(token, t);
		} catch {
			// try next
		}
	}
	return (t) => t;
}

export function isWideNerdPrompt(glyph: string): boolean {
	const cp = glyph.codePointAt(0) ?? 0;
	return (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;
}

export function paintChatboxPrompt(
	promptGlyph: string,
	th: { fg?(color: string, text: string): string } | null | undefined,
	active: boolean,
): string {
	const text = isWideNerdPrompt(promptGlyph) ? ` ${promptGlyph}  ` : ` ${promptGlyph} `;
	if (!th?.fg) return text;
	try {
		if (!active) return th.fg("dim", text);
		return chatboxPrimaryPaint(th)(text);
	} catch {
		return text;
	}
}

export function renderChatboxScrollBorder(
	direction: "\u2191" | "\u2193",
	hiddenLineCount: number,
	width: number,
	borderColor: (text: string) => string,
	primaryColor: (text: string) => string,
): string {
	const availableWidth = Math.max(0, width);
	if (hiddenLineCount <= 0) return borderColor("\u2500".repeat(availableWidth));
	const core = `${direction} ${hiddenLineCount} more`;
	const labelWidth = visibleWidth(core) + 2;
	if (labelWidth + 2 <= availableWidth) {
		const leftWidth = Math.floor((availableWidth - labelWidth) / 2);
		const rightWidth = availableWidth - leftWidth - labelWidth;
		return `${borderColor(`${"\u2500".repeat(leftWidth)} `)}${primaryColor(core)}${borderColor(` ${"\u2500".repeat(rightWidth)}`)}`;
	}
	const prefix = "\u2500\u2500\u2500 ";
	const remaining = availableWidth - visibleWidth(prefix) - visibleWidth(core) - 1;
	if (remaining >= 0) {
		return `${borderColor(prefix)}${primaryColor(core)}${borderColor(` ${"\u2500".repeat(remaining)}`)}`;
	}
	return borderColor(".".repeat(Math.min(3, availableWidth)) + "\u2500".repeat(Math.max(0, availableWidth - 3)));
}

export function renderChatboxLines(
	preset: ChatboxPreset,
	renderInner: (w: number) => string[],
	width: number,
	visible: number | undefined,
	color: (text: string) => string,
	prompt = " > ",
): string[] {
	const promptW = visibleWidth(prompt);
	if (preset === "Pi (system)" || typeof visible !== "number" || width < promptW + 8) return renderInner(width);
	return boxEditorLines(renderInner(width - (2 + promptW)), visible, color, prompt);
}

export function boxEditorLines(
	lines: readonly string[],
	visible: number,
	color: (text: string) => string,
	prompt = " > ",
): string[] {
	const inner = lines.length > 0 ? visibleWidth(lines[0]!) : 0;
	const promptWidth = visibleWidth(prompt);
	if (inner < promptWidth + 4 || visible < 1 || lines.length < visible + 2) return [...lines];
	const out = [...lines];
	const side = color("\u2502");
	const indent = " ".repeat(promptWidth);
	for (let i = 1; i <= visible; i++) out[i] = side + (i === 1 ? prompt : indent) + lines[i]! + side;
	const patch = color("\u2500".repeat(promptWidth));
	out[0] = color("\u256d") + lines[0]! + patch + color("\u256e");
	out[visible + 1] = color("\u2570") + lines[visible + 1]! + patch + color("\u256f");
	return out;
}

function formatTopBorderDialog(
	innerW: number,
	hiddenLineCount: number,
	dialog: "Left" | "Center" | "Right",
	status: string,
	spinnerOnly: string,
	color: (text: string) => string,
	primaryColor: (text: string) => string = (t) => t,
): string {
	const scrollCore = hiddenLineCount > 0 ? `\u2191 ${hiddenLineCount} more` : "";
	const scrollW = scrollCore ? visibleWidth(scrollCore) + 2 : 0;
	const scrollPainted = scrollCore ? `${color(" ")}${primaryColor(scrollCore)}${color(" ")}` : "";
	const tryPlace = (label: string): string | null => {
		const lw = visibleWidth(label);
		if (lw === 0 || innerW < lw + 4) return null;
		if (dialog === "Left") {
			if (scrollW > 0) {
				const centerStart = Math.floor((innerW - scrollW) / 2);
				if (centerStart >= 4 + lw + 1) {
					return `${color("\u2500\u2500 ")}${label}${color(` ${"\u2500".repeat(centerStart - (4 + lw))}`)}${scrollPainted}${color("\u2500".repeat(innerW - centerStart - scrollW))}`;
				}
				return null;
			}
			return color("\u2500\u2500 ") + label + color(` ${"\u2500".repeat(innerW - lw - 4)}`);
		}
		if (dialog === "Center") {
			const leftD = Math.floor((innerW - lw - 2) / 2);
			const rightD = innerW - lw - 2 - leftD;
			if (scrollW > 0) {
				const leftEnd = 2 + scrollW;
				if (leftD >= leftEnd + 1) {
					return `${color("\u2500\u2500")}${scrollPainted}${color(`${"\u2500".repeat(leftD - leftEnd)} `)}${label}${color(` ${"\u2500".repeat(rightD)}`)}`;
				}
				return null;
			}
			return color(`${"\u2500".repeat(leftD)} `) + label + color(` ${"\u2500".repeat(rightD)}`);
		}
		if (scrollW > 0) {
			const centerStart = Math.floor((innerW - scrollW) / 2);
			if (centerStart + scrollW + 1 <= innerW - lw - 4) {
				return `${color("\u2500".repeat(centerStart))}${scrollPainted}${color(`${"\u2500".repeat(innerW - lw - 4 - centerStart - scrollW)} `)}${label}${color(" \u2500\u2500")}`;
			}
			return null;
		}
		return color(`${"\u2500".repeat(innerW - lw - 4)} `) + label + color(" \u2500\u2500");
	};
	const placed = tryPlace(status) ?? (spinnerOnly ? tryPlace(spinnerOnly) : null);
	if (placed) return placed;
	const fallback = spinnerOnly || status;
	const fw = visibleWidth(fallback);
	if (innerW >= fw + 4) {
		if (dialog === "Right") return color(`${"\u2500".repeat(innerW - fw - 4)} `) + fallback + color(" \u2500\u2500");
		if (dialog === "Center") {
			const leftD = Math.floor((innerW - fw - 2) / 2);
			return color(`${"\u2500".repeat(leftD)} `) + fallback + color(` ${"\u2500".repeat(innerW - fw - 2 - leftD)}`);
		}
		return color("\u2500\u2500 ") + fallback + color(` ${"\u2500".repeat(innerW - fw - 4)}`);
	}
	const sw = Math.min(fw, innerW);
	const prefixW = dialog === "Right" ? Math.max(0, innerW - sw) : dialog === "Center" ? Math.max(0, Math.floor((innerW - sw) / 2)) : Math.min(2, Math.max(0, innerW - sw));
	return color("\u2500".repeat(prefixW)) + truncateToWidth(fallback, sw, "") + color("\u2500".repeat(Math.max(0, innerW - prefixW - sw)));
}

/** Places the active working/status dialog relative to the chatbox per the user's Dialog preset. */
export function applyChatboxDialog(
	lines: readonly string[],
	boxed: boolean,
	width: number,
	hiddenLineCount: number,
	dialog: ChatboxDialog,
	status: string,
	spinnerOnly: string,
	color: (text: string) => string,
	primaryColor: (text: string) => string = (t) => t,
): string[] {
	const sw = visibleWidth(status);
	if (sw === 0 || lines.length === 0) return [...lines];
	const out = [...lines];
	if (dialog === "Outside") return out;
	if (dialog === "Inside") {
		if (out.length < 2) return out;
		const side = boxed ? color("\u2502") : "";
		if (boxed && (!out[1]!.startsWith(side) || !out[1]!.endsWith(side))) return out;
		const inner = boxed ? out[1]!.slice(side.length, out[1]!.length - side.length) : out[1]!;
		const innerW = boxed ? width - 2 : width;
		const trimmed = inner.replace(/ +$/, "");
		const gap = innerW - visibleWidth(trimmed);
		if (gap >= sw + 2) {
			out[1] = side + trimmed + " ".repeat(gap - sw - 1) + status + " " + side;
		} else if (innerW >= sw + 6) {
			const kept = truncateToWidth(trimmed, innerW - sw - 2, "");
			const pad = Math.max(1, innerW - visibleWidth(kept) - sw - 1);
			out[1] = side + kept + " ".repeat(pad) + status + " " + side;
		}
		return out;
	}
	const innerW = boxed ? Math.max(1, width - 2) : width;
	const topInner = formatTopBorderDialog(innerW, hiddenLineCount, dialog, status, spinnerOnly, color, primaryColor);
	out[0] = boxed ? color("\u256d") + topInner + color("\u256e") : topInner;
	return out;
}

/** Left-aligns the Outside dialog status in the above-editor slot with 1 blank line
 *  above and below so it never crowds adjacent messages, Todos, or the chatbox. */
export function overlayOutsideDialogOnWidgetLines(lines: readonly string[], width: number, status: string): string[] {
	const sw = visibleWidth(status);
	if (sw === 0) return [...lines];
	const leftRow = truncateToWidth(` ${status}`, width, "");
	if (lines.length === 0) return ["", leftRow, ""];
	const out = [...lines];
	const lastIdx = out.length - 1;
	const last = out[lastIdx]!;
	const plainLast = stripAnsi(last).trim();
	if (plainLast.length === 0) {
		return ["", leftRow, ""];
	}
	if (!/^[╭╰│]/.test(plainLast)) {
		const trimmed = last.replace(/ +$/, "");
		const rest = trimmed.startsWith(" ") ? trimmed : ` ${trimmed}`;
		out[lastIdx] = truncateToWidth(` ${status} ${rest}`, width, "");
		if (stripAnsi(out[0]!).trim().length > 0) out.unshift("");
		out.push("");
		return out;
	}
	const boxStart = out.findIndex((line) => /^[╭╰│]/.test(stripAnsi(line).trim()));
	const prefix = out.slice(0, boxStart).filter((line) => stripAnsi(line).trim().length > 0);
	const boxed = out.slice(boxStart);
	return prefix.length > 0 ? ["", leftRow, "", ...prefix, "", ...boxed] : ["", leftRow, "", ...boxed];
}

const ABOVE_WRAPPED_KEY = Symbol.for("pi-arnative.aboveWidgetWrapped");
const ABOVE_MODE_KEY = Symbol.for("pi-arnative.aboveWidgetMode");

function installAboveEditorHook(widgetContainer: { render?: (w: number) => string[] } | undefined, mode: unknown): void {
	if (!widgetContainer || typeof widgetContainer.render !== "function") return;
	const box = widgetContainer as Record<symbol, unknown> & { render: (w: number) => string[] };
	box[ABOVE_MODE_KEY] = mode;
	if (box[ABOVE_WRAPPED_KEY]) return;
	box[ABOVE_WRAPPED_KEY] = true;
	const ownOrig = Object.hasOwn(box, "render") ? box.render : null;
	box.render = function (this: Record<symbol, unknown>, width: number): string[] {
		const baseRender = ownOrig ?? (Object.getPrototypeOf(this) as { render: (w: number) => string[] }).render;
		const lines = baseRender.call(this, width);
		try {
			const hook = getRuntime().outsideDialogHook;
			return hook ? hook(lines, width, this[ABOVE_MODE_KEY]) : lines;
		} catch {
			return lines;
		}
	};
}

interface InteractiveModeWithWidgets {
	widgetContainerAbove?: { render?: (w: number) => string[] };
	renderWidgetContainer?: (container: unknown, widgets: unknown, spacerWhenEmpty: boolean, leadingSpacer: boolean) => void;
	showStatusIndicator?: (indicator: unknown) => void;
}

if (InteractiveMode?.prototype) {
	const modeProto = InteractiveMode.prototype as unknown as InteractiveModeWithWidgets;
	if (typeof modeProto.renderWidgetContainer === "function") {
		patchOnce(modeProto, "renderWidgetContainer", (orig) => function (
			this: InteractiveModeWithWidgets,
			container: unknown,
			widgets: unknown,
			spacerWhenEmpty: boolean,
			leadingSpacer: boolean,
		): void {
			if (container && container === this.widgetContainerAbove) {
				installAboveEditorHook(container as { render?: (w: number) => string[] }, this);
			}
			orig.call(this, container, widgets, spacerWhenEmpty, leadingSpacer);
		});
	}
	if (typeof modeProto.showStatusIndicator === "function") {
		patchOnce(modeProto, "showStatusIndicator", (orig) => function (
			this: InteractiveModeWithWidgets,
			indicator: unknown,
		): void {
			installAboveEditorHook(this.widgetContainerAbove, this);
			orig.call(this, indicator);
		});
	}
}
