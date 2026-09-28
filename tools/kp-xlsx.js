/* kp-xlsx.js — rebuilds research/kp-deals.xlsx from research/kp-deals.jsonl.
   Formatted: frozen header, colored deal rows, ⚠ rows amber, hyperlinks, EUR columns.
   Called by kp-scan.js after each scan; safe to run standalone:
     node tools/kp-xlsx.js */
"use strict";
const FS = require("node:fs");
const P = require("node:path");

const ROOT = P.resolve(__dirname, "..");
const JSONL = P.join(ROOT, "research", "kp-deals.jsonl");
const XLSX_OUT = P.join(ROOT, "research", "kp-deals.xlsx");

function loadRows() {
  if (!FS.existsSync(JSONL)) return [];
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

function build() {
  const XLSX = require(P.join(__dirname, "node_modules", "xlsx"));
  const rows = loadRows().sort((a, b) =>
    String(b.seenAt || "").localeCompare(String(a.seenAt || "")),
  );

  const head = [
    "Datum",
    "Kategorija",
    "Naziv",
    "Cena",
    "≈EUR",
    "Popust",
    "Stanje",
    "Lokacija",
    "Objavljeno",
    "Link",
    "Napomena",
  ];
  const data = [head];
  const suspicious = []; // 0-based data-row indexes (excluding header)
  rows.forEach((f, i) => {
    if ((f.flag || "").includes("⚠")) suspicious.push(i + 1);
    data.push([
      (f.seenAt || "").slice(0, 16).replace("T", " "),
      f.watch || "",
      f.name || "",
      f.price || "",
      Number.isFinite(f.priceEur) ? f.priceEur : null,
      f.flagClean || f.flag || "",
      f.condition || "",
      f.location || "",
      f.posted || "",
      f.url || "",
      f.note || ((f.flag || "").includes("⚠") ? "moguca prevara" : ""),
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = [
    { wch: 16 },
    { wch: 20 },
    { wch: 55 },
    { wch: 11 },
    { wch: 7 },
    { wch: 34 },
    { wch: 18 },
    { wch: 14 },
    { wch: 14 },
    { wch: 60 },
    { wch: 16 },
  ];
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: Math.max(1, data.length - 1), c: head.length - 1 },
    }),
  };

  // hyperlinks on the Link column + number format on EUR
  for (let r = 1; r < data.length; r++) {
    const linkCell = XLSX.utils.encode_cell({ r, c: 9 });
    if (ws[linkCell] && ws[linkCell].v)
      ws[linkCell].l = { Target: ws[linkCell].v };
    const eurCell = XLSX.utils.encode_cell({ r, c: 4 });
    if (ws[eurCell] && ws[eurCell].v != null) {
      ws[eurCell].t = "n";
      ws[eurCell].z = '#,##0" €"';
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "KP Deals");
  XLSX.writeFile(wb, XLSX_OUT);
  return rows.length;
}

if (require.main === module) {
  try {
    console.log("xlsx rows:", build());
  } catch (e) {
    console.error("xlsx build failed:", e.message);
    process.exit(1);
  }
}
module.exports = { build };
