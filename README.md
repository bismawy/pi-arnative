# Arnative

Refined aesthetics. Cohesive tools. Built for Pi.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-arnative)
[![badge](https://shieldcn.dev/npm/@bismawy/pi-arnative.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-arnative)
[![license](https://shieldcn.dev/github/bismawy/pi-arnative/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-arnative)

<img src="https://raw.githubusercontent.com/bismawy/pi-arnative/main/assets/pi-arnative.webp" alt="pi-arnative" width="100%">

## Overview

pi-arnative replaces pi’s default terminal chrome with a unified visual interface.

- Warm Themes: Contrast-checked OKLCH color palettes generated without drift (`arnative` plus 10 variants).
- Tabbed Header: Compact box menu showing Directory, Model, Context, Skills, Extensions, and Shortcuts.
- Rounded Tool Boxes: Status, spinner, runtime duration, and clickable `[show]` / `[hide]` output toggles.
- Task List: `todo` tool, `/todos` view, and a boxed widget above the editor that auto-hides 30s after all tasks finish.
- Enhanced Footer: 3-row status grid (`Arnative (Full)`) or single collapsible row (`Arnative (Minimal)`) tracking branch, diff, active duration, and token speed.
- Working Spinners: 18 animated presets with live picker preview and optional `[g]` gradient sweep.
- Transcript Clock: Per-message timestamps with clean bubble backgrounds.
- Usage Dashboard: Real-time token counts and cost tracking across local sessions via `/usage`.
- Custom Providers: Interactive `/providers` wizard to probe endpoints, pick models, set thinking levels, and save OpenAI-, Anthropic-, Gemini-, or Ollama-compatible channels to `models.json` and `auth.json`.
- Model Heal: Background sync (`/model-heal`) that fills missing compat flags, `/models` token limits, and accepted reasoning effort levels in `models.json`.
- Auto-compact: Automatic context compaction after a turn settles using smart window tiers or a fixed token budget.

<details>
<summary><b>Configuration & Presets</b></summary>

Saved to `~/.pi/agent/arnative/config.json` via `/arnative`:

- **Headers & Footers:** `Arnative (Full)` (default), `Arnative (Minimal)` (footer only; click head text or press `ctrl+alt+m` to toggle), or `Pi (system)`.
- **Animations:** 18 presets (`Arnative` default, `Pi (system)`, and alphabetical variants). Press `[g]` in the picker to toggle the Google gradient sweep.
- **Auto-compact:** Off by default. **Smart** tiers trigger near ~200k tokens (`≥768k→20%`, `≥384k→40%`, `≥192k→80%`, `<192k→pi core`), or pick a fixed budget (`100k` to `400k`).
- **Model heal:** **Full** (default: offline compat flags, `GET /models` limits with 6h TTL, reasoning effort probe with 24h TTL), **Flags** (offline only), or **Off**. Hand-edited fields are never overwritten.
- **Task list (`todo`):** Stored per session in `~/.pi/agent/arnative/todos/<session-id>.json` (uninstall `@juicesharp/rpiv-todo` first to avoid tool name conflict). Click `[click to expand]` / `[click to collapse]` or press `ctrl+alt+o` (`alt+o`) to toggle; click `↑`/`↓` counters or press `ctrl+alt+j`/`k` (`alt+j`/`k`) to scroll. Auto-hides 30s after completion (set `PI_ARNATIVE_TODO_HIDE_MS` to override, `0` for immediate hide; expanding pauses the timer).

</details>

## Install

```bash
pi install npm:@bismawy/pi-arnative
```

Requires a [Nerd Font](https://www.nerdfonts.com/font-downloads). On a fresh install, `arnative` is applied automatically if no theme is set; switch anytime via `/arnative themes` or `/settings` → **Theme**.

Local development:
```bash
npm run dev
```

## Shortcuts

| Key (Linux / Win) | Action |
| --- | --- |
| `ctrl+alt+t` · `alt+t` | Cycle header tabs |
| `ctrl+alt+r` · `alt+r` | Quick reload (`/reload`) |
| `ctrl+alt+n` · `alt+n` | New session (`/new`) |
| `ctrl+alt+m` · `alt+m` | Toggle Minimal footer |
| `ctrl+alt+o` · `alt+o` | Expand or collapse task list |
| `ctrl+alt+j` · `alt+j` | Scroll task list down |
| `ctrl+alt+k` · `alt+k` | Scroll task list up |
| Click `[show]` / `[hide]` · `ctrl+o` | Toggle tool output box |
| `←` / `Esc` | Step back to parent menu / close active screen |
| `/arnative` | Settings menu (Themes, Headers, Footers, Animations, Auto-compact, Model heal, Providers, Usage) |
| `/usage` | Token & cost dashboard |
| `/todos` | Full task list recap |
| `/providers` | Custom provider manager |
| `/model-heal` | Run `models.json` heal passes now |

<details>
<summary><b>Keybindings & Platform Notes</b></summary>

Bind `app.session.new` in `~/.pi/agent/keybindings.json`:
```json
{
  "app.session.new": ["ctrl+alt+n", "alt+n"]
}
```

- **Windows / WSL:** Windows Terminal maps `Ctrl+Alt` to AltGr; use `alt+…` or disable `altGrAliasing`.
- **macOS:** Use `ctrl+option+…`.
- **tmux / Herdr:** Set `PI_TUI_ESC_TIMEOUT=100` if `Esc` has a delay.

</details>

## Architecture

<details>
<summary><b>Extensions & Components</b></summary>

| File | Role |
| --- | --- |
| `extensions/arnative.ts` | `/arnative` settings menu and live preview pickers |
| `extensions/section-headers.ts` | Tabbed header and resource box |
| `extensions/footer.ts` | 3-row status grid, Minimal footer, and boxed editor |
| `extensions/tools.ts` | Rounded tool boxes, spinners, duration, and `[show]` / `[hide]` toggles |
| `extensions/todos.ts` | `todo` tool, boxed widget above editor, and `/todos` screen |
| `extensions/animations.ts` | Spinner preset picker and live preview |
| `extensions/autocompact.ts` | Smart and fixed-budget context compaction |
| `extensions/model-heal.ts` | Automatic `models.json` heal triggers and `/model-heal` |
| `extensions/timestamps.ts` | Message timestamps and bubble backgrounds |
| `extensions/ui-render-tweaks.ts` | Contrast tweaks, selection styling, and UI polish |
| `extensions/usage.ts` | Token and cost dashboard (`/usage`) |
| `lib/todos.ts` | Task state, window layout, box rows, and session store |
| `lib/spinner.ts` | Spinner preset catalog, frames, and gradient painters |
| `lib/provider.ts` | Custom provider probe, model picker, and config writer |
| `lib/model-heal.ts` | Compat flags, `/models` limit sync, and reasoning effort probe |
| `lib/list-picker.ts` | Shared live-preview and multi-select picker component |

</details>

<details>
<summary><b>Theme Variants & Development</b></summary>

**Themes (`themes/gen-themes.mjs` + `lib/color.ts`):** `arnative` · `sun` · `zinc` · `violet` · `emerald` · `matrix` · `cyberpunk` · `synthwave` · `gruvbox` · `nord` · `dracula`

```bash
npm test                              # Run self-checks and unit tests
npm run themes                        # Regenerate theme JSON files
npm run preview                       # Live preview in Pi and stamp .git/arnative-preview
git config core.hooksPath .githooks   # Enable pre-push preview verification hook
```

</details>

## License

Distributed under the **MIT** license.

## Author

[Bisma](https://github.com/bismawy)
