// Display-name formatting shared by the footer and the header tabs.
// Lives outside `extensions/*.ts` so pi never loads it as an extension.
import { keyText } from "@earendil-works/pi-coding-agent";

export function capitalize(s: string): string {
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

// Model label pieces: titlecased id (or the given name) + capitalized provider.
export function modelDisplayParts(model?: { id?: string; name?: string; provider?: string }): { name: string; provider: string } {
	if (!model) return { name: "No Model", provider: "" };
	let name = model.name || model.id || "Model";
	const provider = capitalize(model.provider || "");
	if (name === model.id) {
		name = name
			.split(/[-_]/)
			.map((w) => capitalize(w))
			.join(" ");
	}
	if (provider && name.toLowerCase().endsWith(`(${provider.toLowerCase()})`)) {
		name = name.slice(0, name.lastIndexOf("(")).trim();
	}
	return { name, provider };
}

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
