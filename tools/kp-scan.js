/* kp-scan.js — KupujemProdajem deal scanner (zero deps, Node 18+).
   Reads tools/kp-watchlist.json, fetches search pages with gentle pacing,
   parses __NEXT_DATA__ (search.byId), dedupes against research/kp-seen.json,
   flags deals per watch rule, appends to research/kp-deals.md, writes
   research/kp-latest.json.

   Usage:  node tools/kp-scan.js            — normal scan
           node tools/kp-scan.js --verbose  — log every step
   Exit:   0 ok · 2 anti-bot/block detected · 1 error */

"use strict";
const FS = require("node:fs");
const P = require("node:path");

const ROOT = P.resolve(__dirname, "..");
const WATCH_FILE = P.join(ROOT, "tools", "kp-watchlist.json");
const SEEN_FILE = P.join(ROOT, "research", "kp-seen.json");
const DEALS_FILE = P.join(ROOT, "research", "kp-deals.md");
const JSONL_FILE = P.join(ROOT, "research", "kp-deals.jsonl");
const LATEST_FILE = P.join(ROOT, "research", "kp-latest.json");
const VERBOSE = process.argv.includes("--verbose");

const log = (...a) => {
  if (VERBOSE) console.error("[kp]", ...a);
};
const UA = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = ([lo, hi]) => lo + Math.floor(Math.random() * (hi - lo));

function readJson(f, fb) {
  try {
    return JSON.parse(FS.readFileSync(f, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(f, o) {
  FS.mkdirSync(P.dirname(f), { recursive: true });
  FS.writeFileSync(f, JSON.stringify(o, null, 2));
}

const BAD_CONDITIONS = [
  "neispravan",
  "neispravno",
  "ostecen",
  "oštećen",
  "za delove",
  "za rezervne delove",
  "pokvaren",
];
const isGoodCondition = (ad) => {
  const c = String(ad.condition || "").toLowerCase();
  return !BAD_CONDITIONS.some((b) => c.includes(b));
};
const eurPrice = (ad, rate) => {
  const n = Number(ad.priceNumber ?? ad.price);
  if (!Number.isFinite(n) || n <= 0) return null;
  return ad.currencyAcronym === "rsd" ? n / rate : n; // eur/din-normalized
};
const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// KP dealers put a bait headline price (e.g. "99€") and the real price list in the
// description. Extract every "N€", "N eur", "Ne", "N rsd/din" token from text.
const PRICE_RE =
  /(\d[\d.,]*\d|\d)\s*(€|eur\b|evra\b|euro\b|rsd\b|dinara\b|din\b|e\b)/gi;
function descPrices(text, rate) {
  const out = [];
  let m;
  PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text))) {
    let n = Number(m[1].replace(/[.,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (/^(rsd|din)/i.test(m[2])) n = n / rate;
    if (n < 10 || n > 50000) continue;
    if (m[2].toLowerCase() === "e" && n < 25 && m[1].length < 3) continue; // "17e" = model name, not price
    out.push(Math.round(n));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
const stripHtml = (s) =>
  String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function adDescription(url) {
  const d = await fetchPage(url);
  const byId =
    d.props &&
    d.props.initialReduxState &&
    d.props.initialReduxState.ad &&
    d.props.initialReduxState.ad.byId;
  const ad = byId && byId[Object.keys(byId)[0]];
  return ad ? stripHtml(ad.description) : "";
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA[Math.floor(Math.random() * UA.length)],
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
      "Accept-Language": "sr-RS,sr;q=0.9,en;q=0.8",
      Referer: "https://www.kupujemprodajem.com/",
    },
    redirect: "follow",
  });
  const body = await res.text();
  if (
    res.status === 403 ||
    res.status === 429 ||
    /Just a moment|cf-chl-|challenge-platform|provera da niste robot/i.test(
      body,
    )
  ) {
    const e = new Error(`anti-bot: HTTP ${res.status}`);
    e.antiBot = true;
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const m = body.match(
    /id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]+?)<\/script>/,
  );
  if (!m) throw new Error("no __NEXT_DATA__ — layout changed or block page");
  return JSON.parse(m[1]);
}

function searchUrl(w) {
  if (w.url) return w.url;
  const u = new URL("https://www.kupujemprodajem.com/pretraga");
  if (w.keywords) u.searchParams.set("keywords", w.keywords);
  if (w.categoryId) u.searchParams.set("categoryId", String(w.categoryId));
  return u.toString();
}

async function main() {
  const cfg = readJson(WATCH_FILE, null);
  if (!cfg || !Array.isArray(cfg.watches)) {
    console.error("watchlist missing/invalid");
    process.exit(1);
  }
  const rate = cfg.eurToRsd || 117;
  const delay = Array.isArray(cfg.delayBetweenRequestsMs)
    ? cfg.delayBetweenRequestsMs
    : [4000, 9000];
  const seen = readJson(SEEN_FILE, { ids: {}, scannedAt: null });
  const now = new Date().toISOString();
  const report = { scannedAt: now, watches: [], flagged: [], errors: [] };

  for (const w of cfg.watches) {
    const queries = Array.isArray(w.keywords) ? w.keywords : [w.keywords];
    const byId = {};
    let total = null;
    for (const kw of queries) {
      const url = searchUrl({ ...w, keywords: kw });
      log(`scanning ${w.name} [${kw}]: ${url}`);
      try {
        const data = await fetchPage(url);
        const s =
          data.props &&
          data.props.initialReduxState &&
          data.props.initialReduxState.search;
        const page =
          s && s.byId ? s.adsIds.map((id) => s.byId[id]).filter(Boolean) : [];
        if (s && s.total != null) total = Math.max(total || 0, s.total);
        for (const a of page) byId[a.id] = a;
        log(`  ${page.length} ads (total ${s ? s.total : "?"})`);
      } catch (e) {
        report.errors.push({ watch: w.name, query: kw, error: e.message });
        console.error(`[kp] ${w.name} [${kw}]: ${e.message}`);
        if (e.antiBot) {
          writeJson(SEEN_FILE, seen);
          writeJson(LATEST_FILE, report);
          process.exit(2);
        }
      }
      await sleep(jitter(delay)); // pacing — polite client
    }
    const ads = Object.values(byId);
    report.watches.push({
      name: w.name,
      queries: queries.length,
      fetched: ads.length,
      total,
    });

    // medians: per KP groupName when a bucket has enough samples (a query mixes models),
    // else the whole query's median.
    const groups = {};
    for (const ad of ads) {
      const g = ad.groupName || "_";
      const p = eurPrice(ad, rate);
      if (p != null) (groups[g] = groups[g] || []).push(p);
    }
    const groupMed = {};
    for (const g of Object.keys(groups))
      if (groups[g].length >= 4) groupMed[g] = median(groups[g]);
    const queryMed = median(
      ads.map((a) => eurPrice(a, rate)).filter(Number.isFinite),
    );

    for (const ad of ads) {
      const id = String(ad.id);
      if (seen.ids[id]) continue;
      seen.ids[id] = now;
      const priceEur = eurPrice(ad, rate);
      if (priceEur == null) continue;
      if (w.goodConditionsOnly !== false && !isGoodCondition(ad)) continue;

      const med = groupMed[ad.groupName || "_"] || queryMed;
      let flag = null;
      if (w.rule && w.rule.belowMedianPct != null && med != null) {
        const off = 1 - priceEur / med;
        if (priceEur <= med * w.rule.belowMedianPct)
          flag =
            off > 0.8
              ? `⚠ ${Math.round(off * 100)}% ispod medijana — moguca prevara/decoy (~${med.toFixed(0)}€ ${ad.groupName || "grupa"})`
              : `${Math.round(off * 100)}% ispod medijana (~${med.toFixed(0)}€ ${ad.groupName || "grupa"})`;
      }
      if (!flag && w.rule && w.rule.underPrice != null) {
        const cur = (w.rule.priceCurrency || "eur").toLowerCase();
        const p = cur === "rsd" ? priceEur * rate : priceEur;
        if (p <= w.rule.underPrice)
          flag = `ispod praga ${w.rule.underPrice} ${cur.toUpperCase()}`;
      }
      if (flag) {
        let f = {
          id,
          watch: w.name,
          name: ad.name,
          flag,
          flagClean: String(flag)
            .replace(/^⚠\s*/, "")
            .replace(" — moguca prevara/decoy", ""),
          seenAt: now,
          _score:
            med != null && priceEur <= med
              ? priceEur / med
              : priceEur / ((w.rule && w.rule.underPrice) || priceEur),
          price: `${ad.price} ${ad.currencyAcronym === "rsd" ? "RSD" : "EUR"}`,
          priceEur: Math.round(priceEur),
          condition: ad.condition || "?",
          location: ad.location || ad.locationName || "?",
          posted: ad.postedDesc || ad.postedRaw || "?",
          views: ad.viewCount || "?",
          url: "https://www.kupujemprodajem.com" + (ad.adUrl || `/oglas/${id}`),
        };
        // description verification — headline price is often bait; real prices live in the ad body
        try {
          const desc = await adDescription(f.url);
          const ps = descPrices(desc, rate);
          f.descPrices = ps;
          if (ps.length >= 3) {
            // dealer price-list ad: headline is bait for the cheapest/imaginary unit
            f.dealer = true;
            f.flag = `⚠ dealer cenovnik — ${ps.length} cena u opisu (${ps[0]}–${ps[ps.length - 1]}€); naslovna cena mamac`;
            f.flagClean = `dealer cenovnik (${ps[0]}–${ps[ps.length - 1]}€) — naslovna cena mamac`;
            f.note = `prave cene u opisu: ${ps.slice(0, 8).join(", ")}€`;
            f._score = 2; // sink to bottom of the per-watch ranking
          } else if (
            ps.length &&
            Math.abs(ps[0] - priceEur) / priceEur > 0.15
          ) {
            const real = ps[0];
            f.note = `naslovna ${Math.round(priceEur)}€ → opis ~${real}€`;
            const thr =
              w.rule && w.rule.belowMedianPct != null && med != null
                ? med * w.rule.belowMedianPct
                : (w.rule && w.rule.underPrice) || 0;
            if (real <= thr) {
              f.priceEur = real;
              f._score = med != null ? real / med : real / thr;
              f.flag =
                med != null
                  ? `${Math.round((1 - real / med) * 100)}% ispod medijana (~${med.toFixed(0)}€) — cena potvrdjena u opisu`
                  : f.flag + " — cena potvrdjena u opisu";
              f.flagClean = f.flag;
            } else {
              f = null; // naslovna cena bila mamac — nije dil
            }
          } else {
            f.note = "cena potvrdjena u opisu";
          }
        } catch (e) {
          if (e.antiBot) {
            report.flagged.push(f);
            writeJson(SEEN_FILE, seen);
            writeJson(LATEST_FILE, report);
            process.exit(2);
          }
          f.note = /404/.test(e.message)
            ? "oglas više nije aktivan (404)"
            : "opis nije proveren: " + e.message;
        }
        if (f) report.flagged.push(f);
        await sleep(jitter(delay)); // pacing for detail-page fetches too
      }
    }
  }

  // prune seen set older than 45 days
  const cutoff = Date.now() - 45 * 864e5;
  for (const [id, ts] of Object.entries(seen.ids))
    if (new Date(ts) < cutoff) delete seen.ids[id];
  seen.scannedAt = now;
  writeJson(SEEN_FILE, seen);
  writeJson(LATEST_FILE, report);

  if (report.flagged.length) {
    // best-first per watch, capped — a first-scan backlog must not flood the review list
    const perWatch = cfg.maxFlagsPerWatch ?? 8;
    const keep = [];
    const byWatch = {};
    for (const f of report.flagged)
      (byWatch[f.watch] = byWatch[f.watch] || []).push(f);
    for (const g of Object.values(byWatch)) {
      g.sort((a, b) => (a._score ?? 9) - (b._score ?? 9));
      keep.push(...g.slice(0, perWatch));
    }
    report.flagged = keep;
    report.flaggedTotal = Object.values(byWatch).reduce(
      (n, g) => n + g.length,
      0,
    );

    let md = FS.existsSync(DEALS_FILE)
      ? FS.readFileSync(DEALS_FILE, "utf8")
      : "# KP Deals\n";
    md += `\n## Scan ${now.slice(0, 16).replace("T", " ")} — ${keep.length} novih (ukupno pogodaka: ${report.flaggedTotal})\n\n`;
    for (const f of keep) {
      md += `- **[${f.watch}] ${f.name}** — ${f.price} (~${f.priceEur}€) · ${f.flag} · ${f.condition} · ${f.location} · ${f.posted}\n  ${f.url}\n`;
    }
    FS.writeFileSync(DEALS_FILE, md);
    // durable log + formatted Excel report
    FS.appendFileSync(
      JSONL_FILE,
      keep.map((f) => JSON.stringify(f)).join("\n") + "\n",
    );
    try {
      require(P.join(__dirname, "kp-xlsx.js")).build();
      require(P.join(__dirname, "kp-report.js")).build();
    } catch (e) {
      console.error("[kp] report rebuild failed:", e.message);
    }
  }
  console.log(
    JSON.stringify({
      ok: true,
      flagged: report.flagged.length,
      errors: report.errors.length,
      watches: report.watches.length,
    }),
  );
}

if (require.main === module)
  main().catch((e) => {
    console.error("[kp] fatal:", e.message);
    process.exit(1);
  });

module.exports = { descPrices, stripHtml, adDescription };
