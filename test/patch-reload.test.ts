/**
 * `/reload` regression suite: pi re-evaluates an extension module in the SAME process,
 * so every prototype patch must reinstall on the second load. A `globalThis` guard
 * installed once and froze the first load's closures — a UI fix looked broken until pi
 * restarted, and an unmarked patch could even be captured as "the original" (double box).
 *
 * Each case imports the extension twice and compares the patched slot. The slot must
 * change (reinstalled) while the recorded original stays pi's own method.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	CompactionSummaryMessageComponent,
	FooterComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("pi-arnative.patchedMethod");
const ORIGINALS = Symbol.for("pi-arnative.protoOriginals");

type Site = { name: string; module: string; proto: () => any; key: string };

const sites: Site[] = [
	{ name: "footer render", module: "../extensions/footer.ts", proto: () => FooterComponent.prototype, key: "render" },
	{
		name: "timestamp user bubble",
		module: "../extensions/timestamps.ts",
		proto: () => UserMessageComponent.prototype,
		key: "render",
	},
	{
		name: "section header addChild",
		module: "../extensions/section-headers.ts",
		proto: () => Object.getPrototypeOf(UserMessageComponent.prototype),
		key: "addChild",
	},
	{
		name: "compaction summary",
		module: "../extensions/ui-render-tweaks.ts",
		proto: () => CompactionSummaryMessageComponent.prototype,
		key: "updateDisplay",
	},
	{
		name: "tool box routing",
		module: "../extensions/tools.ts",
		proto: () => ToolExecutionComponent.prototype,
		key: "getResultRenderer",
	},
];

for (const site of sites) {
	test(`${site.name}: the patch reinstalls on reload`, async () => {
		await import(site.module);
		const proto = site.proto();
		const first = proto?.[site.key];
		assert.equal(typeof first, "function", `${site.name}: patched method exists`);
		assert.equal(first[PATCHED], true, `${site.name}: the installed method is marked`);
		assert.equal(proto[ORIGINALS][site.key][PATCHED], undefined, `${site.name}: the original is pi's own method`);

		await import(`${site.module}?reload=1`);
		const second = proto[site.key];
		assert.notEqual(second, first, `${site.name}: the second load installs a fresh patch`);
		assert.equal(second[PATCHED], true, `${site.name}: the fresh patch is marked too`);
		assert.equal(proto[ORIGINALS][site.key][PATCHED], undefined, `${site.name}: the original never becomes a patch`);
	});
}
