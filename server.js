const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const root = __dirname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const cache = new Map();
http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split("?")[0]); } catch (e) { res.writeHead(400); return res.end("Bad request"); }
  if (p === "/") p = "/index.html";
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root) || file.endsWith("server.js") || file.endsWith("package.json")) { res.writeHead(404); return res.end("Not found"); }
  const ext = path.extname(file);
  const headers = { "Content-Type": types[ext] || "application/octet-stream", "Permissions-Policy": "camera=(self)", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" };
  const send = (data, gz) => { if (gz) headers["Content-Encoding"] = "gzip"; headers["Vary"] = "Accept-Encoding"; res.writeHead(200, headers); res.end(data); };
  const wantsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && (ext === ".js" || ext === ".html");
  if (wantsGzip && cache.has(file)) return send(cache.get(file), true);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    if (!wantsGzip) return send(data, false);
    zlib.gzip(data, (e, gz) => { if (e) return send(data, false); cache.set(file, gz); send(gz, true); });
  });
}).listen(process.env.PORT || 3000, "0.0.0.0");
