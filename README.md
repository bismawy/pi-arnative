# Arnative

A visual layer and tool styling tailored to your vibe coding.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-arnative)
[![badge](https://shieldcn.dev/npm/react.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-arnative)
[![license](https://shieldcn.dev/github/bismawy/pi-arnative/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-arnative)

## Overview

pi-arnative replaces pi’s default terminal chrome with a unified, cohesive visual aesthetic.

- Warm Themes: Cohesive, contrast-checked color palettes generated without drift.
- Tabbed Header: Compact box menu with quick access to Model, Skills, Extensions, and Themes.
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
| `ctrl+alt+t` | Cycle header tabs (Model → Directory → Context → Skills → Extensions → Themes) |
| `ctrl+alt+r` | Quick reload runtime (`/reload`) |
| Click tab | Open selected header tab |
| Click tool / `ctrl+e` | Toggle tool output box |

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
