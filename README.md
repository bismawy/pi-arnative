# Arnative

Refined aesthetics. Cohesive tools. Built for Pi.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-arnative)
[![badge](https://shieldcn.dev/npm/@bismawy/pi-arnative.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-arnative)
[![license](https://shieldcn.dev/github/bismawy/pi-arnative/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-arnative)

![Arnative: tabbed header, rounded tool boxes, transcript clock and /usage dashboard](https://raw.githubusercontent.com/bismawy/pi-arnative/main/assets/pi-arnative.webp)

## Overview

pi-arnative replaces pi’s default terminal chrome with a unified, cohesive visual aesthetic.

- Warm Themes: Cohesive, contrast-checked color palettes generated without drift.
- Tabbed Header: Greeting, version line, and a compact box menu over Directory, Model, Context, Skills, Extensions, and Shortcut.
- Rounded Tool Boxes: Clear status, spinner, and duration for every tool call. Built-in `codemode` is boxed and collapsed to two rows (title + first script line) like `bash`/`grep`/`read`; nested calls and output sit behind `[ctrl+o to expand]`.
- Enhanced Footer: fixed 3-row grid — directory/git line, then extension status paired with token metrics.
- Transcript Clock: Timestamps for messages with clean bubble backgrounds.
- Usage Dashboard: /usage command to track tokens and session costs.

## Install

```bash
pi install npm:@bismawy/pi-arnative
```

Select a theme via `/settings` → **Theme** → `arnative` (or any `arnative-*` variant).

To test locally without installing:
```bash
pi --extension ./extensions/footer.ts
```
> **Prerequisite:** Requires a [Nerd Font](https://www.nerdfonts.com/font-downloads) (e.g. JetBrains Mono Nerd Font) for icons and rounded box borders.

## Shortcuts

| Key (Linux / Win) | Action |
| --- | --- |
| `ctrl+alt+t` · `alt+t` | Cycle header tabs |
| `ctrl+alt+r` · `alt+r` | Quick reload (`/reload`) |
| `ctrl+alt+n` · `alt+n` | New session (`/new`) — requires keybinding below |
| `/usage` | Show session usage & token metrics |
| `/arnative` | Settings menu — Themes, Headers, Footers |
| Click tab | Open selected header tab |
| Click tool / `ctrl+e` | Toggle tool output box |

> **Notes:**
> - **Windows / WSL:** Windows Terminal aliases `Ctrl+Alt` to AltGr; use `alt+…` (or set `"altGrAliasing": false` in WT profile).
> - **macOS:** uses `ctrl+option+…` (plain Option composes special characters).
> - **Herdr / tmux glitch:** if shortcuts feel delayed or type stray letters, set `PI_TUI_ESC_TIMEOUT=100` in your shell profile.

### Keybindings

Add to `~/.pi/agent/keybindings.json` to bind `app.session.new`:

```json
{
  "app.session.new": ["ctrl+alt+n", "alt+n"]
}
```

## Architecture

<details>
<summary><b>Extensions</b></summary>

| File | Role |
| --- | --- |
| `extensions/tools.ts` | Rounded tool boxes, spinners, and duration |
| `extensions/section-headers.ts` | Tabbed header and resource box (preset: `/arnative headers`) |
| `extensions/footer.ts` | 3-row status grid footer and boxed editor (preset: `/arnative footers`) |
| `extensions/arnative.ts` | `/arnative` settings menu — live-preview theme/header/footer pickers |
| `extensions/timestamps.ts` | Message clock and bubble background fixes |
| `extensions/ui-render-tweaks.ts` | Contrast tweaks, selection style, and UI polish |
| `extensions/usage.ts` | `/usage` token dashboard |

</details>

<details>
<summary><b>Themes</b></summary>

- `themes/gen-themes.mjs` is the single source of truth: it **writes every** `themes/*.json`, including the base `arnative.json`.
- Each theme is a few parameters (accent hue, chroma, canvas lightness, neutral tint) plus optional hue overrides for the strong palettes; all colors are derived as OKLCH from a shared ramp, so lightness/saturation stay consistent and no two `vars` collapse to the same value.
- `lib/color.ts` holds the OKLCH↔sRGB math and WCAG contrast used by both the generator and the self-check.

**Variants:** `sun` · `zinc` · `violet` · `emerald` · `matrix` · `cyberpunk` · `synthwave` · `gruvbox` · `nord` · `dracula`

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm test        # Run self-checks & theme generator check
npm run themes  # Rebuild all theme variants
```

</details>

## License

Distributed under the **MIT** license.

## Author

[Bisma](https://github.com/bismawy)
