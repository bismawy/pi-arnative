# pi-arnative

Paket Pi: tema aksen cyan plus footer jam dan model yang dipakai.

## Prasyarat

**Install [JetBrains Mono Nerd Font](https://www.nerdfonts.com/font-downloads) dulu sebelum memakai paket ini.**

Seluruh ikon di paket ini (ikon tab header `󰋖 󰺨 󰰡 󰹲`, ikon tool `󰔟 󱞩 ✓`, ikon footer `󰃭 󰍛 󰣇`, logo kotak, sudut kotak bulat `╭─╮`) adalah glyph Nerd Font — tanpa font ini ikon tampil sebagai kotak kosong (□) atau karakter acak.

Pasang:
1. Unduh **JetBrainsMono Nerd Font** dari [nerdfonts.com/font-downloads](https://www.nerdfonts.com/font-downloads).
2. Ekstrak lalu install font-nya (Linux: salin ke `~/.local/share/fonts/` lalu `fc-cache -f`; Windows: klik kanan → Install).
3. Set terminal Anda memakai **JetBrainsMono NF** (atau varian Nerd Font lain) sebagai font utama.

## Isi

- `themes/arnative.json` — salinan tema dark; ubahan: `vars.accent` jadi `#00d7ff` plus slot `tint` (`vars.softCyan` `#7db9cd`) untuk teks nilai yang lembut.
- `themes/gen-themes.mjs` — generator semua varian: sumber struktur = `themes/arnative.json`, sumber palet = tabel `PALET` di berkas itu. `npm run themes` menulis ulang berkas varian; `npm test` menjalankan mode `--check` sehingga JSON tak bisa melenceng dari generator.
- `themes/arnative-*.json` — varian warna (semuanya dari base yang sama; tiap tema mengisi penuh vars/colors/export, jadi tak ada warna yang diam-diam mewarisi base):
  - `sun` amber hangat · `zinc` netral abu · `violet` ungu · `emerald` hijau
  - `matrix` hijau fosfor monokrom di kanvas hampir hitam
  - `cyberpunk` neon magenta/cyan di indigo pekat
  - `synthwave` retro 80-an (pink neon + cyan, kanvas ungu tua)
  - `gruvbox` retro hangat (emas + aqua + merah bata)
  - `nord` dingin (frost blue + aurora)
  - `dracula` ungu gelap (pink + mint)
- Self-check `extensions/ui-render-tweaks.ts` memvalidasi **semua** `themes/*.json`: `name` = nama berkas, warna wajib lengkap, tiap nilai `colors` wajib hex/var yang benar-benar ada, dan kontras vs kanvas tema itu sendiri (konten ≥ 3.0, teks sekunder ≥ 2.0, ramp `thinking*` 1.3–4.0, pil aksen ≥ 4.5). Khusus: teks isi kotak tool ≥ 4.5 di latar sukses **dan** error, pesan error ≥ 4.5 di kotak error, latar kotak error sepadan bobotnya dengan kotak sukses, `scrollbarThumb` ≠ `scrollbarTrack`, dan `searchMatchBg` ≠ `selectedBg`.

## Perbaikan kontras base (2026-09-26)

Base `arnative` (dan ikut ke semua varian) diperbaiki berdasarkan pengukuran, bukan selera:

| Sebelum | Sesudah | Efek |
| :--- | :--- | :--- |
| `gray` `#808080` | `#8d8d8d` | teks isi kotak tool 3.48–3.81 → **4.53** (AA); ikut memperbaiki `muted`, `mdQuote`, `mdHr`, `thinkingText`, `toolDiffContext` |
| `red` `#cc6666` | `#d07272` | pesan error di kotak error 3.71 → **4.53**; di kanvas 4.05 → 4.53 |
| `toolErrorBg` `#3c2828` | `#342222` | bobot kotak error sepadan kotak sukses (L .026 → .020 vs .020) |
| `scrollbarTrack`/`Thumb` = `#7db9cd` | `#505050` / `#8d8d8d` | thumb terlihat di atas track (sebelumnya identik) |
| `searchMatchBg` = `selectedBg` | `#386168` (var `searchBg`) | highlight pencarian beda dari seleksi; teks 4.60 |
- `extensions/footer.ts` — footer `jam | model-id`, tanpa timer. Jam dibaca saat render dan disegarkan tiap perubahan branch.

## Coba langsung

```bash
pi --extension ./extensions/footer.ts
```

## Install sebagai paket

Dari direktori induk paket ini:

```bash
pi install ./pi-arnative
```

Lalu pilih tema lewat `/settings` > Theme > `arnative` (atau salah satu varian `arnative-*`).
Footer aktif otomatis tiap sesi dimulai.

## Struktur

```text
pi-arnative/
├── package.json          # manifest pi: extensions/*.ts, themes/*.json; script themes/test
├── extensions/*.ts
├── themes/arnative.json  # tema default
├── themes/arnative-*.json # 10 varian (lihat daftar di atas)
├── themes/gen-themes.mjs # generator varian
└── README.md
```
