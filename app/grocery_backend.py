"""Grocery Finder backend logic.

Pure-Python data + costing layer, free of Flask so it can be reused when this app
is exported later: static snapshot (GoDaddy) or standalone backend (Vultr).

Data: Delta tables in workspace.grocery_finder, queried via databricks-sdk + SQL warehouse.
Prices are chain-level snapshots, not store-specific.
"""

import json
import os
import re
import threading
import time

CATALOG = "workspace"
SCHEMA = "grocery_finder"
RECIPES_TABLE = f"{CATALOG}.{SCHEMA}.recipes"

# price-table key -> (display chain name, Delta table)
CHAIN_TABLES = {
    "nofrills": ("No Frills", f"{SCHEMA}.nofrills_prices"),
    "superstore": ("Real Canadian Superstore", f"{SCHEMA}.superstore_prices"),
    "safeway": ("Safeway", f"{SCHEMA}.safeway_prices"),
    "walmart": ("Walmart", f"{SCHEMA}.walmart_prices"),
    "iga": ("IGA", f"{SCHEMA}.iga_prices"),
}

WAREHOUSE_ID = os.environ.get("WAREHOUSE_ID", "15935a9200964ebc")

# The scrapers keyed prices on the recipe database's own distinct ingredient names, so an
# exact (normalized) match works for most ingredients. Aliases are a FALLBACK for keys a chain missed.
ALIASES = {
    "eggs": "egg",
    "garlic cloves": "garlic",
    "garlic clove": "garlic",
    "minced garlic": "garlic",
    "plain flour": "flour",
    "red onions": "onion",
    "red onion": "onion",
    "onions": "onion",
    "spring onions": "spring onion",
    "scallions": "spring onion",
    "ground cumin": "cumin",
    "bay leaves": "bay leaf",
    "chicken breasts": "chicken breast",
    "tomatoes": "tomato",
    "carrots": "carrot",
    "lemons": "lemon",
    "limes": "lime",
    "shallots": "shallot",
    "potatoes": "potato",
    "new potatoes": "potato",
    "cherry tomatoes": "tomato",
    "plum tomatoes": "tomato",
    "chopped tomatoes": "tomato",
    "canned tomatoes": "tomato",
    "diced tomatoes": "tomato",
    "chopped onion": "onion",
    # Second round: keys the price tables stock under a different name than
    # some recipes use. Verified against the tables' own keys.
    "floury potatoes": "potatoes",
    "chicken stock cube": "chicken stock",
    "vegetable stock cube": "vegetable stock",
    "hot beef stock": "beef stock",
    "lamb stock": "beef stock",
    "king prawns": "prawns",
    "raw king prawns": "prawns",
    "lamb mince": "lamb",
    "coriander leaves": "coriander",
    "freshly chopped parsley": "parsley",
    "rapeseed oil": "vegetable oil",
    "smoked haddock": "white fish",
    "white cabbage": "cabbage",
    "hispi (sweetheart) cabbage": "cabbage",
    "cubed feta cheese": "feta",
    "baby plum tomatoes": "plum tomatoes",
    "wholegrain bread": "bread",
    "french lentils": "brown lentils",
    "lemon zest": "lemon",
    "lime zest": "lime",
    "orange zest": "orange"
}

FREE_INGREDIENTS = {"water", "boiling water"}  # pantry staples: always available, no price needed

# Minor flavourings or helpers no price table stocks: shown on the recipe
# card but not priced and not counted against coverage (a missing bottle of
# sake shouldn't hide an otherwise buyable stir-fry).
OPTIONAL_INGREDIENTS = {
    "sweetcorn", "sake", "dry sherry", "summer savoury", "doner meat",
    "lamb kidney", "lime leaves", "lemon juice", "lime juice", "ice cubes",
    "toothpicks", "wooden skewers", "bamboo skewers",
}


def norm_ingredient(raw):
    key = re.sub(r"\s+", " ", (raw or "").strip().lower())
    key = ALIASES.get(key, key)
    return ALIASES.get(key, key)  # second hop for chained aliases


def _variants(key):
    """Lookup variants: the key itself, then simple singularizations."""
    out = [key]
    if key.endswith("ies"):
        out.append(key[:-3] + "y")
    if key.endswith("es") and not key.endswith("ses"):
        out.append(key[:-2])
    if key.endswith("s") and not key.endswith("ss"):
        out.append(key[:-1])
    return out

# Approximate kitchen conversions for recipe measures. All flagged as approximations in the UI.
CUP_GRAMS = [
    ("flour", 120), ("sugar", 200), ("brown sugar", 220), ("icing sugar", 120),
    ("rice", 185), ("milk", 240), ("cream", 240), ("yogurt", 245), ("yoghurt", 245),
    ("oil", 218), ("honey", 340), ("stock", 240), ("wine", 240), ("vinegar", 240),
    ("oat", 90), ("cornmeal", 160), ("corn starch", 150), ("couscous", 180),
    ("lentil", 200), ("bean", 220), ("cheese", 110), ("breadcrumb", 110),
]
DEFAULT_CUP_GRAMS = 200

COUNT_UNITS = {
    "clove": 3, "pinch": 0.5, "dash": 0.5, "sprig": 2, "bunch": 60,
    "handfull": 30, "handful": 30, "slice": 25, "bulb": 30, "head": 100,
    "can": 400, "tin": 400, "packet": 400, "pack": 400, "stick": 60,
    "stalk": 40, "cube": 10, "bay": 0.2, "knob": 25, "piece": 30, "wedge": 60,
}

ITEM_GRAMS = [
    ("chicken breast", 170), ("chicken", 200), ("egg yolk", 18), ("egg", 50),
    ("lemon", 85), ("lime", 67), ("onion", 150), ("tomato", 120), ("carrot", 60),
    ("potato", 170), ("cucumber", 300), ("cabbage", 900), ("lettuce", 300),
    ("garlic", 5), ("chilli", 15), ("pepper", 150), ("avocado", 200),
    ("steak", 250), ("sausage", 75), ("fillet", 200), ("prawn", 20), ("shrimp", 20),
]
DEFAULT_ITEM_GRAMS = 100

WORD_NUMBERS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
                "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "half": 0.5}


def _item_grams(ingredient_name):
    n = ingredient_name.lower()
    for kw, grams in ITEM_GRAMS:
        if kw in n:
            return grams
    return DEFAULT_ITEM_GRAMS


def _cup_grams(ingredient_name):
    n = ingredient_name.lower()
    for kw, grams in CUP_GRAMS:
        if kw in n:
            return grams
    return DEFAULT_CUP_GRAMS


def parse_quantity(text):
    """Parse a leading quantity: '1 1/2', '0.5', '2/3', '1', 'a'."""
    s = (text or "").strip()
    if not s:
        return None
    m = re.match(r"(\d+)\s+(\d+)/(\d+)", s)
    if m:
        return int(m.group(1)) + int(m.group(2)) / int(m.group(3))
    m = re.match(r"(\d+)/(\d+)", s)
    if m:
        return int(m.group(1)) / int(m.group(2))
    m = re.match(r"(\d+(?:\.\d+)?)", s)
    if m:
        return float(m.group(1))
    return WORD_NUMBERS.get(s.split(" ")[0].lower())


def parse_measure(measure, ingredient_name=""):
    """Return (amount, unit_kind) with unit_kind in {'g', 'mL', 'item', 'unknown'}."""
    s = (measure or "").strip().lower()
    if not s:
        return None, "unknown"
    # normalize a leading mixed fraction ('1 1/2 L' -> '1.5 l') before metric scanning
    s = re.sub(r"^(\d+)\s+(\d+)/(\d+)",
               lambda m: str(int(m.group(1)) + int(m.group(2)) / int(m.group(3))), s)
    # embedded metric amount: '200g', '1 (400g) tin', '1.5 l', '500 ml'
    m = re.search(r"(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b", s)
    if m:
        n = float(m.group(1))
        u = m.group(2)
        if u == "kg":
            return n * 1000, "g"
        if u == "g":
            return n, "g"
        if u == "l":
            return n * 1000, "mL"
        return n, "mL"
    qty = parse_quantity(s)
    if qty is None:
        return None, "unknown"
    m2 = re.match(r"(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|half)\s*([a-z]+)", s)
    word = (m2.group(1) if m2 else "").lower()
    if word.startswith("cup"):
        return qty * _cup_grams(ingredient_name), "g"
    if word in ("tbsp", "tbspn", "tbs", "tablespoon", "tablespoons"):
        return qty * 15, "mL"
    if word in ("tsp", "teaspoon", "teaspoons"):
        return qty * 5, "mL"
    if word in ("ml", "millilitre", "milliliter"):
        return qty, "mL"
    if word == "l" or word.startswith("litre") or word.startswith("liter"):
        return qty * 1000, "mL"
    if word in ("g", "gram", "grams"):
        return qty, "g"
    if word == "kg":
        return qty * 1000, "g"
    for unit, grams in COUNT_UNITS.items():
        if word.startswith(unit):
            return qty * grams, "g"
    return qty, "item"


# In-process cache for table data (prices are chain-level snapshots, rarely refreshed)
_CACHE = dict(ts=dict(), data=dict())
# Table data only changes when tables are re-loaded manually: a long TTL keeps
# every request off the warehouse after the first fetch (app restarts on deploy).
_CACHE_TTL = 86400
_LOCK = threading.Lock()


def _query(sql):
    from databricks.sdk import WorkspaceClient
    w = WorkspaceClient()  # authenticated from the app environment (on-behalf-of-user)
    res = w.statement_execution.execute_statement(
        statement=sql, warehouse_id=WAREHOUSE_ID, wait_timeout="50s"
    )
    if res.status.error:
        raise RuntimeError("SQL failed: " + str(res.status.error.message))
    cols = [c.name for c in res.manifest.schema.columns]
    return [dict(zip(cols, arr)) for arr in (res.result.data_array or [])]


def _cached(key, fn):
    now = time.time()
    with _LOCK:
        if now - _CACHE["ts"].get(key, 0) < _CACHE_TTL:
            return _CACHE["data"][key]
    val = fn()
    with _LOCK:
        _CACHE["ts"][key] = time.time()
        _CACHE["data"][key] = val
    return val


def get_recipes():
    def fetch():
        rows = _query(
            "SELECT r.recipe_id, r.title, r.category, r.area, r.instructions, r.sourceUrl, "
            "to_json(r.ingredients) AS ingredients_json, "
            "COALESCE(s.servings, 4) AS recipe_servings, "
            "COALESCE(s.servings_source, 'default') AS servings_source "
            "FROM " + RECIPES_TABLE + " r "
            "LEFT JOIN " + CATALOG + "." + SCHEMA + ".recipe_servings s "
            "ON s.recipe_id = r.recipe_id"
        )
        out = []
        seen = set()
        for r in rows:
            r["ingredients"] = json.loads(r.pop("ingredients_json") or "[]")
            try:
                n = int(r.pop("recipe_servings"))
            except (TypeError, ValueError):
                n = 4
            r["recipeServings"] = n if n and n > 0 else 4
            r["servingsSource"] = r.pop("servings_source") or "default"
            # The same dish can sit under several rows (title differs only by
            # case or punctuation) - keep the first copy only.
            key = re.sub(r"[^a-z0-9]+", " ", str(r.get("title") or "").lower()).strip()
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(r)
        return out
    return _cached("recipes", fetch)


def get_servings():
    """recipe_id -> (servings, source); derived from the recipes cache."""
    return {
        r["recipe_id"]: (
            (r.get("recipeServings") or 4) if (r.get("recipeServings") or 0) > 0 else 4,
            r.get("servingsSource") or "default",
        )
        for r in get_recipes()
    }


def get_all_prices():
    """All five chains' price rows in ONE statement; cached once."""
    def fetch():
        selects = []
        for key in CHAIN_TABLES:
            table = CHAIN_TABLES[key][1]
            selects.append(
                "SELECT '" + key + "' AS chain, brand, ingredient, name, packageQuantity, "
                "packageUnit, priceCad, unitPriceBasis, unitPriceCad FROM "
                + CATALOG + "." + table
            )
        return _query(" UNION ALL ".join(selects))
    return _cached("prices:all", fetch)


def get_prices(chain_key):
    """Return list of price rows for a chain key (from the shared fetch)."""
    def fetch():
        return [dict(r) for r in get_all_prices() if r.get("chain") == chain_key]
    return _cached("prices:" + chain_key, fetch)


def build_price_index(chain_key):
    """ingredient_key -> list of price rows (numerics coerced to floats)."""
    idx = dict()
    for row in get_prices(chain_key):
        row = dict(row)
        for f in ("packageQuantity", "priceCad", "unitPriceCad"):
            try:
                row[f] = float(row[f]) if row[f] is not None else None
            except (TypeError, ValueError):
                row[f] = None
        # Register under every variant of the key: recipes say "potato"
        # while the table keys it as "potatoes" (and vice versa), so both
        # directions of the singular/plural mismatch are tolerated.
        key = (row["ingredient"] or "").strip().lower()
        for cand in _variants(key):
            idx.setdefault(cand, []).append(row)
        if not key.endswith("s"):
            idx.setdefault(key + "s", []).append(row)
    return idx


def lookup_prices(index, key):
    # exact key, then alias, then singular variants
    for cand in _variants(norm_ingredient(key)):
        rows = index.get(cand)
        if rows:
            return cand, rows
    return key, []


def _best_package(rows):
    # cheapest full package by priceCad
    priced = [r for r in rows if r.get("priceCad") is not None]
    if not priced:
        return None
    return min(priced, key=lambda r: r["priceCad"])


def _best_unit(rows, unit_kind):
    # cheapest unit-price row for the parsed unit kind -> (row, approximate)
    priced = [r for r in rows if r.get("unitPriceCad") is not None]
    if not priced:
        return None, True

    def basis_of(r):
        return (r.get("unitPriceBasis") or "").strip()

    def cheapest(rs):
        return min(rs, key=lambda r: r["unitPriceCad"])

    if unit_kind == "mL":
        cand = [r for r in priced if basis_of(r) == "per mL"]
        if cand:
            return cheapest(cand), False
        cand = [r for r in priced if basis_of(r) == "per g"]  # density ~1 approximation
        if cand:
            return cheapest(cand), True
        return None, True
    if unit_kind == "item":
        cand = [r for r in priced if basis_of(r) == "per item"]
        if cand:
            return cheapest(cand), False
        cand = [r for r in priced if basis_of(r) == "per g"]  # item->grams approximation
        if cand:
            return cheapest(cand), True
        return None, True
    cand = [r for r in priced if basis_of(r) == "per g"]
    if cand:
        return cheapest(cand), False
    cand = [r for r in priced if basis_of(r) == "per item"]
    if cand:
        return cheapest(cand), True
    return None, True


def _unit_cost(unit_kind, amount, row, item_grams):
    # prorated cost for the parsed amount using a unit-price row
    if row is None or amount is None:
        return None
    basis = (row.get("unitPriceBasis") or "").strip()
    up = row.get("unitPriceCad")
    if up is None:
        return None
    if unit_kind == "mL" and basis in ("per mL", "per g"):
        return amount * up
    if unit_kind == "item" and basis == "per item":
        return amount * up
    if unit_kind == "item" and basis == "per g":
        return amount * item_grams * up
    if unit_kind == "g" and basis == "per g":
        return amount * up
    return None


def _cost_recipe(recipe, combined_index, primary, servings_map=None, servings=1):
    # Item-level costing for one recipe against a combined price index.
    # primary: nearest chain key (single-store column) or None (cheapest-overall column).
    # Ingredient amounts are divided by the recipe's servings (per-serving basis)
    # and then multiplied by the requested number of servings.
    servings_map = servings_map or {}
    s_info = servings_map.get(recipe.get("recipe_id")) or (4, "default")
    recipe_servings = s_info[0] if s_info[0] and s_info[0] > 0 else 4
    servings_source = s_info[1]
    items = []
    total_pkg = 0.0
    total_meal = 0.0
    seen_keys = set()
    covered = 0
    missing = 0

    for ing in recipe.get("ingredients", []):
        raw_name = (ing.get("name") or "").strip()
        measure = ing.get("measure") or ""
        key = norm_ingredient(raw_name)
        if not raw_name or key in seen_keys or key in FREE_INGREDIENTS:
            continue
        seen_keys.add(key)

        if key in OPTIONAL_INGREDIENTS:
            # flavouring/helper no table stocks: shown, unpriced, coverage-neutral
            items.append(dict(
                measure=measure, name=raw_name, missing=False, optional=True,
                approximate=False, fullPackageCad=None, mealCostCad=None, fromPrimary=False,
            ))
            continue

        _, rows = lookup_prices(combined_index, raw_name)
        amount, unit_kind = parse_measure(measure, raw_name)
        if amount is not None:
            # scale to requested servings on a per-serving basis
            amount = amount * servings / recipe_servings
        item_grams = _item_grams(raw_name)

        if not rows:
            missing += 1
            items.append(dict(
                measure=measure, name=raw_name, missing=True, approximate=False,
                fullPackageCad=None, mealCostCad=None, fromPrimary=False,
            ))
            continue
        covered += 1

        if primary:
            # single-store column: prefer the primary chain, fall back to the others
            primary_rows = [r for r in rows if r.get("chain") == primary]
            pkg_pool = primary_rows if primary_rows else rows
            unit_pool = pkg_pool
        else:
            # cheapest-overall column: every chain competes per item
            pkg_pool = rows
            unit_pool = rows

        pkg_row = _best_package(pkg_pool)
        unit_row, approx_unit = _best_unit(unit_pool, unit_kind)
        meal_cost = _unit_cost(unit_kind, amount, unit_row, item_grams) if unit_row else None
        approximate = approx_unit or unit_kind in ("unknown", "item") or not measure

        if pkg_row:
            total_pkg += pkg_row["priceCad"]
        if meal_cost is not None:
            total_meal += meal_cost

        pkg0 = pkg_row if pkg_row else dict()
        items.append(dict(
            measure=measure, name=raw_name, missing=False, approximate=bool(approximate),
            fromPrimary=bool(pkg_row and pkg0.get("chain") == primary),
            chain=pkg0.get("chain"), brand=pkg0.get("brand"), product=pkg0.get("name"),
            packageQuantity=pkg0.get("packageQuantity"), packageUnit=pkg0.get("packageUnit"),
            fullPackageCad=pkg0.get("priceCad"),
            mealCostCad=round(meal_cost, 2) if meal_cost is not None else None,
            amount=amount, unitKind=unit_kind,
        ))

    denom = covered + missing
    coverage = (covered / denom) if denom else 0.0
    result = dict(
        recipe_id=recipe.get("recipe_id"), title=recipe.get("title"),
        category=recipe.get("category"), area=recipe.get("area"),
        sourceUrl=recipe.get("sourceUrl"), instructions=recipe.get("instructions"),
        items=items, fullPackageTotalCad=round(total_pkg, 2),
        mealCostCad=round(total_meal, 2) if total_meal else None,
        coverage=round(coverage, 3), missingCount=missing,
        recipeServings=recipe_servings, servingsSource=servings_source,
        servings=servings,
    )
    return result


MIN_COSTED_ITEMS = 3  # a real meal, not a 1-2 item snack
MAX_PER_CATEGORY = 2  # variety: no single food style fills the whole list


def _priced_item_count(res):
    return sum(1 for it in res.get("items", [])
               if not it.get("missing") and not it.get("optional"))


def rank_and_pick(recipes, count=10):
    """Cheapest first, but only real meals (>= MIN_COSTED_ITEMS priced
    ingredients) and at most MAX_PER_CATEGORY per category so the results
    aren't three variations of the same snack."""
    pool = [r for r in recipes if _priced_item_count(r) >= MIN_COSTED_ITEMS]
    pool.sort(key=lambda r: (r["mealCostCad"], r["fullPackageTotalCad"]))
    out, chosen = [], set()
    per_cat = {}
    for r in pool:
        cat = (r.get("category") or "misc").lower()
        if per_cat.get(cat, 0) >= MAX_PER_CATEGORY:
            continue
        per_cat[cat] = per_cat.get(cat, 0) + 1
        chosen.add(id(r))
        out.append(r)
        if len(out) >= count:
            return out
    for r in pool:  # top up if diversity left gaps
        if len(out) >= count:
            break
        if id(r) not in chosen:
            out.append(r)
    return out


def cheapest_recipes(chains, count=3, min_coverage=0.9, servings=1):
    # chains: ordered chain keys, nearest store first (unique chains of the 3 nearest stores)
    chains = [c for c in chains if c in CHAIN_TABLES][:3]
    if not chains:
        return dict(single_store=[], cheapest_overall=[],
                    error="no priced chains found near you")

    recipes = get_recipes()
    servings_map = get_servings()
    indexes = dict()
    for c in chains:
        indexes[c] = build_price_index(c)

    combined_index = dict()
    for chain_key in chains:
        for k, rows in indexes[chain_key].items():
            combined_index.setdefault(k, []).extend(
                [dict(r, chain=chain_key) for r in rows]
            )

    primary = chains[0]
    single = []
    overall = []
    for recipe in recipes:
        res_single = _cost_recipe(recipe, combined_index, primary, servings_map, servings)
        if res_single["coverage"] >= min_coverage and res_single["mealCostCad"] is not None:
            res_single["missingFromPrimary"] = sorted(
                it["name"] for it in res_single["items"]
                if it["missing"] or (it.get("chain") and it["chain"] != primary)
            )
            single.append(res_single)

        res_multi = _cost_recipe(recipe, combined_index, None, servings_map, servings)
        if res_multi["coverage"] >= min_coverage and res_multi["mealCostCad"] is not None:
            # carry the one-store price along so the UI can show the saving
            res_multi["singleStoreMealCostCad"] = res_single.get("mealCostCad")
            res_multi["singleStorePackageTotalCad"] = res_single.get("fullPackageTotalCad")
            overall.append(res_multi)

    return dict(
        primary_chain=primary, chains=chains,
        single_store=rank_and_pick(single, count),
        cheapest_overall=rank_and_pick(overall, count),
    )
