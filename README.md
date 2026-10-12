# Arnative

Refined aesthetics. Cohesive tools. Built for Pi.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-arnative)
[![badge](https://shieldcn.dev/npm/@bismawy/pi-arnative.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-arnative)
[![license](https://shieldcn.dev/github/bismawy/pi-arnative/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-arnative)

<img src="https://raw.githubusercontent.com/bismawy/pi-arnative/main/assets/pi-arnative.webp" alt="pi-arnative" width="100%">

## Overview

pi-arnative replaces pi’s default terminal chrome with a unified, cohesive visual aesthetic.

- Warm Themes: Cohesive, contrast-checked OKLCH color palettes generated without drift.
- Tabbed Header: Compact box menu showing Directory, Model, Context, Skills, Extensions, and Shortcuts.
- Rounded Tool Boxes: Status, spinner, and duration for every tool call with expandable outputs.
- Enhanced Footer: 3-row status grid tracking branch, active duration (30s idle freeze), and token speed.
- Transcript Clock: Timestamps for conversation messages with clean bubble backgrounds.
- Usage Dashboard: Real-time token counts and cost tracking across all local sessions via `/usage`.

<details>
<summary><b>Configuration & Presets</b></summary>

### Working Spinner Presets
Configurable via `/arnative` → **Animations** (saved to `arnative-config.json`):
- `Diamond Glow` (default), `Diamond Pulse`, `Circle Pulse`, `Circle Wave`, `Shade Wave`
- `Braille Column`, `Braille Level`, `Kanji Count`, `Suzhou Tally`
- `Pi (system)`, `Gemini` (Google gradient sweep), and `Claude` (pulsing marks)

### Footer Presets
Configurable via `/arnative` → **Footers**:
- `Arnative (Full)` (default 3-row grid)
- `Arnative (Minimal)` (single collapsible head row; click or `ctrl+alt+m` to toggle)
- `Pi (system)` (built-in footer)

</details>

## Install

```bash
pi install npm:@bismawy/pi-arnative
```

Apply a theme via `/settings` → **Theme** → `arnative` (or variant). Requires a [Nerd Font](https://www.nerdfonts.com/font-downloads).

To test locally:
```bash
pi --extension ./extensions/footer.ts
```

## Shortcuts

| Key (Linux / Win) | Action |
| --- | --- |
| `ctrl+alt+t` · `alt+t` | Cycle header tabs |
| `ctrl+alt+r` · `alt+r` | Quick reload (`/reload`) |
| `ctrl+alt+n` · `alt+n` | New session (`/new`) |
| `ctrl+alt+m` · `alt+m` | Toggle Minimal footer |
| `/usage` | Token & cost dashboard (or `/arnative` → **Usage**) |
| `/arnative` | Settings menu (Themes, Headers, Footers, Animations, Usage) |
| Click tool / `ctrl+o` | Toggle tool output box |
| `←` | Back — step back from submenus/dashboard to menu |

<details>
<summary><b>Keybindings & Platform Notes</b></summary>

To bind `app.session.new` in `~/.pi/agent/keybindings.json`:
```json
{
  "app.session.new": ["ctrl+alt+n", "alt+n"]
}
```

- **Windows / WSL:** Windows Terminal aliases `Ctrl+Alt` to AltGr; use `alt+…` (or disable `altGrAliasing` in WT profile).
- **macOS:** Uses `ctrl+option+…`.
- **tmux / Herdr:** If Esc has delay, set `PI_TUI_ESC_TIMEOUT=100` in your environment.
- **Navigation:** `←` navigates back to parent menus; `Esc` cancels or closes the active screen.

</details>

## Architecture

<details>
<summary><b>Extensions & Components</b></summary>

| File | Role |
| --- | --- |
| `extensions/tools.ts` | Rounded tool boxes, spinners, and duration |
| `extensions/section-headers.ts` | Tabbed header and resource box (preset: `/arnative headers`) |
| `extensions/footer.ts` | 3-row status grid footer and boxed editor (preset: `/arnative footers`) |
| `extensions/animations.ts` | Working spinner presets and `/arnative` → Animations picker |
| `lib/spinner.ts` | Spinner preset catalog: frames, cadence, and painters |
| `extensions/arnative.ts` | Settings menu with live preview and navigation |
| `extensions/timestamps.ts` | Message timestamps and bubble backgrounds |
| `extensions/ui-render-tweaks.ts` | Contrast tweaks, selection style, and UI polish |
| `extensions/usage.ts` | Token and cost dashboard (`/usage`) |

</details>

<details>
<summary><b>Theme Variants</b></summary>

Theme definitions are generated via `themes/gen-themes.mjs` using OKLCH color math (`lib/color.ts`).

**Variants:** `sun` · `zinc` · `violet` · `emerald` · `matrix` · `cyberpunk` · `synthwave` · `gruvbox` · `nord` · `dracula`

</details>

<details>
<summary><b>Development & Verification</b></summary>

```bash
npm test        # Run unit tests and self-checks
npm run themes  # Rebuild all theme variants
```

Pre-publish verification and tag validation are enforced via `scripts/release-check.mjs`.

</details>

## License

Distributed under the **MIT** license.

## Author

[Bisma](https://github.com/bismawy)
