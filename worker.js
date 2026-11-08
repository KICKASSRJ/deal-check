// Cloudflare Worker: keeps your API keys private.
// Settings to add in Cloudflare (Settings > Variables and Secrets):
//   RENTCAST_API_KEY     (Secret)  your RentCast key
//   RENTOMETER_API_KEY   (Secret)  your Rentometer API key
//   ALLOWED_ORIGIN       (Text)    https://kickassrj.github.io
//
// Routes:  /       property details (RentCast)
//          /rent   rent summary (Rentometer)
//          /neighborhood   US-NRS neighborhood rating (Claude API + web search)
// Extra setting for /neighborhood:  ANTHROPIC_API_KEY (Secret)

import NRS_PROMPT from "./nrs-prompt.js";

const RATE_LIMIT = 10;          // lookups allowed per visitor...
const RATE_WINDOW_MS = 60000;   // ...per minute
const hits = new Map();         // simple per-instance counter

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function reply(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin) },
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
async function property(url, env) {
  const address = (url.searchParams.get("address") || "").trim();
  if (!validAddress(address)) return { status: 400, body: { error: "Please enter a valid US street address." } };
  if (!env.RENTCAST_API_KEY) return { status: 500, body: { error: "Setup problem: the RentCast key is not saved in the Worker." } };

  const out = await cached("property?address=" + encodeURIComponent(address.toLowerCase()), async () => {
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
  if (out.error) return { status: out.error.status, body: { error: out.error.msg } };
  return { status: 200, body: out.data };
}

// ---- Rentometer: rent summary ---------------------------------------------
async function rent(url, env) {
  const address = (url.searchParams.get("address") || "").trim();
  const beds = url.searchParams.get("bedrooms") || "";
  const baths = url.searchParams.get("baths") || "";
  const type = (url.searchParams.get("building_type") || "any").toLowerCase();
  const back = url.searchParams.get("look_back_days") || "";
  const radius = url.searchParams.get("radius") || "";

  if (!validAddress(address)) return { status: 400, body: { error: "Please enter a valid US street address." } };
  if (!/^[1-4]$/.test(beds)) return { status: 400, body: { error: "Bedrooms must be 1 to 4." } };
  if (!["", "1", "1.5+"].includes(baths)) return { status: 400, body: { error: "Bathrooms must be blank, 1 or 1.5+." } };
  if (!["any", "house", "apartment"].includes(type)) return { status: 400, body: { error: "Building type is not valid." } };
  if (back && !/^\d{1,4}$/.test(back)) return { status: 400, body: { error: "Look-back is not valid." } };
  if (radius && !["0.5", "1", "2", "3", "5"].includes(radius)) return { status: 400, body: { error: "Radius is not valid." } };
  if (!env.RENTOMETER_API_KEY) return { status: 500, body: { error: "Setup problem: the Rentometer key is not saved in the Worker." } };

  const opt = (back ? "&look_back_days=" + back : "") + (radius ? "&radius=" + radius : "");
  const q = "address=" + encodeURIComponent(address) + "&bedrooms=" + beds + (baths ? "&baths=" + encodeURIComponent(baths) : "") + (type !== "any" ? "&building_type=" + type : "");
  const out = await cached("rent?" + (q + opt).toLowerCase(), async () => {
    let up, ignored = false;
    const call = (qs) => fetch("https://www.rentometer.com/api/v1/summary?api_key=" + encodeURIComponent(env.RENTOMETER_API_KEY) + "&" + qs, {
      headers: { "Accept": "application/json" },
    });
    try {
      up = await call(q + opt);
      // If Rentometer does not accept the optional look-back / radius settings, retry without them
      if (opt && (up.status === 400 || up.status === 422)) { up = await call(q); ignored = true; }
    } catch (e) { return { error: { status: 502, msg: "Rent data service is unreachable." } }; }
    if (up.status === 401 || up.status === 403) return { error: { status: 502, msg: "Rentometer rejected the key (code " + up.status + "). Check the key and that API access is active." } };
    if (up.status === 402 || up.status === 429) return { error: { status: 503, msg: "Rentometer credits or rate limit reached (code " + up.status + ")." } };
    if (!up.ok) {
      let detail = "";
      try { detail = (await up.text()).replace(/api_key=[^&\s"]+/g, "").slice(0, 200); } catch (e) {}
      return { error: { status: 502, msg: "Rent data is unavailable right now (code " + up.status + "). " + detail } };
    }
    const data = await up.json();
    if (data && data.error) return { error: { status: 404, msg: String(data.error).slice(0, 160) } };
    if (ignored && data && typeof data === "object") data.filters_ignored = true;
    return { data, error: null };
  });
  if (out.error) return { status: out.error.status, body: { error: out.error.msg } };
  return { status: 200, body: out.data };
}

// ---- Neighborhood rating (US-NRS) via Claude + web search -------------------
const NRS_WEIGHTS = [20, 15, 10, 10, 10, 10, 10, 5, 5, 5];
const NRS_NAMES = ["Crime & Safety", "Household Income", "Schools", "Property Maintenance", "Owner Occupancy", "Appreciation Potential", "Rental Demand", "Amenities & Connectivity", "Employment Stability", "Resale Liquidity"];
const NRS_GRADES = [[95, "A+", "Exceptional"], [90, "A", "Excellent"], [85, "A-", "Very Good"], [80, "B+", "Above Average"], [75, "B", "Good"], [70, "B-", "Fairly Good"], [65, "C+", "Moderate"], [60, "C", "Average"], [55, "C-", "Below Average"], [40, "D", "Weak"], [0, "F", "Poor"]];
const NRS_LIMIT = 3, NRS_WINDOW_MS = 3600000;   // 3 new ratings per visitor per hour (each one costs API credit)
const nrsHits = new Map();

const NRS_FORMAT = `Do your live research with the web search tool. Then reply with ONLY one JSON object (no markdown fences, no commentary) with exactly these keys. Do NOT calculate weighted points, totals or the grade: they are calculated by the application from your factor scores.
{
 "property": {"address": "", "neighborhood": "", "city": "", "county": "", "zip": "", "census_tract": "", "boundaries": "", "evaluation_date": ""},
 "factors": [ exactly 10 objects in this order: crime, income, schools, maintenance, owner occupancy, appreciation, rental demand, amenities, employment, resale liquidity:
   {"id": 1, "score": 1-5 integer, "evidence": "evidence-based explanation with statistics, comparisons, data year and which geography level each statistic is for, and any unavailable data", "sources": ["https://..."]} ],
 "confidence": "High" | "Medium" | "Low",
 "confidence_note": "how missing or older data affects confidence",
 "strengths": [exactly 5 short strings],
 "weaknesses": [exactly 5 short strings covering safety, economic, environmental, infrastructure and resale risks where relevant],
 "outlook": {"homeownership": "", "appreciation": "", "rental_investment": "", "tenant_demand": "", "resale_liquidity": "", "economic_resilience": ""},
 "verdict": {"long_term_ownership": "", "rental_investment": "", "appreciation": "", "biggest_risks": [3 strings], "recommendation": ""}
}
Keep each evidence text under 900 characters. Never fabricate data.`;

async function askClaude(env, address, type) {
  const messages = [{ role: "user", content: "Property Address: " + address + "\nProperty Type: " + type + "\nEvaluation Date: " + new Date().toISOString().slice(0, 10) + "\n\n" + NRS_FORMAT }];
  for (let i = 0; i < 4; i++) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: env.NRS_MODEL || "claude-sonnet-5-5",
          max_tokens: 12000,
          system: NRS_PROMPT,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 12 }],
          messages,
        }),
      });
    } catch (e) { return { error: { status: 502, msg: "The rating service is unreachable." } }; }
    if (res.status === 401 || res.status === 403) return { error: { status: 502, msg: "Anthropic rejected the API key (code " + res.status + ")." } };
    if (res.status === 402 || res.status === 429 || res.status === 529) return { error: { status: 503, msg: "The rating service is busy or out of credit (code " + res.status + "). Try again later." } };
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).replace(/sk-[A-Za-z0-9_-]+/g, "").slice(0, 220); } catch (e) {}
      return { error: { status: 502, msg: "The rating service returned code " + res.status + ". " + detail } };
    }
    const j = await res.json();
    if (j.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: j.content }); continue; }
    return { data: j };
  }
  return { error: { status: 504, msg: "The research took too long. Please try again." } };
}

const cleanStr = (v, n) => String(v === undefined || v === null ? "" : v).slice(0, n || 400);
const cleanList = (a, n, len) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => cleanStr(x, len || 300));

async function neighborhood(url, env, ip) {
  const address = (url.searchParams.get("address") || "").trim();
  let type = (url.searchParams.get("type") || "Single Family").trim();
  if (!validAddress(address)) return { status: 400, body: { error: "Please enter a valid US street address." } };
  if (!["Single Family", "Townhouse", "Condo", "Multi-family", "Other"].includes(type)) type = "Single Family";
  if (!env.ANTHROPIC_API_KEY) return { status: 500, body: { error: "Setup problem: the Anthropic key is not saved in the Worker." } };

  const key = "nrs?address=" + encodeURIComponent(address.toLowerCase()) + "&type=" + encodeURIComponent(type.toLowerCase());
  const cache = caches.default;
  const creq = new Request("https://cache.internal/" + key);
  const hit = await cache.match(creq);
  if (hit) return { status: 200, body: await hit.json() };

  // Stricter limit for uncached ratings, because each one costs API credit
  const now = Date.now();
  const recent = (nrsHits.get(ip) || []).filter((t) => now - t < NRS_WINDOW_MS);
  if (recent.length >= NRS_LIMIT) return { status: 429, body: { error: "Rating limit reached (" + NRS_LIMIT + " new addresses per hour). Please try again later." } };
  recent.push(now); nrsHits.set(ip, recent);
  if (nrsHits.size > 2000) nrsHits.clear();

  const got = await askClaude(env, address, type);
  if (got.error) return { status: got.error.status, body: { error: got.error.msg } };

  const text = (got.data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
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
    const sources = (Array.isArray(f.sources) ? f.sources : []).filter((s) => typeof s === "string" && /^https:\/\//i.test(s)).slice(0, 5);
    return { id: i + 1, name: NRS_NAMES[i], weight: w, score, points, evidence: cleanStr(f.evidence, 1200), sources };
  });
  total = Math.round(total * 100) / 100;
  const g = NRS_GRADES.find((x) => total >= x[0]);
  const p = r.property || {}, o = r.outlook || {}, v = r.verdict || {};
  const conf = ["High", "Medium", "Low"].includes(r.confidence) ? r.confidence : "Medium";
  const body = {
    property: { address: cleanStr(p.address || address), neighborhood: cleanStr(p.neighborhood), city: cleanStr(p.city), county: cleanStr(p.county), zip: cleanStr(p.zip, 20), census_tract: cleanStr(p.census_tract, 60), boundaries: cleanStr(p.boundaries, 500), evaluation_date: cleanStr(p.evaluation_date || new Date().toISOString().slice(0, 10), 40) },
    total, grade: g[1], classification: g[2], confidence: conf, confidence_note: cleanStr(r.confidence_note, 600),
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
      return new Response(JSON.stringify({ error: "Not allowed." }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(allowed) });
    if (request.method !== "GET") return reply({ error: "Method not allowed." }, 405, allowed);

    // Rate limit per visitor IP
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) return reply({ error: "Too many requests. Please wait a minute." }, 429, allowed);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();

    const url = new URL(request.url);
    let result;
    if (url.pathname === "/rent") result = await rent(url, env);
    else if (url.pathname === "/neighborhood") result = await neighborhood(url, env, ip);
    else if (url.pathname === "/" || url.pathname === "") result = await property(url, env);
    else result = { status: 404, body: { error: "Not found." } };

    return reply(result.body, result.status, allowed);
  },
};
