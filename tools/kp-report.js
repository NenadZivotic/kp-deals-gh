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
  const watches = [...new Set(rows.map((r) => r.watch).filter(Boolean))].sort();
  const data = rows.map((r) => ({
    t: String(r.seenAt || "")
      .slice(0, 16)
      .replace("T", " "),
    w: r.watch || "",
    n: r.name || "",
    p: r.price || "",
    e: Number.isFinite(r.priceEur) ? r.priceEur : null,
    f: r.flagClean || r.flag || "",
    sus: /⚠/.test(r.flag || "") ? 1 : 0,
    c: r.condition || "",
    l: r.location || "",
    po: r.posted || "",
    u: r.url || "",
    nt: r.note || "",
    k: r.kind || "",
    m: r.model || "",
    s:
      r.seller &&
      (r.seller.name ||
        r.seller.verified ||
        r.seller.dealerLikely ||
        (r.seller.activeAds | 0) > 0)
        ? `${r.seller.name || "?"} · +${r.seller.reviewsPos ?? "?"}/-${r.seller.reviewsNeg ?? "?"}${r.seller.verified ? " · verifikovan" : ""}${r.seller.dealerLikely ? " · dealer?" : ""}`
        : "",
  }));
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  const watchOpts = watches.map((w) => `<option>${esc(w)}</option>`).join("");
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
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:14px 0;padding:12px;background:#161b22;border-radius:8px}
.controls input,.controls select{background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:7px 10px;font-size:13px}
.controls input[type=search]{min-width:240px}
.controls label{color:#8b949e;font-size:13px;display:flex;gap:6px;align-items:center}
.pager{display:flex;gap:6px;align-items:center;margin:14px 0}
.pager button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px}
.pager button:hover{background:#30363d} .pager button.on{background:#1f6feb;border-color:#1f6feb}
.pager .info{color:#8b949e;font-size:13px;margin-left:8px}
.k{color:#d2a8ff;font-size:11px;border:1px solid #30363d;border-radius:4px;padding:1px 5px;white-space:nowrap}
.mut{color:#8b949e;font-size:12px}
</style></head><body>
<h1>KP Deals — najnoviji nalazi</h1>
<div class="sub">${rows.length} zapisa (${sus} označeno kao sumnjivo) · generisano ${esc(new Date().toLocaleString("sr-RS"))}</div>
<a class="dl" href="kp-deals.xlsx">⬇ Preuzmi Excel (kp-deals.xlsx)</a>
<a class="dl" href="kp-deals.md">⬇ Markdown izveštaj</a>
<div class="controls">
<input type="search" id="q" placeholder="Pretraga po nazivu...">
<select id="watch"><option value="">Sve kategorije</option>${watchOpts}</select>
<select id="kind"><option value="">Sve vrste</option><option>item</option><option>part</option><option>service</option><option>digital</option><option>lot</option><option>wtb</option><option>locked</option><option>excluded</option></select>
<label><input type="checkbox" id="sus"> samo sumnjivi ⚠</label>
<select id="sort"><option value="new">najnovije prvo</option><option value="cheap">jeftinije prvo (EUR)</option><option value="deep">veći popust prvo</option></select>
<select id="ps"><option value="25">25 / strana</option><option value="50" selected>50 / strana</option><option value="100">100 / strana</option><option value="0">sve</option></select>
</div>
<div class="pager" id="pg"></div>
<table><thead><tr><th>Datum</th><th>Kategorija</th><th>Naziv</th><th>Cena</th><th>Popust / medijana</th><th>Vrsta / model</th><th>Prodavac</th><th>Stanje</th><th>Lokacija</th><th>Objavljeno</th><th>Link</th><th>Napomena</th></tr></thead>
<tbody id="tb"></tbody></table>
<script>
const ROWS=${dataJson};
const $=(id)=>document.getElementById(id);
const escH=(s)=>String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
let page=0;
function filt(){
  const q=$("q").value.trim().toLowerCase(),w=$("watch").value,k=$("kind").value,sus=$("sus").checked;
  let r=ROWS.filter(x=>(!q||x.n.toLowerCase().includes(q))&&(!w||x.w===w)&&(!k||x.k===k)&&(!sus||x.sus));
  const s=$("sort").value;
  if(s==="cheap")r.sort((a,b)=>(a.e??1e9)-(b.e??1e9));
  else if(s==="deep")r.sort((a,b)=>{const g=(x)=>{const m=/([0-9]+)%/.exec(x.f);return m?+m[1]:0};return g(b)-g(a)});
  else r.sort((a,b)=>String(b.t).localeCompare(String(a.t)));
  return r;
}
function render(){
  const r=filt(),ps=+$("ps").value||r.length||1,pages=Math.max(1,Math.ceil(r.length/ps));
  if(page>=pages)page=pages-1;
  const slice=r.slice(page*ps,page*ps+ps);
  $("tb").innerHTML=slice.map(x=>'<tr class="'+(x.sus?"sus":"")+'">'+
    "<td>"+escH(x.t)+"</td><td>"+escH(x.w)+"</td><td>"+escH(x.n)+"</td>"+
    '<td class="price">'+escH(x.p)+"</td><td>"+escH(x.f)+"</td>"+
    '<td><span class="k">'+escH(x.k||"?")+"</span>"+(x.m?' <span class="mut">'+escH(x.m)+"</span>":"")+"</td>"+
    '<td class="mut">'+escH(x.s)+"</td><td>"+escH(x.c)+"</td><td>"+escH(x.l)+"</td><td>"+escH(x.po)+"</td>"+
    "<td>"+(x.u?'<a href="'+escH(x.u)+'" target="_blank" rel="noopener">otvori oglas</a>':"")+"</td>"+
    "<td>"+escH(x.nt||(x.sus?"⚠ sumnjivo":""))+"</td></tr>").join("");
  const bt=[];
  const mk=(lbl,p,dis,on)=>'<button '+(dis?"disabled ":"")+'class="'+(on?"on":"")+'" data-p="'+p+'">'+lbl+"</button>";
  bt.push(mk("‹",page-1,page===0));
  const win=2,lo=Math.max(0,page-win),hi=Math.min(pages-1,page+win);
  if(lo>0)bt.push(mk("1",0)+(lo>1?'<span class="mut">…</span>':""));
  for(let i=lo;i<=hi;i++)bt.push(mk(String(i+1),i,false,i===page));
  if(hi<pages-1)bt.push((hi<pages-2?'<span class="mut">…</span>':"")+mk(String(pages),pages-1));
  bt.push(mk("›",page+1,page>=pages-1));
  bt.push('<span class="info">'+r.length+" zapisa · strana "+(page+1)+"/"+pages+"</span>");
  $("pg").innerHTML=bt.join("");
  $("pg").querySelectorAll("button[data-p]").forEach(b=>b.onclick=()=>{page=+b.dataset.p;render()});
}
["q","watch","kind","sus","sort","ps"].forEach(id=>{$(id).oninput=()=>{page=0;render()}});
render();
</script></body></html>`;
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
