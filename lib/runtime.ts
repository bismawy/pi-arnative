/**
 * Centralized reload-safe runtime state and lifecycle dispatcher for @bismawy/pi-arnative.
 *
 * Pi's `/reload` re-evaluates `extensions/index.ts` with a fresh jiti module graph in the
 * same Node process. Holding reload-persistent runtime state under one typed `globalThis`
 * slot (`Symbol.for("pi-arnative.runtime")`) replaces 25+ scattered `Symbol.for` slots,
 * and consolidating `pi.on(...)` fan-out installs one listener per event type instead of
 * registering 40+ separate handlers (e.g. 13 `session_start`, 6 `session_shutdown`).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const RUNTIME_KEY = Symbol.for("pi-arnative.runtime");

// Per-component instance tags shared across `tools.ts` and `render-cache.ts`.
export const TOOL_BOX_SCROLL_HOLD_KEY = Symbol.for("pi-arnative.toolBoxScrollHold");
export const TOOL_BOX_SCROLL_OFFSET_KEY = Symbol.for("pi-arnative.toolBoxScrollOffset");

export interface ActiveClockSnapshot {
	active: number;
	runStarted: number;
	lastSeen: number;
}

export interface ChatTimestampState {
	map: Map<string, number>;
	theme: { fg(color: string, text: string): string; bg?(color: string, text: string): string } | null;
}

export interface ThinkingLabelState {
	ui: { requestRender(): void } | null;
	active: Set<object>;
	starts: WeakMap<object, number[]>;
	finished: WeakMap<object, Array<string | undefined>>;
	timer: ReturnType<typeof setInterval> | null;
}

export interface RuntimeState {
	activeTheme: object | null;
	currentModel: unknown;
	currentThinking: unknown;
	lastCwd: string;
	lastGit: unknown;
	footerGen: number;
	footerRegistrar: ((ctx: ExtensionContext) => void) | null;
	activeClock: ActiveClockSnapshot | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
	clockTimer: ReturnType<typeof setInterval> | null;
	promptTypedAt: number;
	promptIdleTimer: ReturnType<typeof setTimeout> | null;
	minimalFooterExpanded: { left: boolean; right: boolean } | null;
	outsideDialogHook: ((lines: string[], width: number, mode: unknown) => string[]) | null;
	activityHook: ((data: string) => void) | null;
	wrappedTuis: WeakSet<object>;
	editor: unknown;
	workingUi: unknown;
	workingTheme: unknown;
	resourceStore: Map<string, string[]> | null;
	headerInstance: unknown;
	chatTimestampState: ChatTimestampState | null;
	thinkingLabelState: ThinkingLabelState | null;
	renderCacheState: unknown;
	autocompactState: unknown;
	todosWidget: unknown;
}

function createFreshRuntime(): RuntimeState {
	return {
		activeTheme: null,
		currentModel: undefined,
		currentThinking: undefined,
		lastCwd: "",
		lastGit: null,
		footerGen: 0,
		footerRegistrar: null,
		activeClock: null,
		idleTimer: null,
		clockTimer: null,
		promptTypedAt: 0,
		promptIdleTimer: null,
		minimalFooterExpanded: null,
		outsideDialogHook: null,
		activityHook: null,
		wrappedTuis: new WeakSet<object>(),
		editor: null,
		workingUi: null,
		workingTheme: null,
		resourceStore: null,
		headerInstance: null,
		chatTimestampState: null,
		thinkingLabelState: null,
		renderCacheState: null,
		autocompactState: null,
		todosWidget: null,
	};
}

/** Single reload-safe runtime state bag stored under `globalThis[Symbol.for("pi-arnative.runtime")]`. */
export function getRuntime(): RuntimeState {
	const g = globalThis as Record<symbol, RuntimeState | undefined>;
	g[RUNTIME_KEY] ??= createFreshRuntime();
	return g[RUNTIME_KEY]!;
}

type EventHandler = (event: any, ctx: any) => any;

function createEventDispatcher(eventName: string, handlers: readonly EventHandler[]): EventHandler {
	if (eventName === "context") {
		return async (event: any, ctx: any) => {
			let current = event;
			let changed = false;
			for (const handler of handlers) {
				const res = await handler(current, ctx);
				if (res?.messages) {
					current = { ...current, messages: res.messages };
					changed = true;
				}
			}
			return changed ? { messages: current.messages } : undefined;
		};
	}
	if (eventName === "input") {
		return async (event: any, ctx: any) => {
			let current = event;
			let transformed = false;
			for (const handler of handlers) {
				const res = await handler(current, ctx);
				if (res?.action === "handled") return res;
				if (res?.action === "transform") {
					current = { ...current, text: res.text, images: res.images ?? current.images };
					transformed = true;
				}
			}
			return transformed ? { action: "transform", text: current.text, images: current.images } : undefined;
		};
	}
	if (eventName === "before_provider_request") {
		return async (event: any, ctx: any) => {
			let current = event;
			let modified: unknown = undefined;
			for (const handler of handlers) {
				const res = await handler(current, ctx);
				if (res !== undefined) {
					modified = res;
					current = { ...current, payload: res };
				}
			}
			return modified;
		};
	}
	if (eventName.startsWith("session_before_")) {
		return async (event: any, ctx: any) => {
			let result: any = undefined;
			for (const handler of handlers) {
				const res = await handler(event, ctx);
				if (res) {
					result = res;
					if (res.cancel) return result;
				}
			}
			return result;
		};
	}
	return async (event: any, ctx: any) => {
		let firstError: unknown = undefined;
		let hasError = false;
		for (const handler of handlers) {
			try {
				await handler(event, ctx);
			} catch (err) {
				if (!hasError) {
					firstError = err;
					hasError = true;
				}
			}
		}
		if (hasError) throw firstError;
	};
}

/**
 * Registers every feature through a centralized lifecycle hub so Pi receives at most one
 * `pi.on(...)` listener per event type instead of 40+ individual handlers.
 */
export function registerLifecycleFeatures(
	pi: ExtensionAPI,
	features: readonly ((api: ExtensionAPI) => void)[],
): void {
	const handlersByEvent = new Map<string, EventHandler[]>();
	const scopedPi = new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "on") {
				return (event: string, handler: EventHandler) => {
					let list = handlersByEvent.get(event);
					if (!list) {
						list = [];
						handlersByEvent.set(event, list);
					}
					list.push(handler);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	for (const register of features) {
		register(scopedPi);
	}

	const on = pi.on.bind(pi) as (event: string, handler: EventHandler) => void;
	for (const [event, handlers] of handlersByEvent) {
		on(event, handlers.length === 1 ? handlers[0]! : createEventDispatcher(event, handlers));
	}
}
