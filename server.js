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
http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split("?")[0]); } catch (e) { res.writeHead(400); return res.end("Bad request"); }
  if (p === "/api/in-company") return inCompany(req, res);
  if (p === "/") p = "/index.html";
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root) || file.endsWith("server.js") || file.endsWith("package.json")) { res.writeHead(404); return res.end("Not found"); }
  const ext = path.extname(file);
  const headers = { "Content-Type": types[ext] || "application/octet-stream", "Permissions-Policy": "camera=(self)", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" };
  const send = (data, gz) => { if (gz) headers["Content-Encoding"] = "gzip"; headers["Vary"] = "Accept-Encoding"; res.writeHead(200, headers); res.end(data); };
  const wantsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && (ext === ".js" || ext === ".html" || ext === ".wasm");
  if (wantsGzip && cache.has(file)) return send(cache.get(file), true);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    if (!wantsGzip) return send(data, false);
    zlib.gzip(data, (e, gz) => { if (e) return send(data, false); cache.set(file, gz); send(gz, true); });
  });
}).listen(process.env.PORT || 3000, "0.0.0.0");
