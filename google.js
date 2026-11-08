// ---------- Google Maps version (only used when config.js has a key) ----------
var USE_GOOGLE = typeof GOOGLE_MAPS_API_KEY === "string" && GOOGLE_MAPS_API_KEY.trim() !== "";
var googleReady = null;
var googleKeyProblem = null;

function loadGoogle() {
  if (!googleReady) {
    googleReady = new Promise(function (resolve, reject) {
      window.__googleMapsLoaded = resolve;
      window.gm_authFailure = function () {
        googleKeyProblem = "Google rejected the API key. Check it in config.js and that both APIs are enabled.";
        reject(new Error(googleKeyProblem));
      };
      var s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(GOOGLE_MAPS_API_KEY.trim()) +
        "&v=weekly&loading=async&callback=__googleMapsLoaded";
      s.async = true;
      s.onerror = function () { reject(new Error("Couldn't load Google Maps.")); };
      document.head.appendChild(s);
    });
  }
  return googleReady;
}

// Searches Google for each chain near the point (Google returns at most 20
// places per search, so one search per chain avoids missing stores).
async function googleFindStores(lat, lon, radiusKm) {
  await loadGoogle();
  var lib = await google.maps.importLibrary("places");
  var dLat = radiusKm / 111;
  var dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  var box = { north: lat + dLat, south: lat - dLat, east: lon + dLon, west: lon - dLon };

  var failures = [];
  var searches = CHAINS.map(function (chain) {
    return lib.Place.searchByText({
      textQuery: chain.name + " grocery",
      fields: ["displayName", "formattedAddress", "location"],
      locationRestriction: box,
      maxResultCount: 20
    }).then(function (r) { return r.places || []; }).catch(function (e) {
      console.warn("Google search failed for", chain.name, e);
      failures.push(e);
      return [];
    });
  });
  var lists = await Promise.all(searches);
  if (googleKeyProblem) throw new Error(googleKeyProblem);
  // If every single search failed, it's a key/setup problem, not "no stores".
  if (failures.length === CHAINS.length) {
    throw new Error(failures[0] && failures[0].message ? failures[0].message : "Google search failed");
  }

  var seen = {};
  var stores = [];
  lists.forEach(function (places) {
    places.forEach(function (p) {
      if (!p.location) return;
      var name = p.displayName || "";
      var chain = chainOf(name);
      if (!chain) return;
      var s = {
        name: name,
        chain: chain,
        address: (p.formattedAddress || "").replace(/, Canada$/, ""),
        lat: p.location.lat(),
        lon: p.location.lng()
      };
      s.km = distanceKm(lat, lon, s.lat, s.lon);
      var k = chain + "|" + s.lat.toFixed(3) + "|" + s.lon.toFixed(3);
      if (s.km <= radiusKm && !seen[k]) { seen[k] = true; stores.push(s); }
    });
  });
  return stores.sort(function (a, b) { return a.km - b.km; });
}

// ---------- Google map drawing ----------
var gMap = null, gMarkers = [], gCircle = null, gInfo = null;

var DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1d201c" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#9a978d" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#121411" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#30342e" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1a1f" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] }
];
var LIGHT_STYLE = [{ featureType: "poi", stylers: [{ visibility: "off" }] }];

function googleTheme() {
  if (gMap) gMap.setOptions({ styles: currentTheme() === "dark" ? DARK_STYLE : LIGHT_STYLE });
}

async function googleDrawMap(lat, lon, stores, radius) {
  await loadGoogle();
  await google.maps.importLibrary("maps");
  var css = getComputedStyle(document.documentElement);
  var accent = css.getPropertyValue("--accent").trim();
  var you = css.getPropertyValue("--you").trim();

  if (!gMap) {
    gMap = new google.maps.Map(document.getElementById("map"), {
      center: { lat: lat, lng: lon }, zoom: 13,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: true
    });
    gInfo = new google.maps.InfoWindow();
  }
  googleTheme();
  gMarkers.forEach(function (m) { m.setMap(null); });
  gMarkers = [];
  if (gCircle) gCircle.setMap(null);

  gCircle = new google.maps.Circle({
    map: gMap, center: { lat: lat, lng: lon }, radius: radius * 1000,
    strokeColor: accent, strokeWeight: 1, fillColor: accent, fillOpacity: 0.05, clickable: false
  });
  gMap.fitBounds(gCircle.getBounds(), 12);

  gMarkers.push(new google.maps.Marker({
    map: gMap, position: { lat: lat, lng: lon }, title: "You are here", zIndex: 1000,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: you, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 3 }
  }));

  storePins = [];
  stores.forEach(function (s, i) {
    var m = new google.maps.Marker({
      map: gMap, position: { lat: s.lat, lng: s.lon }, title: s.name,
      label: { text: String(i + 1), color: "#ffffff", fontSize: "11px", fontWeight: "700" },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: accent, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 }
    });
    m.addListener("click", function () { openGooglePin(i); highlight(i, false); });
    gMarkers.push(m);
    storePins.push({ google: m, store: s });
  });
}

function openGooglePin(i) {
  var pin = storePins[i];
  if (!pin || !pin.google) return;
  var s = pin.store;
  var box = document.createElement("div");
  box.style.color = "#1c1c1a";
  var b = document.createElement("strong");
  b.textContent = s.name;
  box.append(b, document.createElement("br"), (s.address || "Address not listed") + " · " + s.km.toFixed(1) + " km ");
  var a = document.createElement("a");
  a.href = mapsUrl(s.lat, s.lon); a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = "Directions";
  box.appendChild(a);
  gInfo.setContent(box);
  gInfo.open({ map: gMap, anchor: pin.google });
  gMap.panTo(pin.google.getPosition());
}
