# pi-arnative

Paket Pi: tema aksen cyan plus footer jam dan model yang dipakai.

## Isi

- `themes/arnative.json` — salinan tema dark; ubahan: `vars.accent` jadi `#00d7ff` plus slot `tint` (`vars.softCyan` `#7db9cd`) untuk teks nilai yang lembut.
- `themes/arnative-{sun,zinc,violet,emerald}.json` — varian warna dari base yang sama (cuma beda aksen, tint, latar pesan/kotak, dan ramp `thinking*`): sun = amber hangat, zinc = netral abu, violet = ungu, emerald = hijau. Nama tema = nama berkas; semua varian diverifikasi self-check (`kontras accent >= 4.5`, warna wajib lengkap).
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

Lalu pilih tema lewat `/settings` > Theme > `arnative` (atau varian `arnative-sun`, `arnative-zinc`, `arnative-violet`, `arnative-emerald`).
Footer aktif otomatis tiap sesi dimulai.

## Struktur

```text
pi-arnative/
├── package.json          # manifest pi: extensions/*.ts, themes/*.json
├── extensions/footer.ts
├── themes/arnative.json  # + varian arnative-{sun,zinc,violet,emerald}.json
└── README.md
```
