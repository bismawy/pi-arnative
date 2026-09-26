# pi-arnative

Paket Pi: tema aksen cyan plus footer jam dan model yang dipakai.

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
- Self-check `extensions/ui-render-tweaks.ts` memvalidasi **semua** `themes/*.json`: `name` = nama berkas, warna wajib lengkap, hex valid, dan kontras vs kanvas tema itu sendiri (konten ≥ 3.0, teks sekunder ≥ 2.0, ramp `thinking*` 1.3–4.0, pil aksen ≥ 4.5).
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
