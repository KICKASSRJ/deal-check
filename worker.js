// Cloudflare Worker: keeps your API keys private.
// Settings to add in Cloudflare (Settings > Variables and Secrets):
//   RENTCAST_API_KEY     (Secret)  your RentCast key
//   RENTOMETER_API_KEY   (Secret)  your Rentometer API key
//   ALLOWED_ORIGIN       (Text)    https://kickassrj.github.io
//
// Routes:  /       property details (RentCast)
//          /rent   rent summary (Rentometer)

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

async function cached(key, producer) {
  const cache = caches.default;
  const req = new Request("https://cache.internal/" + key);
  const hit = await cache.match(req);
  if (hit) return { data: await hit.json(), error: null };
  const out = await producer();
  if (!out.error) {
    await cache.put(req, new Response(JSON.stringify(out.data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" },
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
  const baths = url.searchParams.get("baths") || "Any";
  const type = (url.searchParams.get("building_type") || "any").toLowerCase();

  if (!validAddress(address)) return { status: 400, body: { error: "Please enter a valid US street address." } };
  if (!/^[0-6]$/.test(beds)) return { status: 400, body: { error: "Bedrooms must be 0 to 6." } };
  if (!(baths === "Any" || /^[1-6](\.5)?\+?$/.test(baths))) return { status: 400, body: { error: "Bathrooms value is not valid." } };
  if (!["any", "house", "apartment"].includes(type)) return { status: 400, body: { error: "Building type is not valid." } };
  if (!env.RENTOMETER_API_KEY) return { status: 500, body: { error: "Setup problem: the Rentometer key is not saved in the Worker." } };

  const q = "address=" + encodeURIComponent(address) + "&bedrooms=" + beds + "&baths=" + encodeURIComponent(baths) + (type !== "any" ? "&building_type=" + type : "");
  const out = await cached("rent?" + q.toLowerCase(), async () => {
    let up;
    try {
      up = await fetch("https://www.rentometer.com/api/v1/summary?api_key=" + encodeURIComponent(env.RENTOMETER_API_KEY) + "&" + q, {
        headers: { "Accept": "application/json" },
      });
    } catch (e) { return { error: { status: 502, msg: "Rent data service is unreachable." } }; }
    if (up.status === 401 || up.status === 403) return { error: { status: 502, msg: "Rentometer rejected the key (code " + up.status + "). Check the key and that API access is active." } };
    if (up.status === 402 || up.status === 429) return { error: { status: 503, msg: "Rentometer credits or rate limit reached (code " + up.status + ")." } };
    if (!up.ok) return { error: { status: 502, msg: "Rent data is unavailable right now (code " + up.status + ")." } };
    const data = await up.json();
    if (data && data.error) return { error: { status: 404, msg: String(data.error).slice(0, 160) } };
    return { data, error: null };
  });
  if (out.error) return { status: out.error.status, body: { error: out.error.msg } };
  return { status: 200, body: out.data };
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
    else if (url.pathname === "/" || url.pathname === "") result = await property(url, env);
    else result = { status: 404, body: { error: "Not found." } };

    return reply(result.body, result.status, allowed);
  },
};
