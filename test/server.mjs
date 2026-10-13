// Local stand-in for Netlify: serves public/ and runs the api function with an in-memory store.
// Host key for tests: "test-host-key". Usage: node test/server.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const mem = new Map();
const calls = { verify: 0 };
globalThis.__DN_STORE = {
  async get(k, o = {}) { if (!mem.has(k)) return null; const v = mem.get(k); return o.type === "json" ? JSON.parse(v.data) : v.data; },
  async setJSON(k, v) { mem.set(k, { data: JSON.stringify(v) }); return { modified: true }; },
  async set(k, v, o = {}) { mem.set(k, { data: Buffer.from(v), metadata: o.metadata || {} }); return { modified: true }; },
  async getWithMetadata(k) { if (!mem.has(k)) return null; const v = mem.get(k); return { data: v.data, metadata: v.metadata }; },
};
globalThis.__DN_VERIFY = async (k) => { calls.verify++; await new Promise((r) => setTimeout(r, 120)); return k === "test-host-key"; };
const { default: api } = await import("../netlify/functions/api.mjs");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2" };
const delay = Number(process.env.API_DELAY || 0);
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/__state") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [...mem.keys()], site: mem.has("site") ? JSON.parse(mem.get("site").data) : null, history: mem.has("history") ? JSON.parse(mem.get("history").data) : null, calls })); return; }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/img/")) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await api(new Request(url, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  let p = path.join(root, decodeURIComponent(url.pathname));
  if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!fs.existsSync(p)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}).listen(Number(process.argv[2] || 8111), () => console.log("ready"));
