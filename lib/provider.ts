/**
 * Providers menu (/arnative → Providers): interactive TUI wizard for adding, probing,
 * editing, and removing custom endpoints backed by lib/provider-store.ts.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme, TUI } from "@earendil-works/pi-coding-agent";
import { buildEffortMap, isEffortProbeable, probeEffort, type ModelMeta } from "./compat.ts";
import { screenTitle, type ScreenText } from "./box.ts";
import { announce, statusRows } from "./status-widget.ts";
import { INPUT_LEGEND, InputPicker, LIST_LEGEND_MOVE, ListPicker, rowText, type ListRow } from "./list-picker.ts";
import {
	API_FLAVORS,
	FLAVOR_LABELS,
	THINKING_LEVELS,
	authPath,
	chatBaseUrl,
	deleteProviderNamed,
	detectLevel,
	guessProviderName,
	inlineKey,
	isObj,
	keyHint,
	levelToWire,
	loadModelsConfig,
	loadProviderEntry,
	mergeLevels,
	modelsPath,
	normalizeBase,
	probeEndpoint,
	providerNames,
	readAuthKey,
	readJson,
	renameAuth,
	renameProvider,
	resolveMissingMeta,
	saveProvider,
	saveProviderKey,
	seedMeta,
	summarizeProviders,
	withProviderFields,
	withProviderModels,
	writeJson,
	type ApiFlavor,
	type ProbeResult,
	type ProviderEntry,
	type ProviderModel,
	type ProviderSummary,
	type ThinkingLevel,
	type ThinkingSetting,
} from "./provider-store.ts";

export * from "./provider-store.ts";

// ---------------------------------------------------------------- wizard

const PROVIDERS_TEXT: ScreenText = {
	title: screenTitle("Providers"),
	description: "Custom endpoints: add with one probe, delete with a confirm.",
	legend: LIST_LEGEND_MOVE,
};

const ADD_ROW = "+ Add provider";

const MODEL_LEGEND = "[/] Filter  [Space] Toggle  [a] API  [Enter] Save  [Esc] Back";
const MODEL_LEGEND_LOCKED = "[/] Filter  [Space] Toggle  [Enter] Save  [Esc] Back";
/** Rows visible before the model list scrolls (a relay catalog can exceed the screen). */
const MODEL_VIEWPORT = 10;

/** One model-selection screen: Space checks rows, `a` cycles the API flavor (unless the
 *  stored api is final), `/` filters by name, Enter saves. Esc leaves without writing anything. */
const pickModels = async (
	ctx: ExtensionCommandContext,
	models: string[],
	opts: { flavor: ApiFlavor; via?: string; checked?: Set<string>; lockFlavor?: boolean },
): Promise<{ picked: string[]; flavor: ApiFlavor } | undefined> => {
	const checked = new Set(opts.checked ?? models);
	let flavor = opts.flavor;
	const rows: ListRow[] = models.map((id) => ({ label: id }));
	const picked = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
		const picker = new ListPicker(
			theme,
			rows,
			undefined,
			{
				preview: () => {},
				revert: () => {},
				done: () => done([...checked]),
				cancel: () => done(null),
				// A fill screen: `←` is hidden — it must not throw away a half-picked list.
				back: false,
				requestRender: () => tui.requestRender(),
				toggle: () => {
					const label = rows[picker.index]?.label;
					if (!label) return;
					if (checked.has(label)) checked.delete(label);
					else checked.add(label);
				},
				marked: (label) => checked.has(label),
				press: (keyData) => {
					if (opts.lockFlavor || !matchesKey(keyData, "a")) return;
					flavor = API_FLAVORS[(API_FLAVORS.indexOf(flavor) + 1) % API_FLAVORS.length]!;
				},
				description: () => `${FLAVOR_LABELS[flavor]}${opts.via ? ` · ${opts.via}` : ""}`,
				// A relay catalog is long (one had 75 ids), so the same filter line / keeps on the
				// Thinking screen narrows it here too: the count stays whole, the rows do not.
				search: "models",
				// The picked count lives in the legend, accented, next to the keys it refers to.
				legend: () =>
					`${theme.fg("accent", `${checked.size}/${models.length} picked`)}${theme.fg("dim", ` · ${opts.lockFlavor ? MODEL_LEGEND_LOCKED : MODEL_LEGEND}`)}`,
			},
			{ title: screenTitle("Models"), description: FLAVOR_LABELS[flavor], legend: opts.lockFlavor ? MODEL_LEGEND_LOCKED : MODEL_LEGEND },
			false,
			ctx.thinkingLevel,
			MODEL_VIEWPORT,
		);
		return picker;
	});
	if (!picked) return undefined;
	return { picked, flavor };
};

const readInput = async (
	ctx: ExtensionCommandContext,
	/** The arnative screen name — the box title becomes `<screen> - Arnative⠙`. */
	screen: string,
	/** What the field is, shown as the description under the title. */
	field: string,
	placeholder: string,
	initial = "",
): Promise<string | undefined> => {
	if (ctx.mode === "tui") {
		const value = await ctx.ui.custom<string | null>((tui, theme, _kb, done) =>
			new InputPicker(
				theme,
				{ title: screenTitle(screen), description: field, legend: INPUT_LEGEND },
				initial,
				{
					done: (v) => done(v),
					cancel: () => done(null),
					requestRender: () => tui.requestRender(),
				},
				placeholder,
				ctx.thinkingLevel,
			),
		);
		return value === null ? undefined : value.trim();
	}
	// No custom screens (RPC/headless): the native prompt.
	const value = await ctx.ui.input(`${screen} · ${field}`, initial || placeholder);
	return value === undefined ? undefined : value.trim();
};

/** Manual fallback when the probe found nothing: ids one at a time, a flavor question. */
const manualModels = async (ctx: ExtensionCommandContext): Promise<{ picked: string[]; flavor: ApiFlavor } | undefined> => {
	const picked: string[] = [];
	for (;;) {
		const id = await readInput(ctx, "Models", `Model id ${picked.length + 1} — empty to finish`, "paste an id");
		if (id === undefined) return undefined;
		if (id === "") break;
		picked.push(id);
	}
	if (picked.length === 0) return undefined;
	const label = await ctx.ui.select("API flavor", API_FLAVORS.map((f) => FLAVOR_LABELS[f]));
	if (label === undefined) return undefined;
	return { picked, flavor: API_FLAVORS[API_FLAVORS.map((f) => FLAVOR_LABELS[f]).indexOf(label)]! };
};

/** Transient probe status, pinned above the chat column (pi's aboveEditor widget
 *  slot) for exactly as long as the request is in flight — a one-line dim "probing
 *  endpoint…" right where the user is about to type, instead of a status row in the
 *  bottom footer. Removed the moment the probe settles. */
const PROBE_WIDGET_KEY = "arnative-probe";
function probingStatus(ctx: ExtensionCommandContext, text: string | undefined): void {
	if (!text) {
		ctx.ui.setWidget?.(PROBE_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget?.(
		PROBE_WIDGET_KEY,
		(_tui: TUI, theme: Theme) => ({
			dispose() { /* no listeners, no timers — nothing to clean up */ },
			invalidate() { /* a static line, recomputed on every render anyway */ },
			render(width: number): string[] {
				return statusRows(theme, [text], width);
			},
		}),
		{ placement: "aboveEditor" },
	);
}

const addProviderFlow = async (ctx: ExtensionCommandContext): Promise<void> => {
	const endpointRaw = await readInput(ctx, "Provider", "Endpoint API — the base URL", "https://api.example.com/v1");
	if (!endpointRaw) return;
	const endpoint = normalizeBase(endpointRaw);

	const key = await readInput(ctx, "Provider", "API key — empty for local or keyless endpoints", "sk-…");
	// Esc cancels the flow, Enter on an empty field means keyless: readInput keeps the two
	// apart (undefined vs ""), and the field's own legend promises [Esc] Back.
	if (key === undefined) return;

	const suggested = guessProviderName(endpoint);
	const nameInput = await readInput(ctx, "Provider", "a provider id (letters, digits, - and _)", suggested, suggested);
	if (nameInput === undefined) return; // Esc cancels; an empty Enter accepts the suggestion.
	const name = nameInput || suggested;
	if (!/^[A-Za-z0-9_-]+$/.test(name)) {
		ctx.ui.notify(`[arnative] "${name}" is not a usable provider id (letters, digits, - and _ only).`, "warning");
		return;
	}

	probingStatus(ctx, "probing endpoint…");
	let result: ProbeResult | undefined;
	try {
		result = await probeEndpoint(endpoint, key ?? "");
	} finally {
		probingStatus(ctx, undefined);
	}

	let picked: string[];
	let flavor: ApiFlavor;
	if (result) {
		ctx.ui.notify(`[arnative] ${FLAVOR_LABELS[result.flavor]} · ${result.via} · ${result.models.length} models.`, "info");
		if (ctx.mode === "tui") {
			const chosen = await pickModels(ctx, result.models, { flavor: result.flavor, via: result.via });
			if (!chosen) return;
			({ picked, flavor } = chosen);
		} else {
			// No custom screens (RPC/headless): the ids as one editable list, empty = all.
			const answer = await readInput(ctx, "Models", "ids comma/space separated — empty = all", "", result.models.join(", "));
			if (answer === undefined) return;
			picked = answer === "" ? result.models : answer.split(/[\s,]+/).filter(Boolean);
			flavor = result.flavor;
		}
	} else {
		ctx.ui.notify("[arnative] No model list answered. Enter ids by hand.", "warning");
		const manual = await manualModels(ctx);
		if (!manual) return;
		({ picked, flavor } = manual);
	}
	if (picked.length === 0) {
		ctx.ui.notify("[arnative] No models picked — nothing saved.", "warning");
		return;
	}

	probingStatus(ctx, "resolving context limits…");
	let resolvedMeta: Map<string, ModelMeta>;
	try {
		resolvedMeta = await resolveMissingMeta(picked, result?.meta, ctx as never);
	} finally {
		probingStatus(ctx, undefined);
	}

	const entry: ProviderEntry = {
		name,
		baseUrl: chatBaseUrl(flavor, endpoint),
		api: flavor,
		models: mergeLevels({ name, baseUrl: chatBaseUrl(flavor, endpoint), api: flavor, models: [] }, picked, resolvedMeta),
	};
	// A keyless endpoint still needs a resolvable credential for pi to list the models.
	if (!key) entry.apiKey = result?.keyless ? "ollama" : "dummy";
	try {
		saveProvider(name, entry, key || undefined);
	} catch (error) {
		ctx.ui.notify(`[arnative] Not saved: ${error instanceof Error ? error.message : "config file unreadable"}. Fix the JSON by hand first.`, "error");
		return;
	}
	ctx.ui.notify(`[arnative] Provider saved: ${name} (${FLAVOR_LABELS[flavor]}, ${picked.length} models, ${levelsSummary(entry.models)}). Open /model to pick one.`, "info");
	announce(ctx.ui, `Provider saved: ${name} (${picked.length} models).`);
};

const deleteProviderFlow = async (ctx: ExtensionCommandContext, name: string): Promise<void> => {
	const confirmed =
		ctx.mode === "tui"
			? await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
				let picker: ListPicker;
				picker = new ListPicker(
					theme,
					[{ label: "No" }, { label: "Yes" }],
					"No",
					{
						preview: () => {},
						revert: () => {},
						done: () => done(picker.index === 1),
						cancel: () => done(false),
						requestRender: () => tui.requestRender(),
					},
					{ title: screenTitle("Delete provider"), description: `${name}? The stored key goes with it.`, legend: LIST_LEGEND_MOVE },
					false,
					ctx.thinkingLevel,
				);
				return picker;
			})
			: await ctx.ui.confirm("Delete provider", `${name}? The stored key goes with it.`);
	if (confirmed !== true) return;
	try {
		ctx.ui.notify(deleteProviderNamed(name) ? `[arnative] Deleted ${name}.` : `[arnative] ${name} was already gone.`, "info");
		announce(ctx.ui, `Provider deleted: ${name}.`);
	} catch (error) {
		ctx.ui.notify(`[arnative] Not deleted: ${error instanceof Error ? error.message : "config file unreadable"}.`, "error");
	}
};

/** "3 thinking (auto, high, xhigh)" — the levels a save registered, for the notify. */
const levelsSummary = (models: ProviderModel[]): string => {
	const on = models.filter((m) => m.level && m.level !== "off");
	const distinct = [...new Set(on.map((m) => m.level!))];
	return on.length === 0 ? "0 thinking" : `${on.length} thinking (${distinct.join(", ")})`;
};

/** Writes one provider's model list through to models.json (auth.json is untouched — the
 *  key only changes through add or delete). */
type ModelRef = { provider: string; id: string };
type SetModel = (model: ModelRef) => Promise<unknown>;
type RegistryRef = { refresh(options?: { allowNetwork?: boolean }): Promise<unknown>; find(provider: string, id: string): ModelRef | undefined };

let setSessionModel: SetModel | undefined;
/** pi.setModel lives on the extension API, not on a command ctx; the extension binds it once. */
export const bindSetModel = (fn: SetModel): void => {
	setSessionModel = fn;
};

/** Load models.json into the running session. A registry refresh alone is not enough: pi keeps
 *  the session model object (and its thinkingLevelMap) until the model is picked again, so
 *  /thinking kept offering the old levels even after /reload. */
export async function reloadCurrentModel(ctx: { modelRegistry?: RegistryRef; model?: ModelRef }, setModel: SetModel | undefined = setSessionModel, signal?: AbortSignal): Promise<boolean> {
	signal?.throwIfAborted();
	const registry = ctx.modelRegistry;
	if (!registry) return false;
	const current = ctx.model;
	await registry.refresh({ allowNetwork: false });
	signal?.throwIfAborted();
	if (!current) return true;
	const fresh = registry.find(current.provider, current.id);
	if (!fresh || fresh === current) return true;
	if (!setModel) return false;
	await setModel(fresh);
	return true;
}
const saveModelsNamed = async (ctx: ExtensionCommandContext, name: string, models: ProviderModel[]): Promise<void> => {
	try {
		writeJson(modelsPath(), withProviderModels(readJson(modelsPath()), name, models));
	} catch (error) {
		ctx.ui.notify(`[arnative] Not saved: ${error instanceof Error ? error.message : "config file unreadable"}.`, "error");
		return;
	}
	ctx.ui.notify(`[arnative] ${name}: ${models.length} models, ${levelsSummary(models)} — ${(await reloadCurrentModel(ctx as never).catch(() => false)) ? "models.json updated and loaded." : "models.json updated. Pick the model again in /model to load it."}`, "info");
};

const selectModelsFlow = async (ctx: ExtensionCommandContext, name: string, entry: ProviderEntry): Promise<void> => {
	const ids = entry.models.map((m) => m.id);
	let picked: string[] | undefined;
	if (ctx.mode === "tui") {
		const chosen = await pickModels(ctx, ids, { flavor: entry.api, checked: new Set(ids), lockFlavor: true });
		if (!chosen) return;
		picked = chosen.picked;
	} else {
		const answer = await readInput(ctx, "Models", "ids comma/space — empty = keep", "", ids.join(", "));
		if (answer === undefined || answer === "") return;
		picked = answer.split(/[\s,]+/).filter(Boolean);
	}
	probingStatus(ctx, "resolving context limits…");
	let resolvedMeta: Map<string, ModelMeta>;
	try {
		resolvedMeta = await resolveMissingMeta(picked, seedMeta(entry), ctx as never);
	} finally {
		probingStatus(ctx, undefined);
	}
	await saveModelsNamed(ctx, name, mergeLevels(entry, picked, resolvedMeta));
};

const probeModelsFlow = async (ctx: ExtensionCommandContext, name: string, entry: ProviderEntry): Promise<void> => {
	// The real key lives in auth.json; a placeholder never authenticates a probe.
	const key = readAuthKey(name) ?? inlineKey(entry) ?? "";
	probingStatus(ctx, "probing endpoint…");
	let result: ProbeResult | undefined;
	try {
		result = await probeEndpoint(entry.baseUrl, key ?? "");
	} finally {
		probingStatus(ctx, undefined);
	}
	if (!result) {
		ctx.ui.notify("[arnative] The endpoint did not answer a model list (key or URL wrong?).", "warning");
		return;
	}
	ctx.ui.notify(`[arnative] ${FLAVOR_LABELS[result.flavor]} · ${result.via} · ${result.models.length} models.`, "info");
	// Vanished models stay listed (still checked) so a relay hiccup cannot shrink the set.
	const union = [...new Set([...result.models, ...entry.models.map((m) => m.id)])];
	let picked: string[] | undefined;
	if (ctx.mode === "tui") {
		const chosen = await pickModels(ctx, union, { flavor: entry.api, via: result.via, checked: new Set(entry.models.map((m) => m.id)), lockFlavor: true });
		if (!chosen) return;
		picked = chosen.picked;
	} else {
		const answer = await readInput(ctx, "Models", "ids comma/space — empty = keep", "", union.join(", "));
		if (answer === undefined || answer === "") return;
		picked = answer.split(/[\s,]+/).filter(Boolean);
	}
	probingStatus(ctx, "resolving context limits…");
	let resolvedMeta: Map<string, ModelMeta>;
	try {
		resolvedMeta = await resolveMissingMeta(picked, seedMeta(entry, result.meta), ctx as never);
	} finally {
		probingStatus(ctx, undefined);
	}
	await saveModelsNamed(ctx, name, mergeLevels(entry, picked, resolvedMeta));
};

const THINKING_LEGEND = "[/] Filter  [Space] Off/auto  [0-6] Set level  [p] Probe  [a/r] All auto/off  [Enter] Save  [Esc] Back";
// minimal … max: the efforts a map can offer; off is pi's own switch, not an effort.
const EFFORT_LEVELS = THINKING_LEVELS.slice(1);

/** The levels pi offers for a map, read the way pi reads it: a null drops a level, and
 *  xhigh and max need an entry of their own. No map is pi's default scale. */
export function offeredLevels(map: Record<string, string | null> | undefined): ThinkingLevel[] {
	return EFFORT_LEVELS.filter((l) => (map?.[l] === undefined ? l !== "xhigh" && l !== "max" : map[l] !== null));
}

/** Thinking says what each model can do; the level to use is picked per session in /thinking.
 *  Space switches a model between off (chat) and auto (reasoning). The levels auto offers come
 *  from a probe (p), from model heal, or from 1-6, which toggle minimal … max by hand for a
 *  relay that answers a probe and then ignores the effort. A pin an older version stored, or
 *  an id suffix such as -high, opens as the level list it allowed. */
const thinkingFlow = async (ctx: ExtensionCommandContext, name: string, entry: ProviderEntry): Promise<void> => {
	const levels = new Map<string, ThinkingSetting>();
	const probed = new Map<string, Record<string, string | null>>();
	for (const m of entry.models) {
		const level = m.level ?? detectLevel(m.id);
		const map = m.map ?? (level === "off" || level === "auto" ? undefined : levelToWire(level).thinkingLevelMap);
		levels.set(m.id, level === "off" ? "off" : "auto");
		if (map) probed.set(m.id, map);
	}
	let busy: string | undefined;
	let progress: string | undefined;
	let warn: string | undefined;
	let refresh: () => void = () => {};
	let closed = false;
	let probeAbort: AbortController | undefined;
	const cycle = (label: string): void => {
		levels.set(label, levels.get(label) === "off" ? "auto" : "off");
	};
	const toggleLevel = (label: string, level: ThinkingLevel): void => {
		const current = offeredLevels(probed.get(label));
		const next = current.includes(level) ? current.filter((l) => l !== level) : [...current, level];
		if (next.length === 0) {
			warn = `${label}: keep at least one level, or press Space to turn thinking off.`;
			return;
		}
		probed.set(label, buildEffortMap(next)!);
		levels.set(label, "auto");
	};
	const rows: ListRow[] = entry.models.map((m) => ({ label: m.id }));
	/** "low high max": the levels /thinking will list for the model. */
	const summary = (map: Record<string, string | null> | undefined): string => offeredLevels(map).join(" ");
	const probe = async (label: string): Promise<void> => {
		const model = entry.models.find((m) => m.id === label);
		const compat = model?.compat ?? {};
		if (!isEffortProbeable({ provider: name, id: label, api: entry.api, baseUrl: entry.baseUrl, reasoning: true, compat }, compat)) {
			warn = `${label}: this channel does not take a probing request (not an OpenAI-compatible reasoning model).`;
			return;
		}
		busy = label;
		progress = "starting…";
		probeAbort?.abort();
		const controller = new AbortController();
		probeAbort = controller;
		refresh();
		try {
			const supported = await probeEffort(
				{ provider: name, id: label, api: entry.api, baseUrl: entry.baseUrl, reasoning: true, compat },
				{
					baseUrl: entry.baseUrl,
					key: readAuthKey(name) ?? inlineKey(entry),
					signal: controller.signal,
					onLevel: (level, _accepted, index) => {
						progress = `${level} · ${index + 1}/7`;
						refresh();
					},
				},
			);
			if (controller.signal.aborted) return;
			if (supported.length === 0) {
				warn = `${label}: no effort level answered — the map is unchanged.`;
				return;
			}
			const next = buildEffortMap(supported)!;
			probed.set(label, next);
			levels.set(label, "auto");
			warn = `${label}: accepts ${summary(next)}.`;
		} catch (err) {
			if (!controller.signal.aborted) throw err;
		} finally {
			if (probeAbort === controller) probeAbort = undefined;
			busy = undefined;
			progress = undefined;
			refresh();
		}
	};
	let saved: boolean;
	if (ctx.mode === "tui") {
		const outcome = await ctx.ui.custom<boolean | null>((tui, theme, _kb, done) => {
			refresh = () => {
				if (!closed) tui.requestRender();
			};
			const close = (value: boolean | null) => {
				closed = true;
				probeAbort?.abort();
				done(value);
			};
			const picker = new ListPicker(
				theme,
				rows,
				undefined,
				{
					preview: () => {},
					revert: () => {},
					// A probe is a round trip, but it never owns the screen: leaving mid-probe just
					// discards the answer, because the save reads `probed` before it lands.
					done: () => close(true),
					cancel: () => close(null),
					// A fill screen: `←` is hidden — it must not throw away half-set levels.
					back: false,
					requestRender: () => refresh(),
					toggle: () => {
						const label = rows[picker.index]?.label;
						if (label && !busy) cycle(label);
					},
					press: (keyData) => {
						if (busy) return;
						// Letters reach here only outside the filter (/ toggles typing), so the commands are
						// plain keys. Neither bulk key clears a map: it is what the model accepts.
						if (matchesKey(keyData, "a") || matchesKey(keyData, "r")) {
							const to = matchesKey(keyData, "a") ? "auto" : "off";
							for (const id of levels.keys()) levels.set(id, to);
							refresh();
							return;
						}
						const label = rows[picker.index]?.label;
						if (!label) return;
						if (keyData === "0") {
							probed.set(label, buildEffortMap([...EFFORT_LEVELS])!);
							levels.set(label, "auto");
							refresh();
							return;
						}
						const digit = EFFORT_LEVELS.findIndex((_l, i) => keyData === String(i + 1));
						if (digit !== -1) {
							toggleLevel(label, EFFORT_LEVELS[digit]!);
							refresh();
							return;
						}
						if (matchesKey(keyData, "p")) void probe(label);
					},
					note: (label) => {
						if (busy === label) return `probing ${progress ?? ""}`.trim();
						return levels.get(label) === "auto" ? `auto · ${summary(probed.get(label))}` : "off";
					},
					description: () => "0 all · 1-6 minimal low medium high xhigh max · / filter, / or Enter done",
					search: "models",
					legend: () =>
						`${theme.fg("accent", `${[...levels.values()].filter((l) => l !== "off").length}/${rows.length} thinking`)}${theme.fg("dim", ` · ${THINKING_LEGEND}`)}`,
				},
				{ title: screenTitle("Thinking"), description: "levels each model accepts — p probes, 1-6 toggle by hand", legend: THINKING_LEGEND },
				false,
				ctx.thinkingLevel,
				MODEL_VIEWPORT,
			);
			return picker;
		});
		saved = outcome === true;
	} else {
		// No custom screens (RPC/headless): `id:off`, `id:auto` or `id:low+high+max`.
		const current = [...levels].map(([id, l]) => `${id}:${l === "off" ? "off" : probed.has(id) ? offeredLevels(probed.get(id)).join("+") : "auto"}`);
		const answer = await readInput(ctx, "Thinking", "id:off, id:auto or id:low+high+max — empty = cancel", "", current.join(", "));
		if (answer === undefined || answer === "") return;
		for (const pair of answer.split(/[\s,]+/).filter(Boolean)) {
			const [id, value] = pair.split(":");
			if (!id || !value || !levels.has(id)) continue;
			if (value === "off" || value === "auto") {
				levels.set(id, value);
				continue;
			}
			const list = value.split("+").filter((l) => (EFFORT_LEVELS as string[]).includes(l));
			if (list.length === 0) continue;
			probed.set(id, buildEffortMap(list)!);
			levels.set(id, "auto");
		}
		saved = true;
	}
	if (!saved) return;
	await saveModelsNamed(
		ctx,
		name,
		entry.models.map((m) => {
			const level = levels.get(m.id);
			const map = level === "off" ? undefined : probed.get(m.id);
			return { id: m.id, level, ...(map ? { map } : {}) };
		}),
	);
	if (warn) ctx.ui.notify(`[arnative] ${warn}`, "info");
};

const ACTION_EDIT = "Edit";
const ACTION_SELECT = "Select models";
const ACTION_PROBE = "Probe models";
const ACTION_THINKING = "Thinking";
const ACTION_DELETE = "Delete";

const EDIT_BASE = "Base URL";
const EDIT_NAME = "Provider name";
const EDIT_KEY = "API key";

const ACTIONS_DESCRIPTION = "Edit the endpoint, key or models, re-probe, or delete.";

/** One menu row picker shared by the action and edit menus: Enter returns the row's label,
 *  `←` and Esc return undefined (the caller decides what that leaves for). */
const chooseRow = async (ctx: ExtensionCommandContext, title: string, description: string, rows: ListRow[]): Promise<string | undefined> => {
	if (ctx.mode !== "tui") {
		const picked = await ctx.ui.select(title, rows.map(rowText));
		if (picked === undefined) return undefined;
		// Labels are distinct prefixes of their own flat row, so `startsWith` is unambiguous.
		return rows.find((r) => picked.startsWith(r.label))?.label;
	}
	const chosen = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const picker = new ListPicker(
			theme,
			rows,
			undefined,
			{
				preview: () => {},
				revert: () => {},
				done: () => done(rows[picker.index]?.label),
				cancel: () => done(null),
				// `←` leaves this menu for its parent; Esc closes the screen it is on.
				back: () => done(null),
				requestRender: () => tui.requestRender(),
			},
			{ title: screenTitle(title), description, legend: LIST_LEGEND_MOVE },
			false,
			ctx.thinkingLevel,
		);
		return picker;
	});
	return chosen ?? undefined;
};

/** One field written through to models.json, with the notify that says what landed. */
const saveField = (ctx: ExtensionCommandContext, name: string, patch: Record<string, string | undefined>, note: string): void => {
	try {
		writeJson(modelsPath(), withProviderFields(readJson(modelsPath()), name, patch));
	} catch (error) {
		ctx.ui.notify(`[arnative] Not saved: ${error instanceof Error ? error.message : "config file unreadable"}.`, "error");
		return;
	}
	ctx.ui.notify(`[arnative] ${note}`, "info");
};

/** Base URL: stored exactly as typed (normalized only for a bare host). The flavor's own
 *  `/v1` rewriting stays in the add flow — an edit must land what the user wrote. */
const editBaseUrlFlow = async (ctx: ExtensionCommandContext, name: string, entry: ProviderEntry): Promise<void> => {
	const value = await readInput(ctx, "Edit", "Base URL — the endpoint pi calls (include /v1 for OpenAI-style)", "https://api.example.com/v1", entry.baseUrl);
	// Esc cancels; an emptied field keeps what is stored rather than blanking the endpoint.
	if (!value) return;
	const baseUrl = normalizeBase(value);
	if (baseUrl === entry.baseUrl) return;
	saveField(ctx, name, { baseUrl }, `${name}: base URL is now ${baseUrl}. Run Probe models to re-read its list.`);
};

/** Provider id: the models.json key and the auth.json credential move together, so the key
 *  never ends up under an id no provider answers to. Returns the id to keep using. */
const editNameFlow = async (ctx: ExtensionCommandContext, name: string): Promise<string> => {
	const value = await readInput(ctx, "Edit", "provider id (letters, digits, - and _)", name, name);
	if (!value || value === name) return name;
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		ctx.ui.notify(`[arnative] "${value}" is not a usable provider id (letters, digits, - and _ only).`, "warning");
		return name;
	}
	if (providerNames(loadModelsConfig()).includes(value)) {
		ctx.ui.notify(`[arnative] "${value}" is already a provider — pick another id.`, "warning");
		return name;
	}
	const auth = readJson(authPath());
	const holdsKey = isObj(auth) && isObj(auth[name]);
	try {
		if (holdsKey) writeJson(authPath(), renameAuth(auth, name, value));
		try {
			writeJson(modelsPath(), renameProvider(readJson(modelsPath()), name, value));
		} catch (error) {
			// Put the credential back where the old id still looks for it.
			if (holdsKey) writeJson(authPath(), auth);
			throw error;
		}
	} catch (error) {
		ctx.ui.notify(`[arnative] Not renamed: ${error instanceof Error ? error.message : "config file unreadable"}.`, "error");
		return name;
	}
	ctx.ui.notify(`[arnative] Renamed ${name} → ${value}. Open /model to refresh.`, "info");
	announce(ctx.ui, `Provider renamed: ${name} → ${value}.`);
	return value;
};

/** API key: written to auth.json (the store pi prefers over an inline models.json key), so
 *  a literal key leaves models.json instead of being stored twice. */
const editKeyFlow = async (ctx: ExtensionCommandContext, name: string, entry: ProviderEntry): Promise<void> => {
	const stored = readAuthKey(name) ?? inlineKey(entry);
	const field = stored ? `API key — stored ${keyHint(stored)}, empty keeps it` : "API key — empty for a keyless endpoint";
	const value = await readInput(ctx, "Edit", field, "sk-…");
	if (!value) return;
	try {
		saveProviderKey(name, value);
	} catch (error) {
		ctx.ui.notify(`[arnative] Not saved: ${error instanceof Error ? error.message : "config file unreadable"}.`, "error");
		return;
	}
	ctx.ui.notify(`[arnative] ${name}: API key replaced (${keyHint(value)}). Open /model to refresh.`, "info");
	announce(ctx.ui, `API key replaced: ${name} (${keyHint(value)}).`);
};

/** The Edit menu: one field per row, each write immediate. Returns the provider id to keep
 *  using — a rename changes it, and every later action follows the new one. */
const editFlow = async (ctx: ExtensionCommandContext, name: string): Promise<string> => {
	let id = name;
	for (;;) {
		const entry = loadProviderEntry(loadModelsConfig(), id);
		if (!entry) {
			ctx.ui.notify(`[arnative] ${id} is gone — the list will refresh.`, "warning");
			return id;
		}
		const key = readAuthKey(id) ?? inlineKey(entry);
		const rows: ListRow[] = [
			{ label: EDIT_BASE, note: entry.baseUrl || "not set" },
			{ label: EDIT_NAME, note: id },
			{ label: EDIT_KEY, note: key ? keyHint(key) : "not set" },
		];
		const action = await chooseRow(ctx, `Edit · ${id}`, "one field per row — each saves on Enter", rows);
		if (!action) return id;
		if (action === EDIT_BASE) await editBaseUrlFlow(ctx, id, entry);
		else if (action === EDIT_NAME) id = await editNameFlow(ctx, id);
		else await editKeyFlow(ctx, id, entry);
	}
};

/** Enter on an existing provider: an action menu instead of a straight delete. Every
 *  action writes through to models.json (and auth.json for edit, rename and delete) before
 *  returning. */
const providerActionFlow = async (ctx: ExtensionCommandContext, name: string): Promise<void> => {
	let id = name;
	for (;;) {
		const entry = loadProviderEntry(loadModelsConfig(), id);
		if (!entry) {
			ctx.ui.notify(`[arnative] ${id} is gone — the list will refresh.`, "warning");
			return;
		}
		const rows: ListRow[] = [
			{ label: ACTION_EDIT, note: "base URL, provider name, API key" },
			{ label: ACTION_SELECT, note: "tick the models this provider exposes" },
			{ label: ACTION_PROBE, note: "re-read the model list from the endpoint" },
			{ label: ACTION_THINKING, note: "toggle reasoning per model (auto-detected)" },
			{ label: ACTION_DELETE, note: "remove the provider and its stored key" },
		];
		const action = await chooseRow(ctx, `Provider · ${id}`, ACTIONS_DESCRIPTION, rows);
		if (!action) return;
		if (action === ACTION_DELETE) {
			await deleteProviderFlow(ctx, id);
			return;
		}
		if (action === ACTION_EDIT) id = await editFlow(ctx, id);
		else if (action === ACTION_SELECT) await selectModelsFlow(ctx, id, entry);
		else if (action === ACTION_PROBE) await probeModelsFlow(ctx, id, entry);
		else if (action === ACTION_THINKING) await thinkingFlow(ctx, id, entry);
	}
};

/** The Providers screen: existing entries as rows, add as the last row. `←` reopens the
 *  settings menu, like every screen; after an add or a delete the list reopens. */
export const openProviders = async (ctx: ExtensionCommandContext): Promise<boolean | void> => {
	/** Provider rows re-read from models.json; empty means the file turned unreadable. */
	const refresh = (): ListRow[] => {
		let summaries: ProviderSummary[];
		try {
			summaries = summarizeProviders(loadModelsConfig());
		} catch {
			ctx.ui.notify("[arnative] models.json is not valid JSON — fix it by hand first.", "error");
			return [];
		}
		const rows: ListRow[] = summaries.map((s) => ({
			label: s.name,
			note: `${s.api ?? "unknown api"} · ${s.modelCount} model${s.modelCount === 1 ? "" : "s"}`,
		}));
		rows.push({ label: ADD_ROW, note: "endpoint, key, name — the rest is automatic" });
		return rows;
	};

	const rows = refresh();
	if (rows.length === 0) return;

	const choose = async (label: string | undefined): Promise<void> => {
		if (label === ADD_ROW) await addProviderFlow(ctx);
		else if (label) await providerActionFlow(ctx, label);
	};

	if (ctx.mode !== "tui") {
		// No custom screens (RPC/headless): the blocking picker, `rowText` as the flat label.
		const picked = await ctx.ui.select(PROVIDERS_TEXT.title, rows.map(rowText));
		if (picked === undefined) return;
		// Provider ids are [A-Za-z0-9_-], so a `startsWith` on the flat row is unambiguous.
		const label = rows.find((r) => picked.startsWith(r.label))?.label;
		await choose(label);
		return;
	}

	for (;;) {
		const index = await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
			const picker = new ListPicker(theme, rows, undefined, {
				preview: () => {},
				revert: () => {},
				done: () => done(picker.index),
				cancel: () => done(null),
				// `←` steps back to the settings menu; Esc closes for good.
				back: () => done(-1),
				requestRender: () => tui.requestRender(),
			}, PROVIDERS_TEXT, false, ctx.thinkingLevel);
			return picker;
		});
		if (index === null || index === undefined) return;
		if (index === -1) return true;
		await choose(rows[index]?.label);
		// A provider may have been added, edited or deleted: re-read the list instead of
		// showing the copy the screen opened with. An unreadable models.json keeps the old
		// rows up rather than blanking the screen.
		const fresh = refresh();
		if (fresh.length > 0) {
			rows.length = 0;
			rows.push(...fresh);
		}
	}
};

export const __test = {
	PROVIDERS_TEXT,
	ADD_ROW,
	MODEL_LEGEND,
	levelsSummary,
};
