# pi-arnative

Paket Pi: tema aksen cyan plus footer jam dan model yang dipakai.

## Isi

- `themes/arnative-cyan.json` — salinan tema dark, satu-satunya ubahan `vars.accent` jadi `#00d7ff`.
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

Lalu pilih tema lewat `/settings` > Theme > `arnative-cyan`.
Footer aktif otomatis tiap sesi dimulai.

## Struktur

```text
pi-arnative/
├── package.json          # manifest pi: extensions/*.ts, themes/*.json
├── extensions/footer.ts
├── themes/arnative-cyan.json
└── README.md
```
