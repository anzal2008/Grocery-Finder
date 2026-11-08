/* L-account.js — Grocery Finder account kit (L = Louis / new code)
   Sign-in: Auth0 PKCE, no external library. Redirect back to the exact
   page URL, so it works on http://localhost:8000 and on a real host.
   Cloud sync: Firestore REST — paste a Firebase config once, data then
   syncs per signed-in user across devices (last write wins). */
(function () {
  'use strict';

  // (Sign-in via Auth0 removed — the app runs as a local guest.)

  var PRICES_URL = 'data/superstore-prices.json';
  var LS_PREFIX  = 'gf-account-';
  var CLOUD_STORE = 'gf-firebase-cfg';

  var user   = null;
  var prices = null;
  var data   = emptyData();
  var aiRecipe = null;
  var cloud  = null;   // { apiKey, projectId }
  var pushTimer = null;

  function emptyData() {
    return { area: null, stores: [], list: [], alerts: [], lastPrices: {}, feed: [], recipes: [], budget: null, updatedAt: 0 };
  }

  // ---------- tiny helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '$' + Number(n).toFixed(2); }
  function key() { return LS_PREFIX + (user ? user.sub : 'guest'); }
  function loadData() {
    try { data = JSON.parse(localStorage.getItem(key())) || emptyData(); }
    catch (e) { data = emptyData(); }
    var base = emptyData();
    Object.keys(base).forEach(function (k) { if (data[k] == null) data[k] = base[k]; });
    if (!data.updatedAt) data.updatedAt = 0;
    data.alerts = (data.alerts || []).map(function (a) {
      return { category: a.category || String(a.id || '').split(':')[0], createdAt: a.createdAt || new Date().toISOString() };
    }).filter(function (a, i, all) {
      return a.category && !all.slice(0, i).some(function (b) { return b.category === a.category; });
    });
    data.list = (data.list || []).map(function (i) {
      return { name: i.name, checked: !!i.checked, pantry: !!i.pantry, matches: i.matches || matchProducts(i.name).slice(0, 3) };
    });
    data.recipes = (data.recipes || []).map(function (r) {
      return { name: r.name, items: r.items || [], steps: r.steps || [] };
    });
  }
  function saveData(skipCloud) {
    data.updatedAt = Date.now();
    try { localStorage.setItem(key(), JSON.stringify(data)); } catch (e) {}
    if (!skipCloud) scheduleCloudPush();
  }
  function renderAll() {
    renderStores(); renderList(); renderAlerts(); renderFeed(); renderBadge(); renderRecipes();
    $('budget-input').value = data.budget == null ? '' : data.budget;
    checkAlerts();
  }

  // ---------- account chip (sign-in removed) ----------
  function renderUser() {
    $('account-open-btn').textContent = '✨ AI chef';
  }

  // ---------- drawer ----------
  var drawer = null;
  function openDrawer() {
    drawer.hidden = false;
    requestAnimationFrame(function () { drawer.classList.add('open'); });
    cloudPull(true);   // grab any newer data from the cloud while it opens
  }
  function closeDrawer() { drawer.classList.remove('open'); setTimeout(function () { drawer.hidden = true; }, 220); }

  function wireDrawer() {
    drawer = $('account-drawer');
    $('account-open-btn').addEventListener('click', openDrawer);
    $('drawer-close-btn').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

    var tabs = document.querySelectorAll('.drawer-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        document.querySelectorAll('.drawer-panel').forEach(function (p) { p.classList.remove('active'); });
        $('panel-' + tab.getAttribute('data-tab')).classList.add('active');
      });
    });

  }

  function switchTab(name) {
    var tab = document.querySelector('.drawer-tab[data-tab="' + name + '"]');
    if (tab) tab.click();
  }

  // ---------- cloud sync (Firestore REST, no SDK) ----------
  function cloudStatus(msg) {
    var el = $('cloud-status');
    if (el) el.textContent = msg;
  }

  function parseFirebaseConfig(text) {
    if (!text) return null;
    var apiKey = (text.match(/apiKey\"?\s*[:=]\s*\"([^\"]+)\"/) || [])[1];
    var projectId = (text.match(/projectId\"?\s*[:=]\s*\"([^\"]+)\"/) || [])[1];
    if (!apiKey || !projectId) return null;
    return { apiKey: apiKey, projectId: projectId };
  }

  function cloudConfig() {
    if (cloud) return cloud;
    try { cloud = JSON.parse(localStorage.getItem(CLOUD_STORE)); } catch (e) { cloud = null; }
    return (cloud && cloud.apiKey && cloud.projectId) ? cloud : null;
  }

  function docUrl() {
    if (!user || !cloudConfig()) return null;
    return 'https://firestore.googleapis.com/v1/projects/' + cloud.projectId +
      '/databases/(default)/documents/gfUsers/' + encodeURIComponent(user.sub);
  }

  function scheduleCloudPush() {
    if (!user || !cloudConfig()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(cloudPush, 1500);   // debounce rapid edits
  }

  async function cloudPush() {
    var url = docUrl();
    if (!url) return;
    try {
      var res = await fetch(url + '?key=' + encodeURIComponent(cloud.apiKey) + '&currentDocument.exists=true', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            blob:      { stringValue: JSON.stringify(data) },
            updatedAt: { doubleValue: data.updatedAt },
            email:     { stringValue: user.email || '' }
          }
        })
      });
      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        cloudStatus('Cloud sync: problem saving — ' + ((err.error && err.error.message) || res.status).slice(0, 60));
        console.warn('cloudPush failed', err);
        return;
      }
      cloudStatus('Cloud sync: on ✓ saved ' + new Date().toLocaleTimeString());
    } catch (e) {
      cloudStatus('Cloud sync: offline — will retry on next change');
    }
  }

  async function cloudPull(quiet) {
    var url = docUrl();
    if (!url) return;
    try {
      var res = await fetch(url + '?key=' + encodeURIComponent(cloud.apiKey));
      if (res.status === 404) { if (!quiet) cloudPush(); return; }   // nothing in the cloud yet
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var doc = await res.json();
      var remoteTs = (doc.fields && doc.fields.updatedAt && Number(doc.fields.updatedAt.doubleValue)) || 0;
      var blob = doc.fields && doc.fields.blob && doc.fields.blob.stringValue;
      if (!blob) return;
      if (remoteTs <= (data.updatedAt || 0)) return;   // local is newer or equal
      var remote = JSON.parse(blob);
      var base = emptyData();
      Object.keys(base).forEach(function (k) { if (remote[k] == null) remote[k] = base[k]; });
      remote.updatedAt = remoteTs;
      data = remote;
      try { localStorage.setItem(key(), JSON.stringify(data)); } catch (e) {}
      renderAll();
      cloudStatus('Cloud sync: on ✓ loaded ' + new Date(remoteTs).toLocaleTimeString());
    } catch (e) {
      if (!quiet) cloudStatus('Cloud sync: problem loading — ' + (e && e.message ? e.message : e));
      console.warn('cloudPull failed', e);
    }
  }

  function connectCloud() {
    var cfg = parseFirebaseConfig($('cloud-input').value);
    if (!cfg) {
      cloudStatus('That didn\'t look like a Firebase config — it needs apiKey and projectId');
      return;
    }
    cloud = cfg;
    try { localStorage.setItem(CLOUD_STORE, JSON.stringify(cfg)); } catch (e) {}
    $('cloud-input').hidden = true;
    $('cloud-connect-btn').hidden = true;
    cloudStatus('Cloud sync: connecting…');
    cloudPush();
  }

  function renderCloudUi() {
    var input = $('cloud-input'), btn = $('cloud-connect-btn');
    if (cloudConfig()) {
      input.hidden = true; btn.hidden = true;
      cloudStatus(user ? 'Cloud sync: on ✓' : 'Cloud sync: on — sign in to start syncing');
    } else {
      input.hidden = false; btn.hidden = false;
      cloudStatus('Cloud sync: not set up — your data lives only in this browser. Paste a Firebase config below to sync across devices.');
    }
  }

  // ---------- sample data (for testing) ----------
  function loadDemo() {
    var btn = $('demo-data-btn');
    var added = [];

    var demoStores = [
      { name: 'Real Canadian Superstore', address: '350 SE Marine Dr, Vancouver', lat: 49.2736, lon: -123.0945, km: 1.2 },
      { name: 'No Frills', address: '2545 Quebec St, Vancouver', lat: 49.2632, lon: -123.1004, km: 2.1 }
    ];
    demoStores.forEach(function (s) {
      var dup = data.stores.some(function (m) { return m.name === s.name; });
      if (!dup) { data.stores.push(s); added.push(s.name); }
    });
    if (!data.area) {
      data.area = { label: 'V6K 1P2', lat: 49.2639, lon: -123.0670, input: 'V6K 1P2', mode: 'postal' };
    }

    ['butter', 'eggs', 'rice', 'milk', 'flour'].forEach(function (n) {
      if (!data.list.some(function (i) { return i.name === n; })) {
        data.list.push({ name: n, checked: false, pantry: false, matches: matchProducts(n).slice(0, 3) });
        added.push(n);
      }
    });

    if (!data.recipes.some(function (r) { return r.name === 'Pancakes (sample)'; })) {
      data.recipes.push({
        name: 'Pancakes (sample)',
        items: ['flour', 'milk', 'eggs', 'butter'],
        steps: [
          'Whisk 1 cup flour, 1 tbsp sugar and a pinch of salt.',
          'Add 1 cup milk and 2 eggs; whisk until smooth.',
          'Melt 2 tbsp butter in a pan over medium heat.',
          'Pour batter in circles; flip when bubbles form, about 2 min per side.',
          'Stack, add maple syrup, eat.'
        ]
      });
      added.push('Pancakes (sample)');
    }

    if (!data.alerts.some(function (a) { return a.category === 'eggs'; })) {
      data.alerts.push({ category: 'eggs', createdAt: new Date().toISOString() });
      added.push('eggs watch');
    }

    if (!data.budget) data.budget = 60;

    saveData();
    renderAll();
    switchTab('stores');

    btn.textContent = added.length
      ? 'Added ' + added.length + ' things ✓ (check the tabs)'
      : 'Sample data already loaded ✓';
    setTimeout(function () { btn.textContent = 'Load sample data'; }, 2500);
  }

  // ---------- My Stores ----------
  function saveCurrentStores() {
    var pins = (window.storePins || []).filter(function (p) { return p && p.store; });
    if (!pins.length) { $('save-stores-btn').textContent = 'Search for stores first'; return; }

    var added = 0;
    pins.forEach(function (p) {
      var s = p.store;
      var dup = data.stores.some(function (m) {
        return m.name === s.name && m.address === (s.address || '');
      });
      if (!dup) {
        data.stores.push({
          name: s.name, address: s.address || '',
          lat: s.lat, lon: s.lon, km: s.km,
          savedAt: new Date().toISOString()
        });
        added++;
      }
    });

    if (window.lastSearch) {
      data.area = {
        label: window.lastSearch.label,
        lat: window.lastSearch.lat, lon: window.lastSearch.lon,
        input: $('place').value,
        mode: (typeof window.searchMode === 'function') ? window.searchMode() : 'postal'
      };
    }
    saveData();
    renderStores();
    $('save-stores-btn').textContent = added
      ? 'Saved ' + added + ' store' + (added === 1 ? '' : 's') + ' ✓'
      : 'Already saved ✓';
  }

  function removeStore(i) { data.stores.splice(i, 1); saveData(); renderStores(); }

  function renderStores() {
    var ul = $('my-stores-list');
    ul.replaceChildren();

    var areaBtn = $('search-my-area-btn');
    if (data.area && data.area.input) {
      areaBtn.hidden = false;
      areaBtn.textContent = 'Search my area again — ' + data.area.label;
    }

    if (!data.stores.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No saved stores yet. Search, then press "Save these search results".';
      ul.appendChild(li);
      return;
    }

    data.stores.slice().sort(function (a, b) { return a.km - b.km; }).forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'store-row';
      li.innerHTML =
        '<span class="store-main"><strong>' + esc(s.name) + '</strong>' +
        '<span class="dim">' + esc(s.address || '') + ' · ' + Number(s.km).toFixed(1) + ' km</span></span>' +
        '<span class="store-actions">' +
        '<a href="https://www.google.com/maps/search/?api=1&query=' + s.lat + ',' + s.lon + '" target="_blank" rel="noopener noreferrer">Directions</a>' +
        '<button type="button" class="tiny-danger" aria-label="Remove">✕</button></span>';
      li.querySelector('.tiny-danger').addEventListener('click', function () {
        removeStore(data.stores.indexOf(s));
      });
      ul.appendChild(li);
    });
  }

  function searchMyArea() {
    closeDrawer();
    var form = $('search-form'), input = $('place');
    if (!form || !input || !data.area) return;
    var isAddress = data.area.mode === 'address';
    var modeRadios = document.querySelectorAll('input[name="mode"]');
    modeRadios.forEach(function (r) {
      r.checked = isAddress ? (r.value === 'address') : (r.value === 'postal');
    });
    modeRadios[0].dispatchEvent(new Event('change'));
    input.value = data.area.input;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  // ---------- prices ----------
  function loadPrices() {
    return fetch(PRICES_URL)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (p) {
        if (!p && typeof SUPERSTORE_PRICES !== 'undefined') p = SUPERSTORE_PRICES;
        return p;
      });
  }

  function categories() {
    if (!prices) return [];
    return Object.keys(prices.retailers.superstore.categories || {});
  }

  function productsIn(category) {
    return (prices.retailers.superstore.categories[category] || []);
  }

  function cheapestIn(category) {
    var prods = productsIn(category);
    if (!prods.length) return null;
    return prods.reduce(function (a, b) { return (b.unitPriceCad < a.unitPriceCad) ? b : a; });
  }

  function unitLabel(basis) {
    return basis === 'per 100 g' ? '/100g' : '/egg';
  }

  function matchProducts(itemName) {
    var words = itemName.toLowerCase().split(/[^a-z]+/).filter(function (w) { return w.length >= 4; });
    if (!words.length) return [];
    var out = [];
    categories().forEach(function (cat) {
      productsIn(cat).forEach(function (p) {
        var name = (p.name || '').toLowerCase();
        var hits = words.filter(function (w) { return name.indexOf(w) > -1; }).length;
        if (hits) out.push({ product: p, category: cat, hits: hits });
      });
    });
    out.sort(function (a, b) { return b.hits - a.hits || a.product.unitPriceCad - b.product.unitPriceCad; });
    return out;
  }

  // ---------- shopping list ----------
  function addItem(name) {
    var input = $('list-input');
    var n = (name || input.value).trim().toLowerCase();
    if (!n) return;
    if (data.list.some(function (i) { return i.name === n; })) return false;
    data.list.push({ name: n, checked: false, pantry: false, matches: matchProducts(n).slice(0, 3) });
    if (!name) input.value = '';
    saveData();
    renderList();
    return true;
  }

  function togglePantry(item) {
    item.pantry = !item.pantry;
    saveData(); renderList();
  }

  function renderList() {
    var ul = $('shopping-list');
    ul.replaceChildren();
    var total = 0, priced = 0;

    data.list.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'store-row' + (item.checked ? ' done' : '') + (item.pantry ? ' pantry' : '');

      var best = item.matches && item.matches.length ? item.matches[0] : null;
      var priceHtml = '';
      if (best) {
        var p = best.product;
        priceHtml = '<span class="price">' + money(p.priceCad) +
          ' <span class="dim">(' + money(p.unitPriceCad) + unitLabel(p.unitPriceBasis) + ')</span></span>';
        if (!item.checked && !item.pantry) { total += p.priceCad; priced++; }
      } else {
        priceHtml = '<span class="dim">not in price file</span>';
      }

      li.innerHTML =
        '<label class="store-main check"><input type="checkbox"' + (item.checked ? ' checked' : '') + '> ' +
        '<span><strong>' + esc(item.name) + '</strong>' + priceHtml +
        (best ? '<span class="dim">' + esc(best.product.name) + '</span>' : '') + '</span></label>' +
        '<span class="store-actions">' +
        '<button type="button" class="tiny-btn pantry-btn' + (item.pantry ? ' on' : '') + '" title="I have this at home">🧺</button>' +
        '<button type="button" class="tiny-danger" aria-label="Remove">✕</button></span>';

      li.querySelector('input[type=checkbox]').addEventListener('change', function (e) {
        item.checked = e.target.checked; saveData(); renderList();
      });
      li.querySelector('.pantry-btn').addEventListener('click', function () { togglePantry(item); });
      li.querySelector('.tiny-danger').addEventListener('click', function () {
        data.list.splice(data.list.indexOf(item), 1); saveData(); renderList();
      });
      ul.appendChild(li);
    });

    if (!data.list.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Empty list. Type an ingredient — try butter, eggs or rice.';
      ul.appendChild(li);
      $('list-total').textContent = '';
      renderBudgetLine(0);
      return;
    }
    $('list-total').textContent = priced
      ? 'To buy: about ' + money(total) + ' at Superstore (' + priced + ' item' + (priced === 1 ? '' : 's') + ' priced, cheapest package each)'
      : 'Add items to price them';
    renderBudgetLine(total);
  }

  // ---------- weekly budget (optional) ----------
  function renderBudgetLine(total) {
    var el = $('budget-line');
    if (!data.budget) { el.hidden = true; return; }
    var left = data.budget - total;
    el.hidden = false;
    el.className = 'drawer-total' + (left < 0 ? ' over' : '');
    el.textContent = left >= 0
      ? 'Weekly budget ' + money(data.budget) + ' — ' + money(left) + ' left'
      : 'Weekly budget ' + money(data.budget) + ' — ' + money(-left) + ' OVER';
  }

  function setBudget() {
    var v = $('budget-input').value;
    data.budget = (v === '' || Number(v) <= 0) ? null : Number(v);
    saveData();
    renderList();
    $('budget-input').value = data.budget == null ? '' : data.budget;
  }

  // ---------- AI chef (Gemini) ----------
  function aiFlash(msg) {
    var btn = $('ai-generate-btn');
    btn.textContent = msg;
    setTimeout(function () { btn.textContent = 'Make the recipe'; }, 2600);
  }

  async function aiGenerate() {
    var desc = $('ai-desc').value.trim();
    if (!desc) { aiFlash('Describe what you want to eat'); return; }

    var btn = $('ai-generate-btn');
    btn.disabled = true; btn.textContent = 'Cooking…';
    try {
      var res = await fetch('/api/ai-chef', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desc: desc })
      });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok || !j.items) throw new Error(j.error || ('Error ' + res.status));
      aiRecipe = {
        name: String(j.name || desc).trim(),
        items: (j.items || []).map(function (s) { return String(s).toLowerCase().trim(); }).filter(Boolean),
        steps: (j.steps || []).map(function (s) { return String(s).trim(); }).filter(Boolean)
      };
      renderAiResult();
      btn.textContent = 'Make the recipe';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Make the recipe';
      aiFlash('Failed — ' + (e && e.message ? e.message.slice(0, 60) : 'try again'));
      console.warn('AI generate failed:', e);
      return;
    }
    btn.disabled = false;
  }

  async function aiFindNear() {
    if (!aiRecipe || !aiRecipe.items.length) { aiFlash('Make the recipe first'); return; }
    var btn = $('ai-find-btn');
    if (!btn) return;
    btn.disabled = true; btn.textContent = 'Searching…';
    try {
      var body = { items: aiRecipe.items };
      var postalEl = document.getElementById('postal');
      var postal = postalEl ? postalEl.value.trim().toUpperCase() : '';
      if (postal) {
        body.postal = postal;
      } else {
        var pos = await new Promise(function (resolve, reject) {
          if (!navigator.geolocation) return reject(new Error('no geolocation'));
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 });
        }).catch(function () { return null; });
        if (!pos) {
          btn.disabled = false; btn.textContent = '🛒 Find near me';
          aiFlash('Enter your postal code on the main search first');
          return;
        }
        body.lat = pos.coords.latitude; body.lon = pos.coords.longitude;
      }
      var res = await fetch('/api/ai-chef/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(j.error || ('Error ' + res.status));
      renderAiFind(j);
    } catch (e) {
      aiFlash('Failed — ' + (e && e.message ? e.message.slice(0, 60) : 'try again'));
      console.warn('AI find failed:', e);
    }
    btn.disabled = false; btn.textContent = '🛒 Find near me';
  }

  function renderAiFind(j) {
    var box = $('ai-find');
    if (!box) return;
    var h = [];
    var near = (j.stores || []).map(function (s) {
      return esc(s.name) + ' (' + Number(s.distanceKm).toFixed(1) + ' km)';
    });
    if (near.length) h.push('<p class="drawer-note">Nearby: ' + near.join(' · ') + '</p>');
    h.push('<p class="dim">Ingredient prices at nearby chains</p>');
    h.push('<ul class="drawer-list">');
    (j.items || []).forEach(function (it) {
      if (it.missing) {
        h.push('<li class="ai-ing">🚫 ' + esc(it.name) + ' <span class="dim">not priced nearby</span></li>');
      } else if (it.cost != null && it.cost > 0) {
        h.push('<li class="ai-ing">✓ ' + esc(it.name) + ' — ' + money(it.cost) +
          (it.chain ? ' <span class="dim">· ' + esc(it.chain) + '</span>' : '') +
          (it.approximate ? ' <span class="dim">· approx</span>' : '') + '</li>');
      } else {
        h.push('<li class="ai-ing">✓ ' + esc(it.name) + ' <span class="dim">(pantry staple)</span></li>');
      }
    });
    h.push('</ul>');
    if (j.total != null) h.push('<p class="drawer-total">Recipe total: about ' + money(j.total) + '</p>');
    if (j.packagesTotal != null) h.push('<p class="drawer-note">Buying full packages of everything: about ' + money(j.packagesTotal) + '</p>');
    box.innerHTML = h.join('');
    box.hidden = false;
  }

  function renderAiResult() {
    var box = $('ai-result');
    if (!aiRecipe) { box.hidden = true; return; }
    box.hidden = false;
    $('ai-name').textContent = aiRecipe.name;

    var ul = $('ai-ingredients');
    ul.replaceChildren();
    aiRecipe.items.forEach(function (ing) {
      var li = document.createElement('li');
      li.className = 'ai-ing';
      li.textContent = ing;
      ul.appendChild(li);
    });

    var ol = $('ai-steps');
    ol.replaceChildren();
    aiRecipe.steps.forEach(function (st) {
      var li = document.createElement('li');
      li.textContent = st;
      ol.appendChild(li);
    });
  }

  function aiAddToList() {
    if (!aiRecipe) return;
    aiRecipe.items.forEach(function (raw) {
      var core = raw.replace(/^\s*[\d½¼¾\/\.]+\s*\w*\s*/, '').trim();
      addItem(core || raw);
    });
    switchTab('list');
  }

  function aiSave() {
    if (!aiRecipe) return;
    if (data.recipes.some(function (r) { return r.name === aiRecipe.name; })) { flashRecipe('Already saved ✓'); return; }
    data.recipes.push({ name: aiRecipe.name, items: aiRecipe.items, steps: aiRecipe.steps });
    saveData(); renderRecipes();
    flashRecipe('Saved ✓');
  }

  // ---------- saved recipes ----------
  function addRecipe() {
    var name = $('recipe-name').value.trim();
    var raw = $('recipe-ingredients').value.trim();
    if (!name || !raw) { flashRecipe('Name and ingredients, please'); return; }
    var items = raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    if (!items.length) { flashRecipe('Add at least one ingredient'); return; }
    if (data.recipes.some(function (r) { return r.name === name; })) { flashRecipe('Recipe already saved'); return; }
    data.recipes.push({ name: name, items: items, steps: [] });
    $('recipe-name').value = ''; $('recipe-ingredients').value = '';
    saveData(); renderRecipes();
    flashRecipe('Saved "' + name + '" ✓');
  }

  function flashRecipe(msg) {
    var btn = $('add-recipe-btn');
    btn.textContent = msg;
    setTimeout(function () { btn.textContent = 'Save'; }, 1800);
  }

  function addRecipeToList(recipe) {
    recipe.items.forEach(function (raw) {
      var core = raw.replace(/^\s*[\d½¼¾\/\.]+\s*\w*\s*/, '').trim();
      addItem(core || raw);
    });
    saveData(); renderList();
    switchTab('list');
  }

  function removeRecipe(name) {
    data.recipes = data.recipes.filter(function (r) { return r.name !== name; });
    saveData(); renderRecipes();
  }

  function renderRecipes() {
    var ul = $('account-recipes-list');
    ul.replaceChildren();
    if (!data.recipes.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No saved recipes yet. Let the AI chef write one, or save one by hand.';
      ul.appendChild(li);
      return;
    }
    data.recipes.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'recipe-row-wrap';
      li.innerHTML =
        '<div class="recipe-row">' +
        '<span class="store-main"><strong>' + esc(r.name) + '</strong>' +
        '<span class="dim">' + r.items.length + ' ingredients' + (r.steps.length ? ' · ' + r.steps.length + ' steps' : '') + '</span></span>' +
        '<span class="store-actions">' +
        '<button type="button" class="ghost-btn add-all-btn">Add to list</button>' +
        '<button type="button" class="tiny-btn view-btn" title="View recipe">📖</button>' +
        '<button type="button" class="tiny-danger" aria-label="Remove recipe">✕</button></span>' +
        '</div>' +
        '<div class="recipe-details" hidden>' +
        '<p class="dim">Ingredients</p><p>' + r.items.map(esc).join(' · ') + '</p>' +
        (r.steps.length ? '<p class="dim">Steps</p><ol class="ai-steps">' + r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '') +
        '</div>';
      li.querySelector('.add-all-btn').addEventListener('click', function () { addRecipeToList(r); });
      li.querySelector('.view-btn').addEventListener('click', function () {
        var d = li.querySelector('.recipe-details');
        d.hidden = !d.hidden;
      });
      li.querySelector('.tiny-danger').addEventListener('click', function () { removeRecipe(r.name); });
      ul.appendChild(li);
    });
  }

  // ---------- device-to-device sync code (works without cloud) ----------
  function encodeData() {
    return btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  }
  function decodeSyncCode(code) {
    var parsed = JSON.parse(decodeURIComponent(escape(atob(code.replace(/\s+/g, '')))));
    if (!parsed || typeof parsed !== 'object' || !parsed.list) throw new Error('bad code');
    return parsed;
  }
  function copySync() {
    var btn = $('copy-sync-btn');
    var code = encodeData();
    var done = function (ok) {
      btn.textContent = ok ? 'Copied ✓ — paste it on the other device' : 'Copy failed — the code is now in the box below';
      setTimeout(function () { btn.textContent = 'Copy sync code from this device'; }, 2500);
      if (!ok) {
        var inp = $('sync-input');
        inp.value = code;
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { done(true); }, function () { done(false); });
    } else done(false);
  }
  function pasteSync() {
    var inp = $('sync-input');
    try {
      data = decodeSyncCode(inp.value);
      var base = emptyData();
      Object.keys(base).forEach(function (k) { if (data[k] == null) data[k] = base[k]; });
      saveData();
      inp.value = '';
      renderAll();
      switchTab('stores');
    } catch (e) {
      inp.value = '';
      inp.placeholder = 'That code didn\'t work — try again';
    }
  }

  // ---------- price watches ----------
  function addAlert() {
    var cat = $('alert-category').value;
    if (!cat) return;
    if (data.alerts.some(function (a) { return a.category === cat; })) return;
    data.alerts.push({ category: cat, createdAt: new Date().toISOString() });
    saveData();
    renderAlerts();
    checkAlerts();
  }

  function removeAlert(cat) {
    data.alerts = data.alerts.filter(function (a) { return a.category !== cat; });
    saveData(); renderAlerts();
  }

  function renderAlerts() {
    var ul = $('alerts-list');
    ul.replaceChildren();
    if (!data.alerts.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing watched yet. Pick a category and tap Watch.';
      ul.appendChild(li);
      return;
    }
    data.alerts.forEach(function (a) {
      var li = document.createElement('li');
      li.className = 'store-row';
      var now = data.lastPrices[a.category];
      li.innerHTML =
        '<span class="store-main"><strong>' + esc(a.category) + '</strong>' +
        '<span class="dim">watching · cheapest now ' +
        (now != null ? money(now) + unitLabel(currentBasis(a.category)) : '…') + '</span></span>' +
        '<button type="button" class="tiny-danger" aria-label="Stop watching">✕</button>';
      li.querySelector('.tiny-danger').addEventListener('click', function () { removeAlert(a.category); });
      ul.appendChild(li);
    });
  }

  function currentBasis(category) {
    var best = cheapestIn(category);
    return best ? best.unitPriceBasis : 'per 100 g';
  }

  function checkAlerts() {
    if (!prices || !data.alerts.length) { renderFeed(); return; }
    data.alerts.forEach(function (a) {
      var best = cheapestIn(a.category);
      if (!best) return;
      var cur = best.unitPriceCad;
      var prev = data.lastPrices[a.category];
      if (prev != null && cur < prev) {
        data.feed.unshift({
          when: new Date().toISOString(), category: a.category,
          price: cur, basis: best.unitPriceBasis,
          item: best.name, kind: 'drop'
        });
      }
      data.lastPrices[a.category] = cur;
    });
    data.feed = data.feed.slice(0, 30);
    saveData(true);
    renderAlerts(); renderFeed();
    renderBadge();
  }

  function renderFeed() {
    var ul = $('alerts-feed');
    ul.replaceChildren();
    if (!data.feed.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No drops yet. Prices are checked every time you open the site.';
      ul.appendChild(li);
      return;
    }
    data.feed.forEach(function (f) {
      var li = document.createElement('li');
      li.className = 'feed-row drop';
      li.innerHTML = '<strong>' + esc(f.category) + '</strong> dropped to ' + money(f.price) +
        ' <span class="dim">(' + (f.basis === 'per 100 g' ? 'per 100 g' : 'per egg') +
        ') · ' + esc(f.item) + ' · ' +
        new Date(f.when).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) + '</span>';
      ul.appendChild(li);
    });
  }

  function unreadCount() {
    return data.feed.filter(function (f) { return !f.seen; }).length;
  }
  function renderBadge() {
    var n = unreadCount(), b = $('alert-badge');
    if (!b) return;
    b.hidden = n === 0; b.textContent = n;
  }
  function markFeedSeen() {
    data.feed.forEach(function (f) { f.seen = true; });
    saveData(true);
    renderBadge();
  }

  // ---------- wiring ----------
  function wire() {
    $('save-stores-btn').addEventListener('click', saveCurrentStores);
    $('search-my-area-btn').addEventListener('click', searchMyArea);
    $('add-item-btn').addEventListener('click', function () { addItem(); });
    $('list-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
    $('add-alert-btn').addEventListener('click', addAlert);

    $('demo-data-btn').addEventListener('click', loadDemo);

    $('cloud-connect-btn').addEventListener('click', connectCloud);

    $('ai-generate-btn').addEventListener('click', aiGenerate);
    $('ai-desc').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiGenerate(); } });
    $('ai-find-btn').addEventListener('click', aiFindNear);
    $('add-recipe-btn').addEventListener('click', addRecipe);
    $('recipe-ingredients').addEventListener('keydown', function (e) { if (e.key === 'Enter') addRecipe(); });
    $('set-budget-btn').addEventListener('click', setBudget);
    $('budget-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') setBudget(); });
    $('copy-sync-btn').addEventListener('click', copySync);
    $('paste-sync-btn').addEventListener('click', pasteSync);
    $('sync-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') pasteSync(); });

    document.querySelectorAll('.drawer-tab').forEach(function (t) {
      t.addEventListener('click', function () { if (t.getAttribute('data-tab') === 'alerts') markFeedSeen(); });
    });

    var dl = $('ingredients-datalist');
    (typeof INGREDIENTS !== 'undefined' ? INGREDIENTS : []).forEach(function (ing) {
      var o = document.createElement('option'); o.value = ing; dl.appendChild(o);
    });

    var sel = $('alert-category');
    categories().forEach(function (c) {
      var o = document.createElement('option'); o.value = c;
      o.textContent = c.charAt(0).toUpperCase() + c.slice(1); sel.appendChild(o);
    });

  }

  // ---------- init ----------
  async function init() {
    wireDrawer();

    renderUser();
    loadData();
    wire();
    renderCloudUi();
    prices = await loadPrices();
    renderAll();

  }

  init();
})();
