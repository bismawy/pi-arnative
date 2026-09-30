# Changelog

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
