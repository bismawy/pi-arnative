#!/usr/bin/env node
/**
 * Generator varian tema arnative.
 *
 * Sumber kebenaran STRUKTUR = `themes/arnative.json` (berkas itu sendiri = tema
 * default, tidak pernah ditulis ulang di sini). Sumber kebenaran PALET = tabel
 * PALET di bawah. Berkas varian ditulis dengan substitusi teks pada base, jadi
 * format asli (tab + baris kosong pengelompokan) tetap sama persis.
 *
 *   node themes/gen-themes.mjs           tulis ulang semua varian
 *   node themes/gen-themes.mjs --check   gagal bila berkas di disk beda hasil generate
 *
 * Validasi warna (kontras, kelengkapan kunci) ada di self-check
 * `extensions/ui-render-tweaks.ts` supaya tidak ada dua sumber aturan.
 */
import { readFileSync, writeFileSync } from "node:fs";

const baseUrl = new URL("arnative.json", import.meta.url);
const baseText = readFileSync(baseUrl, "utf8");
const base = JSON.parse(baseText);

// Setiap tema wajib mengisi SEMUA kunci ini (supaya tak ada warna yang diam-diam
// mewarisi base dan lolos dari pemeriksaan visual).
const KUNCI_VARS = [
	"accent", "cyan", "blue", "green", "red", "yellow", "text", "gray", "dimGray", "darkGray",
	"softCyan", "selectedBg", "userMsgBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "customMsgBg",
];
const KUNCI_COLORS = [
	"customMessageLabel", "mdHeading", "mdLink",
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
	"syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
	"thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
];
const KUNCI_EXPORT = ["pageBg", "cardBg", "infoBg"];

/**
 * Palet per tema. `vars.cyan`/`vars.blue` = borderAccent/border, `vars.softCyan` = tint,
 * `vars.green/red/yellow` = semantik success/error/warning + diff.
 */
const PALET = {
	// --- varian hue dasar (sejak awal) -------------------------------------
	"arnative-sun": {
		vars: {
			accent: "#ffb454", cyan: "#ffd166", blue: "#da9b2f", green: "#b5bd68", red: "#cc6666",
			yellow: "#ffff00", text: "#d4d4d4", gray: "#808080", dimGray: "#666666", darkGray: "#505050",
			softCyan: "#ceb07e", selectedBg: "#484032", userMsgBg: "#312d25", toolPendingBg: "#29251f",
			toolSuccessBg: "#202828", toolErrorBg: "#3c2828", customMsgBg: "#2e281f",
		},
		colors: {
			customMessageLabel: "#9575cd", mdHeading: "#f0c674", mdLink: "#81a2be",
			syntaxComment: "#6A9955", syntaxKeyword: "#569CD6", syntaxFunction: "#DCDCAA",
			syntaxVariable: "#9CDCFE", syntaxString: "#CE9178", syntaxNumber: "#B5CEA8",
			syntaxType: "#4EC9B0", syntaxOperator: "#D4D4D4", syntaxPunctuation: "#D4D4D4",
			thinkingMinimal: "#5f4e30", thinkingLow: "#80673c", thinkingMedium: "#aa8950",
			thinkingHigh: "#e1a741", thinkingXhigh: "#f2b54a",
		},
		export: { pageBg: "#18181e", cardBg: "#1e1e24", infoBg: "#3c3728" },
	},
	"arnative-zinc": {
		vars: {
			accent: "#a1a1aa", cyan: "#c4c4cc", blue: "#6b6b75", green: "#b5bd68", red: "#cc6666",
			yellow: "#ffff00", text: "#d4d4d4", gray: "#808080", dimGray: "#666666", darkGray: "#505050",
			softCyan: "#a2a0ab", selectedBg: "#3b3a40", userMsgBg: "#2a292e", toolPendingBg: "#232225",
			toolSuccessBg: "#202828", toolErrorBg: "#3c2828", customMsgBg: "#23222a",
		},
		colors: {
			customMessageLabel: "#9575cd", mdHeading: "#f0c674", mdLink: "#81a2be",
			syntaxComment: "#6A9955", syntaxKeyword: "#569CD6", syntaxFunction: "#DCDCAA",
			syntaxVariable: "#9CDCFE", syntaxString: "#CE9178", syntaxNumber: "#B5CEA8",
			syntaxType: "#4EC9B0", syntaxOperator: "#D4D4D4", syntaxPunctuation: "#D4D4D4",
			thinkingMinimal: "#3d3d44", thinkingLow: "#595962", thinkingMedium: "#6e6e78",
			thinkingHigh: "#96969f", thinkingXhigh: "#b8b8c2",
		},
		export: { pageBg: "#18181e", cardBg: "#1e1e24", infoBg: "#3c3728" },
	},
	"arnative-violet": {
		vars: {
			accent: "#a78bfa", cyan: "#c4b5fd", blue: "#8b6ef5", green: "#b5bd68", red: "#cc6666",
			yellow: "#ffff00", text: "#d4d4d4", gray: "#808080", dimGray: "#666666", darkGray: "#505050",
			softCyan: "#a99ad6", selectedBg: "#393248", userMsgBg: "#292531", toolPendingBg: "#221f29",
			toolSuccessBg: "#202828", toolErrorBg: "#3c2828", customMsgBg: "#292240",
		},
		colors: {
			customMessageLabel: "#9575cd", mdHeading: "#f0c674", mdLink: "#81a2be",
			syntaxComment: "#6A9955", syntaxKeyword: "#569CD6", syntaxFunction: "#DCDCAA",
			syntaxVariable: "#9CDCFE", syntaxString: "#CE9178", syntaxNumber: "#B5CEA8",
			syntaxType: "#4EC9B0", syntaxOperator: "#D4D4D4", syntaxPunctuation: "#D4D4D4",
			thinkingMinimal: "#413364", thinkingLow: "#614899", thinkingMedium: "#765cb2",
			thinkingHigh: "#8f6ef0", thinkingXhigh: "#a98bfa",
		},
		export: { pageBg: "#18181e", cardBg: "#1e1e24", infoBg: "#3c3728" },
	},
	"arnative-emerald": {
		vars: {
			accent: "#6ee7b7", cyan: "#a7f3d0", blue: "#34b98a", green: "#b5bd68", red: "#cc6666",
			yellow: "#ffff00", text: "#d4d4d4", gray: "#808080", dimGray: "#666666", darkGray: "#505050",
			softCyan: "#7eceaf", selectedBg: "#324840", userMsgBg: "#25312d", toolPendingBg: "#1f2925",
			toolSuccessBg: "#202828", toolErrorBg: "#3c2828", customMsgBg: "#1f3028",
		},
		colors: {
			customMessageLabel: "#9575cd", mdHeading: "#f0c674", mdLink: "#81a2be",
			syntaxComment: "#6A9955", syntaxKeyword: "#569CD6", syntaxFunction: "#DCDCAA",
			syntaxVariable: "#9CDCFE", syntaxString: "#CE9178", syntaxNumber: "#B5CEA8",
			syntaxType: "#4EC9B0", syntaxOperator: "#D4D4D4", syntaxPunctuation: "#D4D4D4",
			thinkingMinimal: "#305f4d", thinkingLow: "#3c8066", thinkingMedium: "#50aa87",
			thinkingHigh: "#41e1a4", thinkingXhigh: "#4af2b2",
		},
		export: { pageBg: "#18181e", cardBg: "#1e1e24", infoBg: "#3c3728" },
	},

	// --- tema bernuansa kuat ----------------------------------------------
	// Hijau fosfor monokrom di kanvas hampir hitam.
	"arnative-matrix": {
		vars: {
			accent: "#00ff41", cyan: "#8dffab", blue: "#1f8f4f", green: "#47ff7a", red: "#ff5555",
			yellow: "#ffe066", text: "#ccffd8", gray: "#6f9f7f", dimGray: "#4f7f5f", darkGray: "#2f4f3a",
			softCyan: "#58e07a", selectedBg: "#10452a", userMsgBg: "#0a1410", toolPendingBg: "#060f0b",
			toolSuccessBg: "#0b2413", toolErrorBg: "#2a0d0d", customMsgBg: "#08160f",
		},
		colors: {
			customMessageLabel: "#8dffab", mdHeading: "#00ff41", mdLink: "#8dffab",
			syntaxComment: "#4f8f5f", syntaxKeyword: "#00ff41", syntaxFunction: "#9dffb4",
			syntaxVariable: "#d6ffdf", syntaxString: "#2fbf5f", syntaxNumber: "#7dffa0",
			syntaxType: "#3fe07a", syntaxOperator: "#b6ffc4", syntaxPunctuation: "#9dffb4",
			thinkingMinimal: "#1f4a2c", thinkingLow: "#2c7a45", thinkingMedium: "#3fae63",
			thinkingHigh: "#59d97f", thinkingXhigh: "#00ff41",
		},
		export: { pageBg: "#050a06", cardBg: "#0a1410", infoBg: "#123018" },
	},
	// Neon magenta/cyan/kuning di kanvas indigo pekat.
	"arnative-cyberpunk": {
		vars: {
			accent: "#ff2e97", cyan: "#00f0ff", blue: "#2a7fd4", green: "#00ff9f", red: "#ff4d6d",
			yellow: "#ffe600", text: "#eaeaf5", gray: "#8b88a8", dimGray: "#6f6a9a", darkGray: "#4a4763",
			softCyan: "#7fd8f0", selectedBg: "#2b2350", userMsgBg: "#16131f", toolPendingBg: "#0d0b16",
			toolSuccessBg: "#0d2430", toolErrorBg: "#33121f", customMsgBg: "#1a1329",
		},
		colors: {
			customMessageLabel: "#00f0ff", mdHeading: "#ffe600", mdLink: "#00f0ff",
			syntaxComment: "#6f6a9a", syntaxKeyword: "#00f0ff", syntaxFunction: "#ffe600",
			syntaxVariable: "#ffd9f2", syntaxString: "#ff2e97", syntaxNumber: "#ff9a3c",
			syntaxType: "#00ff9f", syntaxOperator: "#c8c8e8", syntaxPunctuation: "#9a96c0",
			thinkingMinimal: "#33285c", thinkingLow: "#4d3a94", thinkingMedium: "#7a4fd6",
			thinkingHigh: "#b84fe8", thinkingXhigh: "#ff4fc3",
		},
		export: { pageBg: "#0d0b16", cardBg: "#16131f", infoBg: "#3a2a10" },
	},
	// Retro 80-an: ungu tua, pink neon, cyan.
	"arnative-synthwave": {
		vars: {
			accent: "#ff7edb", cyan: "#36f9f6", blue: "#7a5fd6", green: "#72f1b8", red: "#ff5f7e",
			yellow: "#fede5d", text: "#f2eafb", gray: "#9b8fb8", dimGray: "#848bbd", darkGray: "#55496e",
			softCyan: "#c3b1f0", selectedBg: "#443a63", userMsgBg: "#2a2138", toolPendingBg: "#1f1830",
			toolSuccessBg: "#1f2e29", toolErrorBg: "#331a2a", customMsgBg: "#2e1f3d",
		},
		colors: {
			customMessageLabel: "#36f9f6", mdHeading: "#fede5d", mdLink: "#36f9f6",
			syntaxComment: "#848bbd", syntaxKeyword: "#fede5d", syntaxFunction: "#36f9f6",
			syntaxVariable: "#f2eafb", syntaxString: "#ff8b39", syntaxNumber: "#f97e72",
			syntaxType: "#ff7edb", syntaxOperator: "#f2eafb", syntaxPunctuation: "#b8a6e8",
			thinkingMinimal: "#4a3a6b", thinkingLow: "#6b4f9e", thinkingMedium: "#9166d6",
			thinkingHigh: "#d47ee8", thinkingXhigh: "#ff7edb",
		},
		export: { pageBg: "#1f1830", cardBg: "#2a2138", infoBg: "#443a63" },
	},
	// Retro hangat: kanvas abu kecoklatan, emas + aqua + merah bata.
	"arnative-gruvbox": {
		vars: {
			accent: "#fabd2f", cyan: "#8ec07c", blue: "#83a598", green: "#b8bb26", red: "#fb4934",
			yellow: "#fabd2f", text: "#ebdbb2", gray: "#a89984", dimGray: "#928374", darkGray: "#665c54",
			softCyan: "#d5c4a1", selectedBg: "#504945", userMsgBg: "#32302f", toolPendingBg: "#1d2021",
			toolSuccessBg: "#2a3225", toolErrorBg: "#3a2a26", customMsgBg: "#3c3836",
		},
		colors: {
			customMessageLabel: "#d3869b", mdHeading: "#fabd2f", mdLink: "#83a598",
			syntaxComment: "#928374", syntaxKeyword: "#fb4934", syntaxFunction: "#b8bb26",
			syntaxVariable: "#83a598", syntaxString: "#b8bb26", syntaxNumber: "#d3869b",
			syntaxType: "#fabd2f", syntaxOperator: "#ebdbb2", syntaxPunctuation: "#d5c4a1",
			thinkingMinimal: "#665c54", thinkingLow: "#a89984", thinkingMedium: "#d5c4a1",
			thinkingHigh: "#fabd2f", thinkingXhigh: "#fe8019",
		},
		export: { pageBg: "#1d2021", cardBg: "#282828", infoBg: "#3c3836" },
	},
	// Dingin & tenang ala Nord: frost blue + aurora.
	"arnative-nord": {
		vars: {
			accent: "#88c0d0", cyan: "#8fbcbb", blue: "#5e81ac", green: "#a3be8c", red: "#c87880",
			yellow: "#ebcb8b", text: "#eceff4", gray: "#9aa5b5", dimGray: "#7b869b", darkGray: "#4c566a",
			softCyan: "#bcd3e0", selectedBg: "#434c5e", userMsgBg: "#3b4252", toolPendingBg: "#2e3440",
			toolSuccessBg: "#333f38", toolErrorBg: "#3f2f33", customMsgBg: "#38404f",
		},
		colors: {
			customMessageLabel: "#b48ead", mdHeading: "#ebcb8b", mdLink: "#88c0d0",
			syntaxComment: "#64728c", syntaxKeyword: "#81a1c1", syntaxFunction: "#88c0d0",
			syntaxVariable: "#d8dee9", syntaxString: "#a3be8c", syntaxNumber: "#b48ead",
			syntaxType: "#8fbcbb", syntaxOperator: "#81a1c1", syntaxPunctuation: "#eceff4",
			thinkingMinimal: "#4c566a", thinkingLow: "#5e81ac", thinkingMedium: "#81a1c1",
			thinkingHigh: "#88c0d0", thinkingXhigh: "#8fbcbb",
		},
		export: { pageBg: "#272c36", cardBg: "#2e3440", infoBg: "#3b4252" },
	},
	// Ungu gelap klasik: pink + cyan + hijau mint.
	"arnative-dracula": {
		vars: {
			accent: "#bd93f9", cyan: "#8be9fd", blue: "#6272a4", green: "#50fa7b", red: "#ff5555",
			yellow: "#f1fa8c", text: "#f8f8f2", gray: "#8b93b8", dimGray: "#6272a4", darkGray: "#4a4e63",
			softCyan: "#c9b8f2", selectedBg: "#44475a", userMsgBg: "#343746", toolPendingBg: "#21222c",
			toolSuccessBg: "#26332e", toolErrorBg: "#3a2430", customMsgBg: "#383a52",
		},
		colors: {
			customMessageLabel: "#ff79c6", mdHeading: "#f1fa8c", mdLink: "#8be9fd",
			syntaxComment: "#6272a4", syntaxKeyword: "#ff79c6", syntaxFunction: "#50fa7b",
			syntaxVariable: "#8be9fd", syntaxString: "#f1fa8c", syntaxNumber: "#bd93f9",
			syntaxType: "#8be9fd", syntaxOperator: "#ff79c6", syntaxPunctuation: "#f8f8f2",
			thinkingMinimal: "#464a5d", thinkingLow: "#6272a4", thinkingMedium: "#7a6fd0",
			thinkingHigh: "#bd93f9", thinkingXhigh: "#ff79c6",
		},
		export: { pageBg: "#21222c", cardBg: "#282a36", infoBg: "#44475a" },
	},
};

/** Substitusi teks pada base; tiap target wajib muncul tepat sekali. */
function render(nama, palet) {
	let out = baseText;
	const tukar = (oldS, newS, apa) => {
		const n = out.split(oldS).length - 1;
		if (n !== 1) throw new Error(`${nama}: ${apa} "${oldS}" muncul ${n}x (harus 1)`);
		out = out.replace(oldS, newS);
	};

	tukar(`"name": ${JSON.stringify(base.name)}`, `"name": ${JSON.stringify(nama)}`, "name");
	for (const [bagian, kunci, wajib] of [
		["vars", palet.vars, KUNCI_VARS],
		["colors", palet.colors, KUNCI_COLORS],
		["export", palet.export, KUNCI_EXPORT],
	]) {
		const kurang = wajib.filter((k) => !(k in kunci));
		const lebih = Object.keys(kunci).filter((k) => !wajib.includes(k));
		if (kurang.length || lebih.length) {
			throw new Error(`${nama}/${bagian}: kurang [${kurang}] lebih [${lebih}]`);
		}
		for (const k of wajib) {
			const lama = base[bagian][k];
			if (lama === undefined) throw new Error(`${nama}: base.${bagian}.${k} tidak ada`);
			tukar(`"${k}": ${JSON.stringify(lama)}`, `"${k}": ${JSON.stringify(kunci[k])}`, `${bagian}.${k}`);
		}
	}
	return out;
}

const cek = process.argv.includes("--check");
let gagal = 0;
for (const nama of Object.keys(PALET)) {
	const isi = render(nama, PALET[nama]);
	const berkas = new URL(`${nama}.json`, import.meta.url);
	if (cek) {
		let lama = null;
		try {
			lama = readFileSync(berkas, "utf8");
		} catch {}
		if (lama !== isi) {
			console.error(`BEDA: themes/${nama}.json`);
			gagal++;
		}
	} else {
		writeFileSync(berkas, isi);
		console.log(`tulis themes/${nama}.json`);
	}
}
if (cek) {
	if (gagal) {
		console.error(`${gagal} tema tidak sinkron dengan generator (jalankan: node themes/gen-themes.mjs)`);
		process.exit(1);
	}
	console.log(`OK: ${Object.keys(PALET).length} tema sinkron dengan generator`);
}
