/**
 * Single Pi extension entry point for @bismawy/pi-arnative.
 *
 * Pi's loader evaluates each file listed in `pi.extensions` with an isolated
 * jiti instance (`moduleCache: false`). Composing all features from one entry
 * point keeps a single module graph per load/reload instead of recompiling
 * shared `lib/` modules up to 14 times.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAnimations from "../lib/features/animations.ts";
import registerArnative from "../lib/features/arnative.ts";
import registerAutoCompact from "../lib/features/autocompact.ts";
import registerBudget from "../lib/features/budget.ts";
import registerFooter from "../lib/features/footer.ts";
import registerModelHeal from "../lib/features/model-heal.ts";
import registerRenderCache from "../lib/features/render-cache.ts";
import registerSectionHeaders from "../lib/features/section-headers.ts";
import registerTimestamps from "../lib/features/timestamps.ts";
import registerTodos from "../lib/features/todos.ts";
import registerTools from "../lib/features/tools.ts";
import registerUiRenderTweaks from "../lib/features/ui-render-tweaks.ts";
import registerUsageExport from "../lib/features/usage-export.ts";
import registerUsage from "../lib/features/usage.ts";

const FEATURES: readonly ((pi: ExtensionAPI) => void)[] = [
	registerTools,
	registerSectionHeaders,
	registerFooter,
	registerTimestamps,
	registerUiRenderTweaks,
	registerRenderCache,
	registerUsage,
	registerUsageExport,
	registerBudget,
	registerAnimations,
	registerAutoCompact,
	registerModelHeal,
	registerTodos,
	registerArnative,
];

export default function registerPiArnative(pi: ExtensionAPI): void {
	for (const register of FEATURES) {
		register(pi);
	}
}
