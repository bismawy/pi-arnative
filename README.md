# Arnative

A visual layer and tool styling tailored to your vibe coding.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-arnative)
[![badge](https://shieldcn.dev/npm/react.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-arnative)
[![license](https://shieldcn.dev/github/bismawy/pi-arnative/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-arnative)

![Arnative: tabbed header, rounded tool boxes, transcript clock and /usage dashboard](https://raw.githubusercontent.com/bismawy/pi-arnative/main/assets/pi-arnative.webp)

## Overview

pi-arnative replaces pi’s default terminal chrome with a unified, cohesive visual aesthetic.

- Warm Themes: Cohesive, contrast-checked color palettes generated without drift.
- Tabbed Header: Greeting, version line, and a compact box menu over Directory, Model, Context, Skills, Extensions, Themes, and Shortcut.
- Rounded Tool Boxes: Clear status, spinner, and duration for every tool call.
- Enhanced Footer: 2-line layout showing directory path, git branch, model, and token metrics.
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

| Key / Action | Result |
| --- | --- |
| `/usage` | Show session usage & token metrics |
| `ctrl+alt+t` (`alt+t` on Windows/WSL) | Cycle header tabs (Directory → Model → Context → Skills → Extensions → Themes → Shortcut) |
| `ctrl+alt+n` (`alt+n` on Windows/WSL) | Start a new session (`/new`) — see [Keybindings](#keybindings) |
| `ctrl+alt+r` (`alt+r` on Windows/WSL) | Quick reload runtime (`/reload`) |
| Click tab | Open selected header tab |
| Click tool / `ctrl+e` | Toggle tool output box |

Same cheatsheet in the header's **Shortcut** tab — it shows the variant your platform actually uses (on macOS `alt` reads `option`); on narrow terminals the rightmost tabs drop off first.

### Platform notes

- **Windows / WSL:** Windows Terminal ≥ 1.24 aliases every `Ctrl+Alt` combo to AltGr ([microsoft/terminal#20052](https://github.com/microsoft/terminal/pull/20052)), so the legacy `ESC` + control-byte encoding never leaves the terminal. Both variants are registered there; `alt+…` is what pi itself uses for the same reason (`alt+v` paste image, `alt+p` cycle model). Setting `"altGrAliasing": false` in your Windows Terminal profile brings `ctrl+alt+…` back.
- **macOS:** only `ctrl+option+…` is registered — plain Option composes characters (`Option+r` = ®) unless “Use Option as Meta key” is on. Works in iTerm2 and Terminal.app as-is.
- **Linux desktops:** `ctrl+alt+t` is “launch terminal” on Ubuntu/Fedora GNOME, which eats the key before pi sees it. Rebind it there if you want tab cycling.
- **Multiplexers (Herdr/tmux) + slow PTYs:** every `ctrl+alt+…` / `alt+…` shortcut is sent as `ESC` followed by a byte. pi waits only ~10 ms for that second byte before treating a lone `ESC` as the Escape key — and an Escape mid-turn aborts it, leaving a stray `r`/`t`/`n` in the editor. That is why the shortcut can look “glitchy” and why it is intermittent. Raise the window with `PI_TUI_ESC_TIMEOUT=100` in the environment that launches pi (same knob pi auto-applies over SSH, at the cost of a ~100 ms delay before a real Escape registers):

  ```powershell
  $env:PI_TUI_ESC_TIMEOUT = 100; pi
  ```

## Keybindings

`ctrl+alt+n` is a plain user keybinding, not a package shortcut — pi-arnative never registers it.
Add it once to `~/.pi/agent/keybindings.json` (the list form keeps Linux and Windows working):

```json
{
  "app.session.new": ["ctrl+alt+n", "alt+n"]
}
```

Restart pi to pick it up.

## Architecture

<details>
<summary><b>Extensions</b></summary>

| File | Role |
| --- | --- |
| `extensions/tools.ts` | Rounded tool boxes, spinners, and duration |
| `extensions/section-headers.ts` | Tabbed header and resource box |
| `extensions/footer.ts` | 2-line status footer and boxed editor |
| `extensions/timestamps.ts` | Message clock and bubble background fixes |
| `extensions/ui-render-tweaks.ts` | Contrast tweaks, selection style, and UI polish |
| `extensions/usage.ts` | `/usage` token dashboard |

</details>

<details>
<summary><b>Themes</b></summary>

- `themes/arnative.json` serves as the structure source of truth.
- `themes/gen-themes.mjs` generates variants with automated contrast checks.

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
