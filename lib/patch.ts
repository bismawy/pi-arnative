/**
 * Prototype patches that survive `/reload`.
 *
 * pi re-evaluates an extension in the SAME process on `/reload`, so a patch guarded
 * by a `globalThis` flag is installed once and then frozen: every later reload keeps
 * the first load's closures, and a UI fix looks broken until pi restarts.
 *
 * Two rules make a patch reload-safe:
 *   1. the pi method behind a patched slot is kept ON the prototype (a symbol key),
 *      so it outlives the module instance and never becomes a previous patch;
 *   2. every function we install is marked, so a reload cannot mistake our own patch
 *      for pi's original and wrap a box around a box.
 *
 * `originalOf` throws when a slot holds a marked method but no original was recorded:
 * that can only happen if the bookkeeping was bypassed, and silently skipping the
 * patch would leave the UI in the state this file exists to prevent.
 */
const ORIGINALS_KEY = Symbol.for("pi-arnative.protoOriginals");
const PATCHED_KEY = Symbol.for("pi-arnative.patchedMethod");

type AnyFn = (...args: any[]) => any;
type Marked = AnyFn & { [PATCHED_KEY]?: true };

/** Mark an installed patch so a later load never reads it back as an original. */
export function markPatched<T extends AnyFn>(fn: T): T {
	(fn as Marked)[PATCHED_KEY] = true;
	return fn;
}

/** pi's own method for `key`, recorded once per prototype and returned on every load. */
export function originalOf<T extends AnyFn>(proto: Record<symbol | string, any>, key: string): T {
	const originals = (proto[ORIGINALS_KEY] ??= {} as Record<string, Marked>);
	const current: Marked | undefined = proto[key];
	if (current && !current[PATCHED_KEY]) originals[key] = current;
	const original = originals[key];
	if (!original) throw new Error(`pi-arnative: ${key} has no recorded original (already patched by another package?)`);
	return original as T;
}

/** Install `build(pi's method)` on `proto[key]`, reinstalled on every load. */
export function patchOnce(proto: Record<symbol | string, any>, key: string, build: (original: AnyFn) => AnyFn): void {
	proto[key] = markPatched(build(originalOf(proto, key)));
}

// Self-check: `node lib/patch.ts`.
import { assert, isMain } from "./check.ts";
if (isMain(import.meta.url)) {
	const proto: any = { render(): string { return "pi"; } };
	const first = originalOf<() => string>(proto, "render");
	assert(first() === "pi", "the original is pi's own method");
	proto.render = markPatched(function (): string {
		return first();
	});

	// A reload: the slot holds OUR patch, and the second load must still see pi's method.
	const second = originalOf<() => string>(proto, "render");
	assert(second === first, "reload: the recorded original never becomes a previous patch");
	const reinstalled = markPatched(function (): string {
		return second();
	});
	proto.render = reinstalled;
	assert(proto.render() === "pi", "the reinstalled patch still calls pi, not itself");
	assert(proto.render !== first && proto.render === reinstalled, "the slot holds the newest patch");
	assert(proto[Symbol.for("pi-arnative.protoOriginals")].render === first, "originals stay on the prototype (outlive the module)");

	// A slot patched without bookkeeping cannot silently disable the patch.
	const lost: any = { render: markPatched(() => "x") };
	let threw = false;
	try {
		originalOf(lost, "render");
	} catch {
		threw = true;
	}
	assert(threw, "a marked slot with no recorded original fails loudly");

	// patchOnce: the one-call form, still reload-safe.
	const twice: any = { render(): string { return "pi"; } };
	patchOnce(twice, "render", (orig) => function (this: any): string {
		return `${orig.call(this)}!`;
	});
	patchOnce(twice, "render", (orig) => function (this: any): string {
		return `${orig.call(this)}?`;
	});
	assert(twice.render() === "pi?", "patchOnce: the second load patches pi's method again, not the first patch");

	console.log("OK");
}
