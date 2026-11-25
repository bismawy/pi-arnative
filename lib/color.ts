/**
 * OKLCH color math — the single source of truth for theme generation
 * (`themes/gen-themes.mjs`) and the theme self-check
 * (`extensions/ui-render-tweaks.ts`). No dependencies.
 */

interface Rgb {
	r: number;
	g: number;
	b: number;
}
interface Oklch {
	L: number;
	C: number;
	H: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** `"oklch(62% 0.1 200)"` or `"oklch(0.62 0.1 200)"` -> Oklch, or null when not OKLCH. */
export function parseOklch(value: string): Oklch | null {
	const m = /^oklch\(\s*([0-9]*\.?[0-9]+)(%?)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)(?:deg)?\s*\)$/i.exec(value.trim());
	if (!m) return null;
	const raw = Number(m[1]);
	return { L: m[2] === "%" ? raw / 100 : raw, C: Number(m[3]), H: Number(m[4]) };
}

function linearFromOklab(L: number, C: number, H: number): [number, number, number] {
	const h = (H * Math.PI) / 180;
	const a = C * Math.cos(h);
	const b = C * Math.sin(h);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

const encode = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const inGamut = (rgb: readonly number[]): boolean => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** OKLCH -> sRGB, reducing chroma until the result fits sRGB. Returns the chroma actually used. */
export function oklchToRgb(L: number, C: number, H: number): Rgb & { chroma: number } {
	let used = C;
	if (!inGamut(linearFromOklab(L, C, H))) {
		let lo = 0;
		let hi = C;
		for (let i = 0; i < 24; i++) {
			const mid = (lo + hi) / 2;
			if (inGamut(linearFromOklab(L, mid, H))) lo = mid;
			else hi = mid;
		}
		used = lo;
	}
	const [r, g, b] = linearFromOklab(L, used, H).map((c) => clamp01(encode(c)));
	return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), chroma: used };
}

const oklchToHex = (L: number, C: number, H: number): string => {
	const { r, g, b } = oklchToRgb(L, C, H);
	return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
};

/** Any theme color value (hex or oklch) -> lowercase `#rrggbb`. Throws otherwise. */
export function toHex(value: string): string {
	const v = value.trim();
	if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
	if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).split("").map((c) => c + c).join("")}`.toLowerCase();
	const o = parseOklch(v);
	if (o) return oklchToHex(o.L, o.C, o.H);
	throw new Error(`Not a hex/oklch color: ${value}`);
}

/**
 * Nearest xterm-256 index for an sRGB color, mirroring `rgbToAnsi256` in
 * @earendil-works/pi-tui (`colors.ts`). pi draws every theme color through that
 * quantizer whenever the terminal is not truecolor, so a value that lands on the
 * 6x6x6 cube black renders as `#000000` no matter what the theme file declared.
 * Kept in sync by test/theme-canvas.test.ts.
 */
export function rgbToAnsi256(rgb: Rgb): number {
	const CUBE = [0, 95, 135, 175, 215, 255];
	const GRAY = Array.from({ length: 24 }, (_, i) => 8 + i * 10);
	const nearest = (values: readonly number[], v: number) =>
		values.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(values[best]! - v) ? i : best), 0);
	const distance = (a: Rgb, b: Rgb) => (a.r - b.r) ** 2 * 0.299 + (a.g - b.g) ** 2 * 0.587 + (a.b - b.b) ** 2 * 0.114;
	const [ri, gi, bi] = [rgb.r, rgb.g, rgb.b].map((c) => nearest(CUBE, c)) as [number, number, number];
	const cube = { r: CUBE[ri]!, g: CUBE[gi]!, b: CUBE[bi]! };
	const grayIndex = nearest(GRAY, Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b));
	const gray = { r: GRAY[grayIndex]!, g: GRAY[grayIndex]!, b: GRAY[grayIndex]! };
	const spread = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
	if (spread < 10 && distance(rgb, gray) < distance(rgb, cube)) return 232 + grayIndex;
	return 16 + 36 * ri + 6 * gi + bi;
}

/** `#rrggbb` -> sRGB channels. Inverse of the hex branch of {@link toHex}. */
export function hexToRgb(hex: string): Rgb {
	const v = toHex(hex);
	return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16) };
}

function relativeLuminance(hex: string): number {
	const [r, g, b] = [1, 3, 5]
		.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
	const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

/** sRGB hex -> OKLCH (seeds a theme's hue from a reference color). */
export function hexToOklch(hex: string): Oklch {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const lin = [r!, g!, b!].map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	const l = Math.cbrt(0.4122214708 * lin[0]! + 0.5363325363 * lin[1]! + 0.0514459929 * lin[2]!);
	const m = Math.cbrt(0.2119034982 * lin[0]! + 0.6806995451 * lin[1]! + 0.1073969566 * lin[2]!);
	const s = Math.cbrt(0.0883024619 * lin[0]! + 0.2817188376 * lin[1]! + 0.6299787005 * lin[2]!);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return { L, C: Math.hypot(A, B), H: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

export const __test = {
	oklchToHex,
};
