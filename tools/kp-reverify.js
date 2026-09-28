/* kp-reverify.js — one-off cleanup pass over research/kp-deals.jsonl.
   Fetches each ad's detail page, reads the description, and rewrites rows whose
   headline price was bait (dealer price-lists, hidden real price).
   Usage: node tools/kp-reverify.js */
"use strict";
const FS = require("node:fs");
const P = require("node:path");
const { descPrices, adDescription } = require("./kp-scan.js");

const ROOT = P.resolve(__dirname, "..");
const JSONL = P.join(ROOT, "research", "kp-deals.jsonl");
const RATE = 117;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
  return FS.readFileSync(JSONL, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main() {
  const rows = load();
  console.log(`re-verifying ${rows.length} rows...`);
  let dealers = 0,
    corrected = 0,
    confirmed = 0,
    failed = 0;
  const out = [];
  for (const f of rows) {
    if (f.dealerVerified) {
      out.push(f);
      continue;
    }
    try {
      const desc = await adDescription(f.url);
      const ps = descPrices(desc, RATE);
      f.descPrices = ps;
      if (ps.length >= 3) {
        f.dealer = true;
        f.flag = `⚠ dealer cenovnik — ${ps.length} cena u opisu (${ps[0]}–${ps[ps.length - 1]}€); naslovna cena mamac`;
        f.flagClean = `dealer cenovnik (${ps[0]}–${ps[ps.length - 1]}€) — naslovna cena mamac`;
        f.note = `prave cene u opisu: ${ps.slice(0, 8).join(", ")}€`;
        dealers++;
      } else if (
        ps.length &&
        Number.isFinite(f.priceEur) &&
        Math.abs(ps[0] - f.priceEur) / f.priceEur > 0.15
      ) {
        f.note = `naslovna ${f.priceEur}€ → opis ~${ps[0]}€`;
        f.flag = `⚠ naslovna cena mamac — u opisu ~${ps[0]}€`;
        f.flagClean = `naslovna cena mamac — opis ~${ps[0]}€`;
        corrected++;
      } else if (ps.length) {
        f.note = "cena potvrdjena u opisu";
        confirmed++;
      } else {
        f.note = "nema cena u opisu — naslovna neverifikovana";
      }
      f.dealerVerified = true;
    } catch (e) {
      f.note = "opis nije proveren: " + e.message;
      failed++;
      if (e.antiBot) {
        console.error("anti-bot hit — stopping, partial results saved");
        out.push(f);
        out.push(...rows.slice(out.length));
        FS.writeFileSync(JSONL, out.map((x) => JSON.stringify(x)).join("\n") + "\n");
        process.exit(2);
      }
    }
    out.push(f);
    process.stdout.write(".");
    await sleep(1500 + Math.floor(Math.random() * 2500));
  }
  FS.writeFileSync(JSONL, out.map((x) => JSON.stringify(x)).join("\n") + "\n");
  console.log(
    `\ndone: ${dealers} dealer price-lists, ${corrected} bait prices corrected, ${confirmed} confirmed, ${failed} failed`,
  );
  require("./kp-xlsx.js").build();
  require("./kp-report.js").build();
  console.log("xlsx + deliverable rebuilt");
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
