# KP Deals — GitHub Actions scanner

Isti KP skener kao u StarNet-u, samo sada u GitHub Actions-u i sa Telegram notifikacijama. Radi 24/7 bez da tvoj komp bude upaljen.

## Šta je preuzeto

- `tools/kp-scan.js` — glavni skener (parsira `__NEXT_DATA__`, medijana, opis-verifikaciju)
- `tools/kp-watchlist.json` — kategorije i pravila
- `tools/kp-xlsx.js` — Excel report
- `tools/notify-telegram.js` — Telegram rezime
- `tools/package.json` — `xlsx` dependency

## GitHub setup

1. Napravi **public** repo na GitHub-u i uploaduj ove fajlove.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**:
   - `TELEGRAM_BOT_TOKEN` — tvoj bot token
   - `TELEGRAM_CHAT_ID` — tvoj chat ID
3. Idi na **Actions** tab → dozvoli workflows ako pita.
4. Workflow se pokreće svakih 6 sati. Možeš i ručno: **Actions → KP Deals Scan → Run workflow**.

## Kako radi

- `kp-scan.js` čita `tools/kp-watchlist.json`, skenira KP, ažurira `research/kp-seen.json` (deduplikacija).
- Novi dealovi idu u `research/kp-deals.jsonl` + `.md` + `.xlsx`.
- `notify-telegram.js` šalje rezime.
- `stefanzweifel/git-auto-commit-action` komituje `research/*` nazad u repo — tako se dedupe pamti između pokretanja.

## Uređivanje kategorija

Izmeni `tools/kp-watchlist.json` i push-uj. Primer:

```json
{
  "name": "iPhone",
  "keywords": ["iphone 15", "iphone 16"],
  "categoryId": 23,
  "rule": { "belowMedianPct": 0.5 },
  "goodConditionsOnly": true
}
```

## Troškovi

GitHub Actions free public repo: **2000 min/mesec**. Ovaj scan traje ~3–5 min po pokretanju, svakih 6 sati = ~20 × 30 = 600–900 min/mesec — sigurno unutar free tiera.
