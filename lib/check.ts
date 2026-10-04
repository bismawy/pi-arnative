// Self-check helpers shared by every module's `node <file>` block.
// Lives outside `extensions/*.ts` so pi never loads it as an extension.
import { pathToFileURL } from "node:url";
export function assert(cond: boolean, msg: string): asserts cond {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
}

export function isMain(url: string): boolean {
	const argv = process.argv[1];
	if (!argv) return false;
	// Compare canonical file URLs: string `endsWith` broke on paths with spaces or
	// other characters that `import.meta.url` percent-encodes, silently skipping the check.
	try {
		return pathToFileURL(argv).href === url;
	} catch {
		return url.endsWith(argv.split("\\").join("/"));
	}
}
