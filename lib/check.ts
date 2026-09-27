// Self-check helpers shared by every module's `node <file>` block.
// Lives outside `extensions/*.ts` so pi never loads it as an extension.
export function assert(cond: boolean, msg: string): asserts cond {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
}

export function isMain(url: string): boolean {
	return Boolean(process.argv[1] && url.endsWith(process.argv[1].split("\\").join("/")));
}
