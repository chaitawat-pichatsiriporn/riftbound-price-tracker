// Values data/collection.csv using the prices in data/latest.csv.
// Usage: node src/collection.mjs
import fs from "node:fs";

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cells = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const latest = parseCsv(fs.readFileSync("data/latest.csv", "utf8"));
const prices = new Map(latest.map((r) => [`${r.id}|${r.finish}`, r]));
const collection = parseCsv(fs.readFileSync("data/collection.csv", "utf8"));

let totalThb = 0;
let totalUsd = 0;
let totalQty = 0;
const rows = [];
for (const c of collection) {
  const qty = Number(c.qty) || 0;
  const p = prices.get(`${c.id}|${c.finish}`);
  if (!p) {
    console.warn(`No price for ${c.id} ${c.finish} (${c.name})`);
    continue;
  }
  const thb = Number(p.avg_thb);
  totalThb += thb * qty;
  totalUsd += Number(p.avg_usd) * qty;
  totalQty += qty;
  rows.push({ name: p.name, id: c.id, finish: c.finish, qty, thb, total: thb * qty });
}
rows.sort((a, b) => b.total - a.total);
console.table(rows.map((r) => ({ ...r, thb: r.thb.toFixed(2), total: r.total.toFixed(2) })));
console.log(
  `Cards: ${totalQty}  Total: ฿${totalThb.toFixed(2)} ($${totalUsd.toFixed(2)})  prices from ${latest[0]?.date}`
);
