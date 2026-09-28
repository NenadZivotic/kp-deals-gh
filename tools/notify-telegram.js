// Sends a Telegram summary based on research/kp-latest.json.
// Exit code 0 regardless of Telegram result so the workflow does not fail on notifications.
"use strict";
const FS = require("node:fs");
const P = require("node:path");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const LATEST = P.resolve(__dirname, "..", "research", "kp-latest.json");

function fmt() {
  let r;
  try {
    r = JSON.parse(FS.readFileSync(LATEST, "utf8"));
  } catch (e) {
    return `🔔 KP Scan — izveštaj nije generisan (${e.message})`;
  }
  const seenAt = r.scannedAt ? new Date(r.scannedAt).toLocaleString("sr-RS") : "?";
  const flagged = r.flagged || [];
  const sus = flagged.filter((f) => /⚠/.test(f.flag || "")).length;
  const good = flagged.length - sus;
  const lines = [
    `🔔 *KP Deals* — ${seenAt}`,
    `${good} novih dealova` + (sus ? ` (+${sus} sumnjivih ⚠)` : ""),
    "",
  ];
  const byWatch = {};
  for (const f of flagged) (byWatch[f.watch] = byWatch[f.watch] || []).push(f);
  for (const [watch, items] of Object.entries(byWatch)) {
    items.sort((a, b) => (a._score ?? 9) - (b._score ?? 9));
    const f = items[0];
    lines.push(
      `• [${watch}] ${(f.name || "").slice(0, 50)} — ${f.price || "?"} (${f.flagClean || f.flag || ""})`,
    );
  }
  if (!flagged.length) lines.push("Nema novih dealova ispod praga u ovom prolazu.");
  return lines.join("\n");
}

async function send(text) {
  if (!TOKEN || !CHAT) {
    console.log("TELEGRAM_BOT_TOKEN/CHAT_ID not set, skipping");
    return;
  }
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("telegram send failed:", err);
  } else {
    console.log("telegram sent ok");
  }
}

send(fmt()).catch((e) => console.error(e.message));
