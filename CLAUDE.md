# Riftbound Price Tracker

`src/track.mjs` runs weekly (GitHub Actions, `.github/workflows/weekly.yml`) and writes `data/latest.csv` and `data/history.csv` to `main`.

## Google Sheet (the card collection lives here, not in this repo)

- Title: Riftbound Price Tracker
- Link: https://docs.google.com/spreadsheets/d/1jZptjSFmwsTNOpIl2Dk_fsP6DIjS1TOkI5iMmYhd0s8/edit
- Spreadsheet ID: `1jZptjSFmwsTNOpIl2Dk_fsP6DIjS1TOkI5iMmYhd0s8`

Tabs: `Collection`, `Collection_Sorted`, `Prices`, `Trend`, `Data_Latest`, `Data_History`.

### Collection tab
- Rows 1–3: totals (USD, THB, card count) as `SUM` formulas. Row 5: headers. Cards start at row 6.
- You only type into **B (finish: `normal`/`foil`), C (qty), D (id, e.g. `ogn-029-298`)**.
  Columns A and E–I are formulas that are already filled down on empty rows, so do not write to them.
- To add a card: if the same id + finish row exists, increase its qty; otherwise write B:D on the first empty row.
  Read the tab first to find rows; column I should say `OK` afterwards (otherwise the id/finish is not in `Data_Latest`).
- `Collection_Sorted` is a sorted `FILTER` view of `Collection`; never edit it.

### Finding a card id
Look the card up in `data/latest.csv` by name (columns `id`, `finish`, `name`, `avg_thb`).
Alternate art ids end in `a` (e.g. `ogn-041a-298`), signatures in `*`, promos start with `opp-`.
