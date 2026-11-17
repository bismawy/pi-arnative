/**
 * Transcript render cache — keep 200k–1M token sessions responsive in pi's TUI.
 *
 * Why: `pi-tui`'s `renderLayoutFrame` allocates a fresh frame cache on every redraw,
 * so `chatContainer.render(width)` re-renders every message and tool box from the start
 * of the session on every streaming delta, spinner tick, or editor keystroke.
 *
 * How:
 * - Settled transcript children inside `chatContainer` cache their `render(width)` output
 *   and reuse it until `width` changes, `rows` changes (for expanded tool boxes), the
 *   session/model resets, or the component mutates (`invalidate`, `updateContent`,
 *   `updateDisplay`, `setExpanded`, `handleMouse`, `SCROLL_OFFSET`, etc.).
 * - Active components (`isStreaming`, `isPartial`, `argsPending`, `status === "running"`,
 *   active thinking dot animation, or active hold-scroll) always render fresh, while all
 *   earlier settled history hits the per-child cache in O(1).
 * - When every child in `chatContainer` is settled, `chatContainer.render(width)` itself
 *   returns its cached `lines` and restores `mouseLayout` in O(1) without rebuilding the
 *   combined array.
 * - Attaches at the `InteractiveMode.chatContainer` instance layer (not `Container.prototype`),
 *   so it never collides with `section-headers.ts` or `ui-render-tweaks.ts` prototype
 *   patches and sits outside `tools.ts` / `timestamps.ts` render wrappers.
 */
import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, isMain } from "../lib/check.ts";
import { patchOnce } from "../lib/patch.ts";
import { RENDER_CACHE_KEY, loadChoice, resetPresetCache, saveChoice } from "../lib/preset-store.ts";

/** Stored exactly as the picker shows them; `"On"` is the default. */
export const RENDER_CACHE_CHOICES = ["On", "Off"] as const;
export type RenderCacheChoice = (typeof RENDER_CACHE_CHOICES)[number];
export const DEFAULT_RENDER_CACHE: RenderCacheChoice = "On";

const RENDER_CACHE_CONFIG_KEY = Symbol.for("pi-arnative.renderCache");
const RENDER_CACHE_STATE_KEY = Symbol.for("pi-arnative.renderCacheState");
const INSTANCE_WRAP_KEY = Symbol.for("pi-arnative.renderCacheWrapped");
const INSTANCE_ORIG_KEY = Symbol.for("pi-arnative.renderCacheOriginals");

// Shared symbols from sibling extensions so active animations / scroll-holds bypass cache.
const THINKING_STATE_KEY = Symbol.for("pi-arnative.thinkingLabelState");
const SCROLL_OFFSET_KEY = Symbol.for("pi-arnative.toolBoxScrollOffset");
const SCROLL_HOLD_KEY = Symbol.for("pi-arnative.toolBoxScrollHold");

interface ChildMeta {
	version: number;
	scrollOffset: number;
	expanded: boolean;
}

interface ChildCacheEntry {
	width: number;
	rows: number;
	epoch: number;
	version: number;
	scrollOffset: number;
	expanded: boolean;
	lines: string[];
}

interface ContainerCacheEntry {
	width: number;
	rows: number;
	epoch: number;
	version: number;
	hasExpanded: boolean;
	children: unknown[];
	childMeta: ChildMeta[];
	lines: string[];
	mouseChildren: Array<{ component: unknown; height: number }>;
}

const MAX_WIDTH_ENTRIES = 2;

interface RenderCacheState {
	epoch: number;
	versions: WeakMap<object, number>;
	childCache: WeakMap<object, ChildCacheEntry[]>;
	containerCache: WeakMap<object, ContainerCacheEntry[]>;
	/** Incremented on every cache hit/miss when needed by diagnostics/self-checks. */
	stats: { containerHits: number; childHits: number; childRenders: number };
}

function getCacheState(): RenderCacheState {
	const g = globalThis as Record<symbol, unknown>;
	if (!g[RENDER_CACHE_STATE_KEY]) {
		g[RENDER_CACHE_STATE_KEY] = {
			epoch: 0,
			versions: new WeakMap(),
			childCache: new WeakMap(),
			containerCache: new WeakMap(),
			stats: { containerHits: 0, childHits: 0, childRenders: 0 },
		} satisfies RenderCacheState;
	}
	return g[RENDER_CACHE_STATE_KEY] as RenderCacheState;
}

/** Current Render cache mode (`"On"` by default). */
export function activeRenderCache(): RenderCacheChoice {
	const stored =
		(globalThis as Record<symbol, unknown>)[RENDER_CACHE_CONFIG_KEY] ??
		loadChoice(RENDER_CACHE_KEY, RENDER_CACHE_CHOICES);
	return RENDER_CACHE_CHOICES.includes(stored as RenderCacheChoice)
		? (stored as RenderCacheChoice)
		: DEFAULT_RENDER_CACHE;
}

/** Update the Render cache choice and drop stale cached frames. */
export function setRenderCache(choice: RenderCacheChoice): void {
	(globalThis as Record<symbol, unknown>)[RENDER_CACHE_CONFIG_KEY] = choice;
	saveChoice(RENDER_CACHE_KEY, choice);
	clearRenderCache();
}

/** Drop all cached lines (e.g. on `/reload`, session switch, or model switch). */
export function clearRenderCache(): void {
	const state = getCacheState();
	state.epoch += 1;
	state.childCache = new WeakMap();
	state.containerCache = new WeakMap();
}

function findWidthEntry<T extends { width: number }>(
	list: T[] | undefined,
	width: number,
	valid: (entry: T) => boolean,
): T | undefined {
	if (!list) return undefined;
	for (let i = list.length - 1; i >= 0; i--) {
		const entry = list[i]!;
		if (entry.width !== width || !valid(entry)) continue;
		if (i !== list.length - 1) {
			list.splice(i, 1);
			list.push(entry);
		}
		return entry;
	}
	return undefined;
}

function putWidthEntry<T extends { width: number }>(
	map: WeakMap<object, T[]>,
	key: object,
	entry: T,
	keepValid: (item: T) => boolean,
): void {
	const prev = map.get(key);
	const next = prev ? prev.filter((item) => item.width !== entry.width && keepValid(item)) : [];
	next.push(entry);
	if (next.length > MAX_WIDTH_ENTRIES) next.shift();
	map.set(key, next);
}

function bumpVersion(comp: unknown): void {
	if (!comp || typeof comp !== "object") return;
	const state = getCacheState();
	state.versions.set(comp, (state.versions.get(comp) ?? 0) + 1);
}

function terminalRows(): number {
	return process.stdout?.rows || 28;
}

/** True when a transcript component is currently animating, streaming, or hold-scrolling. */
export function isDynamicChild(child: unknown): boolean {
	if (!child || typeof child !== "object") return false;
	const c = child as Record<string | symbol, unknown>;
	if (c.isStreaming === true) return true;
	if (c.isPartial === true || c.argsPending === true) return true;
	if (c.status === "running") return true;
	if (c[SCROLL_HOLD_KEY] !== undefined) return true;
	const thinking = (globalThis as Record<symbol, unknown>)[THINKING_STATE_KEY] as
		| { active?: Set<object> }
		| undefined;
	if (thinking?.active?.has(child)) return true;
	return false;
}

type AnyFn = (...args: any[]) => any;
type MarkedWrap = AnyFn & { [INSTANCE_WRAP_KEY]?: true };

/**
 * Wrap an instance method without touching the prototype chain, so prototype-level
 * patches from sibling extensions (`tools.ts`, `timestamps.ts`, `section-headers.ts`,
 * `ui-render-tweaks.ts`) continue to run and reinstall cleanly across `/reload`.
 */
function wrapInstanceMethod(
	obj: Record<string | symbol, any>,
	key: string,
	build: (callNext: (self: any, args: unknown[]) => unknown) => AnyFn,
): void {
	let originals = Object.hasOwn(obj, INSTANCE_ORIG_KEY)
		? (obj[INSTANCE_ORIG_KEY] as Record<string, AnyFn>)
		: undefined;
	if (!originals) {
		originals = {};
		Object.defineProperty(obj, INSTANCE_ORIG_KEY, { value: originals, configurable: true });
	}
	const desc = Object.getOwnPropertyDescriptor(obj, key);
	if (desc && typeof desc.value === "function" && !(desc.value as MarkedWrap)[INSTANCE_WRAP_KEY] && !Object.hasOwn(originals, key)) {
		originals[key] = desc.value as AnyFn;
	}
	const callNext = (self: any, args: unknown[]): unknown => {
		const own = Object.hasOwn(originals!, key) ? originals![key] : undefined;
		const fn = own ?? Object.getPrototypeOf(self)?.[key];
		return typeof fn === "function" ? fn.apply(self, args) : undefined;
	};
	const wrapped = build(callNext) as MarkedWrap;
	wrapped[INSTANCE_WRAP_KEY] = true;
	obj[key] = wrapped;
}

const CHILD_MUTATORS = [
	"invalidate",
	"addChild",
	"removeChild",
	"clear",
	"updateContent",
	"updateDisplay",
	"updateArgs",
	"updateResult",
	"markExecutionStarted",
	"setArgsComplete",
	"setExpanded",
	"setShowImages",
	"setImageWidthCells",
	"setOutputPad",
	"setHideThinkingBlock",
	"setHiddenThinkingLabel",
	"setText",
	"rebuild",
	"appendOutput",
	"setComplete",
] as const;

// Per-module-load tracking so `/reload` reinstalls fresh wrappers once per object.
const hookedContainers = new WeakSet<object>();
const hookedChildren = new WeakSet<object>();

function attachChildHooks(child: unknown): void {
	if (!child || typeof child !== "object" || hookedChildren.has(child)) return;
	hookedChildren.add(child);
	const obj = child as Record<string | symbol, any>;
	for (const method of CHILD_MUTATORS) {
		if (typeof obj[method] !== "function") continue;
		wrapInstanceMethod(obj, method, (callNext) => function (this: any, ...args: unknown[]) {
			bumpVersion(this);
			return callNext(this, args);
		});
	}
	for (const inputMethod of ["handleMouse", "handleInput"] as const) {
		if (typeof obj[inputMethod] !== "function") continue;
		wrapInstanceMethod(obj, inputMethod, (callNext) => function (this: any, ...args: unknown[]) {
			const res = callNext(this, args);
			if (inputMethod === "handleInput" || res !== undefined) bumpVersion(this);
			return res;
		});
	}
}

export interface ChatContainerLike {
	children: unknown[];
	mouseLayout?: { width: number; children: Array<{ component: unknown; height: number }> };
	render(width: number): string[];
	invalidate?: () => void;
	addChild?: (component: unknown) => void;
	removeChild?: (component: unknown) => void;
	clear?: () => void;
	handleMouse?: (event: unknown) => unknown;
}

function renderCachedChatContainer(
	container: ChatContainerLike,
	width: number,
	callNextRender: (self: any, args: unknown[]) => unknown,
): string[] {
	if (activeRenderCache() !== "On") {
		return callNextRender(container, [width]) as string[];
	}

	const state = getCacheState();
	const children = Array.isArray(container.children) ? container.children : [];
	const rows = terminalRows();
	const containerVer = state.versions.get(container) ?? 0;

	const cached = findWidthEntry(
		state.containerCache.get(container),
		width,
		(entry) =>
			(!entry.hasExpanded || entry.rows === rows) &&
			entry.epoch === state.epoch &&
			entry.version === containerVer &&
			entry.children.length === children.length,
	);
	if (cached) {
		let allClean = true;
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (child !== cached.children[i] || isDynamicChild(child)) {
				allClean = false;
				break;
			}
			const cObj = child && typeof child === "object" ? (child as Record<string | symbol, unknown>) : null;
			const meta = cached.childMeta[i]!;
			if (
				meta.version !== (cObj ? (state.versions.get(cObj) ?? 0) : 0) ||
				meta.scrollOffset !== (cObj ? Number(cObj[SCROLL_OFFSET_KEY] ?? 0) : 0) ||
				meta.expanded !== Boolean(cObj?.expanded)
			) {
				allClean = false;
				break;
			}
		}
		if (allClean) {
			state.stats.containerHits += 1;
			container.mouseLayout = { width, children: cached.mouseChildren };
			return cached.lines;
		}
	}

	const lines: string[] = [];
	const mouseChildren: Array<{ component: unknown; height: number }> = [];
	const snapshot: unknown[] = new Array(children.length);
	const childMeta: ChildMeta[] = new Array(children.length);
	let allChildrenCacheable = true;
	let hasExpanded = false;

	for (let i = 0; i < children.length; i++) {
		const child = children[i] as { render?: (w: number) => string[] } & Record<string | symbol, unknown>;
		snapshot[i] = child;
		if (!child || typeof child.render !== "function") {
			childMeta[i] = { version: 0, scrollOffset: 0, expanded: false };
			continue;
		}
		attachChildHooks(child);

		const isObj = typeof child === "object";
		const ver = isObj ? (state.versions.get(child) ?? 0) : 0;
		const scrollOffset = isObj ? Number(child[SCROLL_OFFSET_KEY] ?? 0) : 0;
		const expanded = Boolean(isObj && child.expanded);
		if (expanded) hasExpanded = true;
		childMeta[i] = { version: ver, scrollOffset, expanded };

		let childLines: string[];
		if (isDynamicChild(child)) {
			allChildrenCacheable = false;
			state.stats.childRenders += 1;
			childLines = child.render(width);
		} else {
			const hit = isObj
				? findWidthEntry(
						state.childCache.get(child),
						width,
						(entry) =>
							entry.epoch === state.epoch &&
							entry.version === ver &&
							entry.scrollOffset === scrollOffset &&
							entry.expanded === expanded &&
							(!expanded || entry.rows === rows),
					)
				: undefined;
			if (hit) {
				state.stats.childHits += 1;
				childLines = hit.lines;
			} else {
				state.stats.childRenders += 1;
				childLines = child.render(width);
				if (isObj) {
					putWidthEntry(
						state.childCache,
						child,
						{
							width,
							rows,
							epoch: state.epoch,
							version: ver,
							scrollOffset,
							expanded,
							lines: childLines,
						},
						(entry) =>
							entry.epoch === state.epoch &&
							entry.version === ver &&
							entry.scrollOffset === scrollOffset &&
							entry.expanded === expanded,
					);
				}
			}
		}

		mouseChildren.push({ component: child, height: childLines.length });
		for (let j = 0; j < childLines.length; j++) {
			lines.push(childLines[j]!);
		}
	}

	container.mouseLayout = { width, children: mouseChildren };
	if (allChildrenCacheable) {
		putWidthEntry(
			state.containerCache,
			container,
			{
				width,
				rows,
				epoch: state.epoch,
				version: containerVer,
				hasExpanded,
				children: snapshot,
				childMeta,
				lines,
				mouseChildren,
			},
			(entry) => entry.epoch === state.epoch && entry.version === containerVer,
		);
	} else {
		state.containerCache.delete(container);
	}
	return lines;
}

/** Attach render caching to a `chatContainer` instance (idempotent per module load, reload-safe). */
export function attachChatContainer(container: unknown): void {
	if (!container || typeof container !== "object" || hookedContainers.has(container)) return;
	hookedContainers.add(container);
	const obj = container as Record<string | symbol, any>;

	if (typeof obj.render === "function") {
		wrapInstanceMethod(obj, "render", (callNext) => function (this: ChatContainerLike, width: number): string[] {
			return renderCachedChatContainer(this, width, callNext);
		});
	}
	for (const method of ["addChild", "removeChild", "clear"] as const) {
		if (typeof obj[method] !== "function") continue;
		wrapInstanceMethod(obj, method, (callNext) => function (this: any, ...args: unknown[]) {
			bumpVersion(this);
			if (method === "addChild") attachChildHooks(args[0]);
			return callNext(this, args);
		});
	}
	if (typeof obj.invalidate === "function") {
		wrapInstanceMethod(obj, "invalidate", (callNext) => function (this: any, ...args: unknown[]) {
			bumpVersion(this);
			if (Array.isArray(this.children)) {
				for (const child of this.children) bumpVersion(child);
			}
			return callNext(this, args);
		});
	}
	if (typeof obj.handleMouse === "function") {
		wrapInstanceMethod(obj, "handleMouse", (callNext) => function (this: any, ...args: unknown[]) {
			const res = callNext(this, args);
			if (res !== undefined) bumpVersion(this);
			return res;
		});
	}
}

// Install InteractiveMode hooks so `this.chatContainer` is attached on startup,
// `/reload`, session switch, and any incoming chat/tool event.
if (InteractiveMode?.prototype) {
	const modeProto = InteractiveMode.prototype as unknown as Record<string, unknown>;
	const hookPoints = [
		"init",
		"handleReloadCommand",
		"renderSessionContext",
		"rebuildChatFromMessages",
		"addMessageToChat",
		"handleEvent",
		"updateThinkingBlockVisibility",
	] as const;
	for (const method of hookPoints) {
		if (typeof modeProto[method] !== "function") continue;
		patchOnce(modeProto, method, (orig) => function (this: { chatContainer?: unknown }, ...args: unknown[]) {
			attachChatContainer(this.chatContainer);
			return orig.apply(this, args);
		});
	}
}

export default function registerRenderCache(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		clearRenderCache();
	});
	pi.on("model_select", async () => {
		clearRenderCache();
	});
	pi.on("session_compact", async () => {
		clearRenderCache();
	});
}

// Self-check: `node extensions/render-cache.ts`
if (isMain(import.meta.url)) {
	const fixture = mkdtempSync(join(tmpdir(), "arnative-rendercache-"));
	process.env.PI_CODING_AGENT_DIR = fixture;
	delete (globalThis as Record<symbol, unknown>)[RENDER_CACHE_CONFIG_KEY];
	resetPresetCache();

	// Choice persistence & default.
	assert(activeRenderCache() === "On", "the default is On");
	setRenderCache("Off");
	assert(activeRenderCache() === "Off", "Off persists immediately");
	assert(loadChoice(RENDER_CACHE_KEY, RENDER_CACHE_CHOICES) === "Off", "Off survives reload from disk");
	setRenderCache("On");
	assert(activeRenderCache() === "On", "switching back to On restores caching");

	// Mock chatContainer + children to verify container cache, per-child cache, dynamic bypass,
	// invalidation, mouseLayout restoration, scroll-offset tracking, and Off bypass.
	class FakeChild {
		renders = 0;
		isStreaming = false;
		isPartial = false;
		expanded = false;
		[key: symbol]: unknown;
		private text: string;
		constructor(text: string) {
			this.text = text;
		}
		setText(next: string): void {
			this.text = next;
		}
		handleInput(key: string): void {
			this.text = `${this.text}:${key}`;
		}
		invalidate(): void {}
		render(width: number): string[] {
			this.renders += 1;
			return [`${this.text}@${width}`];
		}
	}
	class FakeContainer implements ChatContainerLike {
		children: FakeChild[] = [];
		mouseLayout?: { width: number; children: Array<{ component: unknown; height: number }> };
		addChild(c: FakeChild): void {
			this.children.push(c);
		}
		invalidate(): void {
			for (const c of this.children) c.invalidate();
		}
		render(width: number): string[] {
			const lines: string[] = [];
			const mouseChildren: Array<{ component: unknown; height: number }> = [];
			for (const c of this.children) {
				const out = c.render(width);
				mouseChildren.push({ component: c, height: out.length });
				lines.push(...out);
			}
			this.mouseLayout = { width, children: mouseChildren };
			return lines;
		}
	}

	const container = new FakeContainer();
	const c1 = new FakeChild("msg1");
	const c2 = new FakeChild("msg2");
	container.addChild(c1);
	container.addChild(c2);
	attachChatContainer(container);

	const out1 = container.render(80);
	assert(out1.join(",") === "msg1@80,msg2@80", "first render outputs both children");
	assert(c1.renders === 1 && c2.renders === 1, "first render calls each child once");

	// Second render at same width hits whole container cache: zero child.render calls.
	const out2 = container.render(80);
	assert(out2 === out1, "whole-container hit returns cached array reference");
	assert(c1.renders === 1 && c2.renders === 1, "container hit skips child renders");
	assert(container.mouseLayout?.children.length === 2, "mouseLayout preserved on container hit");

	// Streaming child bypasses cache while settled sibling stays cached.
	c2.isStreaming = true;
	c2.setText("streaming");
	const out3 = container.render(80);
	assert(out3.join(",") === "msg1@80,streaming@80", "streaming child updates live");
	assert(c1.renders === 1 && c2.renders === 2, "settled sibling stayed cached while streaming child re-rendered");

	c2.isStreaming = false;
	const out4 = container.render(80);
	assert(out4.join(",") === "msg1@80,streaming@80", "post-stream render caches final state");
	assert(c1.renders === 1 && c2.renders === 3, "settled after stream renders once then caches");
	container.render(80);
	assert(c1.renders === 1 && c2.renders === 3, "steady state hits container cache again");

	// Width change renders unseen width; toggling back to previous width hits 2-width LRU in O(1).
	const out5 = container.render(100);
	assert(out5.join(",") === "msg1@100,streaming@100", "width change re-renders at new width");
	assert(c1.renders === 2 && c2.renders === 4, "both re-rendered for new width");
	const out5Back = container.render(80);
	assert(out5Back === out4, "toggling back to prior width hits 2-width container LRU");
	assert(c1.renders === 2 && c2.renders === 4, "toggling back skips child renders");
	container.render(100);

	// Mutation on one child invalidates only that child.
	c1.setText("edited");
	const out6 = container.render(100);
	assert(out6.join(",") === "edited@100,streaming@100", "mutated child re-renders");
	assert(c1.renders === 3 && c2.renders === 4, "unchanged sibling stayed cached");

	// handleInput mutation invalidates that child without needing explicit invalidate().
	c1.handleInput("x");
	const out6Input = container.render(100);
	assert(out6Input.join(",") === "edited:x@100,streaming@100", "handleInput invalidates mutated child");
	assert(c1.renders === 4 && c2.renders === 4, "handleInput did not invalidate sibling");

	// Tool box scroll-offset change invalidates without explicit invalidate().
	c2[SCROLL_OFFSET_KEY] = 5;
	container.render(100);
	assert(c1.renders === 4 && c2.renders === 5, "scrollOffset change invalidates that tool box");

	// Off mode disables caching completely.
	setRenderCache("Off");
	container.render(100);
	container.render(100);
	assert(c1.renders === 6 && c2.renders === 7, "Off mode renders directly every frame");
	setRenderCache("On");

	rmSync(fixture, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete (globalThis as Record<symbol, unknown>)[RENDER_CACHE_CONFIG_KEY];
	resetPresetCache();
	console.log("render-cache.ts self-check OK");
}
