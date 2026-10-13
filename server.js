const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const root = __dirname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const cache = new Map();
const https = require("https");
const inCache = new Map();

/* India: proxy FSSAI's Jaivik Bharat company-name lookup (it sends no CORS headers) */
function inCompany(req, res) {
  const json = (code, obj) => {
    if (res.headersSent) return;
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": code === 200 ? "public, max-age=3600" : "no-store" });
    res.end(JSON.stringify(obj));
  };
  const q = (new URL(req.url, "http://local").searchParams.get("q") || "").trim().slice(0, 60);
  if (q.length < 2) return json(400, { error: "query too short" });
  const key = q.toLowerCase();
  if (inCache.has(key)) return json(200, inCache.get(key));
  const url = "https://jaivikbharat.fssai.gov.in/restwebapi_company/RestController.php?view=single&id=" + encodeURIComponent(q);
  const up = https.get(url, { timeout: 12000, headers: { "User-Agent": "OrganicCheck/1.0" } }, (r) => {
    let body = "";
    r.setEncoding("utf8");
    r.on("data", (d) => { body += d; if (body.length > 200000) r.destroy(); });
    r.on("end", () => {
      let data;
      try { data = JSON.parse(body.trim()); } catch (e) { return json(502, { error: "bad response" }); }
      const names = Array.isArray(data) ? [...new Set(data.map((x) => String((x && x.Company_Name) || "").trim()).filter(Boolean))] : [];
      const out = { names };
      if (inCache.size > 500) inCache.clear();
      inCache.set(key, out);
      json(200, out);
    });
  });
  up.on("timeout", () => up.destroy(new Error("timeout")));
  up.on("error", () => json(502, { error: "registry unreachable" }));
}

/* Open Food Facts search proxy: search.openfoodfacts.org sends no CORS headers */
const offCache = new Map();
async function offSearch(req, res) {
  const json = (code, obj, cache) => { if (res.headersSent) return; res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache ? "public, max-age=3600" : "no-store" }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
  const u = new URL(req.url, "http://local").searchParams;
  const q = (u.get("q") || "").slice(0, 300).trim();
  if (q.length < 2) return json(400, { error: "query too short" });
  const size = Math.min(10, Math.max(1, Number(u.get("page_size")) || 8));
  const fields = /^[a-z_,]{1,200}$/.test(u.get("fields") || "") ? u.get("fields") : "code,product_name,brands";
  const sort = u.get("sort_by") === "-unique_scans_n" ? "&sort_by=-unique_scans_n" : "";
  const url = "https://search.openfoodfacts.org/search?q=" + encodeURIComponent(q) + "&page_size=" + size + "&fields=" + fields + sort;
  if (offCache.has(url)) return json(200, offCache.get(url), true);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { "User-Agent": "OrganicCheck/1.0 (organic-check-production.up.railway.app)" } });
    if (!r.ok) return json(502, { error: "search unavailable" });
    const body = await r.text();
    JSON.parse(body);
    if (offCache.size > 500) offCache.clear();
    offCache.set(url, body);
    json(200, body, true);
  } catch (e) { json(502, { error: "search unreachable" }); }
}

/* Exchange rates (open.er-api.com, free, attribution required), cached 6h */
const fxCache = new Map();
async function fx(req, res) {
  const json = (code, obj) => { if (res.headersSent) return; res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": code === 200 ? "public, max-age=3600" : "no-store" }); res.end(JSON.stringify(obj)); };
  const base = (new URL(req.url, "http://local").searchParams.get("base") || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(base)) return json(400, { error: "bad base" });
  const hit = fxCache.get(base);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return json(200, hit.data);
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/" + base, { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    if (d.result !== "success") return json(502, { error: "no rates" });
    const data = { base, rates: d.rates, updated: d.time_last_update_utc };
    fxCache.set(base, { at: Date.now(), data });
    json(200, data);
  } catch (e) { json(502, { error: "rates unreachable" }); }
}

/* Menu reader: send a menu photo to Claude's vision model and return structured dishes */
const MENU_MODEL = process.env.MENU_MODEL || "claude-sonnet-5-5";
const MENU_PER_PERSON = Number(process.env.MENU_DAILY_PER_PERSON) || 15;
const MENU_TOTAL = Number(process.env.MENU_DAILY_TOTAL) || 300;
const LANGS = { en: "English", hi: "Hindi", te: "Telugu", ta: "Tamil", kn: "Kannada", ml: "Malayalam", mr: "Marathi", gu: "Gujarati", bn: "Bengali", pa: "Punjabi", ur: "Urdu", ne: "Nepali", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", ru: "Russian", tr: "Turkish", el: "Greek", ar: "Arabic", he: "Hebrew", ja: "Japanese", zh: "Simplified Chinese", "zh-tw": "Traditional Chinese", ko: "Korean", vi: "Vietnamese", th: "Thai", id: "Indonesian", ms: "Malay", tl: "Filipino", sw: "Swahili" };
let menuDay = "", menuCount = 0;
const KEYS = ["milk", "eggs", "nuts", "peanuts", "soybeans", "fish", "crustaceans", "sesame-seeds", "mustard", "gluten", "pork", "beef", "chicken", "lamb", "alcohol"];
const AVOID = { vegetarian: "meat and fish (vegetarian)", vegan: "all animal products (vegan)", milk: "milk and dairy", eggs: "eggs", nuts: "tree nuts", peanuts: "peanuts", soybeans: "soy", fish: "fish", crustaceans: "shellfish", "sesame-seeds": "sesame", mustard: "mustard", gluten: "wheat and gluten", pork: "pork, including lard and pork broth", beef: "beef, including beef broth and tallow", chicken: "chicken and poultry, including chicken stock", lamb: "lamb and mutton", alcohol: "alcohol, including wine or sake used in cooking" };
const menuByIp = new Map();
const MOCK = { is_menu: true, menu_language: "Japanese", cuisine: "Japanese", currency: "JPY", dishes: [
  { original: "お好み焼き", english: "Okonomiyaki", what_it_is: "A savoury pancake of cabbage and batter, topped with sweet sauce, mayonnaise and bonito flakes.", main_ingredients: ["cabbage", "flour", "egg", "pork"], kcal_low: 500, kcal_high: 750, spice: 0, vegetarian: false, vegan: false, contains: ["gluten", "eggs", "pork", "fish"], often_hidden: [], price: "¥900", price_value: 900, type: "dish", confidence: "high", wikipedia_title: "Okonomiyaki" },
  { original: "冷奴", english: "Chilled tofu (hiyayakko)", what_it_is: "Cold silken tofu with grated ginger, spring onion and soy sauce.", main_ingredients: ["tofu", "ginger", "spring onion"], kcal_low: 100, kcal_high: 180, spice: 0, vegetarian: true, vegan: true, contains: ["soybeans"], often_hidden: [{ key: "fish", why: "Often topped with bonito flakes." }], price: "¥400", price_value: 400, type: "dish", confidence: "high", wikipedia_title: "Hiyayakko" },
  { original: "担々麺", english: "Tantanmen", what_it_is: "Ramen in a spicy sesame and chilli broth with minced pork.", main_ingredients: ["noodles", "pork", "sesame", "chilli oil"], kcal_low: 650, kcal_high: 900, spice: 2, vegetarian: false, vegan: false, contains: ["gluten", "sesame-seeds", "soybeans", "pork"], often_hidden: [{ key: "chicken", why: "The broth is often made with chicken stock." }], price: "¥1,100", price_value: 1100, type: "dish", confidence: "medium", wikipedia_title: "Dandan noodles" },
  { original: "枝豆", english: "Edamame", what_it_is: "Young soybeans boiled in the pod and lightly salted.", main_ingredients: ["soybeans", "salt"], kcal_low: 120, kcal_high: 200, spice: 0, vegetarian: true, vegan: true, contains: ["soybeans"], often_hidden: [], price: "¥350", price_value: 350, type: "dish", confidence: "high", wikipedia_title: "Edamame" },
  { original: "日本酒", english: "Sake", what_it_is: "Japanese rice wine, served cold or warm; light, slightly sweet, good with grilled food.", main_ingredients: ["rice", "koji"], kcal_low: 100, kcal_high: 140, spice: 0, vegetarian: true, vegan: true, contains: ["alcohol"], often_hidden: [], price: "¥600", price_value: 600, type: "drink", confidence: "high", wikipedia_title: "Sake" } ] };
function mockFor(avoid) {
  const out = JSON.parse(JSON.stringify(MOCK));
  if (avoid.length) {
    out.staff_note = { local: "私は豚肉を食べません。豚肉が入っていない料理を教えてください。", romanized: "Watashi wa butaniku o tabemasen. Butaniku ga haitte inai ryouri o oshiete kudasai.", english: "I do not eat pork. Please tell me which dishes have no pork." };
    out.dishes[2].staff_question = { local: "このスープに鶏ガラは使っていますか？", romanized: "Kono suupu ni torigara wa tsukatte imasu ka?", english: "Is this soup made with chicken stock?" };
  }
  return out;
}

function readMenu(req, res) {
  const json = (code, obj) => { if (res.headersSent) return; res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const mock = process.env.MENU_MOCK === "1";
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key && !mock) return json(503, { error: "not_configured" });
  const today = new Date().toISOString().slice(0, 10);
  if (today !== menuDay) { menuDay = today; menuCount = 0; menuByIp.clear(); }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const mine = menuByIp.get(ip) || 0;
  if (mine >= MENU_PER_PERSON) return json(429, { error: "limit", message: "You have scanned " + MENU_PER_PERSON + " menus today, which is the daily limit. Try again tomorrow." });
  if (menuCount >= MENU_TOTAL) return json(429, { error: "limit", message: "The app has reached its menu-scan limit for today. Try again tomorrow." });
  let body = "", size = 0, tooBig = false;
  req.setEncoding("utf8");
  req.on("data", (d) => { size += d.length; if (size > 12e6) { tooBig = true; req.destroy(); } else body += d; });
  req.on("close", () => { if (tooBig) json(413, { error: "too large" }); });
  req.on("end", async () => {
    let input;
    try { input = JSON.parse(body); } catch (e) { return json(400, { error: "bad json" }); }
    const m = /^data:(image\/jpeg|image\/png|image\/webp|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(input.image || ""));
    if (!m) return json(400, { error: "bad image" });
    const lang = LANGS[input.lang] || "English";
    const avoid = (Array.isArray(input.avoid) ? input.avoid : []).filter((k) => AVOID[k]).slice(0, 20);
    menuByIp.set(ip, mine + 1);
    menuCount++;
    if (mock) return setTimeout(() => json(200, mockFor(avoid)), 500);
    const avoidText = avoid.map((k) => AVOID[k]).join("; ");
    const prompt = "Read every dish on this menu photo. Write all explanations in " + lang + ". Reply with JSON only, in exactly this shape:\n" +
      '{"is_menu":true,"menu_language":"","cuisine":"","currency":"ISO 4217 code of the prices, or empty",' + (avoid.length ? '"staff_note":{"local":"","romanized":"","english":""},' : "") + '"dishes":[{"original":"name exactly as printed, in its original script","english":"common English name","what_it_is":"one or two plain sentences: what it is and how it tastes","main_ingredients":[],"kcal_low":0,"kcal_high":0,"spice":0,"vegetarian":false,"vegan":false,"contains":[],"often_hidden":[{"key":"","why":""}],' + (avoid.length ? '"staff_question":{"local":"","romanized":"","english":""},' : "") + '"type":"dish|drink","price":"as printed, or empty","price_value":0,"confidence":"high|medium|low","wikipedia_title":"exact English Wikipedia article title for this dish, or empty"}]}\n' +
      "Rules: what_it_is, main_ingredients and often_hidden.why are written in " + lang + "; english, menu_language and cuisine stay in English. kcal_low and kcal_high are a realistic range for one typical serving, not an exact figure. spice: 0 none, 1 mild, 2 medium, 3 hot. " +
      "contains lists what the dish normally includes, using only these keys: " + KEYS.join(", ") + ". often_hidden lists keys from the same list that are not obvious from the dish name but that the usual recipe in this cuisine often uses (for example lard, fish sauce, dashi, meat broth, butter, wine or sake); give a short reason in why. Do not repeat a key that is already in contains. vegetarian is false if the dish contains meat, fish, or usually uses meat or fish stock. " +
      (avoid.length ? "The diner avoids: " + avoidText + ". staff_note is a short, polite note in the menu's language that the diner can show to restaurant staff, saying what they avoid and asking which dishes are safe; romanized is a pronunciation guide when the menu's script is not Latin, otherwise empty; english is its meaning. For each dish where an avoided item is in often_hidden or is uncertain, staff_question is a short question in the menu's language asking whether that dish contains it, with romanized and english; otherwise leave staff_question empty. " : "") +
      "Use confidence low when the text is hard to read or the dish is ambiguous. Never add dishes that are not on the menu. Include drinks too, with type drink, and put alcohol in contains for alcoholic drinks; for wine, beer and cocktails say in what_it_is what it tastes like and what it goes with. price_value is the price as a plain number in the menu's currency (null if there is none); currency is the ISO code you infer from the symbol and the menu's country. At most 50 items. If the photo is not a menu, reply {\"is_menu\":false,\"dishes\":[]}.";
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(90000),
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MENU_MODEL, max_tokens: 16000, system: "You read restaurant menus from photos for travellers. You reply with JSON only.", messages: [{ role: "user", content: [m[1] === "application/pdf" ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: m[2] } } : { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }, { type: "text", text: prompt }] }] })
      });
      const d = await r.json();
      if (!r.ok) { console.error("menu api", r.status, JSON.stringify(d).slice(0, 300)); return json(502, { error: "model error" }); }
      if (d.usage) console.log("menu usage", JSON.stringify({ model: d.model, input: d.usage.input_tokens, output: d.usage.output_tokens, dishes: null }));
      const text = (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      const a = text.indexOf("{"), b = text.lastIndexOf("}");
      let out;
      try { out = JSON.parse(text.slice(a, b + 1)); } catch (e) { console.error("menu parse", text.slice(0, 200)); return json(502, { error: "unreadable reply" }); }
      json(200, out);
    } catch (e) {
      console.error("menu fetch", e.message);
      json(502, { error: "model unreachable" });
    }
  });
}
http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split("?")[0]); } catch (e) { res.writeHead(400); return res.end("Bad request"); }
  if (p === "/api/in-company") return inCompany(req, res);
  if (p === "/api/read-menu") return readMenu(req, res);
  if (p === "/api/off-search") return offSearch(req, res);
  if (p === "/api/fx") return fx(req, res);
  if (p === "/") p = "/index.html";
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root) || file.endsWith("server.js") || file.endsWith("package.json")) { res.writeHead(404); return res.end("Not found"); }
  const ext = path.extname(file);
  const headers = { "Content-Type": types[ext] || "application/octet-stream", "Permissions-Policy": "camera=(self)", "Cache-Control": ext === ".html" || ext === ".webmanifest" || file.endsWith("sw.js") ? "no-cache" : "public, max-age=3600" };
  const send = (data, gz) => { if (gz) headers["Content-Encoding"] = "gzip"; headers["Vary"] = "Accept-Encoding"; res.writeHead(200, headers); res.end(data); };
  const wantsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && (ext === ".js" || ext === ".html" || ext === ".wasm");
  if (wantsGzip && cache.has(file)) return send(cache.get(file), true);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    if (!wantsGzip) return send(data, false);
    zlib.gzip(data, (e, gz) => { if (e) return send(data, false); cache.set(file, gz); send(gz, true); });
  });
}).listen(process.env.PORT || 3000, "0.0.0.0");
