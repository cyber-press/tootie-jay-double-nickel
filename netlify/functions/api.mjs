// Tootie Jay's Double Nickel: storage for the host's site edits.
// Everyone can read the saved edits; only someone with the host key (the same one the
// Host Desk uses, checked against the Google backend) can save edits or add photos.
import { getStore } from "@netlify/blobs";

const GOOGLE = "https://script.google.com/macros/s/AKfycbw0oAM_imCcLE61aHOa3CDAnzaOWJbGzhkZzSoi4g0mZuDNk7DxT-QXA9mIHhUtE1Krig/exec";
const MAX_JSON = 2_000_000;       // site edits + history (photos live separately)
const MAX_PHOTO = 4_000_000;      // photos are resized in the browser first (about 0.2–0.6 MB)
const PHOTO_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const store = () => globalThis.__DN_STORE || getStore({ name: "double-nickel", consistency: "strong" });

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const fail = (status, code, message) => json({ ok: false, code, message }, status);

async function sha256(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- host key: checked by the Google backend (which also slows down wrong guesses) ---------- */
const verified = new Map(); // hash of key -> valid until (kept while this server instance is warm)
async function askGoogle(key) {
  const res = await fetch(GOOGLE, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "door", key }),
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  return Boolean(data && data.ok);
}
async function hostOk(key) {
  if (typeof key !== "string" || key.length < 4 || key.length > 200) return false;
  const h = await sha256("dn|" + key);
  const until = verified.get(h);
  if (until && until > Date.now()) return true;
  const ok = await (globalThis.__DN_VERIFY || askGoogle)(key);
  if (ok) verified.set(h, Date.now() + 10 * 60_000);
  return ok;
}
async function requireHost(key) {
  let ok = false;
  try { ok = await hostOk(key); }
  catch (e) { return fail(503, "verify_failed", "Couldn’t check the host key just now. Please try again in a moment."); }
  return ok ? null : fail(401, "unauthorized", "That host key didn’t work.");
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_JSON + 100_000) throw Object.assign(new Error("too big"), { code: "too_large" });
  try { return JSON.parse(text || "{}") || {}; } catch (e) { throw Object.assign(new Error("bad"), { code: "bad_request" }); }
}

/* ---------- routes ---------- */
async function getSite() {
  const site = await store().get("site", { type: "json" });
  return json({ ok: true, rev: site ? site.rev : 0, at: site ? site.at : null, content: site ? site.content : null });
}

async function login(req) {
  const body = await readBody(req);
  const denied = await requireHost(body.key);
  return denied || json({ ok: true });
}

async function history(req) {
  const body = await readBody(req);
  const denied = await requireHost(body.key);
  if (denied) return denied;
  const h = await store().get("history", { type: "json" });
  return json({ ok: true, history: h || { v: 1, entries: [], pool: {} } });
}

async function save(req) {
  const body = await readBody(req);
  const denied = await requireHost(body.key);
  if (denied) return denied;
  const content = body.content, hist = body.history;
  if (!content || typeof content !== "object" || Array.isArray(content)) return fail(400, "bad_request", "Nothing to save.");
  const contentText = JSON.stringify(content), histText = JSON.stringify(hist || { v: 1, entries: [], pool: {} });
  if (contentText.length + histText.length > MAX_JSON) return fail(413, "too_large", "That’s too much to save at once.");
  if (/"data:image\//.test(contentText)) return fail(400, "bad_request", "Photos must be uploaded before saving.");
  const s = store();
  const cur = await s.get("site", { type: "json" });
  const rev = cur ? cur.rev : 0;
  if (Number(body.base) !== rev) return fail(409, "conflict", "Someone else saved a newer version.");
  const next = { rev: rev + 1, at: new Date().toISOString(), content };
  await s.setJSON("history", JSON.parse(histText));
  await s.setJSON("site", next);
  return json({ ok: true, rev: next.rev, at: next.at });
}

async function uploadPhoto(req) {
  const denied = await requireHost(req.headers.get("x-host-key") || "");
  if (denied) return denied;
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = PHOTO_TYPES[type];
  if (!ext) return fail(415, "bad_type", "Please use a JPG, PNG or WebP photo.");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return fail(400, "bad_request", "That photo was empty.");
  if (bytes.length > MAX_PHOTO) return fail(413, "too_large", "That photo is too large.");
  const name = (await sha256(bytes)).slice(0, 32) + "." + ext; // same photo, same name
  await store().set("img/" + name, bytes, { metadata: { type } });
  return json({ ok: true, src: "/img/" + name });
}

async function servePhoto(name) {
  if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) return new Response("Not found", { status: 404 });
  const entry = await store().getWithMetadata("img/" + name, { type: "arrayBuffer" });
  if (!entry || !entry.data) return new Response("Not found", { status: 404 });
  const type = (entry.metadata && entry.metadata.type) || "image/jpeg";
  return new Response(entry.data, {
    headers: {
      "content-type": type,
      // photo names come from their contents, so a name never changes meaning: cache forever
      "cache-control": "public, max-age=31536000, immutable",
      "netlify-cdn-cache-control": "public, durable, max-age=31536000, immutable",
    },
  });
}


/* ---------- memory wall preview: latest approved notes (public, cached briefly at the edge) ---------- */
async function wall() {
  let list;
  if (globalThis.__DN_WALL) list = await globalThis.__DN_WALL();
  else {
    try {
      const res = await fetch(GOOGLE + "?action=messages", { redirect: "follow", signal: AbortSignal.timeout(8_000) });
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.messages)) throw new Error("wall");
      list = data.messages;
      store().setJSON("wall/last", { at: Date.now(), list: list.slice(0, 50) }).catch(() => {}); // fallback copy
    } catch (e) {
      // 2. Google slow or down: serve the last good copy instead of an empty wall
      const last = await store().get("wall/last", { type: "json" }).catch(() => null);
      if (!last || !Array.isArray(last.list)) throw e;
      list = last.list;
    }
  }
  const clip = (t, n) => { t = String(t || "").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
  const notes = list.slice(0, 3).map((m) => ({ name: clip(m.name, 60), message: clip(m.message, 420), posted: m.posted }));
  return new Response(JSON.stringify({ ok: true, total: list.length, notes }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      "netlify-cdn-cache-control": "public, durable, s-maxage=120, stale-while-revalidate=600",
    },
  });
}

/* ---------- party-updates sign-ups (popup on Home); only the host can read the list ---------- */
const recent = new Map(); // ip -> [timestamps], per warm instance: a light brake on scripted spam
function tooMany(ip) {
  const now = Date.now(), list = (recent.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  list.push(now); recent.set(ip, list);
  if (recent.size > 5000) recent.clear();
  return list.length > SUB_PER_HOUR;
}
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const SUB_CAP = 3000;            // plenty for one party; stops anyone filling the store with junk
const SUB_PER_HOUR = 10;         // sign-ups allowed per device (IP) per hour
const sameSite = (req) => {
  const o = req.headers.get("origin");
  if (!o) return true;           // some privacy tools strip it; the other checks still apply
  try { return new URL(o).host === new URL(req.url).host; } catch (e) { return false; }
};
async function rateLimited(ip) {
  if (tooMany(ip)) return true;  // fast check inside this warm instance
  const s = store(), key = "rl/" + (await sha256("rl|" + ip)).slice(0, 24) + "/" + Math.floor(Date.now() / 3_600_000);
  const n = ((await s.get(key, { type: "json" }).catch(() => null)) || { n: 0 }).n + 1;
  await s.setJSON(key, { n }).catch(() => {});
  return n > SUB_PER_HOUR;
}
async function subscribe(req) {
  if (!sameSite(req)) return fail(403, "forbidden", "Please sign up from the party site.");
  const text = await req.text();
  if (text.length > 4000) return fail(413, "too_large", "That’s more than we need.");
  let b; try { b = JSON.parse(text || "{}") || {}; } catch (e) { return fail(400, "bad_request", "The request couldn’t be read."); }
  if (b.website) return json({ ok: true });                         // honeypot: bots fill every box
  if (typeof b.t === "number" && b.t < 1000) return json({ ok: true }); // filled in faster than a person can type
  const ip = req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
  if (await rateLimited(ip)) return fail(429, "busy", "Too many tries. Please wait a bit and try again.");
  const first = clean(b.first, 60), last = clean(b.last, 60), email = clean(b.email, 200).toLowerCase();
  const phoneRaw = clean(b.phone, 40), digits = phoneRaw.replace(/\D/g, "");
  if (!first || !last) return fail(400, "bad_name", "Please add your first and last name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(400, "bad_email", "That email doesn’t look right.");
  if (phoneRaw && (digits.length < 10 || digits.length > 15 || /[^\d\s()+.\-]/.test(phoneRaw))) return fail(400, "bad_phone", "That phone number doesn’t look right. It’s optional, so you can leave it blank.");
  const key = "subs/" + (await sha256("sub|" + email)).slice(0, 32);
  const s = store();
  const prev = await s.get(key, { type: "json" });
  if (!prev) {
    const meta = (await s.get("meta/subs", { type: "json" }).catch(() => null)) || { n: 0 };
    if (meta.n >= SUB_CAP) return fail(503, "full", "Sign-ups are closed right now. Please check back with the host.");
    await s.setJSON("meta/subs", { n: meta.n + 1 });
  }
  const now = new Date().toISOString();
  await s.setJSON(key, { first, last, email, phone: phoneRaw, at: prev ? prev.at : now, updated: now });
  return json({ ok: true, again: Boolean(prev) });
}
async function unsubscribe(req) {
  const b = await readBody(req);
  const denied = await requireHost(b.key);
  if (denied) return denied;
  const email = clean(b.email, 200).toLowerCase();
  if (!email) return fail(400, "bad_request", "Which email should be removed?");
  const s = store(), key = "subs/" + (await sha256("sub|" + email)).slice(0, 32);
  if (await s.get(key, { type: "json" })) {
    await s.delete(key);
    const meta = (await s.get("meta/subs", { type: "json" }).catch(() => null)) || { n: 1 };
    await s.setJSON("meta/subs", { n: Math.max(0, meta.n - 1) });
  }
  return json({ ok: true });
}
async function subscribers(req) {
  const b = await readBody(req);
  const denied = await requireHost(b.key);
  if (denied) return denied;
  const s = store();
  const { blobs } = await s.list({ prefix: "subs/" });
  const rows = (await Promise.all(blobs.map((x) => s.get(x.key, { type: "json" })))).filter(Boolean);
  rows.sort((a, c) => String(c.at).localeCompare(String(a.at)));
  return json({ ok: true, subscribers: rows });
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (path.startsWith("/img/")) return req.method === "GET" || req.method === "HEAD" ? await servePhoto(path.slice(5)) : fail(405, "method", "Not allowed.");
    if (path === "/api/site" && req.method === "GET") return await getSite();
    if (path === "/api/wall" && req.method === "GET") { try { return await wall(); } catch (e) { return fail(502, "wall_unavailable", "The memory wall couldn’t be reached."); } }
    if (req.method !== "POST") return fail(405, "method", "Not allowed.");
    if (path === "/api/login") return await login(req);
    if (path === "/api/history") return await history(req);
    if (path === "/api/save") return await save(req);
    if (path === "/api/photo") return await uploadPhoto(req);
    if (path === "/api/subscribe") return await subscribe(req);
    if (path === "/api/subscribers") return await subscribers(req);
    if (path === "/api/unsubscribe") return await unsubscribe(req);
    return fail(404, "not_found", "Not found.");
  } catch (err) {
    if (err && err.code === "too_large") return fail(413, "too_large", "That’s too much to save at once.");
    if (err && err.code === "bad_request") return fail(400, "bad_request", "The request couldn’t be read.");
    console.error(err);
    return fail(500, "error", "Something went wrong. Please try again.");
  }
};

export const config = { path: ["/api/*", "/img/*"] };
