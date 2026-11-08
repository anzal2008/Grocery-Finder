// Penny & Parsley front-end logic: postal form -> /api/locate -> /api/recipes -> two result columns
"use strict";

const POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][\s\-]?\d[ABCEGHJ-NPRSTV-Z]\d$/i;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ("&" === c ? "&amp;" : "<" === c ? "&lt;" : ">" === c ? "&gt;" : '"' === c ? "&quot;" : "&#39;"));
const cad = (v) => (v == null ? "-" : "$" + Number(v).toFixed(2));

// Theme: explicit light/dark toggle, remembered in localStorage
(function initTheme() {
  const root = document.documentElement;
  const btn = el("theme-btn");
  const saved = localStorage.getItem("gf-theme");
  const prefersDark = window.matchMedia
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = saved || (prefersDark ? "dark" : "light");
  if (btn) {
    const sync = () => {
      btn.textContent = root.dataset.theme === "dark" ? "Light" : "Dark";
    };
    sync();
    btn.addEventListener("click", () => {
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem("gf-theme", root.dataset.theme);
      sync();
    });
  }
})();

const COOKING_TIPS = [
  "Sharp knives are safer than dull ones - they slip less.",
  "Salt your pasta water until it tastes like the sea.",
  "Let meat rest 5-10 minutes after cooking so the juices redistribute.",
  "Dry protein well before searing - moisture steams instead of browning.",
  "Mise en place: prep and measure everything before you turn on the heat.",
  "Taste as you go, and season in layers - not all at the end.",
  "Freeze parmesan rinds and drop them into soups for extra depth.",
  "Toast whole spices in a dry pan for 30 seconds to wake up their flavour.",
  "A splash of lemon or vinegar at the end brightens almost any dish.",
  "Don't crowd the pan - food steams when packed too tight.",
  "Fold cold butter into mashed potatoes at the very end for extra fluff.",
  "Use a kitchen scale for baking - measuring cups vary wildly.",
  "Freeze chopped herbs in olive oil in ice-cube trays for instant flavour.",
  "Deglaze the pan with wine or stock - those brown bits are pure flavour.",
  "Start onions low and slow for sweetness; higher heat keeps their bite.",
  "Pasta water is liquid gold - use a splash to finish and loosen your sauce.",
  "Read the entire recipe from start to finish before you begin.",
  "Preheat the pan before adding oil; shimmering oil means it's ready.",
  "Buy whole spices and grind as you need them - they keep their punch far longer.",
  "A damp towel under your cutting board keeps it from sliding around.",
  "Let minced garlic rest for 10 minutes before cooking - it develops more flavour.",
  "Plunge blanched vegetables into ice water to stop them cooking and keep the colour.",
  "Roast vegetables at high heat (220C / 425F) for deeply caramelized edges.",
  "Bring eggs and dairy to room temperature before baking for smoother batters.",
  "Save chicken bones and vegetable trim in the freezer for free homemade stock.",
  "Rest steak on a warm plate, never a cold one, so it doesn't cool too fast.",
  "Whisk vinaigrettes in three parts oil to one part acid, then adjust.",
  "When doubling a recipe, spice and salt less than double - taste as you go.",
];

const BAKING_TIPS = [
  "Weigh flour instead of scooping - a packed cup can add 20% too much.",
  "Cold butter makes flaky pastry; warm butter makes dense cookies.",
  "Baking soda starts working the instant it gets wet - get the batter in the oven fast.",
  "Most ovens run 10-15 degrees off - a thermometer is cheaper than a ruined cake.",
  "Room-temperature eggs mix into batter smoothly; cold ones can curdle it.",
  "Toast nuts before baking - it doubles their flavour.",
  "Chill cookie dough overnight for deeper flavour and less spreading.",
  "Rotate the pan halfway through - every oven has a hot spot.",
  "Cover with foil if the top browns before the middle sets.",
  "Cool cakes fully before frosting, or the frosting slides off.",
  "Yeast likes warm liquid, not hot - too hot kills it.",
  "Fold gently - overmixing makes muffins and pancakes tough.",
];

let _bakeIdx = Math.floor(Math.random() * BAKING_TIPS.length);

let SERVER_KEY_ON = false; // true when a shared key is configured on the server

function getImgKey() {
  return (localStorage.getItem("gf-img-key") || "").trim();
}

function addPhotoButton(card, r) {
  const row = document.createElement("div");
  row.className = "photo-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "photo-btn";
  btn.textContent = "Take a photo of this dish";
  btn.prepend(lineIcon(ICON_CAMERA));
  row.appendChild(btn);
  card.appendChild(row);
  const box = document.createElement("div");
  box.className = "photo-box";
  box.hidden = true;
  card.appendChild(box);
  btn.addEventListener("click", () => requestDishPhoto(btn, box, r));
}

async function requestDishPhoto(btn, box, r) {
  const key = getImgKey();
  if (!key && !SERVER_KEY_ON) {
    const settings = el("photo-settings");
    if (settings) settings.open = true;
    const input = el("img-key");
    if (input) input.focus();
    box.hidden = false;
    box.textContent = "Dish photos aren't ready yet - the shared key is still being set up.";
    return;
  }
  btn.disabled = true;
  btn.textContent = "Taking the photo...";
  box.hidden = false;
  box.textContent = "";
  const tip = document.createElement("p");
  tip.className = "photo-tip";
  box.appendChild(tip);
  const showTip = () => {
    tip.textContent = "\u2022 " + BAKING_TIPS[_bakeIdx % BAKING_TIPS.length];
    _bakeIdx++;
    tip.classList.remove("tip-anim");
    void tip.offsetWidth; // restart the fade-in animation
    tip.classList.add("tip-anim");
  };
  showTip();
  const timer = setInterval(showTip, 2600);
  try {
    const resp = await fetch("/api/recipe-image", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Image-Key": key },
      body: JSON.stringify({ title: r.title }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.image) {
      throw new Error(data.error || "The photo did not come out - try again.");
    }
    box.textContent = "";
    const img = document.createElement("img");
    img.className = "dish-photo";
    img.alt = "Home-cooked " + r.title;
    img.src = "data:" + (data.mimeType || "image/png") + ";base64," + data.image;
    box.appendChild(img);
    btn.disabled = false;
    btn.textContent = "Take another photo";
  } catch (err) {
    box.textContent = "";
    const p = document.createElement("p");
    p.className = "photo-error";
    p.textContent = err.message || "The photo did not come out - try again.";
    box.appendChild(p);
    btn.disabled = false;
    btn.textContent = "Try again";
  } finally {
    clearInterval(timer);
  }
}

function addChatBox(card, r) {
  const row = document.createElement("div");
  row.className = "chat-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "photo-btn chat-btn";
  btn.textContent = "Ask the kitchen helper";
  btn.prepend(lineIcon(ICON_CHAT));
  row.appendChild(btn);
  card.appendChild(row);
  const box = document.createElement("div");
  box.className = "chat-box";
  box.hidden = true;
  card.appendChild(box);
  const ctx = {
    title: r.title,
    ingredients: (r.items || []).map((it) => (it.measure ? it.measure + " " + it.name : it.name)),
    instructions: r.instructions || "",
  };
  const history = [];
  let built = false;
  btn.addEventListener("click", () => {
    box.hidden = !box.hidden;
    if (!box.hidden && !built) {
      buildChat(box, history, ctx);
      built = true;
    }
  });
}

function buildChat(box, history, ctx) {
  const msgs = document.createElement("div");
  msgs.className = "chat-msgs";
  box.appendChild(msgs);

  const chips = document.createElement("div");
  chips.className = "chat-chips";
  ["What can I swap for tricky ingredients?", "Walk me through the steps", "How can I make this cheaper?"]
    .forEach((s) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = s;
      chip.addEventListener("click", () => {
        input.value = s;
        send.click();
      });
      chips.appendChild(chip);
    });
  box.appendChild(chips);

  const row = document.createElement("div");
  row.className = "chat-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "chat-input";
  input.placeholder = "Ask about swaps or how to make it...";
  input.setAttribute("aria-label", "Ask about this recipe");
  const send = document.createElement("button");
  send.type = "button";
  send.className = "chat-send";
  send.textContent = "Send";
  row.appendChild(input);
  row.appendChild(send);
  box.appendChild(row);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send.click();
  });

  const addMsg = (who, text) => {
    const m = document.createElement("p");
    m.className = "chat-msg " + who;
    m.textContent = text;
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    return m;
  };
  addMsg("bot", "Hi! Ask me about swapping ingredients or how to make this dish.");

  const sendChat = async () => {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    const key = getImgKey();
    if (!key && !SERVER_KEY_ON) {
      const settings = el("photo-settings");
      if (settings) settings.open = true;
      addMsg("bot", "Photos and chat aren't ready yet - the shared key is still being set up. Try again soon.");
      return;
    }
    input.value = "";
    addMsg("me", text);
    const waitMsg = addMsg("bot", "...");
    send.disabled = true;
    try {
      const resp = await fetch("/api/recipe-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Image-Key": key },
        body: JSON.stringify({ recipe: ctx, history: history, message: text }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.reply) {
        throw new Error(data.error || "The helper could not answer - try again.");
      }
      waitMsg.textContent = data.reply;
      history.push({ role: "user", text: text });
      history.push({ role: "assistant", text: data.reply });
    } catch (err) {
      waitMsg.textContent = err.message || "The helper could not answer - try again.";
    } finally {
      msgs.scrollTop = msgs.scrollHeight;
      send.disabled = false;
      input.focus();
    }
  };
  send.addEventListener("click", sendChat);
}

let _tipIdx = Math.floor(Math.random() * COOKING_TIPS.length);
let _tipTimer = null;
let _barTimer = null;
let _barT0 = 0;

function _showTip() {
  const tip = el("loading-tip");
  if (!tip) return;
  tip.textContent = "\u2022 " + COOKING_TIPS[_tipIdx % COOKING_TIPS.length];
  _tipIdx++;
  tip.classList.remove("tip-in");
  void tip.offsetWidth; // restart the fade-in animation
  tip.classList.add("tip-in");
}

function _startBar() {
  const fill = el("progress-fill");
  if (!fill) return;
  _barT0 = Date.now();
  if (_barTimer) clearInterval(_barTimer);
  fill.style.width = "0%";
  // accelerating-then-slowing fill: quick early progress, never quite 100%
  _barTimer = setInterval(() => {
    const secs = (Date.now() - _barT0) / 1000;
    const pct = Math.min(95, 16 * Math.sqrt(secs));
    fill.style.width = pct + "%";
    const pctEl = el("progress-pct");
    if (pctEl) pctEl.textContent = Math.round(pct) + "%";
  }, 150);
}

function _stopBar() {
  if (_barTimer) {
    clearInterval(_barTimer);
    _barTimer = null;
  }
}

function setLoading(on, msg) {
  el("loading").hidden = !on;
  if (msg) el("loading-msg").textContent = msg;
  if (on) {
    _showTip();
    if (!_tipTimer) _tipTimer = setInterval(_showTip, 3200);
    _startBar();
  } else {
    if (_tipTimer) {
      clearInterval(_tipTimer);
      _tipTimer = null;
    }
    _stopBar();
  }
}

function showError(msg) {
  const box = el("form-error");
  box.textContent = msg;
  box.hidden = !msg;
}

async function fetchJson(url) {
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || "Request failed (" + resp.status + ")");
  }
  return data;
}

function renderStores(data) {
  el("location-info").textContent = data.display
    ? "Showing results near " + data.display
    : "";
  const list = el("store-list");
  if (!data.stores || !data.stores.length) {
    list.innerHTML = "<li class='empty'>No stores of the tracked chains found nearby.</li>";
    el("total-count").textContent = "0";
    el("total-nearest").textContent = "-";
    return;
  }
  el("total-count").textContent = String(data.stores.length);
  const pricedChains = [];
  data.stores.forEach((s) => {
    if (s.priced !== false && pricedChains.indexOf(s.chainName) === -1) {
      pricedChains.push(s.chainName);
    }
  });
  el("total-nearest").textContent = pricedChains.slice(0, 3).join(" / ") || "-";
  list.innerHTML = data.stores.map((s, i) =>
    "<li data-idx='" + i + "'>" +
      "<span class='store-num'>" + (i + 1) + "</span>" +
      "<span class='store-line'>" +
        "<span class='store-name'>" + esc(s.chainName) +
          (s.priced === false ? " <i class='no-price'>no price data</i>" : "") + "</span>" +
        "<span class='leader'></span>" +
        "<span class='store-km'>" + Number(s.distanceKm).toFixed(1) + " km</span>" +
      "</span>" +
      "<span class='store-address'>" + esc(s.name) +
        (s.address ? " \u00b7 " + esc(s.address) : "") + "</span>" +
    "</li>"
  ).join("");
  list.querySelectorAll("li[data-idx]").forEach((li) => {
    li.addEventListener("click", () => {
      const m = _storeMarkers[Number(li.getAttribute("data-idx"))];
      if (m && _map) {
        _map.panTo(m.getLatLng());
        m.openPopup();
      }
    });
  });
}

let _map = null;
let _storeLayer = null;
let _userMarker = null;
let _storeMarkers = [];

function renderMap(loc) {
  const div = el("map");
  if (!div || typeof L === "undefined") {
    const fb = el("map-fallback");
    if (fb) fb.hidden = false;
    return;
  }
  if (!_map) {
    _map = L.map(div, { scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "\u00a9 OpenStreetMap contributors",
    }).addTo(_map);
  }
  if (_storeLayer) _storeLayer.remove();
  if (_userMarker) _userMarker.remove();
  const user = L.circleMarker([loc.lat, loc.lon], {
    radius: 8, color: "#c2410c", fillColor: "#c2410c", fillOpacity: 0.9, weight: 3,
  });
  _userMarker = user.addTo(_map).bindPopup("You are here");
  _storeLayer = L.layerGroup().addTo(_map);
  _storeMarkers = [];
  const pts = [[loc.lat, loc.lon]];
  (loc.stores || []).forEach((s, i) => {
    const pin = L.divIcon({
      className: "pin-wrap",
      html: "<div class='pin-store" + (s.priced === false ? " unpriced" : "") + "'><b>" + (i + 1) + "</b></div>",
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -26],
    });
    const m = L.marker([s.lat, s.lon], { icon: pin, title: s.name })
      .addTo(_storeLayer)
      .bindPopup(
        "<b>" + esc(s.chainName) + (s.priced === false ? " (no price data)" : "") + "</b><br>" +
        esc(s.name) + (s.address ? "<br>" + esc(s.address) : "") + "<br>" +
        Number(s.distanceKm).toFixed(1) + " km away"
      );
    _storeMarkers.push(m);
    pts.push([s.lat, s.lon]);
  });
  // Measure the container BEFORE fitting bounds: if the map was created
  // or re-laid-out while hidden, fitBounds would compute zoom from a 0x0
  // container and zoom out over the whole region.
  _map.invalidateSize();
  if (pts.length > 1) {
    // Frame the user plus the nearest handful of stores only, with a zoom cap,
    // so a 20 km result set doesn't zoom out to the whole city.
    const near = pts.slice(0, 7);
    _map.fitBounds(L.latLngBounds(near).pad(0.2), { maxZoom: 15 });
  } else {
    _map.setView([loc.lat, loc.lon], 13);
  }
}

// Thin line-art icons (1.5px stroke) - one consistent custom set, no icon fonts.
const ICON_CAMERA = '<path d="M4.5 8h3.2l1.8-2.6h5l1.8 2.6h3.2v11h-15z"/><circle cx="12" cy="13.2" r="3.4"/>';
const ICON_CHAT = '<path d="M20.5 11.7a8.1 8.1 0 0 1-8.2 8c-1.4 0-2.8-.3-4-1L3.5 20l1.2-4.6a8.1 8.1 0 1 1 15.8-3.7z"/>';
const ICON_PIN = '<path d="M12 21c-4.4-3.8-6.6-7.2-6.6-10.2a6.6 6.6 0 0 1 13.2 0C18.6 13.8 16.4 17.2 12 21z"/><circle cx="12" cy="10.4" r="2.4"/>';
const ICON_SEARCH = '<circle cx="11" cy="11" r="6.4"/><path d="M20 20l-4.4-4.4"/>';

function lineIcon(paths, size) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size || 16);
  svg.setAttribute("height", size || 16);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}

// Curated collection names - lifestyle framing instead of generic categories.
const CATEGORY_LABELS = {
  "main dish": "The Dinner Table", "main": "The Dinner Table", "dinner": "The Dinner Table",
  "chicken": "The Dinner Table", "beef": "The Dinner Table", "pork": "The Dinner Table",
  "lamb": "The Dinner Table", "pasta": "The Pasta Shelf",
  "vegan": "The Garden Plate", "vegetarian": "The Garden Plate", "salad": "The Garden Plate",
  "dessert": "Sweet Finishes", "desserts": "Sweet Finishes",
  "breakfast": "Morning Rituals", "breakfasts": "Morning Rituals",
  "seafood": "From the Coast", "fish": "From the Coast",
  "soup": "The Soup Pot", "starter": "Small Plates", "appetizer": "Small Plates",
  "side dish": "The Sides Board", "side": "The Sides Board", "sides": "The Sides Board",
  "bread": "The Baker's Rack", "baking": "The Baker's Rack",
};
function curatedCategory(c) {
  return CATEGORY_LABELS[String(c || "").trim().toLowerCase()] || c;
}

function recipeCard(r, mode, rank) {
  const card = document.createElement("article");
  card.className = "recipe-card" + (rank === 0 ? " rank-1" : "");
  const head = document.createElement("header");
  head.className = "card-head";
  if (typeof rank === "number") {
    const rankEl = document.createElement("span");
    rankEl.className = "rank" + (rank === 0 ? " best" : "");
    rankEl.textContent = "#" + (rank + 1);
    head.appendChild(rankEl);
  }
  const title = document.createElement("h3");
  title.textContent = r.title;
  head.appendChild(title);
  card.appendChild(head);

  const badges = document.createElement("div");
  badges.className = "badges";
  if (mode === "multi" && r.singleStoreMealCostCad != null
      && r.mealCostCad != null && r.singleStoreMealCostCad > r.mealCostCad + 0.005) {
    const b = document.createElement("span");
    b.className = "badge save";
    const save = (r.singleStoreMealCostCad - r.mealCostCad);
    b.textContent = "Save " + cad(save) + " by mixing stores";
    b.title = "Buying each item at the cheapest of your nearest stores instead of everything at "
      + "your nearest one store.";
    badges.appendChild(b);
  }
  if (r.category) {
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = curatedCategory(r.category);
    badges.appendChild(b);
  }
  if (r.area) {
    const b = document.createElement("span");
    b.className = "badge area";
    b.textContent = r.area;
    badges.appendChild(b);
  }
  if (r.untested) {
    const b = document.createElement("span");
    b.className = "badge untested";
    b.textContent = "Untested";
    b.title = "Suggested to match your filters; priced at your stores but not from the curated collection.";
    badges.appendChild(b);
  }
  card.appendChild(badges);

  if (r.recipeServings) {
    const snote = document.createElement("p");
    snote.className = "servings-note";
    const assumed = r.servingsSource === "default" || r.servingsSource === "none";
    snote.textContent = "Recipe yields " + r.recipeServings + " servings" +
      (assumed ? " (assumed - the source page did not state it)" : "") +
      ". Costs shown are for " + r.servings + " serving" + (r.servings > 1 ? "s" : "") + ".";
    card.appendChild(snote);
  }

  const totals = document.createElement("div");
  totals.className = "totals";
  const meal = document.createElement("div");
  meal.className = "total meal";
  const mLabel = document.createElement("span");
  mLabel.className = "total-label";
  mLabel.textContent = "Cost to make the meal";
  const mVal = document.createElement("strong");
  mVal.className = "total-value";
  mVal.textContent = cad(r.mealCostCad);
  meal.appendChild(mLabel);
  meal.appendChild(mVal);
  totals.appendChild(meal);
  const pkg = document.createElement("div");
  pkg.className = "total pkg";
  const pLabel = document.createElement("span");
  pLabel.className = "total-label";
  pLabel.textContent = "Cost of all full packages";
  const pVal = document.createElement("strong");
  pVal.className = "total-value";
  pVal.textContent = cad(r.fullPackageTotalCad);
  pkg.appendChild(pLabel);
  pkg.appendChild(pVal);
  totals.appendChild(pkg);
  card.appendChild(totals);

  if (mode === "single" && r.missingFromPrimary && r.missingFromPrimary.length) {
    const note = document.createElement("p");
    note.className = "fallback-note";
    note.textContent = "Sourced from other nearby stores: " + r.missingFromPrimary.join(", ");
    card.appendChild(note);
  }

  // ingredients table with matched products and both prices
  const wrap = document.createElement("details");
  wrap.className = "ing-details";
  const summary = document.createElement("summary");
  summary.textContent = "Ingredients and matched products (" + r.items.length + ")";
  wrap.appendChild(summary);
  wrap.appendChild(buildIngTable(r));
  card.appendChild(wrap);
  addInstructions(card, r);
  addSourceLink(card, r);
  return card;
}

function getMode() {
  const checked = document.querySelector("input[name='shopmode']:checked");
  return checked ? checked.value : "single";
}

const ADV_DEFAULTS = { servings: "", radiusKm: 20, stores: 3, diets: [] };
let advanced = (function loadAdvanced() {
  try {
    return Object.assign({}, ADV_DEFAULTS, JSON.parse(localStorage.getItem("gf-advanced") || "{}"));
  } catch (e) {
    return Object.assign({}, ADV_DEFAULTS);
  }
})();
function saveAdvanced() {
  localStorage.setItem("gf-advanced", JSON.stringify(advanced));
}

function getServings() {
  const exact = parseFloat(advanced.servings);
  if (advanced.servings !== "" && advanced.servings != null && !isNaN(exact) && exact > 0) {
    return String(Math.min(20, Math.max(0.25, exact)));
  }
  const slider = el("servings");
  return slider ? slider.value : "1";
}

function priceCap() {
  const s = el("max-price");
  if (!s) return Infinity;
  const v = parseFloat(s.value);
  return v >= 100 ? Infinity : v;
}

function underPriceCap(list) {
  const cap = priceCap();
  return (list || []).filter((r) => r.mealCostCad == null || Number(r.mealCostCad) <= cap);
}

function renderList(recipes, mode) {
  const container = el("recipes-list");
  container.textContent = "";
  if (!recipes || !recipes.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = mode === "single"
      ? "No recipes met the coverage requirement at your nearest store."
      : "No recipes met the coverage requirement across your " + advanced.stores + " nearest stores" +
        (advanced.diets.length || priceCap() !== Infinity
          ? " with your current filters - try loosening the price cap or dietary needs."
          : ".");
    container.appendChild(p);
    return;
  }
  recipes.forEach((r, i) => container.appendChild(recipeCard(r, mode, i)));
}

let lastChains = [];
let lastPrimary = "";
let lastRecipes = null; // cached /api/recipes response so mode toggles don't refetch

function renderRecipesFromCache() {
  if (!lastRecipes) return;
  const mode = getMode();
  if (mode === "single") {
    el("recipes-heading").textContent = "Cheapest meals at your nearest store" +
      (lastPrimary ? " (" + lastPrimary + ")" : "");
    el("recipes-meta").textContent =
      "Everything from your nearest priced store; anything missing is sourced from your next-nearest stores.";
  } else {
    el("recipes-heading").textContent = "Cheapest meals across your " + advanced.stores + " nearest stores";
    el("recipes-meta").textContent =
      "Mix and match: every ingredient comes from whichever of your nearest priced chains sells it cheapest.";
  }
  el("recipes-meta").textContent += lastRecipes.untestedIncluded
    ? " Recipes labelled Untested were suggested to match your filters and priced at your stores."
    : "";
  renderList(mode === "single"
    ? underPriceCap(lastRecipes.single_store)
    : underPriceCap(lastRecipes.cheapest_overall), mode);
  el("recipes").hidden = false;
}

async function renderRecipes(chains, servings) {
  setLoading(true, "Pricing recipes at " + chains.join(", ") + "...");
  try {
    lastRecipes = await fetchJson("/api/recipes?chains=" + chains.join(",") +
      "&servings=" + encodeURIComponent(servings) +
      (advanced.diets.length ? "&diet=" + encodeURIComponent(advanced.diets.join(",")) : ""));
    renderRecipesFromCache();
  } finally {
    setLoading(false);
  }
}

async function afterLocate(loc) {
  renderStores(loc);
  if (!loc.chains || !loc.chains.length) {
    setLoading(false);
    showError("No stores of the five priced chains were found near you.");
    return;
  }
  lastChains = loc.chains;
  const nearestPriced = (loc.stores || []).find((s) => s.priced !== false);
  lastPrimary = nearestPriced ? nearestPriced.chainName : "";
  // #map lives inside #results: reveal it BEFORE rendering so Leaflet can
  // measure the container; otherwise fitBounds zooms from a 0x0 box.
  el("results").hidden = false;
  renderMap(loc);
  await renderRecipes(lastChains, getServings());
}

async function run(postal) {
  showError("");
  el("results").hidden = true;
  el("recipes").hidden = true;
  setLoading(true, "Finding stores near you...");
  const loc = await fetchJson("/api/locate?postal=" + encodeURIComponent(postal) +
    "&radius_m=" + Math.round(advanced.radiusKm * 10) * 100 +
    "&stores=" + advanced.stores);
  await afterLocate(loc);
}

async function runCoords(lat, lon) {
  showError("");
  el("results").hidden = true;
  el("recipes").hidden = true;
  setLoading(true, "Finding stores near you...");
  const loc = await fetchJson("/api/locate?lat=" + lat + "&lon=" + lon +
    "&radius_m=" + Math.round(advanced.radiusKm * 10) * 100 +
    "&stores=" + advanced.stores);
  await afterLocate(loc);
}

el("postal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = el("postal").value.trim().toUpperCase();
  if (!POSTAL_RE.test(raw)) {
    showError("Enter a valid Canadian postal code like V5K 0A1.");
    return;
  }
  try {
    await run(raw);
  } catch (err) {
    setLoading(false);
    showError(err.message || "Something went wrong.");
  }
});

(function initServingsSlider() {
  const slider = el("servings");
  const label = el("servings-value");
  if (!slider) return;
  const syncLabel = () => {
    if (!label) return;
    label.textContent = Number(slider.value) >= Number(slider.max)
      ? slider.value + "+"
      : slider.value;
  };
  syncLabel();
  slider.addEventListener("input", syncLabel);
  slider.addEventListener("change", async () => {
    if (!lastChains.length) {
      return;
    }
    el("results").hidden = false;
    try {
      await renderRecipes(lastChains, getServings());
    } catch (err) {
      showError(err.message || "Something went wrong.");
    }
  });
})();

(function initPriceSlider() {
  const s = el("max-price");
  const label = el("max-price-value");
  if (!s) return;
  const sync = () => {
    const v = parseFloat(s.value);
    if (label) {
      label.textContent = v >= 100 ? "Any" : "$" + v.toFixed(2).replace(/\.00$/, "");
    }
  };
  sync();
  s.addEventListener("input", () => {
    sync();
    if (lastRecipes) renderRecipesFromCache();
  });
})();

(function initAdvancedPage() {
  const btn = el("advanced-btn");
  const sec = el("advanced");
  if (!btn || !sec) return;
  const servingsInput = el("adv-servings");
  const radius = el("adv-radius");
  const radiusVal = el("adv-radius-value");
  const stores = el("adv-stores");
  const storesVal = el("adv-stores-value");
  const dietBoxes = [
    ["diet-vegetarian", "vegetarian"],
    ["diet-vegan", "vegan"],
    ["diet-gluten", "gluten_free"],
    ["diet-dairy", "dairy_free"],
  ];
  const syncRadius = () => {
    if (radiusVal) radiusVal.textContent = Number(radius.value).toFixed(1) + " km";
  };
  const syncStores = () => {
    if (storesVal) storesVal.textContent = stores.value;
  };
  if (servingsInput) {
    servingsInput.value = advanced.servings || "";
    servingsInput.addEventListener("change", () => {
      advanced.servings = servingsInput.value.trim();
      saveAdvanced();
    });
  }
  if (radius) {
    radius.value = advanced.radiusKm;
    syncRadius();
    radius.addEventListener("input", () => {
      advanced.radiusKm = Number(radius.value);
      saveAdvanced();
      syncRadius();
    });
  }
  if (stores) {
    stores.value = advanced.stores;
    syncStores();
    stores.addEventListener("input", () => {
      advanced.stores = Number(stores.value);
      saveAdvanced();
      syncStores();
    });
  }
  dietBoxes.forEach(([id, key]) => {
    const box = el(id);
    if (!box) return;
    box.checked = advanced.diets.indexOf(key) !== -1;
    box.addEventListener("change", () => {
      const idx = advanced.diets.indexOf(key);
      if (box.checked && idx === -1) advanced.diets.push(key);
      if (!box.checked && idx !== -1) advanced.diets.splice(idx, 1);
      saveAdvanced();
    });
  });
  const openAdvanced = (open) => {
    document.body.classList.toggle("adv-open", open);
    sec.hidden = !open;
    btn.textContent = open ? "Save" : "Advanced";
  };
  btn.addEventListener("click", () =>
    openAdvanced(!document.body.classList.contains("adv-open")));
  const back = el("adv-back");
  if (back) back.addEventListener("click", () => {
    saveAdvanced(); // every control already saves on change; this confirms it
    back.textContent = "Saved \u2713";
    window.setTimeout(() => {
      back.textContent = "Save settings";
      openAdvanced(false);
    }, 600);
  });
})();

(function initStaticIcons() {
  const pin = el("use-location");
  if (pin && !pin.querySelector("svg")) pin.prepend(lineIcon(ICON_PIN, 15));
  const submit = document.querySelector("#postal-form button[type='submit']");
  if (submit && !submit.querySelector("svg")) submit.prepend(lineIcon(ICON_SEARCH, 15));
})();

document.querySelectorAll("input[name='shopmode']").forEach((radio) => {
  radio.addEventListener("change", () => {
    if (lastRecipes) {
      renderRecipesFromCache();
    }
  });
});

el("use-location").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showError("Your browser does not support sharing your location - enter a postal code instead.");
    return;
  }
  showError("");
  setLoading(true, "Getting your location...");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        await runCoords(pos.coords.latitude, pos.coords.longitude);
      } catch (err) {
        setLoading(false);
        showError(err.message || "Something went wrong.");
      }
    },
    (err) => {
      setLoading(false);
      showError(err.code === err.PERMISSION_DENIED
        ? "Location permission denied - enter a postal code instead."
        : "Could not get your location - enter a postal code instead.");
    },
    { timeout: 10000, maximumAge: 60000 }
  );
});

function addInstructions(card, r) {
  if (!r.instructions) return;
  const inst = document.createElement("details");
  inst.className = "inst-details";
  const isum = document.createElement("summary");
  isum.textContent = "Instructions";
  inst.appendChild(isum);
  const body = document.createElement("div");
  body.className = "instructions";
  body.textContent = r.instructions;
  inst.appendChild(body);
  card.appendChild(inst);
}

function addSourceLink(card, r) {
  if (!r.sourceUrl) return;
  const link = document.createElement("a");
  link.className = "source-link";
  link.href = r.sourceUrl;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Original recipe";
  card.appendChild(link);
}

function buildIngTable(r) {
  const table = document.createElement("table");
  table.className = "ing-table";
  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  hrow.appendChild(td("Amount"));
  hrow.appendChild(td("Ingredient"));
  hrow.appendChild(td("Matched product"));
  hrow.appendChild(td("Brand"));
  hrow.appendChild(td("Package"));
  hrow.appendChild(td("Chain"));
  hrow.appendChild(td("Full package"));
  hrow.appendChild(td("Meal cost"));
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  r.items.forEach((it) => tbody.appendChild(itemRow(it)));
  table.appendChild(tbody);
  return table;
}

function td(text, cls) {
  const cell = document.createElement("td");
  cell.textContent = text == null || text === "" ? "-" : String(text);
  if (cls) cell.className = cls;
  return cell;
}

function itemRow(it) {
  const tr = document.createElement("tr");
  if (it.missing) {
    tr.className = "missing";
    tr.appendChild(td(it.measure));
    tr.appendChild(td(it.name));
    const span = document.createElement("td");
    span.colSpan = 6;
    span.textContent = "not priced nearby";
    tr.appendChild(span);
    return tr;
  }
  if (it.optional) {
    tr.className = "optional";
    tr.appendChild(td(it.measure));
    tr.appendChild(td(it.name));
    const span = document.createElement("td");
    span.colSpan = 6;
    span.textContent = "optional - not priced";
    tr.appendChild(span);
    return tr;
  }
  const pkg = it.packageQuantity != null && it.packageUnit
    ? it.packageQuantity + " " + it.packageUnit : "-";
  const nameCell = td(it.name);
  if (it.approximate) {
    const flag = document.createElement("span");
    flag.className = "approx";
    flag.title = "amount converted with approximate kitchen conversions";
    flag.textContent = " ~";
    nameCell.appendChild(flag);
  }
  tr.appendChild(td(it.measure));
  tr.appendChild(nameCell);
  tr.appendChild(td(it.product));
  tr.appendChild(td(it.brand));
  tr.appendChild(td(pkg));
  tr.appendChild(td(it.chain));
  tr.appendChild(td(cad(it.fullPackageCad)));
  tr.appendChild(td(cad(it.mealCostCad)));
  return tr;
}

// API-key panel removed - the shared server key (Databricks secret) powers photos and chat.
