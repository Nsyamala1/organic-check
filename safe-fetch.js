/* Fetch a user-supplied menu URL without letting it reach private or internal addresses.
   - http/https only, standard ports, no credentials in the URL
   - every hostname is resolved first; any private, loopback, link-local (cloud metadata),
     carrier-grade NAT, multicast or reserved address is refused
   - the connection is pinned to the address that was checked (no DNS rebinding)
   - at most 3 redirects, each one checked the same way
   - 10 second deadline, 2 MB cap, HTML / plain text / PDF only */
const dns = require("dns").promises;
const net = require("net");
const http = require("http");
const https = require("https");

class FetchRefused extends Error {
  constructor(message) { super(message); this.userMessage = message; }
}

function ipv4Blocked(ip) {
  const p = ip.split(".").map(Number);
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function ipBlocked(ip) {
  if (net.isIPv4(ip)) return ipv4Blocked(ip);
  if (!net.isIPv6(ip)) return true;
  const x = ip.toLowerCase();
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  const mappedHex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const h1 = parseInt(mappedHex[1], 16), h2 = parseInt(mappedHex[2], 16);
    return ipv4Blocked([h1 >> 8, h1 & 255, h2 >> 8, h2 & 255].join("."));
  }
  if (x === "::" || x === "::1") return true;
  if (/^f[cd]/.test(x)) return true;        // unique local fc00::/7
  if (/^fe[89ab]/.test(x)) return true;      // link-local fe80::/10
  if (/^ff/.test(x)) return true;            // multicast
  if (x.startsWith("64:ff9b:")) return true; // NAT64 can map to internal IPv4
  if (x.startsWith("2001:db8")) return true; // documentation
  return false;
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|home|lan|corp)$/i;
// Only for automated tests: lets the test suite fetch a fixture on this machine.
const TEST_ALLOW = (process.env.MENU_URL_TEST_ALLOW || "").split(",").filter(Boolean);
if (TEST_ALLOW.length) console.warn("safe-fetch: test allow-list active:", TEST_ALLOW.join(", "));

async function checkUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch (e) { throw new FetchRefused("That does not look like a web address. Paste the full link, starting with https://."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchRefused("Only http and https links can be read.");
  if (url.username || url.password) throw new FetchRefused("Links with a username or password cannot be read.");
  const testHost = TEST_ALLOW.indexOf(url.host) !== -1;
  if (url.port && !testHost && url.port !== "80" && url.port !== "443") throw new FetchRefused("Only links on standard web ports can be read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!testHost && BLOCKED_NAMES.test(host)) throw new FetchRefused("That address is not a public website.");
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else {
    try { addrs = await dns.lookup(host, { all: true, verbatim: true }); } catch (e) { throw new FetchRefused("That website could not be found. Check the link."); }
  }
  if (!addrs.length) throw new FetchRefused("That website could not be found. Check the link.");
  if (!testHost && addrs.some((a) => ipBlocked(a.address))) throw new FetchRefused("That address is not a public website.");
  return { url, address: addrs[0].address, family: addrs[0].family };
}

function requestOnce(target, deadline, maxBytes) {
  return new Promise((resolve, reject) => {
    const lib = target.url.protocol === "https:" ? https : http;
    const left = deadline - Date.now();
    if (left <= 0) return reject(new FetchRefused("The website took too long to answer."));
    const req = lib.request({
      method: "GET",
      hostname: target.url.hostname.replace(/^\[|\]$/g, ""),
      port: target.url.port || undefined,
      path: target.url.pathname + target.url.search,
      headers: { "User-Agent": "OrganicCheck/1.0 menu reader (+https://organic-check-production.up.railway.app)", "Accept": "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9" },
      lookup: (h, opts, cb) => (opts && opts.all) ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family),
      timeout: left
    }, (res) => {
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => { res.destroy(); reject(new FetchRefused("The website took too long to answer.")); }, Math.max(1, deadline - Date.now()));
      res.on("data", (d) => {
        size += d.length;
        if (size > maxBytes) { clearTimeout(timer); res.destroy(); reject(new FetchRefused("That page is too large to read. Try a photo or a PDF of the menu.")); }
        else chunks.push(d);
      });
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on("error", (e) => { clearTimeout(timer); reject(new FetchRefused("The website could not be read.")); });
    });
    req.on("timeout", () => { req.destroy(); reject(new FetchRefused("The website took too long to answer.")); });
    req.on("error", () => reject(new FetchRefused("The website could not be reached.")));
    req.end();
  });
}

const ALLOWED_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/pdf)\b/i;

async function safeFetch(raw, opts = {}) {
  const maxBytes = opts.maxBytes || 2e6, maxRedirects = opts.maxRedirects == null ? 3 : opts.maxRedirects;
  const deadline = Date.now() + (opts.timeoutMs || 10000);
  let target = await checkUrl(raw);
  for (let hop = 0; ; hop++) {
    const r = await requestOnce(target, deadline, maxBytes);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      if (hop >= maxRedirects) throw new FetchRefused("That link redirects too many times.");
      target = await checkUrl(new URL(r.headers.location, target.url).toString());
      continue;
    }
    if (r.status !== 200) throw new FetchRefused("The website answered with an error (" + r.status + ").");
    const type = String(r.headers["content-type"] || "");
    if (!ALLOWED_TYPES.test(type)) throw new FetchRefused("That link is not a web page or PDF.");
    return { finalUrl: target.url.toString(), contentType: type.toLowerCase(), body: r.body };
  }
}

function decodeBody(buf, contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType || "");
  try { return new TextDecoder(m ? m[1] : "utf-8").decode(buf); } catch (e) { return new TextDecoder("utf-8").decode(buf); }
}

function htmlToText(html, maxChars = 40000) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|object)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/li|\/tr|\/div|\/h[1-6]|\/section|\/article|\/dt|\/dd)\b[^>]*>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "  ")
    .replace(/<[^>]+>/g, " ");
  s = s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") { const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); try { return String.fromCodePoint(n); } catch (x) { return " "; } }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k] || " ";
  });
  s = s.replace(/[ \t\f\v ]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

module.exports = { safeFetch, checkUrl, ipBlocked, htmlToText, decodeBody, FetchRefused };
