<div align="center">

# pi-arnative

An arnative look for [pi](https://github.com/earendil-works/pi-coding-agent) — 11 warm-neutral themes, rounded tool boxes, a branded header with clickable tabs, a 2-line footer, a transcript clock, and a `/usage` dashboard.

[pi package](https://pi.dev/packages/@bismawy/pi-arnative) · [npm](https://www.npmjs.com/package/@bismawy/pi-arnative) · [Issues](https://github.com/bismawy/pi-arnative/issues)

![npm](https://img.shields.io/npm/v/@bismawy/pi-arnative)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

## What it does

pi-arnative replaces pi's chrome with one visual language — box drawing, dim borders, cyan accent, tint for values — without touching session data.

- **11 themes, one generator:** `arnative` plus 10 variants (`sun`, `zinc`, `violet`, `emerald`, `matrix`, `cyberpunk`, `synthwave`, `gruvbox`, `nord`, `dracula`), all generated from a single base file so their structure can never drift.
- **Header box with tabs:** replaces pi's stacked resource list with a 5-line box — logo, version + shortcuts, and a clickable `Model / Directory / Context / Skills / Extensions / Themes` tab menu. The `Directory` tab shows the full working directory (wrapped at `/`, never truncated).
- **Tool boxes:** every tool call renders in its own rounded box — spinner while running, then `✓`/`x`, right-aligned duration, and a one-line summary. Click or `ctrl+e` for the full output.
- **2-line footer:** `cwd | duration | branch/tag/status` on the first line, extension status + tok/s + cache + tokens on the second, plus a full-box editor with a `> ` prompt.
- **Transcript clock:** user and assistant messages get a right-aligned time, and the user bubble background is repaired where Markdown resets would otherwise leave black blocks.
- **Render fixes:** hidden reload box, readable drag selection, single-line compaction messages, and a higher-contrast `↓ Jump to latest message` pill.
- **Contrast-checked themes:** the self-check measures every `themes/*.json` against its own canvas, so no variant ships an unreadable box.

## Install

**Install [JetBrains Mono Nerd Font](https://www.nerdfonts.com/font-downloads) first.** Every icon in this package (tab icons `󰋖 󰺨 󰰡 󰹲`, tool icons `󰔟 󱞩 ✓`, footer icons `󰃭 󰍛 󰣇`, and the rounded box corners `╭─╮`) is a Nerd Font glyph — without the font they render as empty boxes (□) or random characters.

1. Download **JetBrainsMono Nerd Font** from [nerdfonts.com/font-downloads](https://www.nerdfonts.com/font-downloads).
2. Extract and install it (Linux: copy into `~/.local/share/fonts/` then `fc-cache -f`; Windows: right click → Install).
3. Set your terminal to **JetBrainsMono NF** (or another Nerd Font) as the primary font.

```bash
pi install npm:@bismawy/pi-arnative
```

Pick a theme in `/settings` > Theme > `arnative` (or any `arnative-*` variant). Everything else — header, footer, tool boxes, clock — turns itself on at session start.

To try it without installing, from this directory:

```bash
pi --extension ./extensions/footer.ts
```

## Commands

| Command | Action |
| :--- | :--- |
| `/usage` | Token, message & cache usage across all local Pi sessions |

| Shortcut | Action |
| :--- | :--- |
| `ctrl+alt+t` | Cycle the header tab (Model → Directory → Context → Skills → Extensions → Themes) |
| click a header tab | Open that tab |
| click a tool box / `ctrl+e` | Toggle full title and output |

## How it works

<details>
<summary><b>Extensions</b></summary>

| File | Role |
| :--- | :--- |
| `extensions/tools.ts` | Tool call boxes, summaries, spinner, duration, per-tool backgrounds |
| `extensions/section-headers.ts` | Header box, logo, tab menu, and the interception of pi's resource list |
| `extensions/footer.ts` | 2-line footer and the full-box editor |
| `extensions/timestamps.ts` | Transcript clock and user bubble background repair |
| `extensions/ui-render-tweaks.ts` | Reload box, drag selection, compaction, Jev review box, contrast self-check |
| `extensions/usage.ts` | `/usage` table dashboard |

`lib/box.ts` and `lib/ansi.ts` hold the single definitions shared by all of them. They live outside `extensions/` so pi never loads them as extensions.

</details>

<details>
<summary><b>Themes</b></summary>

- `themes/arnative.json` is both the default theme and the structure source of truth — it is never rewritten by the generator.
- `themes/gen-themes.mjs` holds the palette table and writes the variants by text substitution on the base, so the original formatting is preserved.
- `npm run themes` rewrites every variant; `npm test` runs the same generator in `--check` mode, so a hand-edited variant file cannot drift.
- Every variant fills all `vars`/`colors`/`export` keys, so no color can silently inherit the base.

Palette: `sun` warm amber · `zinc` neutral grey · `violet` purple · `emerald` green · `matrix` monochrome phosphor green on near-black · `cyberpunk` neon magenta/cyan on deep indigo · `synthwave` 80s retro · `gruvbox` warm retro · `nord` cool frost blue · `dracula` dark purple.

Contrast rules enforced by the self-check (measured against each theme's own `userMessageBg` canvas): content ≥ 3.0, secondary text ≥ 2.0, `thinking*` ramp 1.3–4.0, accent pill ≥ 4.5, tool box text ≥ 4.5 on both success and error backgrounds, error box weight matched to the success box, and `scrollbarThumb` / `searchMatchBg` distinguishable from their track / selection.

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm test        # every self-check + theme generator --check
npm run themes  # rewrite all theme variants
```

Each extension is also a standalone self-check: `node extensions/tools.ts`.

</details>

## License

Distributed under the **MIT** license.

## Developer

Developed and maintained by [Bisma](https://github.com/bismawy).
