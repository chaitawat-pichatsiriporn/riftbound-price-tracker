# Google Sheet setup (no script needed)

Make a new Google Sheet with four tabs named exactly: `Data_Latest`, `Data_History`, `Prices`, `Trend`.

Links used below (the repo is public):

- latest:  https://raw.githubusercontent.com/chaitawat-pichatsiriporn/riftbound-price-tracker/main/data/latest.csv
- history: https://raw.githubusercontent.com/chaitawat-pichatsiriporn/riftbound-price-tracker/main/data/history.csv

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

## Notes
- IMPORTDATA refreshes about once an hour. New prices appear on their own after the weekly update.
- A Google Sheet holds at most 10 million cells. The history grows by about 36,000 cells per week, so this lasts for years.
- Columns in the CSV files: date, id, finish, name, set, rarity, rifthunt_usd, justtcg_usd, cardmarket_eur, cardmarket_usd, avg_usd, sources, usd_thb, usd_eur, avg_thb. `latest.csv` also has label, prev_date, prev_avg_usd, change_pct.
