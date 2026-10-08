# Changelog

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
