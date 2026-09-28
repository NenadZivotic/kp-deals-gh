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

// ---- item-kind classification ----------------------------------------------
// A "ventilator za graficku" ad must never enter the whole-GPU median pool and
// must never be flagged as a cheap GPU. Title is the primary signal; the
// description (when fetched for a flagged ad) can demote a false positive.
const WTB_WORDS = ["kupujem", "trazim", "tražim", "otkup", "razmena", "menjam"];
const SERVICE_WORDS = [
  "popravka",
  "popravku",
  "servis",
  "servisiranje",
  "reballing",
  "reparacija",
  "diagnostika",
  "cipovanje",
  "čipovanje",
  "otkljucavanje",
  "otključavanje",
  "polovna dela",
  "dijagnostika",
];
const LOCKED_WORDS = [
  "icloud",
  "zakljucan",
  "zaključan",
  "crna lista",
  "crnilista",
  "mdm",
  "frp lock",
  "sim lock",
  "simlock",
  "find my iphone",
  "blokiran imei",
];
const PART_WORDS = [
  "ventilator",
  "hladnjak",
  "cooler",
  "kuler",
  "kuciste",
  "kućište",
  "riser",
  "rajzer",
  "braket",
  "nosac",
  "nosač",
  "maska",
  "poklopac",
  "kutija",
  "futrola",
  "torbica",
  "zastit",
  "zaštit",
  "staklo za",
  "folija",
  "kabl",
  "punjac",
  "punjač",
  "adapter",
  "baterij",
  "ekran za",
  "matrica",
  "tipkovnica",
  "delovi za",
  "rezervni del",
  "kais",
  "kaiš",
  "narukvica",
  "kalup",
  "slot",
  "backplate",
  "dioda",
  "kondenzator",
  "termalna pasta",
  "stalak",
  "postolje",
  "drzac",
  "držač",
  "torba",
  "konektor",
  "port ",
  " cip ",
  " chip",
  "pcb",
  "ploca",
  "ploča",
  "modul",
  "traka",
  "ciscenje",
  "čišćenje",
  "komplet za",
  "kapak",
  "mrezica",
  "mrežica",
  "kalem",
  " stand",
  "led osvetljenje",
  "sajla",
  "kaciga",
  "zaslon",
  "remen",
  "membrana",
  "nalepnic",
  "stiker",
  "igla za",
  "glava za",
  "pribor",
  "korpus",
  "krilo za",
];
const DIGITAL_WORDS = [
  "gift card",
  "giftcard",
  "psn",
  "ps plus",
  "playstation plus",
  "dopune",
  "dopuna",
  "wallet",
  "pretplata",
  "aktivacija",
  "game pass",
  "gamepass",
  " nalog",
  " account",
  " kljuc ",
  " ključ ",
  " key ",
  "v-bucks",
  "robux",
];
const LOT_WORDS = [
  "za delove",
  "za rezervne delove",
  "partsku",
  "komplet delova",
  "lot oglasa",
];

function classifyItem(name, desc, watch) {
  const title = " " + String(name || "").toLowerCase() + " ";
  const all = title + " " + String(desc || "").toLowerCase();
  if (watch && watch.exclude) {
    try {
      if (new RegExp(watch.exclude, "i").test(title)) return "excluded";
    } catch (_) {}
  }
  if (WTB_WORDS.some((w) => title.includes(w))) return "wtb";
  if (SERVICE_WORDS.some((w) => title.includes(w))) return "service";
  if (DIGITAL_WORDS.some((w) => title.includes(w))) return "digital";
  if (LOT_WORDS.some((w) => all.includes(w))) return "lot";
  if (LOCKED_WORDS.some((w) => all.includes(w))) return "locked";
  if (PART_WORDS.some((w) => title.includes(w))) return "part";
  return "item";
}

// Bucket key for median comparison — same MODEL, not same query. A watch can
// declare modelPatterns (regexes); first match wins and is normalized. Fallback:
// KP's own groupName, then generic "brand + numeric model token" extraction.
function modelKey(name, watch) {
  const title = " " + String(name || "").toLowerCase() + " ";
  const pats =
    watch && Array.isArray(watch.modelPatterns) ? watch.modelPatterns : [];
  for (const p of pats) {
    try {
      const m = title.match(new RegExp(p, "i"));
      if (m) return m[0].replace(/\s+/g, " ").trim();
    } catch (_) {}
  }
  // generic "brand + numeric token" extraction only when the watch declared no
  // patterns — in a model-driven watch a leftover title is safer under the
  // KP groupName bucket than under a junk token like "bicikl 26"
  if (pats.length) return null;
  const m = title.match(/([a-zšđčćž]{3,})\s*([a-z]{0,5}\d{2,4}[a-z]{0,4})/i);
  return m ? (m[1] + " " + m[2]).trim() : null;
}
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

// ---- session / anti-stripping ----------------------------------------------
// From datacenter IPs (GitHub Actions, Apify) KP serves a stripped page with no
// initialReduxState.search.byId until the request carries the session cookie
// that a first response sets. Warm the jar once, retry twice, then refresh.
const KP_ORIGIN = "https://www.kupujemprodajem.com";
const cookieJar = new Map();
let cookieGeneration = 0;

const cookieHeader = () =>
  [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

function ingestSetCookie(headers) {
  const all =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") || "").split(/,(?=\s*[^;,\s]+=)/);
  for (const raw of all) {
    const pair = String(raw).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) cookieJar.set(name, value);
    else cookieJar.delete(name);
  }
}

async function fetchHtml(url) {
  const generation = cookieGeneration;
  const headers = {
    "User-Agent": UA[Math.floor(Math.random() * UA.length)],
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
    "Accept-Language": "sr-RS,sr;q=0.9,en;q=0.8",
    Referer: KP_ORIGIN + "/",
    "Sec-Ch-Ua":
      '"Chromium";v="131", "Google Chrome";v="131", "Not?A_Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (generation === cookieGeneration) ingestSetCookie(res.headers);
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
  return body;
}

function parseNextData(body) {
  const m = body.match(
    /<script[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/,
  );
  if (!m) throw new Error("no __NEXT_DATA__ — layout changed or block page");
  return JSON.parse(m[1]);
}

// KP renamed the slot from initialState to initialReduxState; check both.
const reduxState = (d) => {
  const p = (d && d.props) || {};
  return p.initialReduxState || p.initialState || {};
};

async function fetchPage(url) {
  return parseNextData(await fetchHtml(url));
}

let warmupPromise = null;
async function ensureWarmedUp() {
  if (cookieJar.size > 0) return;
  if (!warmupPromise)
    warmupPromise = fetchHtml(KP_ORIGIN + "/")
      .catch(() => {})
      .finally(() => {
        warmupPromise = null;
      });
  return warmupPromise;
}
async function refreshSession() {
  cookieGeneration += 1;
  cookieJar.clear();
  await fetchHtml(KP_ORIGIN + "/");
}

// stripped = search slice missing or byId absent; an empty byId is a real
// zero-result query and must not be retried as a block. EXCEPT: KP also
// answers soft rate-limits with a structurally valid but empty search page
// (byId={}, total=0) instead of a 403. A legit-empty page is retried once
// after a longer pause and flagged _emptySuspect so the report can warn.
async function fetchSearch(url) {
  await ensureWarmedUp();
  let s = reduxState(await fetchPage(url)).search;
  if (!s || !s.byId) {
    await sleep(150);
    s = reduxState(await fetchPage(url)).search;
  }
  if (!s || !s.byId) {
    await refreshSession();
    s = reduxState(await fetchPage(url)).search;
  }
  if (!s || !s.byId) {
    const e = new Error("KP stripped page persisted after session refresh");
    e.antiBot = true;
    throw e;
  }
  if (!s.total && !Object.keys(s.byId).length) {
    await sleep(jitter([3000, 6000]));
    const again = reduxState(await fetchPage(url)).search;
    if (again && again.byId) s = again;
    if (!s.total && !Object.keys(s.byId).length) s._emptySuspect = true;
  }
  return s;
}

async function adDescription(url) {
  await ensureWarmedUp();
  for (let i = 0; i < 3; i++) {
    const st = reduxState(await fetchPage(url));
    const byId = st.ad && st.ad.byId;
    const ad = byId && byId[Object.keys(byId)[0]];
    if (ad) return stripHtml(ad.description);
    if (i === 0) await sleep(150);
    else if (i === 1) await refreshSession();
  }
  return "";
}

function searchUrl(w) {
  if (w.url) return w.url;
  const u = new URL("https://www.kupujemprodajem.com/pretraga");
  if (w.keywords) u.searchParams.set("keywords", w.keywords);
  if (w.categoryId) u.searchParams.set("categoryId", String(w.categoryId));
  if (w.groupId) u.searchParams.set("groupId", String(w.groupId));
  if (w.priceFrom != null) u.searchParams.set("priceFrom", String(w.priceFrom));
  if (w.priceTo != null) u.searchParams.set("priceTo", String(w.priceTo));
  if (w.currency) u.searchParams.set("currency", w.currency);
  for (const c of [].concat(w.condition || []))
    u.searchParams.append("condition", c);
  if (w.keywordsScope) u.searchParams.set("keywordsScope", w.keywordsScope);
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
  const prev = readJson(LATEST_FILE, null);
  const prevTotals = {};
  if (prev && Array.isArray(prev.watches))
    for (const pw of prev.watches) prevTotals[pw.name] = pw.total;
  const now = new Date().toISOString();
  const report = { scannedAt: now, watches: [], flagged: [], errors: [] };

  for (const w of cfg.watches) {
    const queries = Array.isArray(w.keywords) ? w.keywords : [w.keywords];
    const byId = {};
    let total = null;
    let sawSuspect = false;
    for (const kw of queries) {
      const url = searchUrl({ ...w, keywords: kw });
      log(`scanning ${w.name} [${kw}]: ${url}`);
      try {
        const s = await fetchSearch(url);
        if (s._emptySuspect) sawSuspect = true;
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
    const suspect =
      (ads.length === 0 && (prevTotals[w.name] || 0) > 0) || sawSuspect;
    report.watches.push({
      name: w.name,
      queries: queries.length,
      fetched: ads.length,
      total,
      ...(suspect ? { suspectEmpty: true } : {}),
    });
    if (suspect) {
      console.error(
        `[kp] ${w.name}: 0 oglasa, prošli scan je imao ${prevTotals[w.name]} — moguć soft-block`,
      );
      report.errors.push({
        watch: w.name,
        error: `empty result (prethodno ${prevTotals[w.name]}) — verovatno soft-block`,
      });
    }

    // medians: same-item pools only. Parts, services, WTB and locked ads are
    // excluded so a "ventilator za rtx" listing cannot drag the GPU median.
    // Bucket = extracted model key (per-watch modelPatterns, else KP groupName,
    // else generic brand+model token). A bucket needs >=4 samples.
    const groups = {};
    const kindCache = {};
    for (const ad of ads) {
      const kind = classifyItem(ad.name, null, w);
      kindCache[ad.id] = kind;
      if (kind !== "item") continue;
      const g = modelKey(ad.name, w) || ad.groupName || "_";
      const p = eurPrice(ad, rate);
      if (p != null) (groups[g] = groups[g] || []).push(p);
    }
    const groupMed = {};
    for (const g of Object.keys(groups))
      if (groups[g].length >= 4) groupMed[g] = median(groups[g]);
    const queryMed =
      w.allowQueryMedian === true
        ? median(ads.map((a) => eurPrice(a, rate)).filter(Number.isFinite))
        : null;

    for (const ad of ads) {
      const id = String(ad.id);
      if (seen.ids[id]) continue;
      seen.ids[id] = now;
      const priceEur = eurPrice(ad, rate);
      if (priceEur == null) continue;
      if (w.goodConditionsOnly !== false && !isGoodCondition(ad)) continue;

      const kind = kindCache[ad.id] || classifyItem(ad.name, null, w);
      const mk = modelKey(ad.name, w) || ad.groupName || "_";
      const med = groupMed[mk] || queryMed;
      let flag = null;
      // belowMedian only makes sense for a whole item vs its same-model bucket.
      // Parts/services/wtb/locked/lots skip the comparison entirely — they were
      // also excluded from the median pool above.
      if (
        kind === "item" &&
        w.rule &&
        w.rule.belowMedianPct != null &&
        med != null
      ) {
        const off = 1 - priceEur / med;
        if (priceEur <= med * w.rule.belowMedianPct)
          flag =
            off > 0.8
              ? `⚠ ${Math.round(off * 100)}% ispod medijana — moguca prevara/decoy (~${med.toFixed(0)}€ ${mk})`
              : `${Math.round(off * 100)}% ispod medijana (~${med.toFixed(0)}€ ${mk})`;
      } else if (
        !flag &&
        (kind === "item" || w.flagNonItem === true) &&
        w.rule &&
        w.rule.underPrice != null
      ) {
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
          kind,
          model: mk === "_" ? null : mk,
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
          favorites: ad.favoriteCount ?? null,
          fixedPrice: ad.isPriceFixed === true,
          exchange: ad.isExchange === true,
          seller:
            ad.user && typeof ad.user === "object"
              ? {
                  name: ad.user.username || null,
                  reviewsPos: ad.user.reviewsPositive ?? null,
                  reviewsNeg: ad.user.reviewsNegative ?? null,
                  verified:
                    ad.user.hasUserVerifiedBankAccount === true ||
                    ad.user.hasCompanyVerifiedBankAccount === true,
                  activeAds: ad.user.userActiveAdCount ?? null,
                }
              : null,
          url: "https://www.kupujemprodajem.com" + (ad.adUrl || `/oglas/${id}`),
        };
        // high-volume sellers are usually dealers even without a price-list desc
        if (f.seller && (f.seller.activeAds || 0) >= 30)
          f.seller.dealerLikely = true;
        // description verification — headline price is often bait; real prices live in the ad body
        try {
          const desc = await adDescription(f.url);
          // re-classify with the description: title "RTX 3070" + body
          // "prodajem ventilator sa 3070" is a part, not a deal.
          const dKind = classifyItem(f.name, desc, w);
          if (dKind !== "item" && kind === "item" && !w.flagNonItem) {
            log(`  demoted ${id} (${f.name}) item -> ${dKind}`);
            f = null;
          }
          const ps = f ? descPrices(desc, rate) : [];
          if (f) f.descPrices = ps;
          if (!f) {
            // demoted by description — nothing else to verify
          } else if (ps.length >= 3) {
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

module.exports = {
  descPrices,
  stripHtml,
  adDescription,
  classifyItem,
  modelKey,
  fetchSearch,
  searchUrl,
};
