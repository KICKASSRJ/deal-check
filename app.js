(function () {
  // Paste your Google Maps API key between the quotes (restrict it to your website in Google Cloud).
  var API_KEY = "AIzaSyCVNIB_r5_JyiYTvwYOpIOXRVNVnIzbNNs";
  // Address of your Cloudflare Worker (see worker.js). Example: https://deal-check-api.yourname.workers.dev
  var WORKER_URL = "https://deal-check-api.ranjjinisg.workers.dev";

  // ---- Property details catalog ------------------------------------------------
  // To add an attribute, add ONE line to FIELDS:
  //   id     short unique name (letters/numbers)
  //   label  text shown on the page
  //   path   where the value sits in the data; use dots for nested values, e.g. "features.heatingType"
  //   fmt    optional function(value, record) that returns the text to show
  //   on     true = shown by default (visitors can switch fields on/off in "Choose details")
  // Data availability varies by county; missing values show as a dash.
  var money = function (v) { return "$" + Number(v).toLocaleString(); };
  var sqft  = function (v) { return Number(v).toLocaleString() + " sq ft"; };
  var yesNo = function (v) { return v ? "Yes" : "No"; };
  var FIELDS = [
    { id: "type",     label: "Property type", path: "propertyType", on: true },
    { id: "beds",     label: "Bedrooms",      path: "bedrooms", on: true },
    { id: "baths",    label: "Bathrooms",     path: "bathrooms", on: true },
    { id: "area",     label: "Living area",   path: "squareFootage", fmt: sqft, on: true },
    { id: "lot",      label: "Lot size",      path: "lotSize", fmt: sqft, on: true },
    { id: "garage",   label: "Garage",        path: "features.garage", on: true, fmt: function (v, r) {
        var f = r.features || {};
        if (!f.garage) return "None";
        return (f.garageSpaces ? f.garageSpaces + "-car " : "") + (f.garageType || "garage").toLowerCase();
    } },
    { id: "year",     label: "Year built",    path: "yearBuilt", on: true },

    // More attributes, off by default. Tick them in "Choose details" or set on: true.
    { id: "floors",   label: "Floors",             path: "features.floorCount" },
    { id: "rooms",    label: "Total rooms",        path: "features.roomCount" },
    { id: "heating",  label: "Heating",            path: "features.heatingType" },
    { id: "cooling",  label: "Cooling",            path: "features.coolingType" },
    { id: "roof",     label: "Roof",               path: "features.roofType" },
    { id: "pool",     label: "Pool",               path: "features.pool", fmt: yesNo },
    { id: "fire",     label: "Fireplace",          path: "features.fireplace", fmt: yesNo },
    { id: "hoa",      label: "HOA fee",            path: "hoa.fee", fmt: function (v) { return money(v) + " / month"; } },
    { id: "salePx",   label: "Last sale price",    path: "lastSalePrice", fmt: money },
    { id: "saleDt",   label: "Last sale date",     path: "lastSaleDate", fmt: function (v) { return String(v).slice(0, 10); } },
    { id: "zoning",   label: "Zoning",             path: "zoning" },
    { id: "subdiv",   label: "Subdivision",        path: "subdivision" },
    { id: "county",   label: "County",             path: "county" },
    { id: "apn",      label: "Parcel / assessor ID", path: "assessorID" },
    { id: "owner",    label: "Owner occupied",     path: "ownerOccupied", fmt: yesNo }
  ];

  // Remember which fields the visitor turned on or off (stored in their own browser only)
  var enabled = {};
  FIELDS.forEach(function (f) { enabled[f.id] = !!f.on; });
  try {
    var savedPick = JSON.parse(localStorage.getItem("dcFields") || "null");
    if (savedPick) FIELDS.forEach(function (f) { if (f.id in savedPick) enabled[f.id] = !!savedPick[f.id]; });
  } catch (e) {}

  var lastRecord = null;

  function getPath(obj, path) {
    return path.split(".").reduce(function (o, k) { return (o == null) ? undefined : o[k]; }, obj);
  }

  function esc(t) { var d = document.createElement("div"); d.textContent = String(t); return d.innerHTML; }

  function renderPicker() {
    var html = "";
    FIELDS.forEach(function (f) {
      html += '<label class="pick"><input type="checkbox" data-id="' + esc(f.id) + '"' + (enabled[f.id] ? " checked" : "") + "> " + esc(f.label) + "</label>";
    });
    $("pickList").innerHTML = html;
    Array.prototype.forEach.call($("pickList").querySelectorAll("input"), function (cb) {
      cb.addEventListener("change", function () {
        enabled[cb.getAttribute("data-id")] = cb.checked;
        try { localStorage.setItem("dcFields", JSON.stringify(enabled)); } catch (e) {}
        renderDetails();
      });
    });
  }

  function renderDetails() {
    var box = $("details");
    if (!lastRecord) return;
    var html = "<h2>Property details</h2><dl>";
    var count = 0;
    FIELDS.forEach(function (f) {
      if (!enabled[f.id]) return;
      count++;
      var v = getPath(lastRecord, f.path);
      var empty = (v === undefined || v === null || v === "");
      var shown = empty ? "—" : (f.fmt ? f.fmt(v, lastRecord) : v);
      if (f.id === "garage" && empty) shown = "—";
      html += "<dt>" + esc(f.label) + "</dt><dd>" + esc(shown) + "</dd>";
    });
    html += "</dl>";
    if (!count) html = '<div class="note">No details selected. Use "Choose details" below.</div>';
    else html += '<div class="note">Source: public records via RentCast. May differ from listing sites.</div>';
    box.innerHTML = html;
  }

  async function loadDetails(address) {
    var box = $("details");
    lastRecord = null; lastRent = null; lastGrade = "";
    $("kBeds").textContent = "—"; $("kRent").textContent = "—"; $("kGrade").textContent = "—"; $("nrsOut").innerHTML = "";
    lastAddress = address.replace(/,\s*USA$/i, "");
    $("rAddr").value = lastAddress;
    $("rentOut").innerHTML = "";
    if (!WORKER_URL || WORKER_URL.indexOf("PASTE_") === 0) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="note">Loading property details…</div>';
    try {
      var clean = address.replace(/,\s*USA$/i, "");
      var res = await apiGet(WORKER_URL + "?address=" + encodeURIComponent(clean));
      var data = await res.json();
      if (!res.ok) { box.innerHTML = '<div class="note">' + esc(data.error || "Property details are unavailable right now.") + "</div>"; return; }
      lastRecord = data;
      histUpdate({ beds: data.bedrooms, baths: data.bathrooms, sqft: data.squareFootage, ptype: data.propertyType });
      updateKpis();
      renderDetails();
      prefillRent();
      checkRent();   // run the rent check automatically for the found property
    } catch (e) {
      box.innerHTML = '<div class="note">Could not load property details.</div>';
    }
  }

  // ---- Rent check (Rentometer) -------------------------------------------------
  var lastAddress = "";

  function prefillRent() {
    $("rAddr").value = lastAddress;
    var r = lastRecord;
    if (!r) return;
    // Bathrooms: Any, 1 or 1.5+
    if (typeof r.bedrooms === "number") $("rBeds").value = String(Math.max(0, Math.min(6, Math.round(r.bedrooms))));
    // Living area from the property record is used as the maximum square footage (editable; clear it for no limit)
    $("rMaxSqft").value = r.squareFootage ? String(Math.max(500, Math.min(10000, Math.round(r.squareFootage)))) : "";
    if (typeof r.bathrooms === "number") $("rBaths").value = r.bathrooms >= 1.5 ? "1.5+" : "1";
  }

  function money0(v) { return (v === undefined || v === null || isNaN(v)) ? "—" : "$" + Math.round(Number(v)).toLocaleString(); }

  function median(a) {
    var b = a.slice().sort(function (x, y) { return x - y; }), n = b.length;
    return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : null;
  }

  // Which result rows to show (saved in this browser)
  var RENT_FIELDS = [
    { id: "mean",   label: "Average",                      on: true,  html: function (d) { return row("Average", money0(d.mean)); } },
    { id: "range",  label: "Typical range (25th–75th)",    on: false, html: function (d) { return row("Typical range (25th–75th)", money0(d.percentile_25) + " – " + money0(d.percentile_75)); } },
    { id: "minmax", label: "Lowest – highest",             on: true,  html: function (d) { return row("Lowest – highest", money0(d.min) + " – " + money0(d.max)); } },
    { id: "count",  label: "Listings used",                on: true,  html: function (d) { return row("Listings used", d.samples === undefined ? "—" : d.samples); } },
    { id: "radius", label: "Search radius used",           on: true,  html: function (d) { return d.radius_miles === undefined ? "" : row("Search radius used", d.radius_miles + " mi"); } },
    { id: "back",   label: "Look-back used",               on: false, html: function (d) { return d.look_back_days === undefined ? "" : row("Look-back used", d.look_back_days + " days"); } }
  ];
  var rentOn = {};
  RENT_FIELDS.forEach(function (f) { rentOn[f.id] = f.on; });
  try { var sv = JSON.parse(localStorage.getItem("dcRentFields") || "null"); if (sv) RENT_FIELDS.forEach(function (f) { if (typeof sv[f.id] === "boolean") rentOn[f.id] = sv[f.id]; }); } catch (e) {}
  var lastRent = null, lastGrade = "";

  function row(label, value) { return "<dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd>"; }

  function renderRentPicker() {
    var box = $("rPickList");
    box.innerHTML = "";
    RENT_FIELDS.forEach(function (f) {
      var l = document.createElement("label"); l.className = "pick";
      var c = document.createElement("input"); c.type = "checkbox"; c.checked = !!rentOn[f.id];
      c.addEventListener("change", function () {
        rentOn[f.id] = c.checked;
        try { localStorage.setItem("dcRentFields", JSON.stringify(rentOn)); } catch (e) {}
        if (lastRent) renderRent(lastRent);
      });
      l.appendChild(c); l.appendChild(document.createTextNode(f.label)); box.appendChild(l);
    });
  }

  function renderRent(d) {
    lastRent = d;
    if (d && d.median != null) histUpdate({ rent: Math.round(Number(d.median)) });
    updateKpis();
    var askedR = Number($("rRadius").value), askedB = Number($("rBack").value);
    var html = '<div class="big">' + esc(money0(d.median)) + ' <span style="font-size:13px;font-weight:400;color:var(--muted)">median rent / month</span></div><dl>';
    RENT_FIELDS.forEach(function (f) { if (rentOn[f.id]) html += f.html(d); });
    html += "</dl>";
    // Say so when Rentometer used a different radius or look-back than requested
    if (d.radius_miles !== undefined && d.radius_miles !== null && Math.abs(Number(d.radius_miles) - askedR) > 0.001)
      html += '<div class="note">You chose ' + esc(askedR) + ' mile' + (askedR === 1 ? "" : "s") + ', but Rentometer used ' + esc(d.radius_miles) + ' miles. It switches to its Smart Radius when the chosen radius holds more listings than one analysis can use.</div>';
    if (d.look_back_days !== undefined && d.look_back_days !== null && Number(d.look_back_days) !== askedB)
      html += '<div class="note">Rentometer used a look-back of ' + esc(d.look_back_days) + ' days.</div>';
    if (d.max_sqft) html += '<div class="note">Limited to listings up to ' + esc(Number(d.max_sqft).toLocaleString()) + ' sq ft. Listings with no recorded size are excluded.</div>';
    if (d.quickview_url) html += '<div class="note"><a href="' + esc(d.quickview_url) + '" target="_blank" rel="noopener">Open full Rentometer report</a></div>';
    html += '<div class="note">Source: Rentometer. Based on nearby listings with the bedrooms, bathrooms and type chosen above and the limits above. Not a guarantee of achievable rent.</div>';
    $("rentOut").innerHTML = html;
  }

  async function checkRent() {
    var out = $("rentOut");
    var addr = $("rAddr").value.trim().replace(/,\s*USA$/i, "");
    if (!addr) { out.innerHTML = '<div class="note">Search a property first, or type an address above.</div>'; return; }
    if (!WORKER_URL || WORKER_URL.indexOf("PASTE_") === 0) { out.innerHTML = '<div class="err">The site owner has not set up the data service yet.</div>'; return; }
    var bathParam = $("rBaths").value;   // "", "1" or "1.5+"
    out.innerHTML = '<div class="note">Checking rents…</div>';
    try {
      var url = WORKER_URL + "/rent?address=" + encodeURIComponent(addr) + "&bedrooms=" + encodeURIComponent($("rBeds").value) +
        "&baths=" + encodeURIComponent(bathParam) + "&building_type=" + encodeURIComponent($("rType").value) +
        "&look_back_days=" + encodeURIComponent($("rBack").value) + "&radius_miles=" + encodeURIComponent($("rRadius").value);
      var ms = Number(String($("rMaxSqft").value).replace(/[^0-9]/g, "")) || 0;
      if (ms >= 500 && ms <= 10000) url += "&max_sqft=" + ms;
      var res = await apiGet(url);
      var d = await res.json();
      if (!res.ok) { out.innerHTML = '<div class="err">' + esc(d.error || "Rent data is unavailable right now.") + "</div>"; return; }
      renderRent(d);
    } catch (e) {
      out.innerHTML = '<div class="err">Could not load rent data.</div>';
    }
  }

  // ---- Neighborhood rating (US-NRS) -------------------------------------------
  function safeUrl(u) {
    try { var x = new URL(u); return x.protocol === "https:" ? x.href.replace(/"/g, "%22") : ""; } catch (e) { return ""; }
  }
  function ul(a) { return a && a.length ? "<ul>" + a.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : "<p>—</p>"; }
  function pe(label, text) { return text ? "<p><b>" + esc(label) + ":</b> " + esc(text) + "</p>" : ""; }

  function renderNrs(d) {
    var pr = d.property || {}, h = "";
    lastNrs = d;
    // Points, total and grade use the visitor's own weights (scores per factor come from the research and do not change)
    var W = loadWeights(), custom = !isDefault(W), pts = 0;
    var fac = (d.factors || []).map(function (f, i) {
      var p = Math.round((Number(f.score) / 5) * W[i] * 100) / 100; pts += p;
      return { name: f.name, weight: W[i], score: f.score, points: p };
    });
    var total = Math.round(pts * 100) / 100, gr = gradeFor(total);
    lastGrade = gr[1]; histUpdate({ grade: gr[1], score: total });
    updateKpis();
    h += '<div class="score"><b>' + esc(gr[1]) + '</b><span>' + esc(total) + " / 100 · " + esc(gr[2]) + " · Data confidence: " + esc(d.confidence) + "</span></div>";
    h += "<table><tr><th>Criterion</th><th>Wt</th><th>Score</th><th>Pts</th></tr>";
    var calc = [];
    fac.forEach(function (f) {
      h += "<tr><td>" + esc(f.name) + "</td><td>" + esc(f.weight) + "%</td><td>" + esc(f.score) + "/5</td><td>" + esc(f.points) + "</td></tr>";
      calc.push(f.points);
    });
    h += "<tr><td><b>Total</b></td><td>100%</td><td></td><td><b>" + esc(total) + "</b></td></tr></table>";
    h += '<div class="note">Calculation: ' + esc(calc.join(" + ")) + " = " + esc(total) + ". Each factor: (score ÷ 5) × weight." +
      (custom ? " Your own weights are applied. With the standard weights this address scores " + esc(d.total) + " (" + esc(d.grade) + ")." : "") + "</div>";
    h += "<details><summary>Property and area</summary>" + pe("Address", pr.address) + pe("Neighborhood", pr.neighborhood) + pe("City / county", [pr.city, pr.county].filter(Boolean).join(" / ")) +
      pe("ZIP", pr.zip) + pe("Census tract", pr.census_tract) + pe("Boundaries used", pr.boundaries) + pe("Evaluation date", pr.evaluation_date) + pe("Confidence note", d.confidence_note) + "</details>";
    h += "<details><summary>Detailed analysis (10 factors)</summary>";
    (d.factors || []).forEach(function (f) {
      h += "<p><b>" + esc(f.name) + " — " + esc(f.score) + "/5</b><br>" + esc(f.evidence || "—");
      (f.sources || []).forEach(function (u, i) { var s = safeUrl(u); if (s) h += ' <a href="' + s + '" target="_blank" rel="noopener noreferrer">[' + (i + 1) + "]</a>"; });
      h += "</p>";
    });
    h += "</details>";
    h += "<details><summary>Top 5 strengths</summary>" + ul(d.strengths) + "</details>";
    h += "<details><summary>Top 5 weaknesses and risks</summary>" + ul(d.weaknesses) + "</details>";
    var o = d.outlook || {};
    h += "<details><summary>Investment outlook</summary>" + pe("Long-term homeownership", o.homeownership) + pe("Appreciation", o.appreciation) + pe("Rental investment", o.rental_investment) +
      pe("Tenant demand", o.tenant_demand) + pe("Resale liquidity", o.resale_liquidity) + pe("Economic resilience", o.economic_resilience) + "</details>";
    var v = d.verdict || {};
    if ((d.sources_consulted || []).length) {
      h += "<details><summary>Sources consulted</summary><ul>";
      d.sources_consulted.forEach(function (s) { var u = safeUrl(s.uri); if (u) h += '<li><a href="' + u + '" target="_blank" rel="noopener noreferrer">' + esc(s.title || u) + "</a></li>"; });
      h += "</ul></details>";
    }
    h += "<details open><summary>Final verdict</summary>" + pe("Long-term ownership", v.long_term_ownership) + pe("Rental investment", v.rental_investment) + pe("Appreciation", v.appreciation) +
      "<p><b>Three biggest risks:</b></p>" + ul(v.biggest_risks) + pe("Recommendation", v.recommendation) + "</details>";
    h += '<div class="note">US-NRS rates the neighborhood only. It is not a rating of this property as an investment. AI-researched with Gemini and Google Search, so it is less thorough than the full Claude report and may contain errors. Check the sources before relying on it.</div>';
    $("nrsOut").innerHTML = h;
    // Google requires its "Search suggestions" to be shown with grounded results; render them in a sandboxed frame
    if (d.search_html) {
      var fr = document.createElement("iframe");
      fr.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
      fr.style.cssText = "width:100%;height:72px;border:0;margin-top:8px";
      fr.title = "Google Search suggestions";
      fr.srcdoc = '<base target="_blank">' + d.search_html;
      $("nrsOut").appendChild(fr);
    }
  }

  async function checkNrs() {
    var out = $("nrsOut"), btn = $("nrsGo");
    var addr = (lastAddress || $("rAddr").value || "").trim().replace(/,\s*USA$/i, "");
    if (!addr) { out.innerHTML = '<div class="note">Search a property first.</div>'; return; }
    if (!WORKER_URL || WORKER_URL.indexOf("PASTE_") === 0) { out.innerHTML = '<div class="err">The site owner has not set up the data service yet.</div>'; return; }
    var t = lastRecord && lastRecord.propertyType;
    var type = ["Single Family", "Townhouse", "Condo", "Multi-family"].indexOf(t) >= 0 ? t : "Single Family";
    btn.disabled = true;
    out.innerHTML = '<div class="note">Researching the neighbourhood (crime, income, schools, market data…). This can take a minute. Please keep this page open.</div>';
    try {
      var res = await apiGet(WORKER_URL + "/neighborhood?address=" + encodeURIComponent(addr) + "&type=" + encodeURIComponent(type));
      var d = await res.json();
      if (!res.ok) { out.innerHTML = '<div class="err">' + esc(d.error || "Neighborhood rating is unavailable right now.") + "</div>"; }
      else renderNrs(d);
    } catch (e) {
      out.innerHTML = '<div class="err">Could not load the neighborhood rating.</div>';
    }
    btn.disabled = false;
  }

  var $ = function (id) { return document.getElementById(id); };
  // Calls to our server. If the owner has saved an owner key (Privacy > Owner access), send it so usage limits are skipped.
  function apiGet(url) {
    var h = {};
    try { var k = localStorage.getItem("dcOwner"); if (k) h["X-Owner-Key"] = k; } catch (e) {}
    return fetch(url, { headers: h });
  }
  var map = null, marker = null, mapsLoaded = false, lastLatLng = null, lastKey = "";


  function setStatus(msg, isErr) {
    $("status").textContent = msg || "";
    $("status").className = isErr ? "err" : "";
  }

  function loadMaps(key) {
    return new Promise(function (resolve, reject) {
      if (mapsLoaded && key === lastKey) return resolve();
      if (mapsLoaded && key !== lastKey) return reject(new Error("Reload the page to use a different API key."));
      window.__mapsReady = function () { mapsLoaded = true; lastKey = key; resolve(); };
      window.gm_authFailure = function () { setStatus("Google rejected the API key. Check it and that billing and the required APIs are enabled.", true); };
      var s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&callback=__mapsReady&loading=async";
      s.onerror = function () { reject(new Error("Could not load Google Maps. Check your connection and API key.")); };
      document.head.appendChild(s);
    });
  }

  function moveTo(latLng) {
    if (marker) marker.setPosition(latLng);
    lastLatLng = { lat: latLng.lat(), lng: latLng.lng() };
    $("acc").textContent = "Pin moved by you.";
    updateStaticLink();
  }

  function setView(type) {
    $("vRoad").setAttribute("aria-pressed", type === "roadmap");
    $("vSat").setAttribute("aria-pressed", type === "satellite");
    if (map) map.setMapTypeId(type);
    updateStaticLink();
  }

  function currentType() { return $("vSat").getAttribute("aria-pressed") === "true" ? "satellite" : "roadmap"; }

  function updateStaticLink() {
    if (!lastLatLng) return;
    var z = map ? map.getZoom() : 20;
    var url = "https://maps.googleapis.com/maps/api/staticmap?center=" + lastLatLng.lat + "," + lastLatLng.lng +
      "&zoom=" + z + "&size=640x640&scale=2&maptype=" + currentType() +
      "&markers=color:red%7C" + lastLatLng.lat + "," + lastLatLng.lng + "&key=" + encodeURIComponent(lastKey);
    $("staticLink").href = url;
    $("staticLink").style.display = "block";
  }

  async function show() {
    var key = API_KEY.trim(), addr = $("addr").value.trim();
    if (!key || key === "PASTE_YOUR_KEY_HERE") return setStatus("The site owner has not added an API key yet.", true);
    if (!addr) return setStatus("Enter a property address.", true);
    setStatus("Looking up address…");
    $("found").textContent = "";
    try {
      await loadMaps(key);
      var geocoder = new google.maps.Geocoder();
      var res = await geocoder.geocode({ address: addr, componentRestrictions: { country: "US" } });
      if (!res.results || !res.results.length) return setStatus("No match found. Add the city and state and try again.", true);
      var r = res.results[0], loc = r.geometry.location;
      lastLatLng = { lat: loc.lat(), lng: loc.lng() };
      enterWorkspace();
      $("empty").style.display = "none";
      if (!map) {
        map = new google.maps.Map($("map"), {
          center: loc, zoom: 20, mapTypeId: currentType(),
          mapTypeControl: false, streetViewControl: true, fullscreenControl: true, tilt: 0
        });
        map.addListener("zoom_changed", updateStaticLink);
      } else { map.setCenter(loc); map.setZoom(20); }
      if (marker) marker.setMap(null);
      marker = new google.maps.Marker({ position: loc, map: map, title: r.formatted_address, draggable: true });
      marker.addListener("dragend", function (ev) { moveTo(ev.latLng); });
      if (!map.__clickBound) { map.__clickBound = true; map.addListener("click", function (ev) { moveTo(ev.latLng); }); }
      var lt = r.geometry.location_type;
      $("acc").textContent = lt === "ROOFTOP"
        ? "Pin is at the exact building."
        : "Google placed this pin by estimate, so it may be off. Click the correct building on the map, or drag the pin, to move it.";
      $("found").textContent = r.formatted_address;
      histStart(r.formatted_address);
      loadDetails(r.formatted_address);
      setStatus("");
      updateStaticLink();
    } catch (e) {
      var msg = (e && e.message) ? e.message : "Something went wrong.";
      if (/ZERO_RESULTS/.test(msg)) msg = "No match found. Add the city and state and try again.";
      else if (/REQUEST_DENIED/.test(msg)) msg = "Request denied. Enable the Geocoding API and billing for this key.";
      setStatus(msg, true);
    }
  }

  renderPicker();
  renderRentPicker();
  $("rentGo").addEventListener("click", checkRent);
  $("nrsGo").addEventListener("click", checkNrs);
  $("go").addEventListener("click", show);
  // ---- Address suggestions: recent searches + Google Places, biased to your location ----
  var RECENT_KEY = "dcRecent", recent = [], geo = null, acItems = [], acIndex = -1, acTimer = null, acSeq = 0, placesLib = null, placesDown = false;
  try { recent = (JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") || []).filter(function (s) { return typeof s === "string"; }).slice(0, 8); } catch (e) { recent = []; }

  function saveRecent(addr) {
    addr = String(addr || "").replace(/,\s*USA$/i, "").trim();
    if (!addr || !saveOn()) return;
    recent = [addr].concat(recent.filter(function (x) { return x.toLowerCase() !== addr.toLowerCase(); })).slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch (e) {}
  }
  function clearRecent() { recent = []; try { localStorage.removeItem(RECENT_KEY); } catch (e) {} closeSuggest(); }

  function askLocation() {
    var b = $("geoBtn");
    if (!navigator.geolocation) { b.textContent = "Location is not available in this browser"; b.disabled = true; return; }
    b.textContent = "Finding your location…";
    navigator.geolocation.getCurrentPosition(function (p) {
      geo = { lat: p.coords.latitude, lng: p.coords.longitude };
      b.textContent = "Suggestions are favouring places near you"; b.disabled = true;
      try { localStorage.setItem("dcGeo", "1"); } catch (e) {}
    }, function () { b.textContent = "Location not shared. Click to try again."; }, { maximumAge: 600000, timeout: 8000 });
  }

  function closeSuggest() { acItems = []; acIndex = -1; $("acList").style.display = "none"; $("acList").innerHTML = ""; $("addr").setAttribute("aria-expanded", "false"); $("addr").removeAttribute("aria-activedescendant"); }

  function renderSuggest(places) {
    var q = $("addr").value.trim().toLowerCase();
    var rec = recent.filter(function (r) { return !q || r.toLowerCase().indexOf(q) >= 0; }).slice(0, q ? 3 : 8);
    var seen = {}; rec.forEach(function (r) { seen[r.toLowerCase()] = 1; });
    var pl = (places || []).filter(function (p) { return !seen[p.text.replace(/,\s*USA$/i, "").toLowerCase()]; });
    acItems = []; var box = $("acList"); box.innerHTML = "";
    function group(title, arr, kind) {
      if (!arr.length) return;
      var g = document.createElement("div"); g.className = "grp"; g.textContent = title; box.appendChild(g);
      arr.forEach(function (it) {
        var o = document.createElement("div"); o.className = "opt"; o.setAttribute("role", "option"); o.id = "acOpt" + acItems.length;
        var text = kind === "recent" ? it : it.text.replace(/,\s*USA$/i, "");
        if (kind === "recent") { o.textContent = it; }
        else { o.textContent = it.main || text; if (it.sec) { var s = document.createElement("small"); s.textContent = it.sec; o.appendChild(s); } }
        var idx = acItems.length; acItems.push(text);
        o.addEventListener("mousedown", function (ev) { ev.preventDefault(); chooseSuggest(idx); });
        box.appendChild(o);
      });
    }
    group("Recent searches", rec, "recent");
    group("Suggestions", pl, "place");
    if (!acItems.length) { closeSuggest(); return; }
    if (rec.length || !geo) {
      var f = document.createElement("div"); f.className = "foot"; f.style.display = "flex"; f.style.gap = "14px"; f.style.flexWrap = "wrap";
      if (!geo) {
        var l = document.createElement("button"); l.type = "button"; l.className = "linkbtn"; l.id = "acGeo"; l.textContent = "Use my location";
        l.addEventListener("mousedown", function (ev) { ev.preventDefault(); closeSuggest(); askLocation(); });
        f.appendChild(l);
      }
      if (rec.length) {
        var c = document.createElement("button"); c.type = "button"; c.className = "linkbtn"; c.textContent = "Clear recent searches";
        c.addEventListener("mousedown", function (ev) { ev.preventDefault(); clearRecent(); });
        f.appendChild(c);
      }
      box.appendChild(f);
    }
    acIndex = -1; box.style.display = "block"; $("addr").setAttribute("aria-expanded", "true");
  }

  function markActive() {
    var opts = $("acList").querySelectorAll(".opt");
    for (var i = 0; i < opts.length; i++) opts[i].setAttribute("aria-selected", i === acIndex ? "true" : "false");
    if (acIndex >= 0 && opts[acIndex]) { $("addr").setAttribute("aria-activedescendant", opts[acIndex].id); opts[acIndex].scrollIntoView({ block: "nearest" }); }
  }

  function chooseSuggest(i) { if (i < 0 || i >= acItems.length) return; $("addr").value = acItems[i]; closeSuggest(); show(); }

  async function fetchPlaces(q) {
    var key = API_KEY.trim();
    if (placesDown || !key || key.indexOf("PASTE_") === 0) return [];
    await loadMaps(key);
    if (!placesLib) placesLib = await google.maps.importLibrary("places");
    var req = { input: q, includedRegionCodes: ["us"] };
    var c = geo || lastLatLng;
    if (c) req.locationBias = { center: { lat: c.lat, lng: c.lng }, radius: 50000 };
    var out = await placesLib.AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
    return (out.suggestions || []).filter(function (s) { return s.placePrediction; }).slice(0, 5).map(function (s) {
      var p = s.placePrediction;
      return { text: String(p.text && p.text.text || ""), main: String(p.mainText && p.mainText.text || ""), sec: String(p.secondaryText && p.secondaryText.text || "") };
    }).filter(function (x) { return x.text; });
  }

  function onAddrInput() {
    clearTimeout(acTimer);
    var q = $("addr").value.trim(), seq = ++acSeq;
    renderSuggest([]);                       // recent searches show immediately
    if (q.length < 3) return;
    acTimer = setTimeout(async function () {
      try {
        var places = await fetchPlaces(q);
        if (seq === acSeq && document.activeElement === $("addr")) renderSuggest(places);
      } catch (e) {
        placesDown = true;                    // e.g. Places API not enabled for the key: fall back to recent searches only
        if (window.console) console.warn("Address suggestions unavailable:", e && e.message);
      }
    }, 300);
  }

  function onAddrKey(e) {
    var open = $("acList").style.display === "block";
    if (e.key === "ArrowDown" && open) { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; markActive(); }
    else if (e.key === "ArrowUp" && open) { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; markActive(); }
    else if (e.key === "Escape") { closeSuggest(); }
    else if (e.key === "Enter") { if (open && acIndex >= 0) { e.preventDefault(); chooseSuggest(acIndex); } else { closeSuggest(); show(); } }
  }

  $("addr").addEventListener("input", onAddrInput);
  $("addr").addEventListener("focus", function () { renderSuggest([]); });
  $("addr").addEventListener("blur", function () { setTimeout(closeSuggest, 150); });
  $("addr").addEventListener("keydown", onAddrKey);
  $("geoBtn").addEventListener("click", askLocation);
  try {   // if you already allowed location for this site, use it without asking again
    if (navigator.permissions && localStorage.getItem("dcGeo") === "1") navigator.permissions.query({ name: "geolocation" }).then(function (s) { if (s.state === "granted") askLocation(); }).catch(function () {});
  } catch (e) {}

  $("vRoad").addEventListener("click", function () { setView("roadmap"); });
  $("vSat").addEventListener("click", function () { setView("satellite"); });
  $("zIn").addEventListener("click", function () { if (map) map.setZoom(map.getZoom() + 1); });
  $("zOut").addEventListener("click", function () { if (map) map.setZoom(map.getZoom() - 1); });


  // ===========================================================================
  // Workspace, tabs, KPIs
  // ===========================================================================
  function enterWorkspace() {
    if (!document.body.classList.contains("home")) return;
    document.body.classList.remove("home");
    $("slotPanel").appendChild($("searchbox"));
    $("kpis").hidden = false;
    window.scrollTo(0, 0);
  }

  function updateKpis() {
    var r = lastRecord, bits = [];
    if (r && typeof r.bedrooms === "number") bits.push(r.bedrooms === 0 ? "Studio" : r.bedrooms + " bd");
    if (r && typeof r.bathrooms === "number") bits.push(r.bathrooms + " ba");
    $("kBeds").textContent = bits.length ? bits.join(", ") : "—";
    $("kRent").textContent = lastRent && lastRent.median != null ? money0(lastRent.median) : "—";
    $("kGrade").textContent = lastGrade || "—";
  }

  function jump(id) { $(id).scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }
  $("kBeds").parentNode.addEventListener("click", function () { jump("pProp"); });
  $("kRent").parentNode.addEventListener("click", function () { jump("pRent"); });
  $("kGrade").parentNode.addEventListener("click", function () { jump("pNrs"); });

  // ===========================================================================
  // Search history (stored in this browser only)
  // ===========================================================================
  var HIST_KEY = "dcHistory", HIST_MAX = 1000, hist = [], curId = null;
  function saveOn() { try { return localStorage.getItem("dcSave") !== "0"; } catch (e) { return true; } }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function cleanAddr(a) { return String(a || "").replace(/,\s*USA$/i, "").trim().slice(0, 150); }
  function num(v) { v = Number(v); return isFinite(v) ? v : null; }

  try {
    hist = (JSON.parse(localStorage.getItem(HIST_KEY) || "[]") || []).filter(function (e) { return e && typeof e.address === "string" && typeof e.id === "string"; });
    // one-time import of the old "recent searches" list (these have no date)
    if (!localStorage.getItem("dcHistMig")) {
      if (!hist.length) recent.slice().reverse().forEach(function (a) { hist.unshift({ id: uid(), address: a, ts: 0 }); });
      localStorage.setItem("dcHistMig", "1");
      if (hist.length) localStorage.setItem(HIST_KEY, JSON.stringify(hist));
    }
  } catch (e) { hist = []; }

  function histSave() {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); }
    catch (e) { try { hist.length = Math.floor(hist.length / 2); localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch (e2) {} }
  }

  function histStart(addr) {
    addr = cleanAddr(addr);
    saveRecent(addr);
    if (!addr || !saveOn()) { curId = null; refreshHistUi(); return; }
    var now = Date.now(), top = hist[0];
    if (top && top.address.toLowerCase() === addr.toLowerCase() && top.ts && now - top.ts < 60000) { curId = top.id; top.ts = now; }
    else { curId = uid(); hist.unshift({ id: curId, address: addr, ts: now }); if (hist.length > HIST_MAX) hist.length = HIST_MAX; }
    histSave(); refreshHistUi();
  }

  function histUpdate(f) {
    if (!curId) return;
    var e = hist.filter(function (x) { return x.id === curId; })[0];
    if (!e) return;
    var clean = {
      beds: num(f.beds), baths: num(f.baths), sqft: num(f.sqft), rent: num(f.rent), score: num(f.score),
      ptype: f.ptype == null ? null : String(f.ptype).slice(0, 30), grade: f.grade == null ? null : String(f.grade).slice(0, 3)
    };
    Object.keys(f).forEach(function (k) { if (clean[k] !== null && clean[k] !== undefined) e[k] = clean[k]; });
    histSave(); renderHistList();
  }

  function fmtDate(ts) { return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Earlier"; }

  function meta(parent, text, strong) {
    var s = document.createElement("span");
    if (strong) { var b = document.createElement("b"); b.textContent = strong; s.appendChild(b); s.appendChild(document.createTextNode(" " + text)); }
    else s.textContent = text;
    parent.appendChild(s);
  }

  function renderHistList() {
    var dlg = $("histDlg"); if (!dlg.open) return;
    var q = $("histFilter").value.trim().toLowerCase(), ul = $("histList");
    ul.innerHTML = "";
    var items = hist.filter(function (e) { return !q || e.address.toLowerCase().indexOf(q) >= 0; });
    items.forEach(function (e) {
      var li = document.createElement("li");
      var open = document.createElement("button"); open.type = "button"; open.className = "open";
      var a = document.createElement("span"); a.className = "addr"; a.textContent = e.address; open.appendChild(a);
      var m = document.createElement("span"); m.className = "meta";
      meta(m, fmtDate(e.ts));
      if (e.beds != null) meta(m, e.beds === 0 ? "Studio" : e.beds + " bd");
      if (e.baths != null) meta(m, e.baths + " ba");
      if (e.sqft != null) meta(m, Math.round(e.sqft).toLocaleString() + " sq ft");
      if (e.rent != null) meta(m, "$" + Math.round(e.rent).toLocaleString() + " / mo", "Rent");
      if (e.grade) meta(m, e.grade + (e.score != null ? " (" + Math.round(e.score) + ")" : ""), "Neighbourhood");
      open.appendChild(m);
      open.addEventListener("click", function () { dlg.close(); $("addr").value = e.address; show(); });
      var del = document.createElement("button"); del.type = "button"; del.className = "quiet del"; del.textContent = "Delete"; del.setAttribute("aria-label", "Delete " + e.address + " from history");
      del.addEventListener("click", function () {
        hist = hist.filter(function (x) { return x.id !== e.id; }); if (curId === e.id) curId = null;
        histSave(); refreshHistUi();
      });
      li.appendChild(open); li.appendChild(del); ul.appendChild(li);
    });
    var em = $("histEmpty");
    em.hidden = items.length > 0;
    em.textContent = hist.length ? "No searches match that filter." : (saveOn() ? "No searches yet. Check an address and it will appear here." : "History is turned off. Turn it on in Privacy to save new searches.");
    $("histClear").disabled = !hist.length; $("histCsv").disabled = !hist.length;
  }

  function refreshHistUi() {
    $("histCount").textContent = hist.length;
    renderHistList();
    var box = $("recents"), seen = {}, top = [];
    hist.forEach(function (e) { var k = e.address.toLowerCase(); if (!seen[k] && top.length < 4) { seen[k] = 1; top.push(e.address); } });
    box.innerHTML = "";
    if (!top.length) { box.hidden = true; return; }
    var lab = document.createElement("span"); lab.textContent = "Recent"; box.appendChild(lab);
    top.forEach(function (a) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = a; b.title = a;
      b.addEventListener("click", function () { $("addr").value = a; show(); });
      box.appendChild(b);
    });
    box.hidden = false;
  }

  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  function exportCsv() {
    var rows = [["Date", "Address", "Property type", "Bedrooms", "Bathrooms", "Living area (sq ft)", "Median rent per month (USD)", "Neighbourhood grade", "Neighbourhood score"]];
    hist.forEach(function (e) { rows.push([e.ts ? new Date(e.ts).toISOString() : "", e.address, e.ptype, e.beds, e.baths, e.sqft, e.rent, e.grade, e.score]); });
    download("deal-check-history-" + stamp() + ".csv", "﻿" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n"), "text/csv;charset=utf-8");
  }

  // Two-step confirmation without pop-up dialogs
  function confirmTwice(btn, label, action) {
    var orig = btn.textContent, armed = false, t = null;
    btn.addEventListener("click", function () {
      if (!armed) { armed = true; btn.textContent = label; t = setTimeout(function () { armed = false; btn.textContent = orig; }, 4000); return; }
      clearTimeout(t); armed = false; btn.textContent = orig; action();
    });
  }

  function openDlg(d) { if (d.showModal) d.showModal(); else d.setAttribute("open", ""); }
  ["histDlg", "privDlg"].forEach(function (id) {
    $(id).addEventListener("click", function (e) { if (e.target === $(id)) $(id).close(); });
  });
  $("histBtn").addEventListener("click", function () { $("histFilter").value = ""; openDlg($("histDlg")); renderHistList(); });
  $("histClose").addEventListener("click", function () { $("histDlg").close(); });
  $("histFilter").addEventListener("input", renderHistList);
  $("histCsv").addEventListener("click", exportCsv);
  confirmTwice($("histClear"), "Click again to clear", function () { hist = []; curId = null; histSave(); refreshHistUi(); });

  // ===========================================================================
  // Privacy controls
  // ===========================================================================
  var STORE_KEYS = ["dcOwner", "dcWeights", "dcFields", "dcRentFields", "dcRecent", "dcGeo", "dcHistory", "dcSave", "dcNotice", "dcHistMig"];
  $("saveHist").checked = saveOn();
  $("saveHist").addEventListener("change", function () {
    try { localStorage.setItem("dcSave", $("saveHist").checked ? "1" : "0"); } catch (e) {}
    renderHistList();
  });
  function ownerState() { var on = false; try { on = !!localStorage.getItem("dcOwner"); } catch (e) {} $("ownerState").textContent = on ? "Owner key saved on this device. Usage limits are off for you." : "Not set. Normal usage limits apply."; }
  $("ownerSave").addEventListener("click", function () {
    var v = $("ownerKey").value.trim(); if (!v) return;
    try { localStorage.setItem("dcOwner", v); } catch (e) {}
    $("ownerKey").value = ""; ownerState();
  });
  $("ownerClear").addEventListener("click", function () { try { localStorage.removeItem("dcOwner"); } catch (e) {} ownerState(); });
  $("privBtn").addEventListener("click", function () { $("saveHist").checked = saveOn(); ownerState(); openDlg($("privDlg")); });
  $("privClose").addEventListener("click", function () { $("privDlg").close(); });
  $("dlData").addEventListener("click", function () {
    var settings = {};
    STORE_KEYS.forEach(function (k) { if (k === "dcHistory") return; try { var v = localStorage.getItem(k); if (v !== null) settings[k] = v; } catch (e) {} });
    download("deal-check-my-data-" + stamp() + ".json", JSON.stringify({ exported_at: new Date().toISOString(), history: hist, settings: settings }, null, 2), "application/json");
  });
  confirmTwice($("delData"), "Click again to delete everything", function () {
    STORE_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    hist = []; recent = []; curId = null;
    $("privDlg").close(); location.reload();
  });

  // One-time notice about on-device storage
  (function () {
    var seen = false; try { seen = !!localStorage.getItem("dcNotice"); } catch (e) {}
    if (seen) return;
    var n = $("notice"); n.hidden = false;
    function dismiss() { n.hidden = true; try { localStorage.setItem("dcNotice", "1"); } catch (e) {} }
    $("noticeOk").addEventListener("click", dismiss);
    $("noticePriv").addEventListener("click", function () { dismiss(); $("saveHist").checked = saveOn(); openDlg($("privDlg")); });
  })();

  // ===========================================================================
  // Neighbourhood factor weights (kept in this browser until the visitor changes them).
  // When memberships arrive, swap loadWeights/saveWeights for calls to the account API.
  // ===========================================================================
  var lastNrs = null;
  var NRS_DEF = [["Crime & Safety", 20], ["Household Income", 15], ["Schools", 10], ["Property Maintenance", 10], ["Owner Occupancy", 10],
    ["Appreciation Potential", 10], ["Rental Demand", 10], ["Amenities & Connectivity", 5], ["Employment Stability", 5], ["Resale Liquidity", 5]];
  var NRS_SCALE = [[95, "A+", "Exceptional"], [90, "A", "Excellent"], [85, "A-", "Very Good"], [80, "B+", "Above Average"], [75, "B", "Good"], [70, "B-", "Fairly Good"],
    [65, "C+", "Moderate"], [60, "C", "Average"], [55, "C-", "Below Average"], [40, "D", "Weak"], [0, "F", "Poor"]];
  function defaultWeights() { return NRS_DEF.map(function (x) { return x[1]; }); }
  function isDefault(w) { return w.every(function (v, i) { return v === NRS_DEF[i][1]; }); }
  function gradeFor(total) { return NRS_SCALE.filter(function (g) { return total >= g[0]; })[0] || NRS_SCALE[NRS_SCALE.length - 1]; }
  function loadWeights() {
    try {
      var w = JSON.parse(localStorage.getItem("dcWeights") || "null");
      if (Array.isArray(w) && w.length === 10 && w.every(function (v) { return Number.isInteger(v) && v >= 0 && v <= 100; }) && w.reduce(function (a, b) { return a + b; }, 0) === 100) return w;
    } catch (e) {}
    return defaultWeights();
  }
  function saveWeights(w) {
    try { if (isDefault(w)) localStorage.removeItem("dcWeights"); else localStorage.setItem("dcWeights", JSON.stringify(w)); } catch (e) {}
  }

  function buildWeights() {
    var W = loadWeights(), box = $("wList"); box.innerHTML = "";
    NRS_DEF.forEach(function (x, i) {
      var l = document.createElement("label"); l.setAttribute("for", "w" + i); l.textContent = x[0];
      var inp = document.createElement("input"); inp.type = "number"; inp.id = "w" + i; inp.min = "0"; inp.max = "100"; inp.step = "1"; inp.inputMode = "numeric"; inp.value = String(W[i]);
      inp.addEventListener("input", onWeightInput);
      box.appendChild(l); box.appendChild(inp);
    });
    showWeightState(W, true);
  }
  function readWeights() { return NRS_DEF.map(function (x, i) { var v = Number($("w" + i).value); return Number.isInteger(v) && v >= 0 && v <= 100 ? v : NaN; }); }
  function showWeightState(w, ok) {
    var sum = w.reduce(function (a, b) { return a + b; }, 0);
    var good = ok && sum === 100;
    $("wSum").textContent = good ? "Total 100%" + (isDefault(w) ? " (standard weights)" : " (your weights)") : "Total " + (isNaN(sum) ? "?" : sum) + "%. Make the weights add up to 100.";
    $("wSum").className = good ? "note" : "err";
    $("wSummary").textContent = "Factor weights" + (good && !isDefault(w) ? " (custom)" : "");
  }
  function onWeightInput() {
    var w = readWeights(), sum = w.reduce(function (a, b) { return a + b; }, 0);
    showWeightState(w, true);
    if (sum === 100) { saveWeights(w); if (lastNrs) renderNrs(lastNrs); }
  }
  $("wReset").addEventListener("click", function () { saveWeights(defaultWeights()); buildWeights(); if (lastNrs) renderNrs(lastNrs); });
  buildWeights();

  refreshHistUi();
})();
