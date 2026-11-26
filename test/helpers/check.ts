// Test assertion helper shared by self-check suites and scripts/reporter.mjs.
export function assert(cond: boolean, msg: string): asserts cond {
	if (!cond) {
		throw new Error(`FAIL: ${msg}`);
	}
}
