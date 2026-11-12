import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getUsage, piCacheHit } from "../extensions/footer.ts";

let now = Date.now();
beforeEach((t) => {
	now += 5000;
	t.mock.method(Date, "now", () => now);
});

function message(input: number, output = 0, cacheRead = 0): AssistantMessage {
	return {
		role: "assistant", api: "openai-completions", provider: "fixture", model: "m", content: [], timestamp: now, stopReason: "stop",
		usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

const usage = (sessionManager: Pick<SessionManager, "getBranch">): string =>
	getUsage({ sessionManager, getContextUsage: () => undefined }, (text) => text, (text) => text);

test("equal-length native branches do not share their cached prefix", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(message(100));
	const a = manager.appendMessage(message(200));
	manager.resetLeaf();
	manager.appendMessage(message(900));
	const b = manager.appendMessage(message(1000));
	manager.branch(a);
	assert.equal(usage(manager), "↑300");
	manager.branch(b);
	assert.equal(usage(manager), "↑1.9k");
	manager.branch(a);
	assert.equal(usage(manager), "↑300");
});

test("two native session managers cannot share a same-length cache", () => {
	const first = SessionManager.inMemory();
	first.appendMessage(message(400));
	first.appendMessage(message(600));
	const second = SessionManager.inMemory();
	second.appendMessage(message(100));
	second.appendMessage(message(300));
	assert.equal(usage(first), "↑1k");
	assert.equal(usage(second), "↑400");
});

test("a new session on the same manager invalidates its usage prefix", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(message(100));
	manager.appendMessage(message(200));
	assert.equal(usage(manager), "↑300");
	manager.newSession();
	manager.appendMessage(message(900));
	manager.appendMessage(message(1000));
	assert.equal(usage(manager), "↑1.9k");
});

test("stream mutations update the cached tail without counting it twice", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(message(100, 20, 50));
	const tail = message(200, 30, 50);
	manager.appendMessage(tail);
	assert.match(usage(manager), /↑300.*↓50/);
	tail.usage.input = 800;
	tail.usage.output = 80;
	tail.usage.cacheRead = 200;
	assert.match(usage(manager), /↑900.*↓100/);
	assert.equal(piCacheHit(), "pi 21.7%");
	assert.match(usage(manager), /↑900.*↓100/);
	tail.usage.input = 900;
	assert.match(usage(manager), /↑1k.*↓100/);
	assert.equal(piCacheHit(), "pi 20.0%");
});

test("cache-hit metrics follow the selected native branch", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(message(100, 200, 300));
	const a = manager.appendMessage(message(200, 100));
	manager.resetLeaf();
	manager.appendMessage(message(700, 100, 1000));
	const b = manager.appendMessage(message(400, 200, 100));
	manager.branch(a);
	assert.match(usage(manager), /↑300.*↓300/);
	assert.equal(piCacheHit(), "pi 50.0%");
	manager.branch(b);
	assert.match(usage(manager), /↑1.1k.*↓300/);
	assert.equal(piCacheHit(), "pi 50.0%");
});

test("appended entries invalidate the cache and expiry still rescans the prefix", () => {
	const manager = SessionManager.inMemory();
	const first = message(100);
	manager.appendMessage(first);
	manager.appendMessage(message(200));
	assert.equal(usage(manager), "↑300");
	manager.appendMessage(message(300));
	assert.equal(usage(manager), "↑600");
	first.usage.input = 500;
	now += 2001;
	assert.equal(usage(manager), "↑1k");
});

test("lightweight contexts with rebuilt entries still report current totals", () => {
	let input = 100;
	const manager = { getBranch: () => [{ type: "message", message: message(input) }] };
	assert.equal(usage(manager as Pick<SessionManager, "getBranch">), "↑100");
	input = 700;
	assert.equal(usage(manager as Pick<SessionManager, "getBranch">), "↑700");
});
