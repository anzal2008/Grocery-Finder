# Grocery Finder / Penny & Parsley — Databricks App migration bundle

Complete, self-contained copy of the deployed Databricks app as of 2026-11-09.
The old workspace lost Serverless SQL eligibility (billing/limit), so this branch
is the escape hatch for rebuilding everything in a fresh Databricks account.

## Folder map

* `app/` — Databricks App source: `app.py` (Flask server + store search),
  `grocery_backend.py` (pricing/costing engine), `app.yaml`, `requirements.txt`,
  and `static/` (front end: index.html, app.js, style.css).
* `data/servings.json` — recipe servings scraped from source pages; used to build
  the `recipe_servings` table.
* `notebooks/grocery_finder_data_load.ipynb` — rebuilds all Delta tables from the
  raw price JSONs (recipes + 5 retailer price tables + recipe_servings).
* Repo root — `recipes_export.json`, `nofrills-366-prices.json`,
  `superstore-366-prices (1).json` (committed earlier). The remaining raw JSONs
  (safeway, walmart x2, iga) are on Rowan's laptop and need to be added to `data/`
  or uploaded to the new volume.

## Rebuild steps in the new account

1. Create/open the new workspace (a free trial keeps the Serverless Starter
   Warehouse working at no cost).
2. Catalog: the code and notebook reference catalog `workspace`. Either create a
   catalog named `workspace`, or replace `workspace` with the new default catalog
   in: `app/grocery_backend.py` (CATALOG), the notebook cells, and any SQL.
3. Create a volume: schema `grocery_finder`, volume `recipe_files`. Upload ALL
   price JSONs + `recipes_export.json` + `data/servings.json` to
   `/Volumes/workspace/grocery_finder/recipe_files/`.
4. Import `notebooks/grocery_finder_data_load.ipynb` and run the cells top to
   bottom (serverless compute is fine). It creates: `recipes`, `nofrills_prices`,
   `superstore_prices`, `safeway_prices`, `walmart_prices`, `iga_prices`,
   `recipe_servings`, then verifies counts.
5. Copy the `app/` files into a workspace folder, same layout (app.py at the top,
   `static/` subfolder).
6. Create the app from that folder (Apps -> Create). In `app.yaml`, set
   `WAREHOUSE_ID` to the new workspace's Starter Warehouse ID (SQL Warehouses
   page -> copy ID). GEMINI_API_KEY lines stay commented out unless you store a
   secret.
7. Grant the app's service principal: USE CATALOG + USE SCHEMA + SELECT on
   `grocery_finder`, and CAN USE on the warehouse.
8. Deploy, then test with a postal code (hard refresh to bypass cached JS).

## Notes

* Prices are chain-level snapshots (not store-specific), in CAD.
* `app.py` already maps 9 chains (T&T, Save-On, Sobeys, Independent tracked for
  the map) but only 5 have price tables; unpriced chains show "no price data".
* T&T + Save-On scrapes were blocked by the stores' WAFs from datacenter IPs —
  add their JSONs later using the same schema if you ever scrape them from home.
* Free-trial workspaces can hit the same serverless cliff when the trial budget
  runs out — watch usage.
