// ---------- Which chains to show ----------
// Edit this list to change which stores appear.
var CHAINS = [
  { name: "No Frills",     match: /no\s*frills/i },
  { name: "Superstore",    match: /superstore/i },
  { name: "Sobeys",        match: /sobeys/i },
  { name: "Walmart",       match: /walmart/i },
  { name: "T&T",           match: /\bT\s*(&|and)\s*T\b/i },
  { name: "IGA",           match: /\bIGA\b/i },
  { name: "Independent",   match: /independent/i },
  { name: "Save-On-Foods", match: /save[\s-]*on[\s-]*foods/i },
  { name: "Safeway",       match: /safeway/i }
];

// Same list, written the way the map server understands it.
var CHAIN_QUERY = "No ?Frills|Superstore|Sobeys|Walmart|T ?& ?T|T and T|IGA|Independent|Save-On|Save On|Safeway";

function chainOf(text) {
  if (!text) return null;
  for (var i = 0; i < CHAINS.length; i++) {
    if (CHAINS[i].match.test(text)) return CHAINS[i].name;
  }
  return null;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  var R = 6371, toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  var a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fetch that gives up after `ms` milliseconds.
function fetchWithTimeout(url, options, ms, outerSignal) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, ms);
  if (outerSignal) outerSignal.addEventListener("abort", function () { ctrl.abort(); });
  options = Object.assign({}, options, { signal: ctrl.signal });
  return fetch(url, options).finally(function () { clearTimeout(timer); });
}

// ---------- Store lookup (OpenStreetMap, free, no key) ----------
var OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];

// Remembers the last search so changing to a smaller distance is instant.
var storeCache = null;

async function findStores(lat, lon, radiusKm) {
  if (typeof USE_GOOGLE !== "undefined" && USE_GOOGLE) {
    try {
      return await googleFindStores(lat, lon, radiusKm);
    } catch (e) {
      // Google didn't work: say why, then use the free store data instead.
      console.warn("Google failed, using OpenStreetMap instead:", e);
      USE_GOOGLE = false;
      if (typeof onGoogleFailed === "function") onGoogleFailed(e);
    }
  }
  var key = lat.toFixed(4) + "," + lon.toFixed(4);
  if (storeCache && storeCache.key === key && radiusKm <= storeCache.radius) {
    return storeCache.stores.filter(function (s) { return s.km <= radiusKm; });
  }

  var r = Math.round(radiusKm * 1000);
  var around = "(around:" + r + "," + lat + "," + lon + ")";
  var shops = '["shop"~"supermarket|grocery|department_store|wholesale|general"]';
  // Only ask for our chains, so the answer is small and quick.
  var query = "[out:json][timeout:15];(" +
    "nwr" + shops + '["name"~"' + CHAIN_QUERY + '",i]' + around + ";" +
    "nwr" + shops + '["brand"~"' + CHAIN_QUERY + '",i]' + around + ";" +
    ");out center tags;";
  var body = "data=" + encodeURIComponent(query);

  // Ask every server at once and use whichever answers first.
  var stopOthers = new AbortController();
  var data = await Promise.any(OVERPASS_SERVERS.map(function (url) {
    return fetchWithTimeout(url, {
      method: "POST",
      body: body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }, 20000, stopOthers.signal).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
      return res.json();
    });
  }));
  stopOthers.abort();

  var seen = {};
  var stores = (data.elements || [])
    .map(function (el) {
      var t = el.tags || {};
      var sLat = el.lat != null ? el.lat : (el.center && el.center.lat);
      var sLon = el.lon != null ? el.lon : (el.center && el.center.lon);
      var street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
      var address = [street, t["addr:city"]].filter(Boolean).join(", ");
      var name = t.name || t.brand || "";
      return {
        name: name,
        chain: chainOf(name) || chainOf(t.brand),
        address: address,
        lat: sLat,
        lon: sLon
      };
    })
    .filter(function (s) { return s.lat != null && s.chain; })
    .map(function (s) { s.km = distanceKm(lat, lon, s.lat, s.lon); return s; })
    .filter(function (s) {
      var k = s.chain + "|" + s.lat.toFixed(3) + "|" + s.lon.toFixed(3);
      if (seen[k] || s.km > radiusKm) return false;
      seen[k] = true;
      return true;
    })
    .sort(function (a, b) { return a.km - b.km; });

  storeCache = { key: key, radius: radiusKm, stores: stores };
  return stores;
}
