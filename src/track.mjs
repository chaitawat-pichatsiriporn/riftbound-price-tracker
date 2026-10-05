// Riftbound price tracker: fetch prices, average sources, convert to THB, append to history.
// Plain Node.js (v18+), no extra packages. Run: node src/track.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const HISTORY = path.join(DATA, "history.csv");
const LATEST = path.join(DATA, "latest.csv");

const HISTORY_COLS = ["date", "id", "finish", "name", "set", "rarity", "rifthunt_usd", "justtcg_usd", "avg_usd", "sources", "usd_thb", "avg_thb"];
const LATEST_COLS = [...HISTORY_COLS, "label", "prev_date", "prev_avg_usd", "change_pct"];

// ---------- small helpers ----------
function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

async function getJson(url, options = {}, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after")) || 30;
        console.log(`  rate limited, waiting ${wait}s`);
        await sleep(wait * 1000);
        throw new Error("HTTP 429");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < tries) await sleep(2000 * i);
    }
  }
  throw new Error(`${url} failed: ${lastErr.message}`);
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function readCsvObjects(file) {
  if (!fs.existsSync(file)) return [];
  const [head, ...rest] = parseCsv(fs.readFileSync(file, "utf8")).filter((r) => r.length > 1);
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
function writeCsv(file, cols, objs) {
  const lines = [cols.join(","), ...objs.map((o) => cols.map((c) => csvEscape(o[c])).join(","))];
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

// ---------- sources ----------
async function fetchRiftHunt() {
  const [cards, prices] = await Promise.all([
    getJson("https://api.rifthunt.com/bulk/cards"),
    getJson("https://api.rifthunt.com/bulk/prices"),
  ]);
  const byId = new Map();
  for (const c of cards.cards) if (!byId.has(c.riftboundId)) byId.set(c.riftboundId, c); // ids are sometimes duplicated
  console.log(`RiftHunt: ${byId.size} cards, ${prices.prices.length} price rows (prices fetched ${prices.fetched})`);
  return { byId, prices: prices.prices };
}

async function fetchRate() {
  try {
    const j = await getJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB");
    if (j.rates?.THB) return { rate: j.rates.THB, source: "frankfurter (ECB)" };
  } catch (e) { console.log("  frankfurter failed, trying backup:", e.message); }
  const j = await getJson("https://open.er-api.com/v6/latest/USD");
  if (!j.rates?.THB) throw new Error("No THB rate from any source");
  return { rate: j.rates.THB, source: "open.er-api.com" };
}

// JustTCG: look cards up in batches of 20 by TCGplayer product id. Returns Map tcgId -> {normal, foil}.
async function fetchJustTcg(tcgIds) {
  const key = process.env.JUSTTCG_API_KEY;
  const out = new Map();
  if (!key) { console.log("JustTCG: no JUSTTCG_API_KEY set, skipping this source"); return out; }
  const MAX_REQUESTS = 90; // free plan: 100/day, 1000/month
  const ids = [...tcgIds];
  let requests = 0, unmatched = 0;
  for (let i = 0; i < ids.length; i += 20) {
    if (requests >= MAX_REQUESTS) { console.log("JustTCG: stopping early to protect the daily limit"); break; }
    const batch = ids.slice(i, i + 20);
    let json;
    try {
      json = await getJson("https://api.justtcg.com/v1/cards", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(batch.map((id) => ({ tcgplayerId: String(id) }))),
      });
    } catch (e) {
      console.log("JustTCG batch failed:", e.message);
      if (/HTTP 40[13]/.test(e.message)) break; // bad key / over quota: no point continuing
      continue;
    } finally {
      requests++;
    }
    const list = Array.isArray(json) ? json : json.data ?? [];
    for (const card of list) {
      const id = String(card.tcgplayerId ?? "");
      if (!id) { unmatched++; continue; }
      const entry = out.get(id) ?? { normal: null, foil: null };
      for (const v of card.variants ?? []) {
        if (v.price == null) continue;
        if (!/near mint|^nm$/i.test(v.condition ?? "")) continue;
        const finish = /foil/i.test(v.printing ?? "") ? "foil" : "normal";
        entry[finish] = v.price;
      }
      out.set(id, entry);
    }
    if (i + 20 < ids.length) await sleep(7000); // free plan: 10 requests/minute
  }
  console.log(`JustTCG: ${out.size} cards priced using ${requests} requests (${unmatched} without id)`);
  return out;
}

// ---------- main ----------
async function main() {
  loadDotEnv();
  const today = new Date().toISOString().slice(0, 10);
  const { byId, prices } = await fetchRiftHunt();
  const { rate, source: rateSource } = await fetchRate();
  console.log(`USD->THB ${rate} (${rateSource})`);

  const tcgIds = new Set();
  for (const p of prices) if (p.tcgId) tcgIds.add(p.tcgId);
  const justTcg = await fetchJustTcg(tcgIds);

  const rows = [];
  for (const p of prices) {
    const card = byId.get(p.riftboundId);
    if (!card) continue;
    for (const finish of ["normal", "foil"]) {
      const rh = p.finishes?.[finish]?.market ?? null;
      const jt = justTcg.get(String(p.tcgId))?.[finish] ?? null;
      const used = [rh, jt].filter((v) => v != null);
      if (!used.length) continue; // nobody has a price for this version
      const avg = used.reduce((a, b) => a + b, 0) / used.length;
      rows.push({
        date: today, id: p.riftboundId, finish, name: card.name, set: card.set, rarity: card.rarity,
        rifthunt_usd: round(rh), justtcg_usd: round(jt), avg_usd: round(avg), sources: used.length,
        usd_thb: rate, avg_thb: round(avg * rate),
      });
    }
  }

  // Append to history (re-running on the same day replaces that day's rows).
  const history = readCsvObjects(HISTORY).filter((r) => r.date !== today);
  const newHistory = [...history, ...rows];
  writeCsv(HISTORY, HISTORY_COLS, newHistory);

  // Latest prices with change since the previous update.
  const prev = new Map(); // key -> latest earlier row
  for (const r of history) {
    const k = r.id + "|" + r.finish;
    if (!prev.has(k) || prev.get(k).date < r.date) prev.set(k, r);
  }
  const latest = rows.map((r) => {
    const p = prev.get(r.id + "|" + r.finish);
    return {
      ...r,
      label: `${r.name} [${r.id}] ${r.finish === "foil" ? "Foil" : "Normal"}`,
      prev_date: p?.date ?? "",
      prev_avg_usd: p?.avg_usd ?? "",
      change_pct: p && Number(p.avg_usd) > 0 ? round(((r.avg_usd - Number(p.avg_usd)) / Number(p.avg_usd)) * 100) : "",
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  writeCsv(LATEST, LATEST_COLS, latest);

  const both = rows.filter((r) => r.sources === 2).length;
  console.log(`Done ${today}: ${rows.length} prices written (${both} averaged from 2 sources). History now ${newHistory.length} rows.`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
