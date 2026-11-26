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
	// Own property only: an instance without its own map must never read or mutate its
	// prototype's recorded originals across reloads.
	let originals = Object.hasOwn(proto, ORIGINALS_KEY) ? (proto[ORIGINALS_KEY] as Record<string, Marked>) : undefined;
	if (!originals) {
		originals = {};
		Object.defineProperty(proto, ORIGINALS_KEY, { value: originals, configurable: true });
	}
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
