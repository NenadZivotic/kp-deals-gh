/* kp-judge.js — optional semantic second pass over flagged KP deals.
   Calls OpenRouter's Decisions API (respan/span-01-lite:free) — a scoring
   model, not a chat model. For each flagged ad it answers typed questions in
   plain language and returns calibrated probabilities. Needs
   OPENROUTER_API_KEY; without it this module is a silent no-op so CI/local
   runs degrade to heuristic-only behavior.

   Usage:  called automatically by kp-scan.js when the key is present.
           node tools/kp-judge.js            — judge rows in research/kp-deals.jsonl (last scan)
   Cost:   one Decisions call per flagged ad (~0.3s). Free-tier cap lives in
           the watchlist: "judgeMaxPerScan". */

"use strict";
const FS = require("node:fs");
const P = require("node:path");

const ROOT = P.resolve(__dirname, "..");

// .env is optional and gitignored; Node >=20.6 has this built in.
try {
  process.loadEnvFile(P.join(ROOT, ".env"));
} catch (_) {}

const KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = "respan/span-01-lite:free";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const VERBOSE =
  process.argv.includes("--verbose") || process.env.KP_VERBOSE === "1";

const log = (...a) => {
  if (VERBOSE) console.error("[judge]", ...a);
};

const QUESTIONS = {
  whole_item: {
    type: "noul",
    instructions:
      "Is this classified ad selling the complete item itself — not a spare part, accessory, repair service, subscription, gift card, or a wanted/exchange post? The ad may be in Serbian.",
  },
  title_price_real: {
    type: "noul",
    instructions:
      "Is the headline price the actual full price of the item — not a bait price, a price for a different cheaper variant, an installment, a deposit, or 'price in description'?",
  },
  scam_risk: {
    type: "noul",
    instructions:
      "Does this listing look like a scam, fake, or decoy — unrealistically cheap for what it claims to be, mislabeled, or misleading?",
  },
  good_deal: {
    type: "noul",
    instructions:
      "Is this a genuinely attractive deal — the real item, at a clearly below-market price, worth buying for personal use or resale?",
  },
};

function answerValue(a) {
  if (!a || typeof a !== "object") return null;
  if (a.noul != null) return a.noul; // noul answers carry probability under .noul
  if (a.value != null) return a.value;
  if (a.probability != null) return a.probability;
  if (a.answer != null) return a.answer;
  return null;
}

async function decide(state) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`decisions HTTP ${res.status}: ${t.slice(0, 200)}`);
    if (res.status === 429) e.rateLimited = true;
    throw e;
  }
  const d = await res.json();
  const ans = d.answers || d;
  const out = {};
  for (const k of Object.keys(QUESTIONS)) {
    const a = ans[k];
    out[k] = {
      type: a && a.type,
      value: answerValue(a),
    };
    // choice answers carry the picked option label somewhere obvious
    if (a && a.choice != null) out[k].value = a.choice;
    if (a && a.label != null) out[k].value = a.label;
  }
  return out;
}

// Respan requires state to be a plain string or a conversation object —
// serialize the ad as labeled text lines.
function buildState(f) {
  const lines = [
    `Naslov oglasa: ${f.name}`,
    `Cena: ${f.price}`,
    `Kategorija: ${f.watch}`,
    f.model ? `Detektovani model: ${f.model}` : null,
    `Stanje: ${f.condition}`,
    `Lokacija: ${f.location}`,
    `Heuristika: ${f.flag}`,
    f.seller && (f.seller.name || f.seller.activeAds)
      ? `Prodavac: ${f.seller.name || "?"} (aktivnih oglasa: ${f.seller.activeAds ?? "?"}, verifikovan: ${f.seller.verified ? "da" : "ne"})`
      : null,
    f._desc ? `Opis: ${f._desc.slice(0, 2000)}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function applyVerdict(f, v) {
  const p = (x) => (typeof x === "number" ? x : null);
  const whole = p(v.whole_item && v.whole_item.value);
  const real = p(v.title_price_real && v.title_price_real.value);
  const scam = p(v.scam_risk && v.scam_risk.value);
  f.verdict = {
    wholeItem: whole,
    priceReal: real,
    scamRisk: scam,
    goodDeal: p(v.good_deal && v.good_deal.value),
  };
  const deal = f.verdict.goodDeal;
  const notes = [];
  if (whole != null && whole < 0.35)
    notes.push("LLM: verovatno NIJE cela stvar");
  if (real != null && real < 0.4) notes.push("LLM: naslovna cena sumnjiva");
  if (scam != null && scam > 0.6) notes.push("LLM: visok rizik prevare");
  if (deal != null && deal < 0.15)
    notes.push("LLM: nije posebna prilika (cena verovatno tržišna)");
  if (notes.length) {
    f.note = (f.note ? f.note + " | " : "") + notes.join(" | ");
    f._score = (f._score ?? 1) + 1.5; // sink below verified deals
  } else if (
    whole != null &&
    whole > 0.8 &&
    (scam == null || scam < 0.3) &&
    (deal == null || deal > 0.4)
  ) {
    f.note = (f.note ? f.note + " | " : "") + "LLM potvrda: deluje ok";
  }
}

/**
 * Judge an array of flagged deal objects in place. Returns # judged, or 0 when
 * no API key is configured. Never throws on per-ad failures — worst case the
 * flag ships without a verdict.
 */
async function judge(flags, opts = {}) {
  if (!KEY) return 0;
  const max = opts.max ?? 12;
  const targets = flags.slice(0, max);
  let done = 0;
  for (const f of targets) {
    try {
      const v = await decide(buildState(f));
      applyVerdict(f, v);
      done++;
      log(
        `${f.name.slice(0, 50)} -> item=${f.verdict.wholeItem} real=${f.verdict.priceReal} scam=${f.verdict.scamRisk} deal=${f.verdict.goodDeal}`,
      );
    } catch (e) {
      console.error(`[judge] ${f.id}: ${e.message}`);
      if (e.rateLimited) break; // free tier exhausted — keep what we have
      f.verdictError = e.message;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return done;
}

if (require.main === module) {
  (async () => {
    if (!KEY) {
      console.error("OPENROUTER_API_KEY missing — put it in .env");
      process.exit(1);
    }
    const f = P.join(ROOT, "research", "kp-deals.jsonl");
    const rows = FS.existsSync(f)
      ? FS.readFileSync(f, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
    const sample = rows.slice(-5);
    console.log(`judging last ${sample.length} rows...`);
    const n = await judge(sample, { max: 5 });
    for (const r of sample)
      console.log(r.name.slice(0, 55), "=>", JSON.stringify(r.verdict || null));
    console.log("judged:", n);
  })();
}

module.exports = { judge, decide };
