# pi-arnative — repo rules

Global contract (`~/.pi/agent/AGENTS.md`) still applies; these are this package's specifics.

- **After changing `extensions/`, `lib/` or `themes/`, run `npm run overlay` before reporting the
  work as done.** It copies the checkout into the installed npm package and prints what moved, so the
  user's next `/reload` in pi shows the change. Do not skip it because "the code is already saved" —
  pi loads the installed copy, not this directory.
- **Never point pi at this checkout as a package** (`pi install .`, a local path in `settings.json`,
  a symlink into `node_modules`). The npm install stays the loaded package; the overlay copy is the
  whole dev loop. A second package entry registers every tool twice.
- **Verify with `npm test`** (self-checks plus `node --test`). `npm run overlay -- --dry-run` shows
  what an overlay would change without writing it.
- **`scripts/` is dev-only** (not in `files`), so overlay tooling never ships.
- **Commits:** conventional messages on a `feat/…` or `fix/…` branch, stage only intended files,
  never push `main`/`master`. Update `CHANGELOG.md` under `## [Unreleased]` for user-visible changes;
  pure dev tooling skips it.
