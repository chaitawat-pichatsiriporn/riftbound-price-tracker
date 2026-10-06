// Riftbound price tracker: fetch prices, average sources, convert to THB, append to history.
// Plain Node.js (v18+), no extra packages. Run: node src/track.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const HISTORY = path.join(DATA, "history.csv");
const LATEST = path.join(DATA, "latest.csv");

const HISTORY_COLS = ["date", "id", "finish", "name", "set", "rarity", "rifthunt_usd", "justtcg_usd", "cardmarket_eur", "cardmarket_usd", "avg_usd", "sources", "usd_thb", "usd_eur", "avg_thb"];
const LATEST_COLS = [...HISTORY_COLS, "label", "prev_date", "prev_avg_usd", "change_pct", "image_url"];

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
    const j = await getJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB,EUR");
    if (j.rates?.THB && j.rates?.EUR) return { rate: j.rates.THB, eur: j.rates.EUR, source: "frankfurter (ECB)" };
  } catch (e) { console.log("  frankfurter failed, trying backup:", e.message); }
  const j = await getJson("https://open.er-api.com/v6/latest/USD");
  if (!j.rates?.THB || !j.rates?.EUR) throw new Error("No THB/EUR rate from any source");
  return { rate: j.rates.THB, eur: j.rates.EUR, source: "open.er-api.com" };
}

// JustTCG: look cards up in batches of 20 by TCGplayer product id. Returns Map tcgId -> {normal, foil}.
async function fetchJustTcg(tcgIds) {
  const key = process.env.JUSTTCG_API_KEY;
  const out = new Map();
  if (!key || process.env.SKIP_JUSTTCG) { console.log("JustTCG: no key (or SKIP_JUSTTCG set), skipping this source"); return out; }
  const MAX_REQUESTS = 90; // free plan: 100/day, 1000/month
  const ids = [...tcgIds];
  let requests = 0, unmatched = 0, failures = 0;
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
      if (++failures >= 3) { console.log("JustTCG: too many failures, giving up"); break; }
      if (/HTTP (40[13]|429)/.test(e.message)) break; // bad key / over quota: no point continuing
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

// TCG Cardmarket API (EUR). It has no set code or card number, only a name and a numeric expansion id,
// so we work out which expansion is which set by name overlap, then match on (set, name) only when
// that name is unique on both sides. Anything ambiguous is left without a Cardmarket price.
async function fetchCardmarket() {
  const key = process.env.TCGCM_API_KEY;
  if (!key) { console.log("Cardmarket: no TCGCM_API_KEY set, skipping this source"); return []; }
  const base = "https://tcg-api-production-5148.up.railway.app/cards/search?game=riftbound&name=&limit=100";
  const all = [];
  try {
    for (let page = 1, pages = 1; page <= pages; page++) {
      const j = await getJson(`${base}&page=${page}`, { headers: { "X-API-Key": key } });
      all.push(...j.data);
      pages = j.meta?.totalPages ?? 1;
    }
  } catch (e) { console.log("Cardmarket failed:", e.message); return []; }
  console.log(`Cardmarket: ${all.length} products`);
  return all;
}

function matchCardmarket(products, byId) {
  const rhNames = new Map(); // set -> Set(names)
  const rhBySetName = new Map();
  for (const c of byId.values()) {
    if (!rhNames.has(c.set)) rhNames.set(c.set, new Set());
    rhNames.get(c.set).add(c.name);
    const k = c.set + "|" + c.name;
    rhBySetName.set(k, [...(rhBySetName.get(k) ?? []), c.riftboundId]);
  }
  const byExp = new Map();
  for (const p of products) byExp.set(p.expansionId, [...(byExp.get(p.expansionId) ?? []), p]);
  const expToSet = new Map();
  for (const [exp, list] of byExp) {
    if (list.length < 10) continue; // tiny expansions are too uncertain
    let best = null;
    for (const [set, names] of rhNames) {
      const hits = list.filter((p) => names.has(p.name)).length;
      if (!best || hits > best.hits) best = { set, hits };
    }
    if (best && best.hits / list.length >= 0.6) expToSet.set(exp, { set: best.set, size: list.length });
  }
  // Promo expansions reuse names from the main set: each set keeps only its biggest expansion.
  const biggest = new Map();
  for (const [exp, { set, size }] of expToSet) if (!biggest.has(set) || size > biggest.get(set).size) biggest.set(set, { exp, size });
  for (const [exp, { set }] of [...expToSet]) expToSet.set(exp, biggest.get(set).exp === exp ? set : null);
  console.log("Cardmarket expansions matched:", [...expToSet].filter(([, s]) => s).map(([e, s]) => `${e}=${s}`).join(" "));
  const cmBySetName = new Map();
  for (const p of products) {
    const set = expToSet.get(p.expansionId);
    if (!set) continue;
    const k = set + "|" + p.name;
    cmBySetName.set(k, [...(cmBySetName.get(k) ?? []), p]);
  }
  const out = new Map(); // riftboundId -> {normal, foil} in EUR
  for (const [k, cm] of cmBySetName) {
    const rh = rhBySetName.get(k);
    if (!rh || rh.length !== 1 || cm.length !== 1) continue;
    const pr = cm[0].price;
    if (pr) out.set(rh[0], { normal: pr.trend ?? null, foil: pr.foilTrend ?? null });
  }
  console.log(`Cardmarket: ${out.size} cards matched safely`);
  return out;
}

// ---------- main ----------
async function main() {
  loadDotEnv();
  const today = new Date().toISOString().slice(0, 10);
  const { byId, prices } = await fetchRiftHunt();
  const { rate, eur, source: rateSource } = await fetchRate();
  console.log(`USD->THB ${rate}, USD->EUR ${eur} (${rateSource})`);

  const tcgIds = new Set();
  for (const p of prices) if (p.tcgId) tcgIds.add(p.tcgId);
  const justTcg = await fetchJustTcg(tcgIds);
  const cardmarket = matchCardmarket(await fetchCardmarket(), byId);

  const rows = [];
  for (const p of prices) {
    const card = byId.get(p.riftboundId);
    if (!card) continue;
    for (const finish of ["normal", "foil"]) {
      const rh = p.finishes?.[finish]?.market ?? null;
      const jt = justTcg.get(String(p.tcgId))?.[finish] ?? null;
      const cmEur = cardmarket.get(p.riftboundId)?.[finish] ?? null;
      const cmUsd = cmEur == null ? null : cmEur / eur;
      const tcg = [rh, jt].filter((v) => v != null);
      if (!tcg.length) continue; // nobody has a price for this version
      // Ignore a Cardmarket price that is zero or wildly off on a card worth more than $1.
      const tcgMean = tcg.reduce((a, b) => a + b, 0) / tcg.length;
      const cmOk = cmUsd != null && cmUsd > 0 && !(tcgMean > 1 && (cmUsd / tcgMean > 3 || cmUsd / tcgMean < 1 / 3));
      // TCGplayer-based sources (RiftHunt, JustTCG) are averaged first, then that counts as one market
      // against Cardmarket, so TCGplayer data is not counted twice.
      const used = cmOk ? [...tcg, cmUsd] : tcg;
      const avg = cmOk ? (tcgMean + cmUsd) / 2 : tcgMean;
      rows.push({
        date: today, id: p.riftboundId, finish, name: card.name, set: card.set, rarity: card.rarity,
        rifthunt_usd: round(rh), justtcg_usd: round(jt), cardmarket_eur: round(cmEur), cardmarket_usd: round(cmUsd), avg_usd: round(avg), sources: used.length,
        usd_thb: rate, usd_eur: eur, avg_thb: round(avg * rate),
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
      image_url: byId.get(r.id)?.imgUrl ?? "",
      change_pct: p && Number(p.avg_usd) > 0 ? round(((r.avg_usd - Number(p.avg_usd)) / Number(p.avg_usd)) * 100) : "",
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  writeCsv(LATEST, LATEST_COLS, latest);

  const counts = [1, 2, 3].map((n) => rows.filter((r) => r.sources === n).length);
  console.log(`Done ${today}: ${rows.length} prices written (averaged from 1/2/3 sources: ${counts.join("/")}). History now ${newHistory.length} rows.`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
