# Google Sheet setup (no script needed)

Make a new Google Sheet with tabs named exactly: `Data_Latest`, `Data_History`, `Prices`, `Trend`, `Data_Collection`, `Collection`.

Links used below (the repo is public):

- latest:  https://raw.githubusercontent.com/chaitawat-pichatsiriporn/riftbound-price-tracker/main/data/latest.csv
- history: https://raw.githubusercontent.com/chaitawat-pichatsiriporn/riftbound-price-tracker/main/data/history.csv
- collection: https://raw.githubusercontent.com/chaitawat-pichatsiriporn/riftbound-price-tracker/main/data/collection.csv

## 1. Data_Latest  (cell A1)
```
=IMPORTDATA("https://raw.githubusercontent.com/chaitawat-pichatsiriporn/riftbound-price-tracker/main/data/latest.csv")
```

## 2. Data_History  (cell A1)
```
=IMPORTDATA("https://raw.githubusercontent.com/chaitawat-pichatsiriporn/riftbound-price-tracker/main/data/history.csv")
```

## 3. Prices  (cell A1)
Latest price per card and finish, with the change since the previous update.
```
=QUERY(Data_Latest!A:S, "select P, K, O, S, L, A where P is not null order by P", 1)
```
Columns shown: card, average USD, average THB, change %, number of sources used, date.
To see the most expensive cards first, change `order by P` to `order by K desc`.

## 4. Trend
- Cell A1: `Pick a card:`
- Cell B1: the dropdown. Select B1, then Data > Data validation > Add rule > "Dropdown (from a range)" > `Data_Latest!P2:P`.
- Cell A2: `id`   Cell B2:
```
=INDEX(Data_Latest!B:B, MATCH(B1, Data_Latest!P:P, 0))
```
- Cell A3: `finish`   Cell B3:
```
=INDEX(Data_Latest!C:C, MATCH(B1, Data_Latest!P:P, 0))
```
- Cell A5 (the history for the chosen card):
```
=QUERY(Data_History!A:O, "select A, K, O where B='"&B2&"' and C='"&B3&"' order by A", 1)
```
- Chart: select A5:C (the three columns), then Insert > Chart > "Line chart". In the chart settings, put the THB series on the right axis, since THB numbers are about 34 times bigger than USD.

## 5. Data_Collection  (cell A1)
The cards you own, from `data/collection.csv` (columns: id, finish, qty, name).
```
=IMPORTDATA("https://raw.githubusercontent.com/chaitawat-pichatsiriporn/riftbound-price-tracker/main/data/collection.csv")
```

## 6. Collection
Your cards with their latest THB price, most valuable first.
- Row 1 headers: `card`, `id`, `finish`, `qty`, `price THB`, `total THB`, `change %`
- Cell A2:
```
=LET(c, FILTER(Data_Collection!A2:C, Data_Collection!A2:A<>""), key, INDEX(c,,1)&"|"&INDEX(c,,2), lk, Data_Latest!B2:B&"|"&Data_Latest!C2:C, qty, INDEX(c,,3), thb, XLOOKUP(key, lk, Data_Latest!O2:O, 0), SORT(HSTACK(XLOOKUP(key, lk, Data_Latest!D2:D, "not found"), INDEX(c,,1), INDEX(c,,2), qty, thb, qty*thb, XLOOKUP(key, lk, Data_Latest!S2:S, "")), 6, FALSE))
```
- Cell I1: `Cards`   Cell J1: `=SUM(D2:D)`
- Cell I2: `Total THB`   Cell J2: `=SUM(F2:F)`

To add cards, edit `data/collection.csv` on the `main` branch (one row per card and finish; foil and normal are separate rows). You can also run `node src/collection.mjs` to see the same total in a terminal.

## Notes
- IMPORTDATA refreshes about once an hour. New prices appear on their own after the weekly update.
- A Google Sheet holds at most 10 million cells. The history grows by about 36,000 cells per week, so this lasts for years.
- Columns in the CSV files: date, id, finish, name, set, rarity, rifthunt_usd, justtcg_usd, cardmarket_eur, cardmarket_usd, avg_usd, sources, usd_thb, usd_eur, avg_thb. `latest.csv` also has label, prev_date, prev_avg_usd, change_pct.
