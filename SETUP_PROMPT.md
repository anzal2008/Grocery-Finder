# Grocery Finder — Master Rebuild Prompt

Paste the block below into the Genie Code chat of the NEW Databricks account. It is a complete, self-contained brief: fetch the bundle from GitHub, stage data into Unity Catalog, rebuild all Delta tables, deploy the app, wire permissions, and verify.

---

## PASTE FROM HERE

Rebuild the "Grocery Finder" Databricks App (a grocery-budget web app called Penny & Parsley) in THIS workspace, from a verified migration bundle that lives entirely on GitHub. Do not recreate anything from scratch — every source file, data file, and the data-load notebook is in the repo. Work phase by phase, verify each phase before moving on, and stop and ask me if a file listed below is missing.

### Source of truth

GitHub repo `Rowan-Fehr/Grocery-Finder`, branch `Rowan-Fehr` (my fork of anzal2008/Grocery-Finder).

Get the files onto this workspace first: clone that branch into a Databricks Git folder (or download it) so the paths below exist locally. The layout:

- `app/` — the app source: `app.py` (Flask server + JSON APIs), `grocery_backend.py` (data access + meal-costing engine), `app.yaml`, `requirements.txt`, `static/` (index.html, app.js, style.css)
- `notebooks/grocery_finder_data_load.ipynb` — builds every Delta table from the JSONs; import and run it
- `MIGRATION.md` — human-oriented guide to the same steps
- Repo root (older scrapes, also needed): `recipes_export.json`, `nofrills-366-prices.json`, `superstore-366-prices (1).json`
- `data/` folder on the branch: `servings.json`, `walmart-missing-ingredients-prices.json`, and (I will have uploaded these too — if any is missing, ask me to upload it before continuing): `safeway-366-prices (1).json`, `walmart-364-fresh-prices (1).json`, `iga-366-prices.json`

### Phase 1 — Unity Catalog staging

1. Create the schema and volume (run as SQL):
   CREATE SCHEMA IF NOT EXISTS workspace.grocery_finder;
   CREATE VOLUME IF NOT EXISTS workspace.grocery_finder.recipe_files;
   If this workspace's default catalog is not named `workspace`, use its real name here AND update two places in the code later: `CATALOG = "workspace"` at the top of grocery_backend.py, and the catalog references inside the load notebook.
2. Copy ALL SEVEN JSONs into `/Volumes/workspace/grocery_finder/recipe_files/` with EXACT original filenames (including the " (1)" suffixes — the notebook reads them by name): recipes_export.json, nofrills-366-prices.json, superstore-366-prices (1).json, safeway-366-prices (1).json, walmart-364-fresh-prices (1).json, walmart-missing-ingredients-prices.json, iga-366-prices.json, servings.json.

### Phase 2 — Rebuild the tables

Import `notebooks/grocery_finder_data_load.ipynb` and run it top to bottom (serverless compute is fine). It: creates the schema; loads recipes from recipes_export.json (ingredients end up as ARRAY<STRUCT<measure,name>> — keep that); builds `recipe_servings` from servings.json (242 rows); loads nofrills+superstore+safeway prices (brand present in source, packageQuantity CAST to DOUBLE for schema parity); loads walmart (both Walmart files merged into ONE table) and iga (extra source field `estimatedPrice` is dropped), deriving brand from product titles where it is null in source.

Verify these counts before proceeding — any mismatch means a truncated/missing JSON:
- recipes 242, recipe_servings 242
- nofrills_prices 514 rows (278 distinct ingredients)
- superstore_prices 536 (285)
- safeway_prices 435 (249)
- walmart_prices 404 (226)
- iga_prices 481 (273)
All five price tables must end up with the identical 12-column schema.

### Phase 3 — Create the app

1. Create a SERVERLESS SQL warehouse (that is the whole point of the move — do not use a classic/pro warehouse). Note its ID.
2. Stage the `app/` folder contents as app source in my workspace (e.g. /Workspace/Users/<me>/grocery-finder).
3. Edit `app.yaml`: set env var `WAREHOUSE_ID` to the new serverless warehouse ID (the committed file has a TODO placeholder for the old account's warehouse). `command: python app.py`, `user_api_scopes: [sql]`, requirements: flask, requests, databricks-sdk, gunicorn — keep all of that as committed.
4. Gemini API key: create a secret scope (e.g. `grocery-finder`) with secret `GEMINI_API_KEY` — I will supply the value — and reference it in app.yaml env. It powers recipe photos and the kitchen-helper chat; the app also accepts a per-user key via header, but the server key is the intended path.
5. Do NOT remove the `if __name__ == "__main__"` block at the end of app.py (runs on DATABRICKS_APP_HOST/PORT) — a missing entry point previously caused "app exited unexpectedly" deploy failures.
6. Create the Databricks App named `grocery-finder` from that source path (SNAPSHOT mode).

### Phase 4 — Permissions (app runs as its service principal, not as me)

Grant the app's service principal: USE_CATALOG on the catalog, USE_SCHEMA + SELECT on the `grocery_finder` schema, and CAN_USE on the warehouse. Without these the app deploys but every API call fails.

### Phase 5 — Deploy and verify

Check app status first: `apps get grocery-finder` → if STOPPED, `apps start`, then deploy from the staged source path. Verify in a browser:
- `/api/health` → `{"ok": true, "serverKey": true}` (serverKey true = Gemini secret visible)
- `/api/locate?postal=V5K0A1` (any Canadian postal) → stores of the 5 chains + a chains array
- `/api/recipes?chains=nofrills,safeway` → two ranked recipe columns ("single store" + "cheapest across stores") with CAD costs

Report the app URL when all three pass.

### Known gotchas (already handled in the code — listed so you don't undo them)
- Warehouse cold start is ~16s; the app warms its table caches in a background thread at startup, so the first request is already fast.
- OpenStreetMap Overpass/Nominatim rate limits: the app already throttles, uses 3 mirror endpoints in parallel, and caches store results per ~1 km area. Don't restructure that.
- `grocery_backend.py` caches recipes + all five price tables for 24h in-process; price data only changes when tables are reloaded.
- App logs may not be fetchable through this chat's tooling; if deploy fails, diagnose via deployment status + source inspection.

## PASTE TO HERE
