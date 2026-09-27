# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
