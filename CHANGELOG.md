# Changelog

## [Unreleased]

### Added
- **Task list: `todo` tool, boxed widget and `/todos`.** Replaces `@juicesharp/rpiv-todo`, so uninstall that package first (both register the `todo` tool). The widget collapses to one boxed row naming the task in progress; clicking it in fullscreen mode, or `alt+o` in any mode, expands it to five rows around the active task, with `↑ n more` / `↓ n more` for the rest, `✓` / `◉` / `◌` status glyphs and the in-progress note in dim. The heading icon and `✓` are accent, `◉` borrows the footer's model-name colour (`mdHeading`, accent when a theme omits it), `◌` is dim. Click a counter row, or press `alt+j` / `alt+k`, to scroll the five-row window one task at a time; the window parks at either end and returns to the active task after a mutation. The box never exceeds pi's 10-line widget budget, and the expand hint survives a narrow terminal by cutting the task name instead. The list is per session in `<agent>/arnative/todos/<session id>.json`, written with the same in-place fallback as the preset store so a refused Windows replace cannot lose it; `/todos` lists every task in the arnative screen chrome, in progress first (`lib/todos.ts`, `extensions/todos.ts`, `test/todos.test.ts`).

## [0.8.2] - 2026-10-28

### Changed
- **Test output uses the arnative glyphs.** Those marks come from Node, not from this repo: the built-in `spec` reporter paints `U+2714 U+2716 U+2139 U+26F3` and a direct `node --test` has no hook to restyle it. `scripts/reporter.mjs` replaces the reporter instead, emitting `U+2713` pass, `U+2717` fail, `U+1F6C8` summary and `U+2691` file-level failure, with the assertion message and stack kept. `npm test` passes `--test-reporter=./scripts/reporter.mjs`; `NODE_OPTIONS=--test-reporter=./scripts/reporter.mjs node --test` applies it to every run. A failing run still exits non-zero (verified with a temporary failing test).

### Fixed
- **`/reload` applies every patch now, in all five patched files.** `footer.ts` (2-line footer), `timestamps.ts` (bubble clock), `section-headers.ts` (loaded-resources tabs) and `ui-render-tweaks.ts` (reload box, selection colors, accent pill, select rows, package box, status widget, compaction line) sat behind `globalThis` guards, so only the first load's closures were ever installed and a UI fix needed a full pi restart. `lib/patch.ts` holds the one implementation: pi's method is recorded on the prototype under a symbol, every installed patch is marked, and each module reinstalls on load. `test/patch-reload.test.ts` imports all five modules twice and fails if a slot keeps the old patch (proven by temporarily restoring the guard: 2/5 fail).
- **No double box after `/reload`.** The reinstall captured the previous arnative patch as "the original", so the new patch wrapped its box around the old one (`✓ memory_write` inside a box inside a box, two `✓` on one row). Only an unmarked method is now taken as the original, and the self-check re-imports the module and asserts one box per call (`extensions/tools.ts`).
- **`/reload` now applies renderer changes.** Both `ToolExecutionComponent` prototype patches (gap strip, box/boxed-renderer routing) sat behind a `globalThis` guard. That flag survives extension reload, so only the first load's closures were ever installed and a UI fix needed a full pi restart. The originals now live on the prototype under a symbol and the patches reinstall on every module load; the self-check re-imports the module once to pin it (`extensions/tools.ts`).
- **MCP calls keep the arnative box.** pi-mcp-adapter ≥ 2.3x defaults to `toolResultRendering: "compact"`, and that mode declares `renderShell: "self"` while painting flat text (`mcp call x @ y`, no border). The generic boxing predicate read `self` as "this tool draws its own box", so every MCP call and result fell back to that flat line. The MCP names now stay boxed whatever shell they declare, and the `mcp`/`mcp__<server>` call box names the invoked tool (`✓ mcp cloudflare_execute @ cloudflare`) instead of reusing the adapter's flat line. Verified through `ToolExecutionComponent` in the self-check (`extensions/tools.ts`).

## [0.8.1] - 2026-10-26

### Changed
- **`/providers` is its own command.** The provider screen was reachable only as `/arnative providers`; it now also answers to `/providers`, through the same handler, so the two cannot drift. Both are registered in `registerCommands` and the self-check pins the set (`extensions/arnative.ts`).
- **Status rows above the chat column now use the arnative mark and the theme's `dim` token.** pi renders a `setWidget` string array as unstyled `Text`, so every status line (model heal, the provider probe, other extensions' `setWidget` calls) landed in the default foreground. A render patch turns those arrays into a component factory that receives the live theme: the `\ueb1b` mark leads the block with one space, rows align under it, and a row another extension already painted keeps its own colour (an error row stays red). `lib/status-widget.ts`.

### Fixed
- **The Extensions tab lists packages, not every module inside them.** The header used to print one row per loaded entry point (`@bismawy/pi-arnative@0.8.0:footer.ts`, `:model-heal.ts`, …), so a twelve-module package filled the box on its own. The `:subpath` is dropped and each package appears once with its version — the count matches what `pi list` shows. Local single-file extensions (`hark.ts`) are unchanged (`extensions/section-headers.ts`, `extractItemsFromBody`).

## [0.8.0] - 2026-10-26

### Added
- **Model heal keeps `models.json` correct with no command (adopted from pi-auto-compat).** On `session_start`, `model_select`, a change to `models.json` (debounced watcher) and an assistant error that names a rejected parameter, three passes run on the rules the provider wizard already uses: flags (missing compat flags and a default `thinkingLevelMap`, offline), meta (`contextWindow`/`maxTokens` from each channel's `GET /models`, 6 h TTL, unit anomalies rejected, caps clamped to the window) and effort (the `reasoning_effort` levels a relay accepts, remapped to the nearest accepted one, 24 h TTL). Each pass is one read-modify-write that writes only real differences: an explicit value (even `false`) is never overwritten, a hand-edited network value stays manual, a user-shaped map is never probed, a corrupt file is reported and never rewritten, and the first write keeps a backup. Channel-wide flags land at provider level; extension-owned providers are fixed through `modelOverrides`. `/arnative` → **Model heal** picks `Full` (default), `Flags` (offline only) or `Off`; `/model-heal` forces every pass now, and `/auto-compat` stays as an alias once pi-auto-compat is uninstalled. While pi-auto-compat is still installed, pi-arnative defers to it and says so once, so two healers never write the same file. State lives in `<agent>/arnative/model-heal.json` (`lib/model-heal.ts`, `extensions/model-heal.ts`).
- **Auto-compact keeps long sessions light.** `/arnative` → **Auto-compact** picks **Smart** — a tier table by context window (≥768k→20%, ≥384k→40%, ≥192k→80%, below 192k→pi core; every tier lands the trigger near the same ~200k-token transcript ceiling) — or a **manual token budget** (`100k`–`400k`, one absolute number for any window). When a run settles with the context at or above the threshold, pi's own compaction fires through `ctx.compact()` — the same machinery and summary as `/compact`, never mid-run. Small windows defer entirely: a 128k model keeps pi's near-full `reserveTokens` compaction untouched. The saved choice is marked with a green ✓ at the end of its picker row. Guards: no re-trigger while a compaction runs, a growth-margin wait (5% of the threshold) after an attempt that freed too little or failed (usage oscillating at the threshold cannot re-summarize every turn), and a full reset on session start (`extensions/autocompact.ts`).
- **The push gate hook now ships with the repo.** `.githooks/pre-push` is the pre-push gate the README describes (it used to live only in a machine-local setup): it rejects a branch push whose tip tree does not match the `.git/arnative-preview` stamp that `npm run preview` writes, so a fix cannot reach GitHub without a live preview. Tags and branch deletions pass; activate per clone with `git config core.hooksPath .githooks`.
- **Providers now write the limits and compat flags the endpoint implies.** The wizard already read the `/models` answer to list ids and threw the rest away; the same answer now also supplies each model's `contextWindow`/`maxTokens` (kept through later edits that never mention them) and a `compat` block the rules imply — developer-role off for reasoning models on a third-party OpenAI-compatible channel, session-affinity headers, Anthropic cache control on Claude-style relays, deepseek thinking format, adaptive thinking on Opus/Sonnet ≥ 4.6 and Fable ≥ 5 — while any value already in `models.json` still wins (`lib/compat.ts`, `suggestCompat`; `lib/provider.ts`, `wireModels`).
- **Thinking screen: `p` asks the channel which effort levels it accepts.** A 7-request probe per model sends `none`…`max`, records what answers, and stores the result as that model's `thinkingLevelMap` — a rejected level is remapped to the nearest accepted one, so `/think` offers only real levels instead of discovering them one 400 at a time. The result is the map itself, so it stays until the level is changed by hand; a channel that answers nothing writes nothing (`lib/compat.ts`, `probeEffort`/`buildEffortMap`; `lib/provider.ts`, `thinkingFlow`). The screen also gains two bulk keys: `[A]` sets every model to `auto` and `[R]` sets every model to `off`, in memory only, so Esc still discards and Enter saves.

### Changed
- **Thinking now starts at `auto` for every model.** The provider wizard's id heuristic used to fall back to `off`, so a relay catalog with no effort suffix in its ids saved every model as chat and the Thinking screen showed almost nothing to do. The fallback is now `auto` (`reasoning: true`, no `thinkingLevelMap`), so `/think` passes the level straight to the endpoint for all of them; an explicit `-high`/`-xhigh`/`-max`/`-medium`/`-low`/`-minimal` suffix still pins that level, and Space in the Thinking screen still sets a model to `off` by hand (`lib/provider.ts`, `detectLevel`).

### Fixed
- **The preview gate launches pi again on Windows.** `scripts/preview.mjs` spawned `pi` directly, which Node cannot do on Windows — the npm launcher is a sh script (ENOENT) or a `.cmd` (needs a shell) — so `npm run preview` crashed before pi ever opened and no push could ever be stamped. It now resolves the real entry (`where pi` → the global npm dir → `dist/bundle/cli.js`) and runs it with Node directly, args unquoted and intact; POSIX behavior is unchanged (`pi` still spawns directly when that works).
- **Large-session render cost: the per-frame patches are bounded now.** Both render patches scaled with the whole transcript on every frame, which made long sessions (a 1M-context model past ~20%) feel heavy in the terminal. The reload-box scan ran inside every `Container.render` — measured at 0.76 ms against pi's own 0.59 ms layout pass at 12.6k lines — and now refuses containers larger than 64 lines before scanning, because the reload box is a fixed ~9-line container (`extensions/ui-render-tweaks.ts`, `shouldHideReloadBox`). The user-bubble bg repair rebuilt every styled line on every frame and is now memoized per source line — pi's Markdown cache returns the same string references frame after frame — reset on a theme change and capped at 8192 entries (`extensions/timestamps.ts`, `repairBubbleBg`).

## [0.7.0] - 2026-10-24

### Added
- **Providers: a custom endpoint from three inputs.** `/arnative` → **Providers** asks for the endpoint URL, API key, and name, then probes the endpoint once (Ollama `/api/tags`, Gemini `/v1beta/models`, OpenAI/Anthropic `/models` lists), lists the models it answered with, and saves on Space-picked selection — the key into `auth.json` (the file `/login` writes), the declaration into `models.json`. `[a]` switches the API flavor when a relay answers in an ambiguous shape; no answer falls back to manual ids. Opening `/model` picks up the saved provider (`extensions/provider.ts`).
- **Provider actions: edit and delete on Enter.** Enter on a stored provider opens an action menu — Select models, Probe models (re-reads the endpoint, vanished models stay listed), Thinking, Delete. Every action writes through to `models.json` immediately (delete also removes the `auth.json` key); sibling provider fields like `compat` survive every edit.
- **Reasoning auto-detection.** Model ids decide the thinking flag on save: a `thinking`/`reasoner` token, an effort suffix (`-high`/`-medium`/`-low`), or an o1/o3/o4/r1-style generation marks reasoning models — `ag/claude-opus-4-6-thinking` and `ag/gemini-4-argon-high` on, `wally/glm-5.3-flash` off. The Thinking screen lists the flags with the detected values and Space overrides them.
- **Thinking levels on pi's full scale.** The Thinking screen no longer toggles a boolean: Space cycles each model through `off → auto → minimal → low → medium → high → xhigh → max`, detected from the id (an explicit `-high`/`-xhigh`/`-max`… suffix pins that level; a `thinking`/`reasoner`/o1/r1 token means `auto`). Levels write pi's own wire shape — `reasoning: true` plus a `thinkingLevelMap` that pins exactly the supported level — so `/think` offers the model's real levels and clamps to them (`xhigh`/`max` only appear when mapped, exactly as pi's schema defines).
- **Scrolling model lists.** The shared picker gains a 10-row viewport: long relay catalogs scroll a window centered on the cursor, with `↑ N more` / `↓ N more` rows announcing what is hidden, so the box keeps one height (`lib/list-picker.ts`).
- **Picked count in the models legend.** The models picker footer reads `34/44 picked · [↑↓] Move …` with the count in the accent color, next to the keys it describes (`lib/box.ts` renders a pre-styled legend verbatim).
- **Back where it belongs.** `←` works in submenus only: the provider list steps back to the `/arnative` menu, the provider actions step back to the list, and every settings screen keeps its `[←] Back` legend. The root menu hides the key entirely (`back: false`) — it has nothing behind it, so Esc and `q` stay the only closes and its legend reads `[↑↓] Move  [Enter] Open  [Esc] Close`. Fill screens (model pick, thinking levels) hide it too, so a stray `←` cannot throw away a half-picked list.
- **The provider list reflects its own edits.** After adding, editing or deleting a provider, the Providers screen re-reads `models.json` instead of showing the copy it opened with — a new provider appears immediately, no `/arnative` round-trip.
- **Wizard prompts in the arnative box.** Every text field the provider wizard asks for (endpoint, key, name, manual ids, headless fallbacks) renders as an arnative screen: rounded thinking-colored border, `Provider - Arnative⠙` title, the field as the description, a `> ` prompt with the pi-tui editor underneath (arrows, word motions, paste, undo all work), a dim example while empty, and the `[Enter] Save  [Esc] Cancel` legend — replacing pi's full-width native input dialog (`lib/list-picker.ts`, `InputPicker`).
- **Probe status above the chat input.** While the wizard probes an endpoint (add flow and the Probe models action), a one-line dim `probing endpoint…` appears directly above the chat input (pi's `setWidget` aboveEditor slot) and disappears the moment the probe settles — no longer a status row in the bottom footer (`lib/provider.ts`, `probingStatus`).
- **All pi-arnative files in one folder, cache 55% smaller.** Everything the package writes now lives under `~/.pi/agent/arnative/` — `config.json` (preset choices) and `usage-cache.json` (the `/usage` scan cache) — instead of three flat `arnative-*.json` files in `~/.pi/agent/`; existing files are migrated in automatically on first read. The cache gained a compact disk shape: keys are session-dir-relative paths, rollups store one row per provider+model (provider rows are derived on load), and one-letter field names — 90 KB shrank to 40 KB on a real machine with identical answers. The legacy `arnative-prices.json` is deleted from the disk on first load (nothing has read it since pricing moved into `cost` fields in pi's `models.json`, which the provider wizard fills in), and a flat file a downgrade recreated beside the folder copy is removed the same way; `config.json` stamps a `layoutVersion` so the next layout change has one hook to migrate from. Preset choices and the cache are never deleted — only moved (`lib/preset-store.ts`, `lib/usage-store.ts`).
- **Footer diff stat now tracks edits as they land.** The git refresh ran only at session and turn start, so a session that edits or commits inside a turn (the normal pattern when each step is committed) kept showing the pre-turn snapshot — often clean — and the `+X -Y` working-tree diff never appeared. The footer now re-reads git state whenever a tool call finishes (edit, write, or a commit through bash); concurrent refreshes still coalesce into at most two `git` runs per burst (`extensions/footer.ts`).

### Changed
- **`/arnative` → Themes lists this package's themes only.** The picker shows the `arnative` family (`arnative` and its variants) and nothing else — pi's own `system`/`dark`/`light` and a theme of your own (e.g. `omarchy-system`) stay in `/settings` → Theme, which keeps the full list. Esc still reverts to whatever theme was active when the picker opened, arnative or not, and the empty-list message now points at a reinstall instead of the themes folder (`extensions/arnative.ts`).

### Fixed
- **Esc cancels the add-provider flow at every prompt.** The flow asked for endpoint, API key and provider name, but only Esc at the first prompt aborted: Esc at the key prompt continued keyless (and could save a provider with a dummy key that never authenticates), Esc at the name prompt silently accepted the suggested name. Both prompts now honor the `[Esc] Cancel` their legend promises — Enter on an empty key field still means keyless, and an empty name still accepts the suggestion (`lib/provider.ts`).
- **Provider config writes are atomic.** `writeJson` wrote `models.json` and `auth.json` with a direct `writeFileSync`, so a crash or power loss mid-write could truncate them — a truncated `auth.json` breaks the stored credentials of every provider, and the wizard then refuses to save until the file is repaired by hand. It now writes a temp file and renames it over the target, the same pattern `preset-store.ts` and `usage-store.ts` already use, and the self-check proves an interrupted save leaves the previous config intact (`lib/provider.ts`).

## [0.6.2] - 2026-10-20

### Fixed
- **The usage cache no longer loses another session's rollup.** `saveDiskCache` wrote its whole in-memory map, so of two pi sessions sharing one agent dir the later writer dropped the entries the other had cached for its own files. It now re-reads the disk cache before the rename and keeps the keys this session does not have — only while their session file still exists, so a prune done by this scan stays pruned (`lib/usage-store.ts`).

### Added
- **The footer cache cell falls back to pi's own usage.** `pi-cache-optimizer` only reports providers it has an adapter for; a provider it does not recognize (a custom one such as `hark.ts`) publishes no `pi-cache-stats` status and the cell stayed empty. It now shows `pi X%`, computed as `cacheRead / (input + cacheRead)` from the usage pi already records on the branch — the optimizer's own string still wins when present (`extensions/footer.ts`).

## [0.6.1] - 2026-10-19

### Fixed
- **A preset choice survives a second pi session.** `saveChoice` merged into a memo read once per process and wrote the whole file back, so a session that had already loaded the file dropped the keys another session had written: two concurrent saves left only the last one. Every save now re-reads the file, merges its one key, and replaces the file atomically (temp file + `rename`). The self-check writes the file behind the module and asserts the other key survives (`lib/preset-store.ts`).
- **The usage cache is replaced atomically.** `saveDiskCache` wrote in place, so a second pi session could read a truncated JSON, discard the cache and rescan every session file. It now writes a temp file and renames it, and `Object.fromEntries` replaces the manual copy loop (`lib/usage-store.ts`).

### Changed
- **`ROW_DIVIDER` has one definition.** The divider between a picker row label and its note was declared twice, once in the picker and once in the animations module. It now lives in `lib/format.ts` beside `markedLabels`, and both modules import it (`lib/format.ts`, `extensions/arnative.ts`, `extensions/animations.ts`).

## [0.6.0] - 2026-10-17

### Fixed
- **A model id no longer reports another route's tokens.** The match rule also accepted a stored name the target merely *ends* with (`target.endsWith("/" + name)`), so a first run under `river/deepseek-ai/DeepSeek-V4.1-Flash` showed wally+yarz's `deepseek-v4.1-flash` history — 29.5M in / 3.2M out / 360.5M cache reads — as its own. Matching is now exact after `canonicalModel` (trimmed, case-folded, `:route` tag dropped), so the header's Model tab and `/usage` state the tokens of the id they name. Measured on the operator's own history: River reports 148.5k in / 26.5k out / 1.6M cache reads, and the old totals stay reachable under `deepseek-v4.1-flash` (`lib/usage-store.ts`).
- Self-check pinning per-id totals: a bare id does not absorb a longer id that ends with it, a path id counts its own provider only, case does not split one model's history, and a `:free` tag still folds into the model it tags. Proved negative: restoring the suffix rule fails `npm test` (`extensions/usage.ts`).
- **The `[g]` sweep no longer strobes.** One cycle now takes 20s (`GRADIENT_CYCLE_MS`) instead of 4s. The frame interval is fixed per preset, so a fast cycle forces a huge colour jump between frames — measured worst-case step was 64.9 RGB units at 200ms and 26.2 at 80ms, which the eye reads as flashing rather than a sweep. 20s brings that to 13.2 and 5.7; the self-check pins those ceilings so a later speed-up cannot silently reintroduce the strobe (`lib/spinner.ts`).

### Added
- **The Animations picker previews the live frame, and lists presets in a stable order.** The selected row's note now ends in the preset's *current* frame — the picker repaints every 80ms and reads the frame from the clock (`previewFrameAt`), so a dropped repaint costs one frame and can never desynchronise the animation. The glyph is padded to the widest frame of that preset, so the row does not shift as it moves. Rows are `Pi (system)`, `Arnative`, then the rest alphabetically: the escape hatch and the package's own spinner are the two a user reaches for and must not move when a preset is added. The self-check pins the order, name uniqueness, and the clock arithmetic; the picker was rendered at 80/100/120 columns with 0 width mismatches (`lib/spinner.ts`, `extensions/animations.ts`, `extensions/arnative.ts`).
- **`Dot Spine` preset.** A dot body growing outward from a two-cell core — `⠂⠐` → `⠺ ⠂⠐ ⠗` → `⠺ ⠪ ⠂⠐ ⠕ ⠗` at 200ms, one cell added at each end per frame. All three frames are 10 columns so the label never shifts, and the self-check pins the frames plus two properties the animation depends on: the core `⠂⠐` stays in columns 4–5 in every frame, and the dot count grows `2,4,6`. Named off the `Braille *` prefix so it does not read as a third variant of `Braille Column`/`Braille Level`; the note still says braille, which is what the glyphs are (`lib/spinner.ts`).
- **`Bagua Trigram` preset.** Three I Ching trigrams — `☶` (U+2636, mountain) → `☵` (U+2635, water) → `☳` (U+2633, thunder) at 200ms. Like `Yin Yang Lines`, none of the three exists in the terminal face (JetBrainsMono Nerd Font) but all three are served by the same fallback face at the same 1.50 cells, so the row keeps its place. Three of the eight trigrams are used, not all eight: a spinner is a short loop. Frames are pinned by codepoint in the operator's order, and the self-check asserts all three are distinct (`lib/spinner.ts`).
- **`Yin Yang Lines` preset.** The four I Ching digrams — `⚌` (U+268C, both lines whole) → `⚎` (U+268E, lower line broken) → `⚍` (U+268D, break moves up) → `⚏` (U+268F, both broken) at 200ms, so a single broken yin line travels through the pair. All four glyphs are absent from the terminal face (JetBrainsMono Nerd Font) but every one is served by the same fallback face at the same 1.50 cells, which is the property that matters: a constant width means no sideways shift, unlike a set that mixes native and fallback glyphs. Frames are pinned by codepoint in the operator's order, and the self-check asserts all four are distinct (`lib/spinner.ts`).
- **`Pacman` preset.** Pacman eating his way across the row, one cell per frame — `ᗧ + − ×` → `~ ᗧ − ×` → `~ ~ ᗧ ×` → `~ ~ ~ ᗧ` at 200ms, with the eaten pellets left as a ghost trail. `ᗧ` is U+15E7 (Canadian Syllabics `ye`), the glyph the pacman CLI spinners use because it reads as an open mouth facing right. The self-check pins the exact frames and asserts the mouth sits in column `2 × frameIndex`, which is the animation's whole point (`lib/spinner.ts`).
- **The package now has its own spinner and ships it as the default: `Arnative`.** A spark (`✧` / `✦`) and a Braille cell trading places around the centre — `✧⠙` → `✧⣠` → `⣄✧` → `⠋✦` at 200ms, painted with the theme accent (or the brand sweep under `[g]`). `DEFAULT_SPINNER_PRESET` moved from `Diamond Glow` to `Arnative`, so a fresh install shows it without opening a menu; an existing install keeps whatever it already stored. Two frames carry a trailing space; it is load-bearing, because both cells are one column wide and dropping it would shift the label sideways on every second frame. The self-check pins the exact frames by codepoint, asserts every frame of a multi-glyph preset has one length, and pins the default (`lib/spinner.ts`).
- **The `arnative` theme is applied on a fresh install.** `session_start` checks pi's own theme setting and calls `ctx.ui.setTheme("arnative")` only when no setting exists and the theme actually loaded. A theme you chose is never overridden, and because `setTheme` writes the setting, the check is a no-op on every later session (`extensions/arnative.ts`).
- **`Arrow Orbit` preset.** A four-arrow ring turning clockwise one position per frame — `▴▸▾◂` → `▸▾◂▴` → `▾◂▴▸` → `◂▴▸▾` at 200ms, one full turn per 0.8s, the same rate as `Diamond Glow`. Frames are pinned by codepoint in the self-check (U+25B4, U+25B8, U+25BE, U+25C2) so a font fallback cannot swap a glyph unnoticed (`lib/spinner.ts`).
- **`[g]` in `/arnative` → Animations paints accent presets with the Google brand sweep.** The switch sits on the Animations screen only, states its current mode in the legend (`[g] Gradient on`), saves as `spinnerGradient` in `arnative-config.json`, and repaints the live spinner the moment it is pressed. Esc and `←` undo it together with a previewed preset, so leaving the screen restores what it opened with. `Gemini` already sweeps and `Claudeon` carries its own mark colour, so the override leaves both untouched (`lib/spinner.ts`, `extensions/animations.ts`, `extensions/arnative.ts`).

### Changed
- **`UsageModalComponent.hintText` is gone: the render path calls `legendUsage(width)` directly.** A private one-line method that returned another function added a name with no behaviour, so the call site now states what it wants (`extensions/usage.ts`).
- **`Claudeon`: the `Claude` preset, renamed and restyled — inspired by Claude.** The preset was called `Claude` and reused Claude Code's own dingbats; it is now `Claudeon`, a mark of this package's own that reads as the Claude-style pulse without borrowing Claude's name for a glyph set Claude does not use. The attribution lives in the row's note (`inspired by Claude — pulsing marks, 120ms`) rather than only in the code, and the paint mode and colour constant follow (`claude` → `claudeon`, `CLAUDE_RGB` → `CLAUDEON_RGB`); the grey-orange mark colour is kept, because that colour is what makes the pulse read as the Claude-style spinner. The preset had not shipped yet, so no stored config can reference the old name (`lib/spinner.ts`, `extensions/animations.ts`).
- **`Claudeon`'s frames are native-only, so the row cannot walk sideways.** The old set (`· ✢ U+2733 * ✶ ✻ ✽`) mixed font-fallback widths: `✢` `✻` `✽` are absent from most monospace faces, so the terminal served them from a fallback font — measured in the terminal face (JetBrainsMono Nerd Font) `✢`/`✤`/`✻`/`✽`/`❋` advance **1.48** cells and `U+2733` **2.29**, against a **1.00** native cell, so the label shifted on every tick that used one and `U+2733` sheared the row. The set is now `· * ⋆ ✶` (U+00B7, U+002A, U+22C6, U+2736) — four marks that every monospace face checked (JetBrainsMono Nerd Font, Consolas, Cascadia, Lucida, Courier) reports at exactly 1.00 — giving an 8-frame there-and-back loop (`· * ⋆ ✶ ✶ ⋆ * ·`, the peak held for two frames as elsewhere in the package) at 120ms, so the displacement is 0.00 cells. There is no fifth mark to add: a scan of all 86 installed families found none covering the Dingbats block at ~1 em (`lib/spinner.ts`).

## [0.5.3] - 2026-10-14

### Fixed
- A new session showed the previous session's token counts. The footer's 2s `getUsage` cache is keyed on branch length, and the module is not re-imported by `/new`, so a fresh session whose branch happened to reach the same length read the cached sums instead of its own. The cache is now cleared in the non-reload `session_start` branch (`extensions/footer.ts`).
- **The cell was invisible: the footer still matched the value on `jev-eye`.** The value became `Eye: ● ON (Clef Flash)`, which contains no `jev-eye` anywhere, so `value.includes("jev-eye")` went false and the whole cell fell through to the generic path — no icon, no dim backend suffix, just grey text. The router now recognises the cell by the label its value carries (`isJevEyeStatus`, `^\s*Eye\s*:`), and the self-check pins that rule from both sides: every mode's real value is recognised, `Jev: ● ON` and `MCP: 2 servers enabled` are not, and the value is asserted to contain no internal key name. Proved negative: reverting the rule to the substring test makes both `node extensions/footer.ts` and pi-jev-eye's `render-check` fail.
- **One space after the glyph, not two.** The two spaces existed because the previous glyph's ink overran its cell (`\uedcf`); with `\uf21b` in place they read as a gap in `  Eye: ● ON (Clef Flash)`. Pinned in pi-jev-eye's render check as one space, with an explicit assert that the glyph is not followed by two.

### Changed
- **The cell glyph is U+F21B (`fa-user_secret`), chosen by the operator.** U+EDCF (`fa-user_shield`) was the previous one; both exist in JetBrainsMono Nerd Font, and the codepoint is pinned by number in pi-jev-eye's render check because a Nerd glyph that renders blank on another platform is the bug the ponytail cell had (`\uef51` -> `\uef04`).
- **The pi-jev-eye status cell renders `Eye: ● ON (Backend)`, parsed from the value instead of hardcoded.** The format is `Eye: ● ON (Clef Flash)` when a Clef model answers and `Eye: ● ON (Jev)` when TypeSafe or OpenRouter does. `jevEyeStatusLine()` reads the label before the first colon and the backend from the trailing parentheses — so nothing about the cell is a literal in this repo, and an older pi-jev-eye value with no suffix gains no guessed one.
- **The backend suffix takes `dim`, while `Eye:` and the state keep their tiers.** A backend painted like the label would bury `Eye: ● ON`, which is the case this cell exists for; the spaced `Clef Flash` (not a nested `clef (flash)`) reads as one label on a single line.
- **The status line moved out of the render closure**, next to `ponytailStatusLine`, so the self-check in `node extensions/footer.ts` drives the exact path the footer uses instead of a copy of it.
- Dropped two unused imports (`CustomMessageComponent`, `isPointerOrFocusInput`) and corrected three stale statements: the usage estimate comment named `prices.json` where the code reads `models.json`, the footer header listed two of the three footer presets, and the README's local-test snippet ran one extension where `npm run dev` runs all eight (`extensions/ui-render-tweaks.ts`, `lib/usage-store.ts`, `extensions/footer.ts`, `test/footer-minimal.test.ts`, `README.md`).

### Added
- Self-check for the pi-jev-eye cell: both requested forms (`Eye: ● ON (Clef Flash)`, `Eye: ● ON (Jev)`), the tierless `(Clef)`, an upstream `(Clef Omni)`, `OFF` taking the dim bullet, `REVIEW` keeping its warning bullet, and a suffix-less value drawing no parenthesis.

## [0.5.2] - 2026-10-13

### Fixed
- Restored the footer's two-tone labels. `0.5.1` moved the label colour onto `softOf(accent)`, which softens the *accent* hue, so cwd/branch/clock/status text inherited the accent (pink) instead of the border-accent (blue) tier and the footer collapsed into a single hue (`extensions/footer.ts`).
- Added `vars.secondarySoft` to all 11 themes, softened from the same value the `borderAccent` token resolves to (L 0.82, chroma × 0.18, hue kept), and `softSecondaryOf` in `lib/ansi.ts` to derive the identical value at runtime — `vars` names are not addressable via `fg()`, and Pi 1.2 rejects custom `colors` keys, so the declared and derived values must be produced by one recipe.
- Routed the header's model/thinking/token text, tool bodies, list rows and the usage dashboard onto the label tier. Icons, marks and the logo's second tone stay on the accent tier, so each line keeps its two tones (`extensions/section-headers.ts`, `extensions/tools.ts`, `extensions/usage.ts`, `extensions/arnative.ts`, `extensions/ui-render-tweaks.ts`).

### Added
- `soften()` is now shared by the generator and the runtime, and `extensions/ui-render-tweaks.ts` asserts every declared `*Soft` var equals its derived value — a drifting or rogue soft colour fails `npm test` instead of shipping (`themes/gen-themes.mjs`, `lib/ansi.ts`).
- Behavioral test pinning the two-tone rule: labels take the border-accent hue, icons keep the accent hue (`test/footer-minimal.test.ts`).

### Notes
- Label colour is deliberately softer than the pre-0.5.1 `#05dee7`. `SOFT_CHROMA_SCALE` in `lib/ansi.ts` is the single knob: `0.18` gives `#b2c9ca` on cyberpunk, `0.30` gives `#b2dadc`, `0.50` gives `#9adfe3`. Changing it regenerates all 11 themes and the guard forces them to stay in sync.

## [0.5.1] - 2026-10-13

### Fixed
- Restored all 11 arnative themes on Pi 1.2.0, which validates the `colors` object with `additionalProperties: false` and rejected the whole theme — "must not have additional properties" followed by "Theme not found" (`lib/ansi.ts`, `themes/gen-themes.mjs`, `themes/*.json`, `extensions/ui-render-tweaks.ts`). Arnative's own colors (`accentSoft`, `primary`, `secondary`, `primarySoft`, `secondarySoft`) moved from `colors` to `vars`.
- Kept the two-tone soft tier instead of collapsing it to grey: `softOf` replaces `accentSoftOf` and derives the soft accent from the resolved `accent` color when `fg("accentSoft")` throws, so the header logo, tab labels, model line, footer labels, tool titles and the usage dashboard keep their tint (`lib/ansi.ts`).
- Updated `$schema` in every theme and the generator from the raw GitHub `theme-schema.json` path to the published `https://pi.dev/schemas/theme.schema.json` (`themes/gen-themes.mjs`, `themes/*.json`).
- Replaced the footer's raw `fg("accentSoft")` probe with the shared painter and mapped `primary`/`secondary` onto the official tokens they carry (`mdHeading`, `borderAccent`), since Pi 1.2 rejects custom `colors` keys (`extensions/footer.ts`).
- Mapped the usage dashboard's name/value/arrow colors off `accentSoft` onto the shared soft painter and plain `dim`/`text`, keeping provider rows distinguishable (`extensions/usage.ts`).
- Added a self-check that fails when a theme puts a non-schema key in `colors`, so a rogue token breaks `npm test` instead of the user's startup (`extensions/ui-render-tweaks.ts`).

### Notes
- `0.5.0` is intentionally skipped on the npm registry. It was tagged and merged, but never published, and its themes are the ones Pi 1.2.0 rejects. `0.5.1` carries everything from v0.5.0 plus this fix. The tag stays in the history; install from npm and you get `0.5.1`.

## [0.5.0] - 2026-10-13

### Added
- Extended theme token hierarchy in `vars` with `primary`, `primarySoft`, `secondary`, and `secondarySoft` across all 11 themes (`themes/gen-themes.mjs`), ensuring unique hex mappings and full perceptual OKLCH color space discipline.
- Tri-color multi-palette overhauls for expressive themes (`arnative-cyberpunk`, `arnative-synthwave`, `arnative-dracula`, `arnative-gruvbox`, and `arnative-nord`), mapping `mdHeading` to `primary` and `borderAccent`/`mdCode` to `secondary`.
- Footer multi-color pairing (`extensions/footer.ts`): paired vibrant `accent` icons with readable `secondarySoft` labels and highlighted the model name with `primary`.

### Changed
- Increased message bubble background lightness (`surfaceMsg` / `userMessageBg`) on `arnative-cyberpunk`, `arnative-matrix`, and `arnative-synthwave` to 24% (`oklch(24% 0.035 ...)`) to ensure container boundaries remain clearly defined against pitch-black terminal canvases.

### Fixed
- Fixed parenthetical suffix per-row dimming in `/arnative` → **Animations** so `(system)` on `Pi (system)` renders softly in `dim` even when descriptive frame notes are present (`extensions/arnative.ts`).
- Fixed inline image preview layout spacing by dropping the redundant spacer gap between the tool execution box and the image payload (`extensions/tools.ts`).

## [0.4.0] - 2026-10-12

### Added
- `/arnative` → **Animations** picker and working-spinner presets (`lib/spinner.ts`, `extensions/animations.ts`): Diamond Glow (default), Diamond Pulse, Circle Pulse, Circle Wave, Shade Wave, Braille Column, Braille Level, Kanji Count, Suzhou Tally, Pi (system), Gemini (Google brand gradient), and Claude (pulsing mark loop).
- Automatic token cost estimation for unpriced models via pi's `models.json` declared rates (`lib/usage-store.ts`, `extensions/usage.ts`).
- Usage dashboard integration into `/arnative` → **Usage** alongside standalone `/usage` command (`extensions/arnative.ts`, `extensions/usage.ts`).

### Changed
- Active session clock tracks duration while active and freezes after inactivity (`IDLE_PAUSE_MS`), ignoring non-keystroke inputs (`extensions/footer.ts`, `test/footer-minimal.test.ts`).
- Working spinner frames clear `renderIndicatorVerbatim` to apply theme `accent` color while preserving `accentSoft` for labels (`extensions/footer.ts`, `extensions/animations.ts`).
- Unified screen chrome and title format via `renderScreen` and `screenTitle` in `lib/box.ts`, with adaptive thinking-level border colors across all `/arnative` screens (`lib/box.ts`, `lib/ansi.ts`, `extensions/arnative.ts`, `extensions/usage.ts`).
- Back key `←` (`matchesBack`) standard across `/arnative` submenus and usage dashboard, stepping back without losing selection context (`lib/shortcuts.ts`, `extensions/arnative.ts`, `extensions/usage.ts`).
- Compact usage dashboard layout: removed `↑In`/`↓Out`/`Cache` columns from main table (moved to selected row detail line) and added mouse click toggle for provider rows (`extensions/usage.ts`).
- Aligned list picker layout to standard `Label · note` format, removing redundant `●` indicator column (`extensions/arnative.ts`).
- Header brand updated to `Arnative⠙ vX.Y.Z` using shared `BRAND` constant (`extensions/section-headers.ts`).

### Fixed
- Fixed spinner preset selection in `/arnative` → **Animations** by sharing active UI and theme references across extension module instances via `globalThis` (`extensions/animations.ts`).
- Fixed missing `animations.ts` in `scripts/preview.mjs` extension launch list (`scripts/preview.mjs`).
- Fixed box row truncation in `boxRow` to prevent right wall clipping on lines narrower than content (`lib/box.ts`).
- Fixed `boxRow` zero-column overflow when width is below 4 columns (`lib/box.ts`).
- Avoided repeated synchronous disk reads during usage summary collection by passing memoized price table (`lib/usage-store.ts`).
- Cleaned up active clock state initialization on fresh sessions (`extensions/footer.ts`).
- Bounded tool duration cache (`TIMINGS`) to 200 entries with FIFO eviction and cleared on session boundaries to prevent memory growth (`extensions/tools.ts`).
- Added short-circuit in `repairBubbleBg` to avoid string split/join allocations on lines without ANSI reset sequences (`extensions/timestamps.ts`).
- Added fast substring check in `shouldHideReloadBox` to bypass `stripAnsi` and array mapping across general containers (`extensions/ui-render-tweaks.ts`).

## [0.3.10] - 2026-10-11

### Fixed
- The ponytail icon rendered as a blank cell on Windows. The status drew `U+EF51` (`fa-circle_radiation`), a codepoint the Windows JetBrainsMono Nerd Font build lists in its cmap but rasterizes with no outline, so the footer left an empty gap before `ponytail:`. It now draws `U+EF04` (`fa-horse`), which renders on both platforms. The cell also spends one space after the icon instead of two, matching `MCP:`. A self-check pins the codepoint, so an edit back to an invisible glyph fails `npm test` instead of shipping silently (`extensions/footer.ts`).

## [0.3.9] - 2026-10-08

### Fixed
- The README told you to press `ctrl+e` to expand a tool box. The key actually follows pi's `app.tools.expand` binding, whose default is `ctrl+o` (`lib/format.ts`, `extensions/tools.ts`). Docs only — no behaviour changed in this release.

### Changed
- The README now states the footer facts it never listed: all three presets (`Arnative (Full)`, `Pi (system)`, `Arnative (Minimal)`), the Minimal preset's click behaviour and `ctrl+alt+m`, the session clock surviving `/resume`, and the working-tree diff beside it (`README.md`).

## [0.3.8] - 2026-10-08

### Added
- New footer preset **Arnative (Minimal)**, selectable in `/arnative` → Footers. It shows a single head row (cwd, clock, diff, git, model) with a dim `▲` at the end of each side. Each head's own text is the click target — anywhere on the cwd/git string toggles the left side (extension statuses), anywhere on the model string toggles the right side (speed/cache/token) — while the blank gap between them is inert, so a stray click on empty space cannot expand anything. Opened sides show `▼` and their rows; the two sides open independently. Ctrl+alt+M (alt+M on Windows/WSL) toggles both, so it also works in `tuiMode: "regular"` where the terminal owns the mouse. Zone columns are measured from the row this module places itself rather than mirrored from `pairRow`, because the ellipsis on a truncated head shifts every column after it (`extensions/footer.ts`, `lib/shortcuts.ts`).
- The footer shows the working tree's diff next to the session clock only while there is one: `\uf4d2 +500 -100`, with the same green/red the diff body uses (`toolDiffAdded`/`toolDiffRemoved`). It comes from `git diff HEAD --numstat` in the existing `refreshGit` pass (one extra spawn, nothing new on the per-frame path) and is hidden when the tree is clean or git cannot answer (not a repo, no binary) — no fake `+0 -0`, no dangling icon. A repo with an unborn `HEAD` (no commit yet) falls back to diffing against the empty tree, so a staged first commit still counts. Note the count is the whole uncommitted change, not just this session's edits: it includes anything done before or outside the session. Untracked files are not part of a diff and stay counted by the `~N` worktree segment (`extensions/footer.ts`).

### Fixed
- The footer's session clock no longer restarts when you switch sessions with `/resume`. The reset came from `session_start`, which set the start to `Date.now()` for every reason but `"reload"`. It now reads the session header's `timestamp` (the moment the session was created) for `"resume"`/`"startup"`, so the duration reflects the session's real age; `"new"`/`"fork"` write a fresh header and still start at zero. A missing or unparsable header falls back to now (`extensions/footer.ts`).
- Every third-party tool that ships its own `renderCall`/`renderResult` now renders in the arnative box, not just the ones on a hardcoded name list. The predicate was an allowlist (`ls`, `powershell`, `ffgrep`, `fffind`, `find`, `grep`, `BOXED_TOOLS`, MCP), so any other extension's tool — present or future — fell through to pi's `contentBox`: a padded background block with no border. It is now shape-based: boxed unless the tool declares `renderShell: "self"` (arnative's own boxes) or is in `NOT_BOXED` (`extensions/tools.ts`).
- The inter-box gap is now stripped for the generic box path too. The gap-strip patch keyed on a name list (`OWN_BOX`), so a tool boxed by the widened predicate but not registered through `minimal()`/`BOXED_TOOLS` kept the leading `Spacer` and floated a blank row above its box (`extensions/tools.ts`).

## [0.3.7] - 2026-10-05

### Fixed
- The `powershell` and `ls` tools now render in the arnative box like every other call. pi draws a tool that ships its own `renderCall`/`renderResult` but sets no `renderShell` through its own `contentBox` — a background block with no border. Both tools match that shape (their definitions spread the renderer functions onto the tool object), so they now go through `minimal()` like `bash`/`grep`/`read`. `powershell` is Windows-only: `getPowerShellConfig()` throws elsewhere, and re-registering it would activate a tool the builtin deliberately leaves off (`extensions/tools.ts`).
- pi-fff's default-mode tools `ffgrep` and `fffind` are boxed too. The box path only recognized the override names `find`/`grep`, which pi-fff uses when it replaces pi's builtins, so a session running it in default mode showed those calls as bare blocks (`extensions/tools.ts`).
- pi's `[Extension issues]` diagnostic now draws in the arnative box, stripped to two content rows: the title (warning glyph + section name, brackets dropped, `[ctrl+o to expand]` hint) over the extension's source path. pi's extra diagnostic lines are dropped — the expand hint stands in for them (`extensions/section-headers.ts`).
- The package-update box title lost the double space after its glyph (`extensions/ui-render-tweaks.ts`).

### Changed
- The `section-headers.ts` self-check moved out of the extension into `test/section-headers.test.ts` and runs under `node --test`, so `npm test` lists it as a test instead of a script that prints `OK`. This is a pilot for the other modules; the remaining in-file self-checks follow the same layout once proven (`extensions/section-headers.ts`, `test/section-headers.test.ts`, `package.json`).

## [0.3.6] - 2026-10-05

### Fixed
- Fixed a startup crash: `Cannot read properties of null (reading 'fg')`. pi's `[Extension issues]` diagnostic box passed a null theme into the box renderer, which dereferenced it and killed the process with `uncaughtException`. It only surfaced on machines where an extension reported a problem (a conflicting shortcut, a failed `session_start`, …), because that is when the diagnostic is drawn. The renderer now draws an uncolored box for the first frame instead of throwing (`lib/box.ts`).
- The active theme now lives in a single `globalThis` slot. `/reload` re-imports extension modules, so two copies can coexist, and only one of them receives `session_start`. The copy that owns the `loadedResourcesContainer` patch used to keep a permanently-null theme; it now paints with the live theme (`lib/ansi.ts`, `extensions/section-headers.ts`, `extensions/ui-render-tweaks.ts`).
- Removed the `activeThemeProxy ?? Theme` fallback in the package-update box: `Theme` is a class, not an instance, so the fallback would itself have thrown `th.fg is not a function`. The box component now tolerates a null theme (`extensions/ui-render-tweaks.ts`).

## [0.3.5] - 2026-10-04

### Fixed
- Git info in the footer now works on a fresh machine: the branch is read straight from `.git/HEAD` (the trick pi's own footer uses), so it shows without a `git` install and on a repo git refuses to touch (its dubious-ownership guard). Tag, dirty count and ahead/behind still need the `git` binary; when it cannot answer, those parts are left out instead of a fabricated `-`/`clean` (`extensions/footer.ts`).
- `run()` no longer swallows a failed `git` call into `""`. "git said nothing" and "git could not run" used to be indistinguishable, which is what made four different states — not a repo, no `git` on PATH, a detached HEAD, and a foreign-owned repo — all show as no git info at all.
- The header's `Context`/`Skills`/`Extensions` counts show `—` instead of a misleading `0` under `"quietStartup": true` (or `"header"`), which hides the resource listing the counts are read from. The empty-tab placeholder now says the counts are not tracked, and the state resets on `session_start` so `/new` cannot show stale counts (`extensions/section-headers.ts`).
- The header and footer preset chosen in `/arnative` now survives a restart. The choice was only kept on `globalThis`, so every new pi process fell back to the default Arnative (Full) header and footer. It is now written to `arnative-config.json` in the agent dir and read back at startup (`lib/preset-store.ts`, `extensions/section-headers.ts`, `extensions/footer.ts`).
- The reload-box patch no longer blanks a whole chat: it only drops a container that holds nothing but the box itself (border rows, blank spacers and the message copy). Any other container whose content merely mentioned "Reloading keybindings" — a `read`/`grep` result, this repo's own source — was rendered as zero lines (`extensions/ui-render-tweaks.ts`).
- Row-1 git info works from a subfolder of a repo: `.git` is looked up by walking up the directory tree like git itself does, so the branch no longer vanishes when the session runs in `extensions/` or `src/` (`extensions/footer.ts`).
- A tool result whose text merely starts with `Error` is no longer painted as a failed call (red `x`); only `ctx.isError`/`result.isError` decide. Reading a file that opens with "Error handling…" used to show an error box (`extensions/tools.ts`).
- The stale git state is cleared when the working directory leaves a repo, so a `/reload` cannot re-show the previous directory's branch (`extensions/footer.ts`).
- The `usage.ts` self-check builds a fixture session directory (and its own cache) instead of reading the real `~/.pi/agent/sessions`. A machine without `gemini-3.8-flash` in its history failed `npm test` (`extensions/usage.ts`, `lib/usage-store.ts`).
- `isMain()` compares canonical file URLs, so a checkout path containing a space or another character that `import.meta.url` percent-encodes no longer makes a self-check exit 0 without running (`lib/check.ts`).

### Changed
- An active session that grows is no longer walked in full on every usage refresh. The cache keeps a per-file rollup (providers and provider+model totals) plus the byte offset of the last complete line, so a refresh reads only the appended tail and folds it in. On a 2.3MB / 11,000-message session, a refresh after one new record went from ~76ms (full re-parse **and** re-aggregation of every cached entry) to ~12ms, flat as the chat grows; the cache file went from megabytes to ~0.4KB. A half-written trailing record is retried instead of counted or dropped (`lib/usage-store.ts`).
- The usage cache format is version 4 (per-file rollup, was raw entries in v3); an older cache is rebuilt once.
- `npm test` also runs `lib/color.ts`; `prepublishOnly` runs the full test suite before the pre-publish preflight, so a publish cannot ship a red build (`package.json`).
- `release-check.mjs` verifies the tag points at `HEAD`, and `post-publish` also checks the `latest` dist-tag and the tarball URL are live, not just that the version exists (`scripts/release-check.mjs`).
- The open-PR check falls back to the public GitHub API when `gh` is unavailable, instead of failing the whole preflight (`scripts/release-check.mjs`).
- `.gitattributes` pins every text file to LF in the repository, so a Windows checkout stops reintroducing CRLF into diffs.

### Removed
- `ASCII_LOGO_LINES` (computed at module load, never read) and the unused `Dim` export (`extensions/section-headers.ts`, `lib/box.ts`).

## [0.3.4] - 2026-10-04

### Added
- `scripts/release-check.mjs`, a read-only release preflight with one stage per step of the release (`pre-tag`, `pre-publish`, `post-publish`): it verifies a clean tree on `main` in sync with `origin/main`, no open pull requests, the `CHANGELOG.md` entry, whether the tag exists **and is pushed**, and whether the registry already serves the version. It never writes, tags, pushes or publishes.
- `npm run release:check` (the `pre-tag` stage) and a `prepublishOnly` hook wired to the `pre-publish` stage. A missing or unpushed tag now aborts `npm publish` with `npm error code 1`, so a forgotten `git tag` can no longer ship a release.

### Changed
- README documents the release stages and their exit codes (`0` pass, `1` check failed, `2` bad usage).

## [0.3.3] - 2026-10-04

### Changed
- `codemode` now renders in the arnative box like every other tool call: side borders, green background (`toolSuccessBg`), and the script's first line prefixed with the `󱞩` summary glyph. While the tool runs the box shows the shared spinner; the `\uf489` glyph appears with the result (`extensions/tools.ts`).
- Collapsed `codemode` is now two rows, the same footprint as `bash`/`grep`/`read`: title + the script's first line. Nested calls and output wait behind the standard `[ctrl+o to expand]` hint. A failing run still shows its output.
- pi's `Script completed / Wall time / Output:` header no longer shows in the box.
- Shared duration wording (`2ms` under a second, `1.4s` above) and one error glyph (`x`) across every tool; a failing `codemode` run shows its whole output and never a `[ctrl+o to expand]` hint.
- The file tools (`bash`, `read`, `write`, `grep`, `find`, `edit`) now show `[ctrl+o to expand]` when their collapsed summary hides more than it shows — a two-line `extra +1 / -1` box no longer looks complete while its diff sits behind it. Expanded and genuinely single-line results get no hint (`extensions/tools.ts`).
- The `chrome_devtools_*` tools (from `@narumitw/pi-chrome-devtools`) now render in the same box instead of their bare "Chrome DevTools: …" lines. Their own `renderCall`/`renderResult` are bypassed: the call box uses the Chrome glyph and the result box the usual summary + `[ctrl+o to expand]` (`extensions/tools.ts`).

## [0.3.2] - 2026-10-04

### Changed
- Source cleanup only: the generator's 11 `accent` seeds, the color self-check and one test fixture no longer hold raw hex. Each seed is now the OKLCH value of the same colour (`#00d7ff` → `oklch(81.1% 0.1455 217.709375)`), produced by `hexToOklch`, so the theme output is **byte-identical**; `themes/*.json` are untouched. `lib/color.ts` also keeps its hex, deliberately: those literals are the test vectors for the hex parser, not styling (`themes/gen-themes.mjs`, `lib/color.ts`, `extensions/ui-render-tweaks.ts`).
- `themes/gen-themes.mjs` dropped its private `parseOklch` (percent-only regex) for the shared one in `lib/color.ts`, which also accepts a fractional `L` — a seed can no longer parse as `NaN`.
- No user-visible change; this release exists to bring the npm tarball in line with `main` after #8.

## [0.3.1] - 2026-10-04

### Changed
- `/arnative headers` and `/arnative footers` picker rows are reordered built-in first (`Pi (system)`, `Arnative (Full)`) and the parenthetical suffix now renders in the theme's `dim` token, so the preset name carries the row and the qualifier reads as a footnote (`extensions/arnative.ts`).
- Preset ids renamed: `Pi` → `Pi (system)`. `Arnative (Full)` is still the default and the header/footer slot logic is unchanged.
- Picker subtitles no longer repeat the preset names: "Selection applies live — custom header or built-in."
- README shows only `assets/pi-arnative.webp` as the hero image; the full-width `assets/banner.webp` stays reserved for the pi.dev package page via `pi.image`.
- `package.json` `description` now leads with the README tagline ("Refined aesthetics. Cohesive tools. Built for Pi.") followed by the capability summary, per the `/arnative-pi` manifest standard — pi.dev/packages renders this field verbatim as the package card description.

## [0.3.0] - 2026-10-03

### Fixed
- `package.json` `files` now ships `LICENSE`; README hero banner uses the standard full-width `assets/banner.webp`.
- Unit-boundary display bugs in the usage numbers (`lib/usage-store.ts` `formatTokens`, `extensions/usage.ts` `formatCost`): a value that rounds up to the next unit printed `"1000k"` / `"$1000.00"` instead of `"1M"` / `"$1.0k"`; every unit now promotes through `fmtUnit()` (also strips a `.0` tail below 10k, so `9,999` is `"10k"` not `"10.0k"`).
- `getModelAllTimeUsage()` without a model id matched **every** model, so the header's Model tab showed the grand total under "No Model"; it now matches nothing (zeros).
- The usage disk cache never dropped session files deleted from disk, so `~/.pi/agent/arnative-usage-cache.json` only ever grew; `collectUsageSummary()` now prunes missing files while scanning.
- A git refresh arriving while one was in flight was dropped (early return in `refreshGit()`), so the footer's git state stayed stale until the next trigger; it is now queued (last requested cwd wins) and re-run after the in-flight one (`extensions/footer.ts`).
- `USER_TIMESTAMPS_MAP` grew for the whole process lifetime (it survives `/reload`); `session_start` now clears it first — it is refilled from the branch right after, so it is bounded by the current session (`extensions/timestamps.ts`).
- The footer's token usage could show numbers up to 2s stale while a reply streamed: the cache only refreshed when the branch length changed, but a stream tick mutates the last message in place. The delta of that message is now applied on top of the cached sums — O(1) per frame, always fresh, still no O(N) rescan (`getUsage()` in `extensions/footer.ts`).

### Changed (breaking — theme contents)
- All 12 `themes/*.json` are now generated from `themes/gen-themes.mjs` and store **OKLCH** values (`oklch(L% C H)`) instead of hand-written hex. `vars` was renamed to a role-based scheme (`text`→`fg`, `gray`→`fgMuted`, `dimGray`→`fgDim`, `darkGray`→`fgFaint`, `cyan`→`accentBorder`, `softCyan`→`accentSoft`, `blue`→`border`, `green/red/yellow`→`success/error/warning`, `searchBg`→`surfaceSearch`, `selectedBg`→`surfaceSelected`, `userMsgBg`→`surfaceMsg`, `toolPendingBg`→`surfaceRaised`, `toolSuccessBg`→`surfaceToolOk`, `toolErrorBg`→`surfaceToolErr`, `customMsgBg`→`surfaceCustom`); the custom `colors.tint` token was renamed to `colors.accentSoft`. Any theme copied from the old 0.2.x files must be updated by hand — there is no compatibility shim.
- Colour sets are now derived from a shared ramp, so every theme has consistent lightness/saturation per type and no two `vars` resolve to the same value (the old base had `accent` = `cyan`, `syntaxOperator` = `syntaxPunctuation` = `text`, and variants that copied 12+ identical hex values).
- `lib/color.ts` (new) holds the OKLCH↔sRGB math, WCAG contrast and `toHex`, shared by the generator and the theme self-check.

### Changed
- The header's `Themes` tab is gone: pi 1.0 no longer emits a startup `[Themes]` section (only Context, Skills, Prompts, Extensions), so the tab could only ever read `Themes [0]`. The theme list stays reachable through `/settings` → Theme and `/arnative themes` (`extensions/section-headers.ts`).
- Select menus (`ctx.ui.select`, e.g. `/arnative` and `/jev-eye`): the selected row no longer turns fully accent — only the `→` marker and `·` separators keep accent, the selected text uses `accentSoft` (fallback accent on themes without the token). Live-preview theme picker follows the same rule (`extensions/ui-render-tweaks.ts`, `extensions/arnative.ts`).
- `accentSoftOf` (accentSoft token with accent fallback) moved to `lib/ansi.ts`, shared by `tools.ts`, `usage.ts` and the new select-row patch; the theme picker no longer crashes when a built-in theme without `accentSoft` is previewed.
- Theme self-check (`extensions/ui-render-tweaks.ts`) now accepts hex **or** validated OKLCH, converts through `lib/color.ts` before building pi's `Theme` (the bundled 0.87.1 parser only understands hex), asserts every `vars` value is unique per theme, and asserts the thinking ramp rises monotonically.

### Added
- `/arnative footers` picks the footer preset with the same live-preview picker as headers: `Arnative (Full)` (default, the 3-row grid footer) or `Pi` (pi's built-in footer, stock line count). Moving the selection swaps the footer on the spot, Enter keeps it, Esc restores the preset the picker opened with. The boxed editor is registered once per session and stays arnative in both presets — pi's `setEditorComponent()` calls `disposeActiveSelector()`, which would close the picker mid-preview (`extensions/footer.ts`, `extensions/arnative.ts`).
- `/arnative headers` picks the header preset: `Arnative (Full)` (default, this extension's header) or `Pi` (pi's built-in header). It uses the same live-preview picker as themes — moving the selection swaps the header on the spot via `ctx.ui.setHeader()`, Enter keeps it, Esc restores the preset the picker opened with. The choice lasts for the process (a new pi launch starts at `Arnative (Full)` again) (`extensions/section-headers.ts`, `extensions/arnative.ts`).
- `/arnative <menu>` settings command, shaped like `/jev-eye`: no argument opens the menu picker with autocomplete; first menu `themes` is a live-preview picker over the `/settings` → Theme list — moving the selection applies the theme instantly via `ctx.ui.setTheme()`, Enter keeps it, Esc reverts to the theme opened with (`extensions/arnative.ts`). The picker component (`ListPicker`) is shared by the themes, headers and footers menus, and the three identical picker-label helpers were consolidated into `markedLabels()` in `lib/format.ts`.

### Changed
- Header layout reworked (`extensions/section-headers.ts`): the left column is the pi block mark with `pi vX` directly under it (10 columns wide). The info column starts with `Arnative vY · Welcome back, <User>` (username's first letter capitalized via `capitalize()`), then the tab box and the tab data — no blank lines, so no row is left half empty. The box is 7 lines.
- The mark is the pi logo's grid rendered at terminal aspect (8 columns x 4 lines) instead of the 6-line "Pi" wordmark, and keeps the old wordmark's two-tone: P (the salmon/blue structure, columns 0-2) in the theme accent, i (the yellow bar, column 3) in the theme tint.
- The column divider joins the frame with `┬`/`┴` (`render()`, `border()`), so the left/right split runs the full height with no gap at the top or bottom border.
- The tab box lost its ` Menu ` label, and its tab dividers now join its own borders with `┬`/`┴` (`tabRule()`, `tabSeps`), so each divider is full height instead of a lone `│` on the middle row.

## [0.2.12] - 2026-10-02

### Changed
- The footer is a fixed 3-row grid: row 1 pairs the cwd line with the model, rows 2-3 pair the extension status (mcp first) with the metrics (tok/s · cache · token) — each side wraps inside its half of the terminal, the right cells stay right-aligned, and a row where both sides ran out is dropped. Replaces the adaptive 2→3 reflow; no click toggle (`extensions/footer.ts`, `layoutFooterGrid()` + `pairRow()`).

## [0.2.11] - 2026-10-01

### Changed
- The footer status area now reflows: 2 lines stay the default while everything fits, but on a narrow terminal the statuses and the metrics (tok/s, cache, context) move onto a 3rd line instead of being truncated. `extensions/footer.ts` `layoutStatusLines()` (`rows` = line budget of the whole footer, `maxRows` caps the growth); self-check covers the wide/narrow/cap cases.

## [0.2.10] - 2026-10-01

### Added
- The working loader now shows elapsed turn time next to the label — `⠴ Working (50s)`, `⠴ Executing (1m 5s)`. One `setInterval(1s)` per turn (`extensions/footer.ts`), cleared on `turn_end`/`session_shutdown`; the suffix only appears from 1s (no `(0s)` flicker) and the timer keeps counting across tool switches inside a turn. With parallel tools the label follows the last started tool and only falls back to `Working` when every `toolCallId` has ended.

### Fixed
- Tool image previews (e.g. `read` on a PNG) no longer break the layout. pi renders a preview as an extra child below the tool box, padded with `result.rows - 1` blank rows, and the gap-stripping patch deleted exactly those rows — the terminal then painted the image over the rows underneath (chat text, editor, footer). Only the leading Spacer is dropped now; from the image sequence on, every line is kept.

## [0.2.9] - 2026-09-30

### Fixed
- The startup `[Context]`, `[Skills]`, `[Extensions]` and `[Themes]` lists stacked under the header again on pi ≥ 0.99: pi replaced `ExpandableText`'s `getCollapsedText`/`getExpandedText` fields with a `build` callback plus a `state` object, so the section detector matched nothing and the tabs stayed at `[0]`. Both shapes are read now (`sectionBodyOf`), and the same applies to the `[Extension issues]` box, which read the stale `child.text` snapshot instead of the theme-aware `build()` output.
- Fixed NPM version badge in `README.md` to reference `@bismawy/pi-arnative` instead of placeholder `react`.

---

## [0.2.8] - 2026-09-28

### Fixed
- Custom `ctrl+alt+<letter>` shortcuts (`t` next tab, `n` new session, `r` reload) never fired on Windows: Windows Terminal ≥ 1.24 aliases every `Ctrl+Alt` combo to AltGr ([microsoft/terminal#20052](https://github.com/microsoft/terminal/pull/20052)), so the legacy `ESC` + control-byte encoding is never emitted. All of them now also accept `alt+<letter>` on Windows **and WSL** (same input translation), matching pi's own convention (`alt+v`, `alt+p`). Linux keeps `ctrl+alt`, macOS keeps `ctrl+option` (plain Option composes characters there).
- Shortcut ids, platform variants and cheatsheet labels now come from one place (`lib/shortcuts.ts`) instead of being spelled out per extension; the label is derived from the key id that is actually registered, so a cheatsheet can no longer advertise a key the platform never binds.
- README: platform notes for Windows/WSL, macOS, Linux desktops and multiplexers, including `PI_TUI_ESC_TIMEOUT` for the intermittent “Escape + stray letter” glitch (`ESC`-prefixed shortcuts flushed by pi's ~10 ms lone-ESC timer).
- Reload state for the chat clock now lives on a `globalThis` symbol instead of module locals: `/reload` re-imports the module while the prototype patches stay on the class, so the surviving render closure and the new `session_start` handler read the same map and theme. The old shape captured `ctx` in the module, which pi rejects after reload/session replacement, and that throw surfaced as an uncaughtException during a render pass.

---

## [0.2.7] - 2026-09-28

### Fixed
- README screenshot used raw HTML `<img>`, which pi.dev's markdown sanitizer strips; now plain markdown image syntax, so it renders on GitHub, npm and pi.dev alike (supersedes 0.2.6, whose README image was invisible on pi.dev).

---

## [0.2.6] - 2026-09-28

### Added
- Package banner and README screenshot (`assets/banner.webp` as the pi.dev gallery preview via `pi.image`, `assets/pi-arnative.webp` under the README badges).

---

## [0.2.5] - 2026-09-28

### Fixed
- `timestamps.ts`: missing `themeOf` import crashed `session_start` with "themeOf is not defined" on `/reload` and session resume (0.2.4 regression).

---

## [0.2.4] - 2026-09-28

### Added
- `lib/check.ts` and `lib/format.ts`: shared self-check helpers (`assert`, `isMain`) and shared display formatting (model names, capitalize, expand-hint key) — footer, header tabs and tool boxes now agree by construction.

### Fixed
- A crashing third-party tool renderer (e.g. pi-web-access `get_content` with missing args) no longer exits pi: every external renderer call is wrapped in a safe fallback, matching pi's own `updateDisplay` semantics.
- Restored / `--continue` sessions now show the real send time on user messages (timestamps prefilled from session history). A message with no recorded time shows no clock instead of a fake "now".
- The spinner animates at the documented 500 ms cadence (was 150 ms); footer status stripping no longer carries a broken ANSI-regex leftover.
- The usage log prefilter no longer silently undercounts if the JSONL key order/shape changes.

### Changed
- Self-check boilerplate, ANSI stripping and model-name formatting were deduplicated into `lib/`; dead compatibility exports removed. Behavior unchanged, `npm test` green.

---

## [0.2.3] - 2026-09-27

### Added
- `Shortcut` header tab (rightmost, after `Themes`) holding the key cheatsheet: `Esc`, `Ctrl+c/d`, `/`, `!`, `Ctrl+o`, `Ctrl+alt+t`, `Ctrl+alt+n`, `Ctrl+alt+r`. Tab order is now `Directory → Model → Context → Skills → Extensions → Themes → Shortcut`.

### Changed
- The header no longer spends a line on the shortcut legend. Line 1 greets the device username (`Welcome back, <user>`), line 2 shows `pi vX.Y.Z · Arnative vX.Y.Z` (names in the theme accent, versions dim). The tab box labels itself on its top border (`╭─ Menu ───╮`) instead of spending a text line. The Arnative version is read from the package.json of the running build, so an outdated npm install can no longer claim to be the executing code.
- The `Shortcut` tab is dropped first on narrow terminals (~<146 columns), like every rightmost tab.

---

## [0.2.2] - 2026-09-27

### Added
- `ctrl+alt+r` reload legend in the header shortcut line (`[Ctrl+alt+r] Reload`), shown from 142 columns on.

### Changed
- `Directory` is now the first header tab (and the default tab on open), so the working directory shows immediately. Tab order: `Directory → Model → Context → Skills → Extensions → Themes`.
- The `Directory` tab label is just `Directory`; the full path moved to the tab content line, shown on click.
- Model tab label uses brackets: `Model [Deepseek V4.1 Flash]` instead of `Model: Deepseek V4.1 Flash`.

### Fixed
- Click hit-areas for header tabs were off by 2 columns (tab box border + leading space were not counted), so the leftmost tab looked dead on its last 2 columns.

---

## [0.2.1] - 2026-09-27

### Fixed
- Fixed `ctrl+alt+r` reload shortcut by publishing missing extension logic to NPM registry.
- Hoisted reload shortcut key id to typed `Key.ctrlAlt("r")` with encoding assertions for both legacy ESC (`\x1b\x12`) and Kitty CSI-u (`\x1b[114;7u`).

### Added
- Added `npm run dev` script for conflict-free local live TUI testing.

---

## [0.2.0] - 2026-09-27

### Added
- Interactive header box with clickable resource tabs (`Model`, `Directory`, `Context`, `Skills`, `Extensions`, `Themes`).
- Full working directory view under the `Directory` tab (wrapped at path segments, never truncated).
- Keyboard shortcut `ctrl+alt+t` to cycle through header tabs.
- Keyboard shortcut `ctrl+alt+r` for instant runtime reload (`/reload`).
- Full `/usage` interactive dashboard modal with session/all-time token metrics and estimated costs.
- 10 expressive palette variants generated from base Arnative (`sun`, `zinc`, `violet`, `emerald`, `matrix`, `cyberpunk`, `synthwave`, `gruvbox`, `nord`, `dracula`).
- Visual rounded boxes with animated status spinners for built-in and MCP tool executions.
- Transcript timestamp clock and message bubble background repair.

### Changed
- Shortened footer working directory display to tail segments.
- Compacted compaction and status notices into single-line dimmed highlights.
- Unified theme token contrast check across all variants via automated test suite.

---

## [0.1.0] - 2026-09-24

### Added
- Initial release of `@bismawy/pi-arnative`.
- Warm-neutral base Arnative theme with cyan accents.
- Fixed 2-line status footer with real-time streaming speed (tok/s), Git branch/tag status, and token metrics.
- Boxed editor input with dim ` > ` prompt.
