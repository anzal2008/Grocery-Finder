"""Grocery Finder - Flask app: serves the static front end and the JSON API.

Endpoints:
  /api/locate?postal=V5K0A1  -> geocode (OSM Nominatim) + nearby stores (Overpass)
  /api/recipes?chains=a,b,c  -> cheapest recipes (single-store + across-3-stores columns)
  /api/health                -> liveness probe
"""

import json
import math
import re
import threading
import time

import requests
from flask import Flask, jsonify, request, send_from_directory

import os

import grocery_backend as gb

app = Flask(__name__, static_folder="static", static_url_path="/static")

NOMINATIM = "https://nominatim.openstreetmap.org/search"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "GroceryFinderDatabricksApp/1.0"

# Shared HTTP session: keep-alive avoids a TLS handshake per request
_HTTP = requests.Session()
_HTTP.headers.update({"User-Agent": USER_AGENT})

# Photon (Komoot OSM geocoder): ~0.5s, generous usage limits
PHOTON = "https://photon.komoot.io/api/"

# Overpass name pattern -> chain key. Five chains have price tables
# (gb.CHAIN_TABLES); the rest are tracked for the store map only.
CHAIN_PATTERNS = [
    (re.compile(r"no[\s.-]*frills", re.I), "nofrills"),
    (re.compile(r"superstore", re.I), "superstore"),
    (re.compile(r"safeway", re.I), "safeway"),
    (re.compile(r"walmart", re.I), "walmart"),
    (re.compile(r"\biga\b", re.I), "iga"),
    (re.compile(r"sobeys", re.I), "sobeys"),
    (re.compile(r"\bt\s*(&|and)?\s*t\b", re.I), "tnt"),
    (re.compile(r"independent", re.I), "independent"),
    (re.compile(r"save[\s.-]*on", re.I), "saveon"),
]

CHAIN_DISPLAY_NAMES = {
    "nofrills": "No Frills",
    "superstore": "Superstore",
    "safeway": "Safeway",
    "walmart": "Walmart",
    "iga": "IGA",
    "sobeys": "Sobeys",
    "tnt": "T&T",
    "independent": "Independent",
    "saveon": "Save-On-Foods",
}

POSTAL_RE = re.compile(
    r"^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]([\s\-]?\d[ABCEGHJ-NPRSTV-Z]\d)?$", re.I
)

_geo_cache = dict()
_geo_lock = threading.Lock()

# Overpass is rate-limited (2 concurrent slots per IP): serialize calls and
# keep a minimum gap between requests. Store results are cached per area.
_store_cache = dict()
_overpass_lock = threading.Lock()
_last_overpass_ts = 0.0
_OVERPASS_MIN_GAP = 1.0  # seconds between Overpass request bursts

# Nominatim policy is max 1 request/second: throttle it too (geocoding + fallback)
_nominatim_lock = threading.Lock()
_last_nominatim_ts = 0.0
_NOMINATIM_MIN_GAP = 1.2


def _nominatim_throttle():
    global _last_nominatim_ts
    with _nominatim_lock:
        gap = _last_nominatim_ts + _NOMINATIM_MIN_GAP - time.time()
        if gap > 0:
            time.sleep(gap)
        _last_nominatim_ts = time.time()


def haversine(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def classify(name):
    for pattern, key in CHAIN_PATTERNS:
        if pattern.search(name or ""):
            return key
    return None


def _photon_geocode(postal):
    """Photon geocoder: ~0.5s, no strict rate limit. (lat, lon, name) or None."""
    try:
        resp = _HTTP.get(PHOTON, params=dict(q=postal + ", Canada", limit=3), timeout=8)
        resp.raise_for_status()
        feats = resp.json().get("features") or []
        best = next(
            (f for f in feats if (f.get("properties") or {}).get("countrycode") == "CA"),
            None,
        )
        if best is None:
            return None
        lon, lat = best["geometry"]["coordinates"]
        p = best.get("properties") or {}
        display = ", ".join(x for x in (p.get("name"), p.get("city"), p.get("state")) if x)
        return (float(lat), float(lon), display)
    except Exception:
        return None


def _nominatim_geocode(postal):
    """Nominatim fallback (1 req/s policy - throttled)."""
    params = dict(q=postal + ", Canada", format="json", limit=1, countrycodes="ca")
    _nominatim_throttle()
    resp = _HTTP.get(NOMINATIM, params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    if not data:
        return None
    return (float(data[0]["lat"]), float(data[0]["lon"]), data[0].get("display_name", ""))


def geocode_postal(postal):
    # A hit for the full code or its FSA (first 3 chars) skips the geocoder.
    with _geo_lock:
        for key in (postal, postal[:3]):
            if key in _geo_cache:
                return _geo_cache[key]
    out = _photon_geocode(postal) or _nominatim_geocode(postal)
    if out:
        with _geo_lock:
            _geo_cache[postal] = out
            _geo_cache[postal[:3]] = out
    return out


def _fetch_mirror(endpoint, query):
    """POST one Overpass mirror; None on any failure (429, timeout, bad JSON)."""
    try:
        resp = _HTTP.post(endpoint, data=dict(data=query), timeout=15)
        if resp.status_code == 429:
            return None
        resp.raise_for_status()
        return resp.json().get("elements", [])
    except Exception:
        return None


def overpass_query(lat, lon, radius_m):
    # One query, union of two clauses: (a) chain-named shops of common grocery
    # types, (b) any POI whose name/brand matches a tracked chain (catches odd
    # shop tagging). Bus stops and platforms named after stores are dropped
    # later, in _parse_overpass_elements.
    chains_re = "no[ .-]?frills|superstore|safeway|walmart|iga|sobeys|save[ .-]?on|independent|t[ &]?t"
    q = "[out:json][timeout:25];("
    q += "nwr(around:" + str(radius_m) + "," + str(lat) + "," + str(lon) + ")"
    q += "[shop~\"supermarket|convenience|department_store|greengrocer|butcher|bakery|grocery|general|wholesale\"]"
    q += "[~\"^(name|brand)$\"~\"" + chains_re + "\",i];"
    q += "nwr(around:" + str(radius_m) + "," + str(lat) + "," + str(lon) + ")"
    q += "[~\"^(name|brand)$\"~\"" + chains_re + "\",i];"
    q += ");out center tags;"
    global _last_overpass_ts
    with _overpass_lock:
        gap = _last_overpass_ts + _OVERPASS_MIN_GAP - time.time()
        if gap > 0:
            time.sleep(gap)
        _last_overpass_ts = time.time()
        # fire all mirrors concurrently; the first success wins, so latency is
        # the fastest mirror, not the sum of serial timeouts
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=len(OVERPASS_ENDPOINTS)) as pool:
            futures = [pool.submit(_fetch_mirror, ep, q) for ep in OVERPASS_ENDPOINTS]
            for fut in as_completed(futures):
                elements = fut.result()
                if elements is not None:
                    return elements
    raise RuntimeError(
        "OpenStreetMap store search is busy right now (rate limited). "
        "Please try again in a few seconds."
    )


def nominatim_nearby_stores(lat, lon, radius_m=20000):
    """Fallback store search via Nominatim special-phrase query, used when all
    Overpass mirrors are rate limited. Finds shop=supermarket POIs inside a
    bounding box and keeps the five priced chains within radius."""
    dlat = radius_m / 111320.0
    coslat = max(math.cos(math.radians(lat)), 0.01)
    dlon = radius_m / (111320.0 * coslat)
    viewbox = ",".join(str(round(v, 6)) for v in (lon - dlon, lat + dlat, lon + dlon, lat - dlat))
    params = dict(q="supermarket", format="jsonv2", limit=50, bounded=1, viewbox=viewbox)
    _nominatim_throttle()
    resp = _HTTP.get(NOMINATIM, params=params, timeout=15)
    resp.raise_for_status()
    out = []
    seen = set()
    for item in resp.json():
        name = item.get("name") or ""
        chain = classify(name)
        if not chain:
            continue
        elat = float(item.get("lat"))
        elon = float(item.get("lon"))
        dedupe = (chain, name, round(elat, 4), round(elon, 4))
        if dedupe in seen:
            continue
        seen.add(dedupe)
        dist = round(haversine(lat, lon, elat, elon), 2)
        if dist > radius_m / 1000.0:
            continue
        display = item.get("display_name") or ""
        address = display[len(name):].strip(" ,") if display.startswith(name) else display
        out.append(dict(
            chain=chain, chainName=CHAIN_DISPLAY_NAMES.get(chain, name), name=name,
            priced=chain in gb.CHAIN_TABLES,
            address=address[:140], lat=elat, lon=elon, distanceKm=dist,
        ))
    out.sort(key=lambda s: s["distanceKm"])
    return out


def _parse_overpass_elements(lat, lon, elements, radius_m):
    stores = []
    seen = set()
    for el in elements:
        tags = el.get("tags") or dict()
        if tags.get("highway") or tags.get("public_transport"):
            continue  # bus stops / platforms named after stores are not stores
        name = tags.get("name") or tags.get("brand") or ""
        chain = classify(name) or classify(tags.get("brand") or "")
        if not chain:
            continue
        elat = el.get("lat") or (el.get("center") or dict()).get("lat")
        elon = el.get("lon") or (el.get("center") or dict()).get("lon")
        if elat is None or elon is None:
            continue
        dedupe = (chain, name, round(elat, 4), round(elon, 4))
        if dedupe in seen:
            continue
        seen.add(dedupe)
        parts = [tags.get("addr:housenumber"), tags.get("addr:street"), tags.get("addr:city")]
        address = ", ".join(p for p in parts if p)
        stores.append(dict(
            chain=chain, chainName=CHAIN_DISPLAY_NAMES.get(chain, name), name=name,
            priced=chain in gb.CHAIN_TABLES,
            address=address, lat=elat, lon=elon,
            distanceKm=round(haversine(lat, lon, elat, elon), 2),
        ))
    stores = [s for s in stores if s["distanceKm"] <= radius_m / 1000.0 + 0.05]
    stores.sort(key=lambda s: s["distanceKm"])
    return stores


def find_stores(lat, lon, radius_m=20000):
    """Nearby stores of the priced chains. ONE Overpass query within the
    requested radius, sorted by distance (nearest stores first). Overpass
    primary, Nominatim fallback if every mirror is busy. Cached per ~1km
    area and radius bucket."""
    radius_m = max(100, min(100000, int(radius_m)))
    cache_key = (round(lat, 3), round(lon, 3), radius_m // 500)
    cached = _store_cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        elements = overpass_query(lat, lon, radius_m)
    except Exception:
        best = nominatim_nearby_stores(lat, lon, radius_m)
    else:
        best = _parse_overpass_elements(lat, lon, elements, radius_m)
    if best:
        _store_cache[cache_key] = best
    return best


@app.get("/")
def home():
    return send_from_directory("static", "index.html")


@app.get("/api/health")
def health():
    return jsonify(ok=True, serverKey=bool((os.environ.get("GEMINI_API_KEY") or "").strip()))


@app.get("/api/locate")
def locate():
    postal = (request.args.get("postal") or "").strip().upper()
    lat_s = request.args.get("lat")
    lon_s = request.args.get("lon")
    if lat_s and lon_s:
        # direct coordinates (browser geolocation): skips the geocoder entirely
        try:
            lat = float(lat_s)
            lon = float(lon_s)
            if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                raise ValueError
        except ValueError:
            return jsonify(error="Invalid coordinates."), 400
        display = "Your current location"
    else:
        if not POSTAL_RE.match(postal):
            return jsonify(error="Enter a valid Canadian postal code (e.g. V5K 0A1)."), 400
        normalized = postal.replace(" ", "").replace("-", "")
        try:
            geo = geocode_postal(normalized)
        except Exception as exc:
            return jsonify(error="Geocoding service unavailable: " + str(exc)), 502
        if not geo:
            return jsonify(error="Could not find that postal code - try a nearby one."), 404
        lat, lon, display = geo
    try:
        radius_m = int(float(request.args.get("radius_m") or 20000))
    except (TypeError, ValueError):
        radius_m = 20000
    radius_m = max(100, min(100000, int(round(radius_m / 100.0)) * 100))
    try:
        store_count = int(request.args.get("stores") or 3)
    except (TypeError, ValueError):
        store_count = 3
    store_count = max(1, min(3, store_count))
    try:
        stores = find_stores(lat, lon, radius_m)
    except Exception as exc:
        return jsonify(error="Store lookup unavailable: " + str(exc)), 502

    chains = []
    for s in stores:
        if s.get("priced") and s["chain"] not in chains:
            chains.append(s["chain"])
        if len(chains) >= store_count:
            break
    return jsonify(
        lat=lat, lon=lon, display=display,
        stores=stores[:15], chains=chains,
    )


_DIET_WORDS = {
    "vegetarian": [
        "chicken", "beef", "pork", "bacon", "ham", "sausage", "turkey", "lamb",
        "meat", "steak", "mince", "hamburger", "fish", "tuna", "salmon", "shrimp",
        "anchovy", "pepperoni", "chorizo", "prosciutto", "lard", "gelatin",
        "worcestershire", "broth", "stock",
    ],
    "vegan": [
        "chicken", "beef", "pork", "bacon", "ham", "sausage", "turkey", "lamb",
        "meat", "steak", "mince", "hamburger", "fish", "tuna", "salmon", "shrimp",
        "anchovy", "pepperoni", "chorizo", "prosciutto", "lard", "gelatin",
        "worcestershire", "broth", "stock",
        "milk", "cheese", "butter", "cream", "yogurt", "yoghurt", "buttermilk",
        "ghee", "egg", "honey", "whey", "custard", "mayonnaise", "mayo",
        "parmesan", "cheddar", "mozzarella", "feta", "ricotta",
    ],
    "gluten_free": [
        "flour", "wheat", "bread", "pasta", "noodle", "breadcrumb", "panko",
        "barley", "rye", "couscous", "bulgur", "seitan", "soy sauce", "teriyaki",
        "malt", "semolina", "graham", "cracker", "spelt", "baguette",
    ],
    "dairy_free": [
        "milk", "cheese", "butter", "cream", "yogurt", "yoghurt", "buttermilk",
        "ghee", "whey", "custard", "parmesan", "cheddar", "mozzarella", "feta",
        "ricotta", "margarine",
    ],
}


def matches_diet(recipe, diets):
    """Approximate dietary filter: word-boundary keyword scan over the title,
    category and ingredient names. A matching category tag can vouch for
    vegetarian/vegan."""
    category = (recipe.get("category") or "").lower()
    text = " ".join(
        [str(recipe.get("title") or ""), category]
        + [str(i.get("name") or "") for i in (recipe.get("items") or [])]
    ).lower()
    for d in diets:
        if d == "vegetarian" and ("vegetarian" in category or "vegan" in category):
            continue
        if d == "vegan" and "vegan" in category:
            continue
        for w in _DIET_WORDS.get(d, []):
            if re.search(r"(?<![a-z])" + re.escape(w) + "(?![a-z])", text):
                return False
    return True


# ---- Live TheMealDB recipe pool -------------------------------------------
# The curated table is a small slice of the public MealDB. When it cannot fill
# both columns with unique dishes (small pool, or strict diet filters), pull
# more complete recipes straight from the MealDB API - free, no key required -
# and price them through the exact same store-price pipeline.

_MEALDB = "https://www.themealdb.com/api/json/v1/1/"
_MEALDB_TTL = 24 * 3600.0
_MEALDB_POOL = {"at": 0.0, "recipes": []}
_MEALDB_PRICED_CACHE = dict()  # (diets, chains, servings) -> (timestamp, columns)


def _title_key(t):
    return re.sub(r"[^a-z0-9]+", " ", str(t or "").lower()).strip()


def _mealdb_to_recipe(m):
    ings = []
    for i in range(1, 21):
        name = str(m.get("strIngredient" + str(i)) or "").strip()
        if not name or name.lower() == "null":
            continue
        ings.append({"name": name[:80],
                     "measure": str(m.get("strMeasure" + str(i)) or "").strip()[:40]})
    if not ings:
        return None
    return dict(
        recipe_id="mdb-" + re.sub(
            r"[^a-z0-9]+", "-",
            str(m.get("idMeal") or m.get("strMeal") or "").lower()).strip("-")[:40],
        title=str(m.get("strMeal") or "").strip()[:120],
        category=str(m.get("strCategory") or "Main").strip()[:40],
        area=m.get("strArea") or None,
        instructions=str(m.get("strInstructions") or "").strip(),
        sourceUrl=m.get("strSource") or (m.get("strYoutube") or None),
        ingredients=ings,
        recipeServings=4,
    )


def mealdb_pool():
    """Every MealDB recipe whose name starts with a letter, deduped by title.
    Cached in-process for 24h."""
    now = time.time()
    if (_MEALDB_POOL["recipes"]
            and now - _MEALDB_POOL["at"] < _MEALDB_TTL):
        return _MEALDB_POOL["recipes"]
    recipes, seen = [], set()
    for letter in "abcdefghijklmnopqrstuvwxyz":
        try:
            resp = _HTTP.get(_MEALDB + "search.php?f=" + letter, timeout=10)
            resp.raise_for_status()
            meals = (resp.json() or {}).get("meals") or []
        except Exception:
            continue  # a failed letter just means fewer recipes
        for m in meals:
            r = _mealdb_to_recipe(m)
            if not r:
                continue
            k = _title_key(r["title"])
            if not k or k in seen:
                continue
            seen.add(k)
            recipes.append(r)
    if recipes:
        _MEALDB_POOL["at"] = now
        _MEALDB_POOL["recipes"] = recipes
    return recipes


def _mealdb_priced_recipes(diets, chains, servings, exclude_titles):
    """Price MealDB recipes (diet-matched, not already shown) on the given
    chains. Same shape as the curated columns. Cached per filter combination
    for an hour so repeat searches are instant."""
    cache_key = (",".join(diets), ",".join(chains), servings)
    now = time.time()
    hit = _MEALDB_PRICED_CACHE.get(cache_key)
    if hit and now - hit[0] < 3600.0:
        return hit[1]
    priced_chains = [c for c in chains if c in gb.CHAIN_TABLES][:3]
    if not priced_chains:
        return {"single_store": [], "cheapest_overall": []}
    pool = [r for r in mealdb_pool() if _title_key(r["title"]) not in exclude_titles]
    if diets:
        pool = [r for r in pool
                if matches_diet(dict(r, items=[{"name": i["name"]}
                                              for i in r["ingredients"]]), diets)]
    if not pool:
        return {"single_store": [], "cheapest_overall": []}
    combined = dict()
    for c in priced_chains:
        for k, rows in gb.build_price_index(c).items():
            combined.setdefault(k, []).extend([dict(r, chain=c) for r in rows])
    s_map = {r["recipe_id"]: (r["recipeServings"], "default") for r in pool}
    columns = {"single_store": [], "cheapest_overall": []}
    for col, primary in (("single_store", priced_chains[0]), ("cheapest_overall", None)):
        for recipe in pool:
            res = gb._cost_recipe(recipe, combined, primary, s_map, servings)
            if res["mealCostCad"] is None or res["coverage"] < 0.9:
                continue  # exotic ingredients the stores don't stock
            res["missingFromPrimary"] = sorted(
                it["name"] for it in res["items"] if it["missing"])
            columns[col].append(res)
        columns[col] = gb.rank_and_pick(columns[col], 10)
    _MEALDB_PRICED_CACHE[cache_key] = (now, columns)
    return columns


# ---- AI-suggested recipe fallback ------------------------------------------
# When the curated recipe collection comes up thin for a filter combination
# (e.g. vegan + gluten-free), generate a few matching recipes with the AI
# service, price them against the same store price tables, and include them
# labelled "untested".

_AI_CACHE = dict()   # (diets, chains, servings) -> (timestamp, priced columns)
_AI_TTL = 3600.0

_DIET_TEXT = {
    "vegetarian": "vegetarian (no meat, fish or seafood)",
    "vegan": "vegan (no meat, fish, dairy, eggs or honey)",
    "gluten_free": "gluten-free (no wheat, barley, rye, bread or regular pasta)",
    "dairy_free": "dairy-free (no milk, butter, cheese, cream or yogurt)",
}


def _server_key():
    return (os.environ.get("GEMINI_API_KEY") or "").strip()


def _ai_generate_recipes(diets, n=4):
    """Ask the AI service for n simple recipes honouring the diet filters.
    Returns recipe dicts in the same shape gb.get_recipes() uses."""
    constraints = "; ".join(_DIET_TEXT.get(d, d) for d in diets)
    prompt = (
        "Create " + str(n) + " simple, cheap, home-cooked dinner recipes that are strictly "
        + constraints + ". Every ingredient must be a basic item sold at ordinary Canadian "
        "supermarkets (No Frills, Superstore, Sobeys, Walmart, T&T). Use plain store-style "
        "ingredient names like 'chickpeas', 'white rice', 'frozen peas', 'olive oil', "
        "'canned tomatoes'. Measures must be simple: g, mL, cups, tablespoons, teaspoons, "
        "cans, or a plain count like '2'. Avoid specialty items a small grocery store may "
        "not stock. Each recipe serves 4 and cooks in under 45 minutes. Respond as JSON "
        "only: {\"recipes\": [{\"title\": \"...\", \"category\": \"Main\", \"servings\": 4, "
        "\"instructions\": \"numbered short steps\", \"ingredients\": [{\"name\": \"...\", "
        "\"measure\": \"...\"}]}]}"
    )
    resp = _HTTP.post(
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-2.5-flash:generateContent",
        params={"key": _server_key()},
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.5, "responseMimeType": "application/json"},
        },
        timeout=45,
    )
    resp.raise_for_status()
    text = (((resp.json().get("candidates") or [{}])[0].get("content") or {})
            .get("parts") or [{}])[0].get("text") or ""
    parsed = json.loads(text)
    out = []
    for r in (parsed.get("recipes") or [])[:n]:
        title = str(r.get("title") or "").strip()[:120]
        ings = []
        for ing in (r.get("ingredients") or []):
            name = str(ing.get("name") or "").strip()
            if name:
                ings.append({"name": name[:80],
                             "measure": str(ing.get("measure") or "").strip()[:40]})
        if title and ings:
            out.append(dict(
                recipe_id="ai-" + re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40],
                title=title,
                category=str(r.get("category") or "Main").strip()[:40],
                area=None,
                instructions=str(r.get("instructions") or "").strip(),
                sourceUrl=None,
                ingredients=ings,
                recipeServings=4,
            ))
    return out


def _ai_priced_recipes(diets, chains, servings):
    """Generate AI recipes and price them on the given chains' price tables.
    Returns {"single_store": [...], "cheapest_overall": [...]}, every recipe
    flagged untested=True so the front end labels it."""
    cache_key = (",".join(diets), ",".join(chains), servings)
    now = time.time()
    hit = _AI_CACHE.get(cache_key)
    if hit and now - hit[0] < _AI_TTL:
        return hit[1]
    priced_chains = [c for c in chains if c in gb.CHAIN_TABLES][:3]
    if not priced_chains:
        return {"single_store": [], "cheapest_overall": []}
    generated = _ai_generate_recipes(diets)
    if not generated:
        return {"single_store": [], "cheapest_overall": []}
    combined = dict()
    for c in priced_chains:
        for k, rows in gb.build_price_index(c).items():
            combined.setdefault(k, []).extend([dict(r, chain=c) for r in rows])
    s_map = {r["recipe_id"]: (r["recipeServings"], "ai-estimate") for r in generated}
    columns = {"single_store": [], "cheapest_overall": []}
    for col, primary in (("single_store", priced_chains[0]), ("cheapest_overall", None)):
        for recipe in generated:
            res = gb._cost_recipe(recipe, combined, primary, s_map, servings)
            if res["mealCostCad"] is None or res["coverage"] < 0.5:
                continue  # not priceable at these stores
            res["untested"] = True
            res["servingsSource"] = "ai-estimate"
            res["missingFromPrimary"] = sorted(
                it["name"] for it in res["items"] if it["missing"])
            columns[col].append(res)
        columns[col] = gb.rank_and_pick(columns[col], 4)
    _AI_CACHE[cache_key] = (now, columns)
    return columns


@app.get("/api/recipes")
def recipes():
    chains = [c for c in (request.args.get("chains") or "").split(",") if c]
    if not chains:
        return jsonify(error="chains parameter required (e.g. chains=nofrills,safeway)"), 400
    try:
        servings = float(request.args.get("servings") or 1)
    except ValueError:
        servings = 1.0
    servings = max(0.25, min(20.0, round(servings, 2)))
    diets = [d for d in (request.args.get("diet") or "").split(",")
             if d in ("vegetarian", "vegan", "gluten_free", "dairy_free")]
    try:
        result = gb.cheapest_recipes(chains, count=10, servings=servings)
    except Exception as exc:
        return jsonify(error="Recipe lookup failed: " + str(exc)), 500
    if diets and not result.get("error"):
        result = dict(
            single_store=[r for r in result.get("single_store", []) if matches_diet(r, diets)],
            cheapest_overall=[r for r in result.get("cheapest_overall", []) if matches_diet(r, diets)],
        )
    # Still thin or repetitive (small curated table, strict diets)? Fill both
    # columns with more unique dishes pulled live from the public MealDB and
    # priced through the same store tables - no API key needed.
    if not result.get("error") and any(
            len(result.get(k) or []) < 6
            for k in ("single_store", "cheapest_overall")):
        try:
            exclude = {_title_key(r["title"])
                       for k in ("single_store", "cheapest_overall")
                       for r in result.get(k) or []}
            mdb = _mealdb_priced_recipes(diets, chains, servings, exclude)
        except Exception:
            mdb = None
        if mdb:
            for k in ("single_store", "cheapest_overall"):
                have = {_title_key(r["title"]) for r in result.get(k) or []}
                extra = [r for r in mdb.get(k) or []
                         if _title_key(r["title"]) not in have]
                result[k] = (result.get(k) or []) + extra
                result[k] = gb.rank_and_pick(result[k], 10)
    # Obscure filter combination even the MealDB pool cannot cover? Ask the AI
    # service for a few recipes and label them untested.
    if (diets and _server_key() and not result.get("error") and any(
            len(result.get(k) or []) < 3
            for k in ("single_store", "cheapest_overall"))):
        try:
            ai = _ai_priced_recipes(diets, chains, servings)
        except Exception:
            ai = None
        if ai and (ai.get("single_store") or ai.get("cheapest_overall")):
            for k in ("single_store", "cheapest_overall"):
                result[k] = (result.get(k) or []) + ai[k]
            result["untestedIncluded"] = True
    return jsonify(result)


@app.post("/api/recipe-image")
def recipe_image():
    """Candid, home-style photo of a chosen recipe. The caller supplies their
    own API key per request (X-Image-Key header); nothing is stored.
    A shared server key (app.yaml secret) takes precedence."""
    key = ((os.environ.get("GEMINI_API_KEY") or "").strip()
           or (request.headers.get("X-Image-Key") or "").strip())
    if not key:
        return jsonify(error="Dish photos aren't ready yet - the shared key is missing."), 400
    payload = request.get_json(force=True, silent=True) or {}
    title = str(payload.get("title") or "").strip()[:120]
    if not title:
        return jsonify(error="Missing recipe title."), 400
    prompt = (
        "An editorial food photograph of home-cooked " + title + ", in the style of a "
        "premium food magazine: natural directional window light from one side casting "
        "soft shadows, a textured backdrop of linen, marble or worn wood, shallow depth "
        "of field, visible steam and ingredient texture, muted earth-tone colour grading "
        "consistent across a set, minimal props (a linen napkin, a simple ceramic plate, "
        "a single fork). Realistic and unforced rather than a glossy studio render: no "
        "text, no watermark, no people, no plastic-perfect look."
    )
    try:
        resp = _HTTP.post(
            "https://generativelanguage.googleapis.com/v1beta/models/"
            "gemini-2.5-flash-image:generateContent",
            params={"key": key},
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=90,
        )
    except Exception:
        return jsonify(error="The photo service could not be reached - try again."), 502
    if resp.status_code in (401, 403):
        return jsonify(error="That API key was not accepted - double-check it under 'Dish photos'."), 400
    if resp.status_code == 429:
        return jsonify(error="The photo service is busy right now - try again in a moment."), 429
    if resp.status_code != 200:
        return jsonify(error="Photo failed (" + str(resp.status_code) + ") - try again."), 502
    try:
        data = resp.json()
    except Exception:
        return jsonify(error="Photo response was unreadable - try again."), 502
    parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    for part in parts:
        inline = part.get("inlineData") or part.get("inline_data") or {}
        b64 = inline.get("data")
        if b64:
            return jsonify(
                image=b64,
                mimeType=inline.get("mimeType") or inline.get("mime_type") or "image/png",
            )
    return jsonify(error="No photo came back - try again."), 502


@app.post("/api/recipe-chat")
def recipe_chat():
    """Cooking helper chat for one recipe: ingredient swaps + method guidance.
    The caller supplies their own API key per request (X-Image-Key header).
    A shared server key (app.yaml secret) takes precedence."""
    key = ((os.environ.get("GEMINI_API_KEY") or "").strip()
           or (request.headers.get("X-Image-Key") or "").strip())
    if not key:
        return jsonify(error="Dish photos aren't ready yet - the shared key is missing."), 400
    payload = request.get_json(force=True, silent=True) or {}
    recipe = payload.get("recipe") or {}
    title = str(recipe.get("title") or "").strip()[:120]
    if not title:
        return jsonify(error="Missing recipe title."), 400
    ingredients = [str(x)[:120] for x in (recipe.get("ingredients") or []) if x][:60]
    instructions = str(recipe.get("instructions") or "")[:4000]
    history = (payload.get("history") or [])[:12]
    message = str(payload.get("message") or "").strip()[:1000]
    if not message:
        return jsonify(error="Type a question first."), 400

    system = (
        "You are a friendly, plain-spoken kitchen helper inside a grocery budget "
        "app. The user is looking at one recipe. Help them cook it and adapt it. "
        "When they ask about ingredients, suggest practical swaps a home cook "
        "either already has or can get cheaply, and say in one short line how "
        "each swap changes flavour or texture. When they ask about the method, "
        "walk them through it in short numbered steps. Keep replies conversational "
        "- about 150 words at most unless they ask for more detail. Stay on the "
        "topic of this recipe. Do not name or promote any company, and never "
        "mention who made you."
    )
    recipe_block = "Recipe: " + title + "\n"
    if ingredients:
        recipe_block += "Ingredients: " + "; ".join(ingredients) + "\n"
    if instructions:
        recipe_block += "Method: " + instructions
    contents = []
    for h in history:
        role = "model" if h.get("role") in ("model", "assistant") else "user"
        text = str(h.get("text") or "").strip()[:1500]
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})
    contents.append({"role": "user", "parts": [{"text": recipe_block + "\n\n" + message}]})

    try:
        resp = _HTTP.post(
            "https://generativelanguage.googleapis.com/v1beta/models/"
            "gemini-2.5-flash:generateContent",
            params={"key": key},
            json={
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": contents,
                "generationConfig": {"maxOutputTokens": 700, "temperature": 0.7},
            },
            timeout=60,
        )
    except Exception:
        return jsonify(error="The helper could not be reached - try again."), 502
    if resp.status_code in (401, 403):
        return jsonify(error="That API key was not accepted - double-check it under 'Dish photos'."), 400
    if resp.status_code == 429:
        return jsonify(error="The helper is busy right now - try again in a moment."), 429
    if resp.status_code != 200:
        return jsonify(error="The helper hit a snag (" + str(resp.status_code) + ") - try again."), 502
    try:
        data = resp.json()
    except Exception:
        return jsonify(error="The helper's reply was unreadable - try again."), 502
    parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    text = "".join(str(p.get("text") or "") for p in parts).strip()
    if not text:
        return jsonify(error="The helper had nothing to say - try asking again."), 502
    return jsonify(reply=text)


def _warm_caches():
    """Fetch table data at app startup so the first user request skips the
    warehouse round trips entirely."""
    try:
        gb.get_recipes()
        gb.get_all_prices()
    except Exception:
        pass  # first request will retry lazily
    try:
        mealdb_pool()  # pull the live recipe pool so enrichment is instant
    except Exception:
        pass


threading.Thread(target=_warm_caches, daemon=True).start()


if __name__ == "__main__":
    import os
    app.run(
        host=os.environ.get("DATABRICKS_APP_HOST", "127.0.0.1"),
        port=int(os.environ.get("DATABRICKS_APP_PORT", "8000")),
    )
