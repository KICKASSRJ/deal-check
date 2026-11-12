// Cloudflare Worker: keeps your API keys private.
// Settings to add in Cloudflare (Settings > Variables and Secrets):
//   RENTCAST_API_KEY     (Secret)  your RentCast key
//   RENTOMETER_API_KEY   (Secret)  your Rentometer API key
//   ALLOWED_ORIGIN       (Text)    https://kickassrj.github.io
//
// Routes:  /       property details (RentCast)
//          /rent   rent summary (Rentometer)
//          /neighborhood   US-NRS neighborhood rating (Gemini + Google Search)
// Extra setting for /neighborhood:  GEMINI_API_KEY (Secret)
//
// Usage limits (shared across all Worker copies through the LIMITER Durable Object, see wrangler.jsonc).
// Optional Text variables to change them:  LIMIT_IP_PER_MIN, LIMIT_NRS_IP_DAY, LIMIT_NRS_SITE_DAY,
//   LIMIT_RENT_IP_DAY, LIMIT_RENT_SITE_DAY, LIMIT_PROP_IP_DAY, LIMIT_PROP_SITE_DAY

import NRS_PROMPT from "./nrs-prompt.js";

// ---- Owner access -------------------------------------------------------------
// Add a Secret named OWNER_KEY. The site sends it in the X-Owner-Key header when the owner has entered it
// under Privacy > Owner access. Requests with the right key skip every usage limit.
const OWNER = { owner: true };
async function isOwner(request, env) {
  const k = request.headers.get("X-Owner-Key");
  if (!k || !env.OWNER_KEY) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(k)), crypto.subtle.digest("SHA-256", enc.encode(String(env.OWNER_KEY)))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];   // compare without leaking where they differ
  return d === 0;
}

// ---- Usage limits ------------------------------------------------------------
// Counters live in a Durable Object so every copy of the Worker shares them.
// Only requests that cost money (cache misses) count against the daily limits.
const num = (v, d) => { const n = Number(v); return n > 0 ? Math.floor(n) : d; };
const limitsFor = (env) => ({
  ipMin: num(env.LIMIT_IP_PER_MIN, 20),
  nrsIpHour: 3,
  nrsIpDay: num(env.LIMIT_NRS_IP_DAY, 10),    nrsSiteDay: num(env.LIMIT_NRS_SITE_DAY, 300),
  rentIpDay: num(env.LIMIT_RENT_IP_DAY, 40),  rentSiteDay: num(env.LIMIT_RENT_SITE_DAY, 600),
  propIpDay: num(env.LIMIT_PROP_IP_DAY, 80),  propSiteDay: num(env.LIMIT_PROP_SITE_DAY, 1000),
});

// One counter per name, fixed window starting at its first hit; clears itself when the window ends
export class Limiter {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const u = new URL(request.url);
    const limit = Number(u.searchParams.get("limit")) || 1, win = (Number(u.searchParams.get("win")) || 60) * 1000;
    const now = Date.now();
    let w = await this.state.storage.get("w");
    if (!w || now - w.start >= win) w = { start: now, n: 0 };
    if (w.n >= limit) return Response.json({ ok: false, retry: Math.max(1, Math.ceil((w.start + win - now) / 1000)) });
    w.n++;
    await this.state.storage.put("w", w);
    await this.state.storage.setAlarm(w.start + win + 1000);
    return Response.json({ ok: true, left: limit - w.n });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}

const mem = new Map();   // fallback if the Durable Object is not set up: per-copy counters (weaker)
function memAllow(name, limit, win) {
  const now = Date.now(); let w = mem.get(name);
  if (!w || now - w.start >= win * 1000) w = { start: now, n: 0 };
  if (mem.size > 5000) mem.clear();
  if (w.n >= limit) return { ok: false, retry: Math.ceil((w.start + win * 1000 - now) / 1000) };
  w.n++; mem.set(name, w); return { ok: true };
}
async function allow(env, name, limit, win) {
  if (!env.LIMITER) return memAllow(name, limit, win);
  try {
    const stub = env.LIMITER.get(env.LIMITER.idFromName(name));
    const r = await stub.fetch("https://limiter/?limit=" + limit + "&win=" + win);
    return await r.json();
  } catch (e) { return memAllow(name, limit, win); }
}
// Returns null if allowed, otherwise an error object for the visitor
async function gate(env, ip, kind) {
  if (ip === OWNER) return null;
  const L = limitsFor(env);
  const rules = kind === "nrs"
    ? [["nrs-h:" + ip, L.nrsIpHour, 3600, "You can rate " + L.nrsIpHour + " new addresses per hour."], ["nrs-d:" + ip, L.nrsIpDay, 86400, "You have reached today's limit of " + L.nrsIpDay + " new ratings."], ["nrs-site", L.nrsSiteDay, 86400, null]]
    : kind === "rent"
    ? [["rent-d:" + ip, L.rentIpDay, 86400, "You have reached today's limit of " + L.rentIpDay + " new rent checks."], ["rent-site", L.rentSiteDay, 86400, null]]
    : [["prop-d:" + ip, L.propIpDay, 86400, "You have reached today's limit of " + L.propIpDay + " new property lookups."], ["prop-site", L.propSiteDay, 86400, null]];
  for (const [name, limit, win, msg] of rules) {
    const r = await allow(env, name, limit, win);
    if (!r.ok) return msg
      ? { status: 429, msg: msg + " Please try again later.", retry: r.retry }
      : { status: 503, msg: "This service has reached its daily capacity. Please try again tomorrow.", retry: r.retry };
  }
  return null;
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Owner-Key",
    "Vary": "Origin",
  };
}

// Sent with every response: this API only returns JSON, so lock it down
const SECURE = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "X-Frame-Options": "DENY",
};

function reply(body, status, origin, retry) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(retry ? { "Retry-After": String(retry) } : {}), ...SECURE, ...cors(origin) },
  });
}

function validAddress(a) {
  return a.length >= 8 && a.length <= 150 && /^[A-Za-z0-9 .,#'\-\/]+$/.test(a);
}

async function cached(key, producer, ttl) {
  const cache = caches.default;
  const req = new Request("https://cache.internal/" + key);
  const hit = await cache.match(req);
  if (hit) return { data: await hit.json(), error: null };
  const out = await producer();
  if (!out.error) {
    await cache.put(req, new Response(JSON.stringify(out.data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + (ttl || 86400) },
    }));
  }
  return out;
}

// ---- RentCast: property details ------------------------------------------
async function property(url, env, ip) {
  const address = (url.searchParams.get("address") || "").trim();
  if (!validAddress(address)) return { status: 400, body: { error: "Please enter a valid US street address." } };
  if (!env.RENTCAST_API_KEY) return { status: 500, body: { error: "Setup problem: the RentCast key is not saved in the Worker." } };

  const out = await cached("property?address=" + encodeURIComponent(address.toLowerCase()), async () => {
    const blocked = await gate(env, ip, "prop");
    if (blocked) return { error: { status: blocked.status, msg: blocked.msg, retry: blocked.retry } };
    let up;
    try {
      up = await fetch("https://api.rentcast.io/v1/properties?address=" + encodeURIComponent(address), {
        headers: { "X-Api-Key": env.RENTCAST_API_KEY, "Accept": "application/json" },
      });
    } catch (e) { return { error: { status: 502, msg: "Property data service is unreachable." } }; }
    if (up.status === 429) return { error: { status: 503, msg: "Property data limit reached. Try again later." } };
    if (up.status === 401 || up.status === 403) return { error: { status: 502, msg: "RentCast rejected the key (code " + up.status + "). Check the key and that a plan is active." } };
    if (!up.ok) return { error: { status: 502, msg: "Property data is unavailable right now (code " + up.status + ")." } };
    const list = await up.json();
    const record = Array.isArray(list) ? list[0] : list;
    if (!record) return { error: { status: 404, msg: "No public record found for this address." } };
    return { data: record, error: null };
  });
  if (out.error) return { status: out.error.status, body: { error: out.error.msg }, retry: out.error.retry };
  return { status: 200, body: out.data };
}

// ---- Rentometer: rent summary ---------------------------------------------
async function rent(url, env, ip) {
  const address = (url.searchParams.get("address") || "").trim();
  const beds = url.searchParams.get("bedrooms") || "";
  const baths = url.searchParams.get("baths") || "";
  const type = (url.searchParams.get("building_type") || "any").toLowerCase();
  const back = url.searchParams.get("look_back_days") || "";
  const radius = url.searchParams.get("radius_miles") || "";
  const maxSqft = url.searchParams.get("max_sqft") || "";

  if (!validAddress(address)) return { status: 400, body: { error: "Please enter a valid US street address." } };
  if (!/^[0-6]$/.test(beds)) return { status: 400, body: { error: "Bedrooms must be 0 to 6." } };
  if (!["", "1", "1.5+"].includes(baths)) return { status: 400, body: { error: "Bathrooms must be blank, 1 or 1.5+." } };
  if (!["any", "house", "apartment"].includes(type)) return { status: 400, body: { error: "Building type is not valid." } };
  if (back && !(/^\d{2,4}$/.test(back) && +back >= 90 && +back <= 1460)) return { status: 400, body: { error: "Look-back must be 90 to 1460 days." } };
  if (radius && !(/^\d{1,2}(\.\d)?$/.test(radius) && +radius >= 0.1 && +radius <= 10)) return { status: 400, body: { error: "Radius must be 0.1 to 10 miles." } };
  if (maxSqft && !(/^\d{3,5}$/.test(maxSqft) && +maxSqft >= 500 && +maxSqft <= 10000)) return { status: 400, body: { error: "Max square feet must be 500 to 10000." } };
  if (!env.RENTOMETER_API_KEY) return { status: 500, body: { error: "Setup problem: the Rentometer key is not saved in the Worker." } };

  const opt = (back ? "&look_back_days=" + back : "") + (radius ? "&radius_miles=" + radius : "") + (maxSqft ? "&max_sqft=" + maxSqft : "");
  const q = "address=" + encodeURIComponent(address) + "&bedrooms=" + beds + (baths ? "&baths=" + encodeURIComponent(baths) : "") + (type !== "any" ? "&building_type=" + type : "");
  const out = await cached("rent?" + (q + opt).toLowerCase(), async () => {
    const blocked = await gate(env, ip, "rent");
    if (blocked) return { error: { status: blocked.status, msg: blocked.msg, retry: blocked.retry } };
    let up;
    try {
      up = await fetch("https://www.rentometer.com/api/v1/summary?api_key=" + encodeURIComponent(env.RENTOMETER_API_KEY) + "&tool=deal-check&" + q + opt, {
        headers: { "Accept": "application/json" },
      });
    } catch (e) { return { error: { status: 502, msg: "Rent data service is unreachable." } }; }
    if (up.status === 401 || up.status === 403) return { error: { status: 502, msg: "Rentometer rejected the key (code " + up.status + "). Check the key and that API access is active." } };
    if (up.status === 402 || up.status === 429) return { error: { status: 503, msg: "Rentometer credits or rate limit reached (code " + up.status + ")." } };
    if (!up.ok) {
      let detail = "";
      try {
        const t = (await up.text()).replace(/api_key=[^&\s"]+/g, "");
        try { const j = JSON.parse(t); detail = Array.isArray(j.errors) ? j.errors.map((e) => (e && (e.message || e.detail || e.title)) || (typeof e === "string" ? e : "")).filter(Boolean).join("; ") : ""; if (!detail) detail = t; } catch (e) { detail = t; }
      } catch (e) {}
      const hint = up.status === 422 ? " Try a larger radius, a longer look-back, or clear the max square feet." : "";
      return { error: { status: up.status === 404 || up.status === 422 ? 422 : 502, msg: (up.status === 422 ? "" : "Rentometer: ") + String(detail).slice(0, 220) + (up.status === 422 ? "" : " (code " + up.status + ")") + "." + hint } };
    }
    const data = await up.json();
    if (data && data.error) return { error: { status: 404, msg: String(data.error).slice(0, 160) } };
    return { data, error: null };
  });
  if (out.error) return { status: out.error.status, body: { error: out.error.msg }, retry: out.error.retry };
  return { status: 200, body: out.data };
}

// ---- Neighborhood rating (US-NRS) via Gemini 2.5 Flash-Lite + Google Search ---
const NRS_WEIGHTS = [20, 15, 10, 10, 10, 10, 10, 5, 5, 5];
const NRS_NAMES = ["Crime & Safety", "Household Income", "Schools", "Property Maintenance", "Owner Occupancy", "Appreciation Potential", "Rental Demand", "Amenities & Connectivity", "Employment Stability", "Resale Liquidity"];
const NRS_GRADES = [[95, "A+", "Exceptional"], [90, "A", "Excellent"], [85, "A-", "Very Good"], [80, "B+", "Above Average"], [75, "B", "Good"], [70, "B-", "Fairly Good"], [65, "C+", "Moderate"], [60, "C", "Average"], [55, "C-", "Below Average"], [40, "D", "Weak"], [0, "F", "Poor"]];

const NRS_FORMAT = `Do your live research with Google Search. Then reply with ONLY one JSON object (no markdown fences, no commentary) with exactly these keys. Do NOT calculate weighted points, totals or the grade: they are calculated by the application from your factor scores.
{
 "property": {"address": "", "neighborhood": "", "city": "", "county": "", "zip": "", "census_tract": "", "boundaries": "", "evaluation_date": ""},
 "factors": [ exactly 10 objects in this order: crime, income, schools, maintenance, owner occupancy, appreciation, rental demand, amenities, employment, resale liquidity:
   {"id": 1, "score": 1-5 integer, "evidence": "evidence-based explanation with statistics, comparisons, data year and which geography level each statistic is for, and any unavailable data"} ],
 "confidence": "High" | "Medium" | "Low",
 "confidence_note": "how missing or older data affects confidence",
 "strengths": [exactly 5 short strings],
 "weaknesses": [exactly 5 short strings covering safety, economic, environmental, infrastructure and resale risks where relevant],
 "outlook": {"homeownership": "", "appreciation": "", "rental_investment": "", "tenant_demand": "", "resale_liquidity": "", "economic_resilience": ""},
 "verdict": {"long_term_ownership": "", "rental_investment": "", "appreciation": "", "biggest_risks": [3 strings], "recommendation": ""}
}
Keep each evidence text under 900 characters. Never fabricate data.`;

const DEFAULT_MODEL = "gemini-3.5-flash-lite";   // override with a NRS_MODEL variable when Google retires it

async function askGemini(env, address, type) {
  const prompt = "Property Address: " + address + "\nProperty Type: " + type + "\nEvaluation Date: " + new Date().toISOString().slice(0, 10) + "\n\n" + NRS_FORMAT;
  let res;
  try {
    res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + (env.NRS_MODEL || DEFAULT_MODEL) + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: NRS_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        // Gemini 3 models work best at their default temperature; older ones get a low one for steadier scores
        generationConfig: { ...(/^gemini-3/.test(env.NRS_MODEL || DEFAULT_MODEL) ? {} : { temperature: 0.2 }), maxOutputTokens: 16384 },
      }),
    });
  } catch (e) { return { error: { status: 502, msg: "The rating service is unreachable." } }; }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).replace(/AIza[A-Za-z0-9_-]+/g, "").slice(0, 600); } catch (e) {}
    if (res.status === 400 && /API key/i.test(detail)) return { error: { status: 502, msg: "Google rejected the Gemini API key. Check it in the Worker settings." } };
    if (res.status === 401 || res.status === 403) return { error: { status: 502, msg: "Google rejected the Gemini API key (code " + res.status + ")." } };
    if (res.status === 429 || res.status === 503) {
      let why = "";
      try { why = String((JSON.parse(detail + "").error || {}).message || ""); } catch (e) { why = detail.replace(/\s+/g, " "); }
      return { error: { status: 503, msg: "The rating service is busy or its quota is used up (code " + res.status + "). " + why.replace(/\s+/g, " ").slice(0, 200) } };
    }
    return { error: { status: 502, msg: "The rating service returned code " + res.status + ". " + detail } };
  }
  return { data: await res.json() };
}

const cleanStr = (v, n) => String(v === undefined || v === null ? "" : v).slice(0, n || 400);
const cleanList = (a, n, len) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => cleanStr(x, len || 300));

async function neighborhood(url, env, ip) {
  const address = (url.searchParams.get("address") || "").trim();
  let type = (url.searchParams.get("type") || "Single Family").trim();
  if (!validAddress(address)) return { status: 400, body: { error: "Please enter a valid US street address." } };
  if (!["Single Family", "Townhouse", "Condo", "Multi-family", "Other"].includes(type)) type = "Single Family";
  if (!env.GEMINI_API_KEY) return { status: 500, body: { error: "Setup problem: the Gemini key is not saved in the Worker." } };

  const key = "nrs?address=" + encodeURIComponent(address.toLowerCase()) + "&type=" + encodeURIComponent(type.toLowerCase());
  const cache = caches.default;
  const creq = new Request("https://cache.internal/" + key);
  const hit = await cache.match(creq);
  if (hit) return { status: 200, body: await hit.json() };

  // Stricter limit for uncached ratings, because each one costs API credit
  const blocked = await gate(env, ip, "nrs");
  if (blocked) return { status: blocked.status, body: { error: blocked.msg }, retry: blocked.retry };

  const got = await askGemini(env, address, type);
  if (got.error) return { status: got.error.status, body: { error: got.error.msg } };

  const cand = (got.data.candidates || [])[0] || {};
  const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
  const gm = cand.groundingMetadata || {};
  const consulted = (gm.groundingChunks || []).map((c) => c.web || {}).filter((x) => typeof x.uri === "string" && /^https:\/\//i.test(x.uri)).slice(0, 12).map((x) => ({ title: cleanStr(x.title || x.uri, 120), uri: x.uri }));
  const searchHtml = gm.searchEntryPoint && typeof gm.searchEntryPoint.renderedContent === "string" ? gm.searchEntryPoint.renderedContent.slice(0, 20000) : "";
  let r;
  try { r = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch (e) { r = null; }
  if (!r || !Array.isArray(r.factors) || r.factors.length < 10) return { status: 502, body: { error: "The rating came back incomplete. Please try again." } };

  // The application, not the model, calculates points, total and grade (exact US-NRS formula and scale)
  let total = 0;
  const factors = NRS_WEIGHTS.map((w, i) => {
    const f = r.factors.find((x) => Number(x.id) === i + 1) || r.factors[i] || {};
    const score = Math.min(5, Math.max(1, Math.round(Number(f.score) || 3)));
    const points = Math.round((score / 5) * w * 100) / 100;
    total += points;
    const sources = [];
    return { id: i + 1, name: NRS_NAMES[i], weight: w, score, points, evidence: cleanStr(f.evidence, 1200), sources };
  });
  total = Math.round(total * 100) / 100;
  const g = NRS_GRADES.find((x) => total >= x[0]);
  const p = r.property || {}, o = r.outlook || {}, v = r.verdict || {};
  const conf = ["High", "Medium", "Low"].includes(r.confidence) ? r.confidence : "Medium";
  const body = {
    property: { address: cleanStr(p.address || address), neighborhood: cleanStr(p.neighborhood), city: cleanStr(p.city), county: cleanStr(p.county), zip: cleanStr(p.zip, 20), census_tract: cleanStr(p.census_tract, 60), boundaries: cleanStr(p.boundaries, 500), evaluation_date: cleanStr(p.evaluation_date || new Date().toISOString().slice(0, 10), 40) },
    total, grade: g[1], classification: g[2], confidence: conf, confidence_note: cleanStr(r.confidence_note, 600),
    sources_consulted: consulted, search_html: searchHtml, model: env.NRS_MODEL || DEFAULT_MODEL,
    factors, strengths: cleanList(r.strengths, 5), weaknesses: cleanList(r.weaknesses, 5),
    outlook: { homeownership: cleanStr(o.homeownership, 600), appreciation: cleanStr(o.appreciation, 600), rental_investment: cleanStr(o.rental_investment, 600), tenant_demand: cleanStr(o.tenant_demand, 600), resale_liquidity: cleanStr(o.resale_liquidity, 600), economic_resilience: cleanStr(o.economic_resilience, 600) },
    verdict: { long_term_ownership: cleanStr(v.long_term_ownership, 500), rental_investment: cleanStr(v.rental_investment, 500), appreciation: cleanStr(v.appreciation, 500), biggest_risks: cleanList(v.biggest_risks, 3), recommendation: cleanStr(v.recommendation, 900) },
  };
  await cache.put(creq, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=604800" } }));
  return { status: 200, body };
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN;
    const origin = request.headers.get("Origin") || "";

    // Only your website may call this Worker
    if (origin !== allowed) {
      return new Response(JSON.stringify({ error: "Not allowed." }), { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURE } });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(allowed) });
    if (request.method !== "GET") return reply({ error: "Method not allowed." }, 405, allowed);

    // Rate limit per visitor IP
    const ip = (await isOwner(request, env)) ? OWNER : (request.headers.get("CF-Connecting-IP") || "unknown");
    const m = ip === OWNER ? { ok: true } : await allow(env, "min:" + ip, limitsFor(env).ipMin, 60);
    if (!m.ok) return reply({ error: "Too many requests. Please wait a minute." }, 429, allowed, m.retry);

    const url = new URL(request.url);
    let result;
    if (url.pathname === "/rent") result = await rent(url, env, ip);
    else if (url.pathname === "/neighborhood") result = await neighborhood(url, env, ip);
    else if (url.pathname === "/" || url.pathname === "") result = await property(url, env, ip);
    else result = { status: 404, body: { error: "Not found." } };

    return reply(result.body, result.status, allowed, result.retry);
  },
};
