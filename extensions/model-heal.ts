/**
 * Model heal trigger: runs the passes in lib/model-heal.ts with no command.
 
 * Triggers: session_start, model_select, a change to models.json (debounced watcher), and an
 * assistant error that names a rejected parameter (pi's auto-retry would otherwise burn its
 * attempts on the same bad effort level). /model-heal forces every pass now, ignoring TTLs.
 
 * Mode (/arnative -> Model heal): Full = flags + network passes, Flags = offline flags
 * only, Off = nothing. While pi-auto-compat is installed this module defers to it and says so
 * once, so two healers never write models.json at the same time.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { assert, isMain } from "../lib/check.ts";
import { REJECTION_RE } from "../lib/compat.ts";
import { activeModelHeal, autoCompatInstalled, healEffort, healFlags, healMeta, type HealDeps, type HealResult, type ModelHealChoice, type RtModel } from "../lib/model-heal.ts";

interface RegistryLike {
	getAll?: () => unknown[];
	refresh?: (options?: { allowNetwork?: boolean }) => Promise<unknown>;
	getRegisteredProviderConfig?: (provider: string) => unknown;
}

interface AssistantMessage {
	role?: string;
	provider?: string;
	model?: string;
	errorMessage?: string;
}

const DEBOUNCE_MS = 800;
const WIDGET_MS = 10_000;

const registryOf = (ctx: unknown): RegistryLike | undefined => (ctx as { modelRegistry?: RegistryLike } | undefined)?.modelRegistry;

/** The session's view of the registry, in the shape the passes take. An extension that
 *  supplies its own model list owns it: only modelOverrides reaches the merged model. */
export function depsFor(ctx: unknown): HealDeps {
	const registry = registryOf(ctx);
	return {
		models: () => (registry?.getAll?.() ?? []).filter((m): m is RtModel => !!m && typeof m === "object"),
		ownsModels: (provider) => {
			try {
				const cfg = registry?.getRegisteredProviderConfig?.(provider) as { models?: unknown; refreshModels?: unknown } | undefined;
				return !!cfg && typeof cfg === "object" && (Array.isArray(cfg.models) || typeof cfg.refreshModels === "function");
			} catch {
				return false;
			}
		},
	};
}

/** Only a parameter rejection says the level on the wire is wrong; auth, quota and
 *  transport errors cost no probe. */
export function isRejectedParam(message: AssistantMessage | undefined): boolean {
	if (!message || message.role !== "assistant" || !message.provider || !message.model) return false;
	return REJECTION_RE.test(message.errorMessage ?? "");
}

/** Whether a pass may run: Off runs nothing, Flags runs only the offline flags pass, Full runs
 *  everything, and an installed pi-auto-compat owns models.json in every mode. */
export function healAllowed(need: "Flags" | "Full", mode: ModelHealChoice, autoCompat: boolean): boolean {
	if (autoCompat || mode === "Off") return false;
	return need === "Flags" || mode === "Full";
}

/** The one-time hand-over notice: only when heal is wanted and pi-auto-compat holds the file. */
export const deferNotice = (mode: ModelHealChoice, autoCompat: boolean): boolean => mode !== "Off" && autoCompat;

export default function registerModelHeal(pi: ExtensionAPI): void {
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let widgetTimer: ReturnType<typeof setTimeout> | undefined;
	let deferNoticeShown = false;

	// ctx getters throw once the session was replaced or reloaded, and deferred callbacks
	// (timer, watcher, network passes) can outlive it: capture ui while live, guard dismissal.
	function notify(ctx: ExtensionContext, lines: string[]): void {
		let ui: ExtensionContext["ui"] | undefined;
		try {
			ui = ctx.ui;
			ui?.setWidget?.("model-heal", lines.map((line) => "model-heal: " + line));
		} catch {
			return;
		}
		if (widgetTimer) clearTimeout(widgetTimer);
		widgetTimer = setTimeout(() => {
			widgetTimer = undefined;
			try {
				ui?.setWidget?.("model-heal", undefined);
			} catch {
				// session replaced while the widget was up
			}
		}, WIDGET_MS);
	}

	async function apply(ctx: ExtensionContext, label: string, result: HealResult): Promise<void> {
		if (!result.changed) return;
		let refreshed = true;
		try {
			await registryOf(ctx)?.refresh?.({ allowNetwork: false });
		} catch {
			refreshed = false;
		}
		notify(ctx, [label + " (" + result.detail.length + " change(s))" + (refreshed ? "" : " - run /reload to load it")]);
	}

	const enabled = (need: "Flags" | "Full"): boolean => healAllowed(need, activeModelHeal(), autoCompatInstalled());

	function runFlags(ctx: ExtensionContext, only?: RtModel[]): void {
		if (!enabled("Flags")) return;
		try {
			const result = healFlags(depsFor(ctx), only, ctx.model as RtModel | undefined);
			void apply(ctx, "flags healed", result).catch(() => undefined);
		} catch {
			// stale ctx: the next session_start runs the pass again
		}
	}

	function runNetwork(ctx: ExtensionContext, force: boolean): void {
		if (!enabled("Full")) return;
		let deps: HealDeps;
		try {
			deps = depsFor(ctx);
		} catch {
			return;
		}
		void healMeta(deps, force).then((r) => apply(ctx, "limits synced", r)).catch(() => undefined);
		void healEffort(deps, force).then((r) => apply(ctx, "thinking levels probed", r)).catch(() => undefined);
	}

	function stopWatcher(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		try {
			watcher?.close();
		} catch {
			// already closed
		}
		watcher = undefined;
	}

	function startWatcher(ctx: ExtensionContext): void {
		stopWatcher();
		try {
			// A pass's own write fires this too; the re-run finds nothing to change.
			watcher = watch(join(getAgentDir(), "models.json"), { persistent: false }, () => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					timer = undefined;
					runFlags(ctx);
				}, DEBOUNCE_MS);
			});
		} catch {
			// models.json missing or not watchable
		}
	}

	pi.on("session_start", (_event, ctx) => {
		stopWatcher();
		if (deferNotice(activeModelHeal(), autoCompatInstalled())) {
			if (!deferNoticeShown) notify(ctx, ["pi-auto-compat is installed, so it heals models.json. Uninstall it to hand over to pi-arnative."]);
			deferNoticeShown = true;
			return;
		}
		runFlags(ctx);
		if (enabled("Flags")) startWatcher(ctx);
		runNetwork(ctx, false);
	});

	pi.on("model_select", (event, ctx) => {
		const model = (event as { model?: RtModel } | undefined)?.model;
		runFlags(ctx, model ? [model] : undefined);
		runNetwork(ctx, false); // TTL-gated: network only when a channel is stale
	});

	pi.on("message_end", (event, ctx) => {
		const message = (event as { message?: AssistantMessage } | undefined)?.message;
		if (!isRejectedParam(message) || !enabled("Full")) return;
		try {
			const deps = depsFor(ctx);
			const target = deps.models().find((m) => m.provider.toLowerCase() === message!.provider!.toLowerCase() && m.id === message!.model);
			if (!target) return;
			void healEffort(deps, true, [target]).then((r) => apply(ctx, "thinking levels re-probed", r)).catch(() => undefined);
		} catch {
			// stale ctx
		}
	});

	pi.on("session_shutdown", () => {
		stopWatcher();
		if (widgetTimer) clearTimeout(widgetTimer);
		widgetTimer = undefined;
	});

	registerCommands(pi, (_args, ctx) => healNow(ctx));
}

/** Every pass now, ignoring TTLs: the /model-heal command and the /arnative Run now row. */
export async function healNow(ctx: ExtensionContext): Promise<void> {
	if (autoCompatInstalled()) {
		ctx.ui.notify("[arnative] pi-auto-compat is installed and heals models.json. Run /auto-compat, or uninstall it to use model heal.", "warning");
		return;
	}
	const deps = depsFor(ctx);
	const flags = healFlags(deps, undefined, ctx.model as RtModel | undefined);
	const meta = await healMeta(deps, true);
	const effort = await healEffort(deps, true);
	const detail = [...flags.detail, ...meta.detail, ...effort.detail];
	const errors = [...flags.errors, ...meta.errors, ...effort.errors];
	if (detail.length > 0) {
		await registryOf(ctx)?.refresh?.({ allowNetwork: false }).catch(() => undefined);
		ctx.ui.notify("[arnative] Model heal fixed:\n  - " + detail.join("\n  - "), "info");
		return;
	}
	ctx.ui.notify(
		errors.length ? "[arnative] Model heal: nothing to fix; " + errors.length + " endpoint(s) unreachable: " + errors.join("; ") : "[arnative] Model heal: nothing to fix.",
		errors.length ? "warning" : "info",
	);
}

function registerCommands(pi: ExtensionAPI, runNow: (args: string, ctx: ExtensionContext) => Promise<void>): void {
	const description = "Heal models.json now: compat flags, contextWindow/maxTokens from each /models, accepted thinking efforts";
	pi.registerCommand("model-heal", { description, handler: runNow });
	// Migration alias: keeps the old habit working once pi-auto-compat is uninstalled.
	if (!autoCompatInstalled()) pi.registerCommand("auto-compat", { description: description + " (alias of /model-heal)", handler: runNow });
}

if (isMain(import.meta.url)) {
	assert(isRejectedParam({ role: "assistant", provider: "r", model: "m", errorMessage: "400 invalid reasoning_effort" }), "a rejected effort triggers a re-probe");
	assert(!isRejectedParam({ role: "assistant", provider: "r", model: "m", errorMessage: "401 unauthorized" }), "an auth failure costs no probe");
	assert(!isRejectedParam({ role: "user", provider: "r", model: "m", errorMessage: "bad request" }), "only assistant messages count");
	assert(!isRejectedParam(undefined), "no message, no probe");
	assert(healAllowed("Flags", "Full", false) && healAllowed("Full", "Full", false), "Full runs every pass");
	assert(healAllowed("Flags", "Flags", false) && !healAllowed("Full", "Flags", false), "Flags runs only the offline pass");
	assert(!healAllowed("Flags", "Off", false) && !healAllowed("Full", "Off", false), "Off runs nothing");
	assert(!healAllowed("Flags", "Full", true) && !healAllowed("Flags", "Flags", true), "an installed pi-auto-compat owns the file");
	assert(deferNotice("Full", true) && deferNotice("Flags", true), "the hand-over notice shows while heal is wanted");
	assert(!deferNotice("Off", true) && !deferNotice("Full", false), "and stays quiet when Off or nothing to defer to");
	const owned = depsFor({ modelRegistry: { getAll: () => [{ provider: "x", id: "a" }, null], getRegisteredProviderConfig: (p: string) => (p === "ext" ? { refreshModels: () => [] } : undefined) } });
	assert(owned.models().length === 1, "non-object registry entries are dropped");
	assert(owned.ownsModels("ext") && !owned.ownsModels("x"), "an extension list with refreshModels owns its models");
	const throwing = depsFor({ modelRegistry: { getRegisteredProviderConfig: () => { throw new Error("stale"); } } });
	assert(!throwing.ownsModels("x") && throwing.models().length === 0, "a stale registry reads as empty");
	console.log("model-heal extension self-check OK");
}
