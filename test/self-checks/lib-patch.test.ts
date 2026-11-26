import test from "node:test";
import { assert } from "../helpers/check.ts";
import { markPatched, originalOf, patchOnce } from "../../lib/patch.ts";

test("lib/patch.ts self-check", async () => {
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

	// Instance vs prototype isolation: recording an original on a child object must never
	// overwrite its prototype's recorded original.
	class Parent {
		render(): string { return "parent"; }
	}
	patchOnce(Parent.prototype, "render", (orig) => function (this: any): string {
		return `[${orig.call(this)}]`;
	});
	const child = new Parent() as any;
	child.render = () => "stale-instance";
	patchOnce(child, "render", (orig) => function (this: any): string {
		return `(${orig.call(this)})`;
	});
	patchOnce(Parent.prototype, "render", (orig) => function (this: any): string {
		return `<${orig.call(this)}>`;
	});
	assert(new Parent().render() === "<parent>", "prototype original stays untouched when a child instance is patched");
	assert(child.render() === "(stale-instance)", "instance keeps its own recorded original");

});
