import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";
import { sendSms, snsConfigured, toE164 } from "@inkress/apps-core/sns";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[birthday-promotions] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("birthday_promotions", `
  CREATE TABLE IF NOT EXISTS contacts (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    name TEXT NOT NULL, email TEXT, birthday DATE NOT NULL,
    last_sent_year INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, email)
  );
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone TEXT;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS customer_id TEXT;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS anniversary DATE;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_anniv_year INTEGER;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_active DATE;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_winback_on DATE;
  ALTER TABLE contacts ALTER COLUMN birthday DROP NOT NULL;
  CREATE TABLE IF NOT EXISTS settings (
    merchant_id BIGINT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sends (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, contact_id BIGINT, email TEXT, code TEXT,
    message_id TEXT, sent_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE sends ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';
  ALTER TABLE sends ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'birthday';
  ALTER TABLE sends ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT false;
  CREATE TABLE IF NOT EXISTS promo (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, contact_id BIGINT, code TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'birthday', redeemed BOOLEAN NOT NULL DEFAULT false, order_id TEXT, revenue NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), redeemed_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_bp_promo ON promo (merchant_id, code);
  CREATE INDEX IF NOT EXISTS idx_bp_contacts ON contacts (merchant_id, birthday);
  CREATE INDEX IF NOT EXISTS idx_bp_sends ON sends (merchant_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("birthday_promotions", core.cfg);

const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
const merchantName = (req) => req.session.data?.merchant?.name || "your shop";
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const codeToken = () => crypto.randomBytes(4).toString("hex").toUpperCase();
const DEFAULTS = {
  channels: ["email"], auto_send: false, accent: "#e0457b", code_prefix: "BDAY",
  subject: "Happy Birthday from {{shop}}! 🎂", body: "We're celebrating you, {{name}}! Enjoy a treat on us.", days_before: 0,
  anniversary: { enabled: false, subject: "Happy anniversary, {{name}}!", body: "It's been a year since your first visit to {{shop}} — thank you! Here's a little something." },
  winback: { enabled: false, days_inactive: 120, subject: "We miss you at {{shop}}", body: "It's been a while, {{name}}. Come back for a treat on us." },
};

function daysUntil(dateStr) {
  if (!dateStr) return 9999;
  const now = new Date(); const t = new Date(dateStr);
  const next = new Date(now.getFullYear(), t.getMonth(), t.getDate());
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (next < base) next.setFullYear(now.getFullYear() + 1);
  return Math.round((next - base) / 86400000);
}
const serialize = (c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, birthday: c.birthday, anniversary: c.anniversary,
  source: c.source, last_sent_year: c.last_sent_year, last_active: c.last_active,
  days_until: daysUntil(c.birthday), days_until_anniv: daysUntil(c.anniversary) });
async function getSettings(mid) { const r = await db.one(`SELECT data FROM settings WHERE merchant_id=$1`, [mid]); return mergeSettings(r?.data || {}); }
function mergeSettings(d) { return { ...DEFAULTS, ...d, anniversary: { ...DEFAULTS.anniversary, ...(d.anniversary || {}) }, winback: { ...DEFAULTS.winback, ...(d.winback || {}) }, channels: Array.isArray(d.channels) && d.channels.length ? d.channels : DEFAULTS.channels }; }
const fillTpl = (t, vars) => String(t || "").replace(/\{\{shop\}\}/g, vars.shop).replace(/\{\{name\}\}/g, vars.name).replace(/\{\{code\}\}/g, vars.code || "");

// ---- Contacts --------------------------------------------------------------
app.get("/api/contacts", core.requireSession, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const filter = String(req.query.filter || "");
  let rows = (await db.q(`SELECT * FROM contacts WHERE merchant_id=$1 ORDER BY name`, [req.session.merchantId])).map(serialize);
  const all = rows.slice();
  if (q) rows = rows.filter((c) => (c.name + (c.email || "")).toLowerCase().includes(q));
  if (filter === "upcoming") rows = rows.filter((c) => c.days_until <= 30);
  else if (filter === "no_email") rows = rows.filter((c) => !c.email);
  else if (filter === "no_birthday") rows = rows.filter((c) => !c.birthday);
  const upcoming = all.filter((c) => c.birthday && c.days_until <= 30).sort((a, b) => a.days_until - b.days_until);
  res.json({ contacts: rows, upcoming, ses_configured: sesConfigured(), sms_configured: snsConfigured(),
    connected: await tokens.hasToken(req.session.merchantId), capture_url: `${PUBLIC_BASE(req)}/birthday/${req.session.merchantId}`,
    stats: { total: all.length, upcoming: upcoming.length, with_email: all.filter((c) => c.email).length, no_birthday: all.filter((c) => !c.birthday).length } });
});
app.post("/api/contacts", core.requireSession, async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || "").trim()) return res.status(400).json({ error: "missing", message: "Name is required." });
  if (b.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(b.birthday)) return res.status(400).json({ error: "bad_date" });
  await db.run(`INSERT INTO contacts (merchant_id, name, email, phone, birthday, anniversary, source) VALUES ($1,$2,$3,$4,$5,$6,'manual')
    ON CONFLICT (merchant_id, email) DO UPDATE SET name=$2, phone=$4, birthday=COALESCE($5,contacts.birthday), anniversary=COALESCE($6,contacts.anniversary)`,
    [req.session.merchantId, b.name.trim(), b.email || null, b.phone || null, b.birthday || null, /^\d{4}-\d{2}-\d{2}$/.test(b.anniversary) ? b.anniversary : null]);
  res.status(201).json({ ok: true });
});
app.patch("/api/contacts/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const c = await db.one(`SELECT * FROM contacts WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!c) return res.status(404).json({ error: "not_found" });
  await db.run(`UPDATE contacts SET name=$1, email=$2, phone=$3, birthday=$4, anniversary=$5 WHERE id=$6`,
    [b.name ?? c.name, b.email !== undefined ? (b.email || null) : c.email, b.phone !== undefined ? (b.phone || null) : c.phone,
      b.birthday !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.birthday) ? b.birthday : null) : c.birthday,
      b.anniversary !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.anniversary) ? b.anniversary : null) : c.anniversary, c.id]);
  res.json({ ok: true });
});
app.delete("/api/contacts/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM contacts WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

// Import customers from Inkress (names/emails/phones; DOB is filtered from OAuth → capture link)
app.post("/api/contacts/import", core.requireSession, async (req, res) => {
  let imported = 0, withBirthday = 0;
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `users?limit=100&order=id desc`);
    const entries = r?.result?.entries || r?.result || [];
    for (const u of (Array.isArray(entries) ? entries : [])) {
      const name = u.full_name || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
      const email = u.email || null; if (!name || !email) continue;
      const dob = /^\d{4}-\d{2}-\d{2}/.test(u.dob || u.date_of_birth || "") ? String(u.dob || u.date_of_birth).slice(0, 10) : null;
      if (dob) withBirthday++;
      await db.run(`INSERT INTO contacts (merchant_id, name, email, phone, birthday, customer_id, source) VALUES ($1,$2,$3,$4,$5,$6,'inkress')
        ON CONFLICT (merchant_id, email) DO UPDATE SET name=$2, phone=COALESCE($4,contacts.phone), customer_id=$6, birthday=COALESCE(contacts.birthday,$5)`,
        [req.session.merchantId, name, email, u.phone || u.phone_number || null, dob, u.id != null ? String(u.id) : null]);
      imported++;
    }
  } catch (err) { return res.status(502).json({ error: "import_failed", message: err?.message }); }
  res.json({ imported, with_birthday: withBirthday, capture_url: `${PUBLIC_BASE(req)}/birthday/${req.session.merchantId}` });
});

// CSV import / export
app.post("/api/contacts/csv", core.requireSession, async (req, res) => {
  const text = String(req.body?.csv || "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let imported = 0;
  for (const line of lines) {
    const [name, email, birthday, phone] = line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    if (!name || name.toLowerCase() === "name") continue;
    await db.run(`INSERT INTO contacts (merchant_id, name, email, phone, birthday, source) VALUES ($1,$2,$3,$4,$5,'csv')
      ON CONFLICT (merchant_id, email) DO UPDATE SET name=$2, phone=$4, birthday=COALESCE($5,contacts.birthday)`,
      [req.session.merchantId, name, email || null, phone || null, /^\d{4}-\d{2}-\d{2}$/.test(birthday) ? birthday : null]).catch(() => {});
    imported++;
  }
  res.json({ imported });
});
app.get("/api/contacts.csv", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM contacts WHERE merchant_id=$1 ORDER BY name`, [req.session.merchantId]);
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((c) => [c.name, c.email, c.birthday || "", c.phone || "", c.anniversary || "", c.source].map(esc).join(","));
  res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", `attachment; filename="contacts.csv"`);
  res.send(["name,email,birthday,phone,anniversary,source", ...lines].join("\n"));
});

// ---- Settings (3 templates + channels + auto) ------------------------------
app.get("/api/settings", core.requireSession, async (req, res) => res.json({ settings: await getSettings(req.session.merchantId), ses_configured: sesConfigured(), sms_configured: snsConfigured() }));
app.post("/api/settings", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const data = {
    channels: Array.isArray(b.channels) ? b.channels.filter((c) => ["email", "sms"].includes(c)) : DEFAULTS.channels,
    auto_send: !!b.auto_send, accent: /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : DEFAULTS.accent, code_prefix: String(b.code_prefix || "BDAY").replace(/[^A-Z0-9]/gi, "").slice(0, 10) || "BDAY",
    subject: String(b.subject || DEFAULTS.subject).slice(0, 160), body: String(b.body || DEFAULTS.body).slice(0, 1000), days_before: Math.max(0, Math.min(30, Number(b.days_before) || 0)),
    anniversary: { enabled: !!b.anniversary?.enabled, subject: String(b.anniversary?.subject || DEFAULTS.anniversary.subject).slice(0, 160), body: String(b.anniversary?.body || DEFAULTS.anniversary.body).slice(0, 1000) },
    winback: { enabled: !!b.winback?.enabled, days_inactive: Math.max(30, Math.min(365, Number(b.winback?.days_inactive) || 120)), subject: String(b.winback?.subject || DEFAULTS.winback.subject).slice(0, 160), body: String(b.winback?.body || DEFAULTS.winback.body).slice(0, 1000) },
  };
  data.shop_name = req.session.data?.merchant?.name || null;
  await db.run(`INSERT INTO settings (merchant_id, data, updated_at) VALUES ($1,$2,now()) ON CONFLICT (merchant_id) DO UPDATE SET data=$2, updated_at=now()`, [req.session.merchantId, JSON.stringify(data)]);
  res.json({ settings: mergeSettings(data) });
});

// ---- Send (manual or via scheduler) ----------------------------------------
async function deliver(mid, req, c, kind, s) {
  const shop = req ? merchantName(req) : (s._shop || "your shop");
  const tpl = kind === "anniversary" ? s.anniversary : kind === "winback" ? s.winback : s;
  let code = "";
  if (kind === "birthday") { code = `${s.code_prefix}-${codeToken()}`; await db.run(`INSERT INTO promo (merchant_id, contact_id, code, kind) VALUES ($1,$2,$3,'birthday')`, [mid, c.id, code]); }
  const vars = { shop, name: c.name, code };
  const channels = s.channels || ["email"];
  let sent = 0;
  for (const ch of channels) {
    try {
      if (ch === "email" && c.email && sesConfigured()) { const out = await sendEmail({ to: c.email, subject: fillTpl(tpl.subject, vars), html: emailHtml(shop, c.name, fillTpl(tpl.body, vars), code, s.accent) }); await db.run(`INSERT INTO sends (merchant_id, contact_id, email, code, message_id, channel, kind) VALUES ($1,$2,$3,$4,$5,'email',$6)`, [mid, c.id, c.email, code, out.messageId, kind]); sent++; }
      else if (ch === "sms" && c.phone && snsConfigured()) { await sendSms({ to: toE164(c.phone), message: `${fillTpl(tpl.body, vars)}${code ? ` Code: ${code}` : ""}` }); await db.run(`INSERT INTO sends (merchant_id, contact_id, email, code, channel, kind) VALUES ($1,$2,$3,$4,'sms',$5)`, [mid, c.id, c.phone, code, kind]); sent++; }
    } catch (err) { console.error(`[birthday] deliver ${ch} ${c.id}: ${err?.message}`); }
  }
  return sent;
}

app.post("/api/contacts/:id/send", core.requireSession, async (req, res) => {
  const c = await db.one(`SELECT * FROM contacts WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!c) return res.status(404).json({ error: "not_found" });
  const s = await getSettings(req.session.merchantId);
  const kind = ["anniversary", "winback"].includes(req.body?.kind) ? req.body.kind : "birthday";
  const sent = await deliver(req.session.merchantId, req, c, kind, s);
  if (!sent) return res.status(400).json({ error: "no_channel", message: "No deliverable channel (check email/phone + channel config)." });
  if (kind === "birthday") await db.run(`UPDATE contacts SET last_sent_year=$1 WHERE id=$2`, [new Date().getFullYear(), c.id]);
  if (kind === "anniversary") await db.run(`UPDATE contacts SET last_anniv_year=$1 WHERE id=$2`, [new Date().getFullYear(), c.id]);
  res.json({ ok: true, sent });
});

app.get("/api/log", core.requireSession, async (req, res) => {
  const log = await db.q(`SELECT * FROM sends WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 200`, [req.session.merchantId]);
  const promos = await db.q(`SELECT code, redeemed, revenue FROM promo WHERE merchant_id=$1`, [req.session.merchantId]);
  const redeemed = promos.filter((p) => p.redeemed);
  res.json({ log, roi: { codes_sent: promos.length, redeemed: redeemed.length, revenue: round2(redeemed.reduce((s, p) => s + Number(p.revenue || 0), 0)) } });
});

// ---- Status / webhook ------------------------------------------------------
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try { await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) }); await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid, url }; }
    catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub), can_register: Boolean(canRegister) });
});

// Public birthday capture page (DOB is OAuth-filtered, so collect it from the customer)
app.get("/birthday/:merchantId", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(capturePage(req.params.merchantId, req.query.name || ""));
});
app.post("/api/public/birthday/:merchantId", express.json(), async (req, res) => {
  const mid = Number(req.params.merchantId); const b = req.body || {};
  const name = String(b.name || "").trim(); const email = String(b.email || "").trim().toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !/^\d{4}-\d{2}-\d{2}$/.test(b.birthday)) return res.status(400).json({ error: "bad_input" });
  await db.run(`INSERT INTO contacts (merchant_id, name, email, birthday, source) VALUES ($1,$2,$3,$4,'capture')
    ON CONFLICT (merchant_id, email) DO UPDATE SET name=$2, birthday=$4`, [mid, name, email, b.birthday]);
  res.json({ ok: true });
});

// Webhook receiver — track birthday-code redemption (code present in order meta/title)
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || !isPaidStatus(o)) return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    const hay = `${o.title || ""} ${JSON.stringify(o.meta_data || o.metadata || {})}`.toUpperCase();
    const codes = await db.q(`SELECT * FROM promo WHERE merchant_id=$1 AND redeemed=false`, [merchantId]);
    for (const p of codes) { if (hay.includes(String(p.code).toUpperCase())) { await db.run(`UPDATE promo SET redeemed=true, order_id=$2, revenue=$3, redeemed_at=now() WHERE id=$1`, [p.id, String(o.id), round2(o.total)]); break; } }
  } catch (err) { console.error(`[birthday] webhook failed: ${err?.message}`); }
});

// ---- Scheduler: auto-send birthdays / anniversaries / win-back --------------
async function runScheduler() {
  try {
    const year = new Date().getFullYear();
    const mids = await db.q(`SELECT DISTINCT merchant_id FROM settings WHERE (data->>'auto_send')='true'`);
    for (const { merchant_id: mid } of mids) {
      const s = await getSettings(mid);
      s._shop = s.shop_name || "your shop";
      if (!sesConfigured() && !snsConfigured()) continue;
      // birthdays (on or days_before, once per year)
      const contacts = await db.q(`SELECT * FROM contacts WHERE merchant_id=$1 AND birthday IS NOT NULL`, [mid]);
      for (const c of contacts) {
        const du = daysUntil(c.birthday);
        if (du <= (s.days_before || 0) && c.last_sent_year !== year) { try { const sent = await deliver(mid, null, c, "birthday", s); if (sent) await db.run(`UPDATE contacts SET last_sent_year=$1 WHERE id=$2`, [year, c.id]); } catch { /* */ } }
        if (s.anniversary.enabled && c.anniversary) { const da = daysUntil(c.anniversary); if (da === 0 && c.last_anniv_year !== year) { try { const sent = await deliver(mid, null, c, "anniversary", s); if (sent) await db.run(`UPDATE contacts SET last_anniv_year=$1 WHERE id=$2`, [year, c.id]); } catch { /* */ } } }
      }
      // win-back
      if (s.winback.enabled) {
        const cutoff = new Date(Date.now() - s.winback.days_inactive * 86400000).toISOString().slice(0, 10);
        const lapsed = await db.q(`SELECT * FROM contacts WHERE merchant_id=$1 AND last_active IS NOT NULL AND last_active < $2 AND (last_winback_on IS NULL OR last_winback_on < $3)`, [mid, cutoff, new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10)]);
        for (const c of lapsed) { try { const sent = await deliver(mid, null, c, "winback", s); if (sent) await db.run(`UPDATE contacts SET last_winback_on=now() WHERE id=$1`, [c.id]); } catch { /* */ } }
      }
    }
  } catch (err) { console.error(`[birthday] scheduler: ${err?.message}`); }
}
setInterval(runScheduler, 6 * 3600 * 1000); setTimeout(runScheduler, 45000);

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[birthday-promotions] listening on ${HOST}:${PORT}`));

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function emailHtml(shop, name, body, code, accent = "#e0457b") {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;text-align:center;color:#1a1a1a;">
    <div style="font-size:40px;">🎂</div>
    <h2 style="margin:6px 0 10px;">Happy Birthday, ${esc(name)}!</h2>
    <p style="color:#555;margin:0 0 18px;">${esc(body)}</p>
    ${code ? `<div style="display:inline-block;border:2px dashed ${esc(accent)};border-radius:12px;padding:14px 28px;margin:6px 0 16px;"><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;">Your gift code</div><div style="font-size:24px;font-weight:800;letter-spacing:.04em;color:${esc(accent)}">${esc(code)}</div></div>` : ""}
    <p style="color:#aaa;font-size:12px;margin-top:18px;">with love from ${esc(shop)} · via Marketplace</p></div>`;
}
function capturePage(mid, name) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tell us your birthday</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#fff0f6;color:#2a1a22;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border:1px solid #ffd6e6;border-radius:18px;box-shadow:0 14px 44px rgba(180,40,90,.12);max-width:400px;width:100%;padding:30px;text-align:center}
  h1{font-size:1.4rem;margin:0 0 4px}p{color:#7a5260;margin:0 0 18px}
  input{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;border:1px solid #ffc9dd;border-radius:10px;font-size:1rem}
  button{width:100%;padding:13px;margin-top:8px;background:#e0457b;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer}
  .ok{display:none;color:#1a7d4b;font-weight:700;margin-top:14px}</style></head>
  <body><div class="card"><div style="font-size:38px">🎂</div><h1>Tell us your birthday</h1><p>And we'll send you a little something to celebrate.</p>
  <input id="n" placeholder="Your name" value="${esc(name)}"><input id="e" type="email" placeholder="Email"><input id="b" type="date" placeholder="Birthday">
  <button onclick="go()">Send me birthday treats</button><div class="ok" id="ok">🎉 Thank you! See you on your birthday.</div>
  <script>async function go(){const n=document.getElementById('n').value,e=document.getElementById('e').value,b=document.getElementById('b').value;if(!n||!e||!b)return;const r=await fetch('/api/public/birthday/${esc(mid)}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,email:e,birthday:b})});if(r.ok){document.getElementById('ok').style.display='block';}}</script>
  </div></body></html>`;
}
