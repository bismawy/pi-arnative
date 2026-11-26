// Display-name formatting shared by the footer and the header tabs.
// Lives outside `extensions/*.ts` so pi never loads it as an extension.
import { keyText } from "@earendil-works/pi-coding-agent";

export function capitalize(s: string): string {
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

// Model label pieces: clean model name + capitalized provider with optional route segment
// (e.g. "Gemini 4 Neon" + "Magpie/agy-cli" for remote/agy-cli/gemini-4-neon).
export function modelDisplayParts(model?: { id?: string; name?: string; provider?: string }): { name: string; provider: string } {
	if (!model) return { name: "No Model", provider: "" };
	const baseProvider = capitalize(model.provider || "");
	const idParts = (model.id || "").split("/").filter(Boolean);
	const prefixParts = idParts.length > 1 ? idParts.slice(0, -1) : [];
	let route = "";
	if (prefixParts.length > 0) {
		if (prefixParts[0]!.toLowerCase() === "remote" && prefixParts.length > 1) {
			route = prefixParts[1]!;
		} else {
			const kept = prefixParts.slice(0, 2);
			route = kept.length === 1 && kept[0]!.toLowerCase() === baseProvider.toLowerCase() ? "" : kept.join("/");
		}
	}

	let name = model.name || model.id || "Model";
	if (name === model.id) {
		const leaf = idParts[idParts.length - 1] || name;
		name = leaf
			.split(/[-_]/)
			.map((w) => capitalize(w))
			.join(" ");
	} else {
		// Magpie / proxy names append verbose metadata with " · " (e.g. "Gemini 4 Neon · Antigravity (local agy CLI) · Remote").
		name = name.split(" · ")[0]!.trim() || name;
	}
	if (baseProvider && name.toLowerCase().endsWith(`(${baseProvider.toLowerCase()})`)) {
		name = name.slice(0, name.lastIndexOf("(")).trim();
	}
	const provider = baseProvider && route ? `${baseProvider}/${route}` : baseProvider || route;
	return { name, provider };
}

// Divider between a picker row label and its note (Label · note), shared by every /arnative list.
export const ROW_DIVIDER = " · ";

// Picker rows for every /arnative list (themes, header & footer presets):
// `● name` marks the active entry, everything else gets a two-space indent.
export function markedLabels(names: readonly string[], current: string | undefined): string[] {
	return names.map((n) => `${n === current ? "● " : "  "}${n}`);
}

// Expand-hint key follows the active keybinding; outside a pi session keyText() is empty.
export function expandKeyName(): string {
	try {
		return keyText("app.tools.expand") || "ctrl+o";
	} catch {
		return "ctrl+o";
	}
}
