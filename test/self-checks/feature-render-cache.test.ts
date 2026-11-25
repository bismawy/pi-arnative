import test from "node:test";
import { assert } from "../helpers/check.ts";
import { Text } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RENDER_CACHE_KEY, loadChoice, resetPresetCache } from "../../lib/preset-store.ts";
import { RENDER_CACHE_CHOICES, activeRenderCache, setRenderCache, attachChatContainer, type ChatContainerLike, __test } from "../../lib/features/render-cache.ts";

const { RENDER_CACHE_CONFIG_KEY, SCROLL_OFFSET_KEY } = __test;

test("lib/features/render-cache.ts self-check", async () => {
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

	// Use a known Text prototype to exercise cache policy without loading a theme.
	function makeChild(text: string) {
		const child = Object.assign(new Text(text, 0, 0), { renders: 0, isStreaming: false, isPartial: false, expanded: false });
		const setText = child.setText.bind(child);
		child.setText = (next: string): void => { text = next; setText(next); };
		const result = Object.assign(child, {
			handleInput(key: string): void { child.setText(`${text}:${key}`); },
		});
		result.render = (width: number): string[] => { result.renders += 1; return [`${text}@${width}`]; };
		return result as typeof result & { [key: symbol]: unknown };
	}
	type FakeChild = ReturnType<typeof makeChild>;
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
	const c1 = makeChild("msg1");
	const c2 = makeChild("msg2");
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
	assert(
		container.childLines?.width === 80 &&
			container.childLines.children.length === 2 &&
			container.childLines.parts.length === 2 &&
			container.childLines.lines === out2,
		"Pi 1.6.0+ childLines preserved on container hit",
	);

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
});
