/* kp-report.js — publishes the KP scan results as a StarNet WORKSHOP DELIVERABLE.
   Writes workshop/kp-report/ (index.html + kp-deals.xlsx + kp-deals.md + deliverable.json)
   and stamps a builtRunId into ../researcher.workshop.json so the report shows up in
   WORK → DELIVERABLES with an OPEN action — one click in the app. */
"use strict";
const FS = require("node:fs");
const P = require("node:path");

const ROOT = P.resolve(__dirname, "..");
const WORKSPACES = P.resolve(ROOT, "..");
const AGENT = "researcher";
const RUN_ID = "kp-report";
const RUN_DIR = P.join(ROOT, "workshop", RUN_ID);
const BACKLOG_FILE = P.join(WORKSPACES, AGENT + ".workshop.json");
const BACKLOG_ID = "kp-report";

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function loadRows() {
  const f = P.join(ROOT, "research", "kp-deals.jsonl");
  if (!FS.existsSync(f)) return [];
  return FS.readFileSync(f, "utf8")
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

function html(rows) {
  const sus = rows.filter((r) => /⚠/.test(r.flag || "")).length;
  const rowsHtml = rows
    .map((r) => {
      const bad = /⚠/.test(r.flag || "");
      return `<tr class="${bad ? "sus" : ""}">
<td>${esc(
        String(r.seenAt || "")
          .slice(0, 16)
          .replace("T", " "),
      )}</td>
<td>${esc(r.watch)}</td>
<td>${esc(r.name)}</td>
<td class="price">${esc(r.price)}</td>
<td>${esc(r.flagClean || r.flag)}</td>
<td>${esc(r.condition)}</td>
<td>${esc(r.location)}</td>
<td>${esc(r.posted)}</td>
<td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">otvori oglas</a>` : ""}</td>
<td>${esc(r.note || (bad ? "⚠ sumnjivo" : ""))}</td>
</tr>`;
    })
    .join("\n");
  return `<!doctype html><html lang="sr"><head><meta charset="utf-8"><title>KP Deals</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;background:#0d1117;color:#e6edf3;margin:24px}
h1{font-size:20px} .sub{color:#8b949e;margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{background:#161b22;color:#79c0ff;text-align:left;padding:8px;position:sticky;top:0}
td{padding:7px 8px;border-bottom:1px solid #21262d;vertical-align:top}
tr:hover{background:#161b22} tr.sus{background:#2d1f00} tr.sus:hover{background:#3a2800}
a{color:#58a6ff} .price{white-space:nowrap;font-weight:600;color:#3fb950}
.dl{display:inline-block;margin:4px 16px 16px 0;padding:8px 14px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none}
</style></head><body>
<h1>KP Deals — najnoviji nalazi</h1>
<div class="sub">${rows.length} zapisa (${sus} označeno kao sumnjivo) · generisano ${esc(new Date().toLocaleString("sr-RS"))}</div>
<a class="dl" href="kp-deals.xlsx">⬇ Preuzmi Excel (kp-deals.xlsx)</a>
<a class="dl" href="kp-deals.md">⬇ Markdown izveštaj</a>
<table><thead><tr><th>Datum</th><th>Kategorija</th><th>Naziv</th><th>Cena</th><th>Popust / medijana</th><th>Stanje</th><th>Lokacija</th><th>Objavljeno</th><th>Link</th><th>Napomena</th></tr></thead>
<tbody>
${rowsHtml}
</tbody></table></body></html>`;
}

function ensureBacklog() {
  let rec = null;
  try {
    rec = JSON.parse(FS.readFileSync(BACKLOG_FILE, "utf8"));
  } catch (_) {}
  if (!rec || typeof rec !== "object") rec = {};
  if (!Array.isArray(rec.backlog)) rec.backlog = [];
  const it = rec.backlog.find((b) => b && b.id === BACKLOG_ID);
  if (it) {
    it.builtRunId = RUN_ID;
    it.builtAt = Date.now();
    delete it.buildingRunId;
  } else {
    rec.backlog.push({
      id: BACKLOG_ID,
      title: "KP Deals — dnevni izveštaj",
      detail:
        "Automatski generisan pregled jeftinih oglasa sa KupujemProdajem (skener svakih 30 min).",
      source: "routine",
      ts: Date.now(),
      builtRunId: RUN_ID,
      builtAt: Date.now(),
    });
  }
  FS.writeFileSync(BACKLOG_FILE, JSON.stringify(rec, null, 2));
}

function build() {
  const rows = loadRows();
  FS.mkdirSync(RUN_DIR, { recursive: true });

  // copy current reports into the run dir
  for (const name of ["kp-deals.xlsx", "kp-deals.md"]) {
    const src = P.join(ROOT, "research", name);
    if (FS.existsSync(src)) FS.copyFileSync(src, P.join(RUN_DIR, name));
  }
  FS.writeFileSync(P.join(RUN_DIR, "index.html"), html(rows));

  const files = ["index.html", "kp-deals.xlsx", "kp-deals.md"]
    .map((name) => {
      const abs = P.join(RUN_DIR, name);
      return FS.existsSync(abs)
        ? { path: name, bytes: FS.statSync(abs).size }
        : null;
    })
    .filter(Boolean);

  FS.writeFileSync(
    P.join(RUN_DIR, "deliverable.json"),
    JSON.stringify(
      {
        v: 1,
        runId: RUN_ID,
        agentId: AGENT,
        backlogId: BACKLOG_ID,
        title: "KP Deals — izveštaj",
        kind: "doc",
        summary:
          "Pregled jeftinih oglasa sa KupujemProdajem. Otvori index.html za tabelu u browseru ili preuzmi Excel.",
        files,
        howToUse: "Otvori index.html ili kp-deals.xlsx",
        notVerified: [],
      },
      null,
      2,
    ),
  );

  ensureBacklog();
  return { rows: rows.length, dir: RUN_DIR };
}

if (require.main === module) {
  const r = build();
  console.log("kp-report published:", r.rows, "rows ->", r.dir);
}
module.exports = { build };
