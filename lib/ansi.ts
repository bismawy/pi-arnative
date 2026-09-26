/** Probe escape latar tema: kode pembuka bg (tanpa reset penutup \x1b[49m). */
export function ansiBgOpen(th: { bg?(color: string, text: string): string } | null, color: string): string {
	if (!th?.bg) return "";
	try {
		const probe = th.bg(color, "");
		const reset = "\x1b[49m";
		return probe.endsWith(reset) ? probe.slice(0, -reset.length) : probe;
	} catch {
		return "";
	}
}

// Self-check: `node lib/ansi.ts`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/"))) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`FAIL: ${msg}`);
			process.exit(1);
		}
	};
	assert(ansiBgOpen(null, "selectedBg") === "", "tanpa tema: kosong");
	assert(ansiBgOpen({ bg: (_c, t) => `\x1b[48;2;9;9;9m${t}\x1b[49m` }, "selectedBg") === "\x1b[48;2;9;9;9m", "probe bg tanpa reset");
	console.log("lib/ansi.ts OK");
}
