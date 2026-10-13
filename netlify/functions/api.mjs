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

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (path.startsWith("/img/")) return req.method === "GET" || req.method === "HEAD" ? await servePhoto(path.slice(5)) : fail(405, "method", "Not allowed.");
    if (path === "/api/site" && req.method === "GET") return await getSite();
    if (req.method !== "POST") return fail(405, "method", "Not allowed.");
    if (path === "/api/login") return await login(req);
    if (path === "/api/history") return await history(req);
    if (path === "/api/save") return await save(req);
    if (path === "/api/photo") return await uploadPhoto(req);
    return fail(404, "not_found", "Not found.");
  } catch (err) {
    if (err && err.code === "too_large") return fail(413, "too_large", "That’s too much to save at once.");
    if (err && err.code === "bad_request") return fail(400, "bad_request", "The request couldn’t be read.");
    console.error(err);
    return fail(500, "error", "Something went wrong. Please try again.");
  }
};

export const config = { path: ["/api/*", "/img/*"] };
