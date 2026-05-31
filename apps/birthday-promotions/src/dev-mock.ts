/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

function bdayIn(days: number) { const d = new Date(); d.setDate(d.getDate() + days); d.setFullYear(1990); return d.toISOString().slice(0, 10); }
let CONTACTS: any[] = [
  { id: 1, name: "Maria Brown", email: "maria@example.com", phone: "8761111111", birthday: bdayIn(0), anniversary: null, source: "manual", last_sent_year: null, last_active: "2026-05-01" },
  { id: 2, name: "Devon Clarke", email: "devon@example.com", phone: null, birthday: bdayIn(3), anniversary: null, source: "inkress", last_sent_year: null, last_active: "2026-05-20" },
  { id: 3, name: "Aaliyah Wright", email: null, phone: "8762222222", birthday: bdayIn(12), anniversary: null, source: "capture", last_sent_year: null, last_active: null },
  { id: 4, name: "Kemar Lewis", email: "kemar@example.com", phone: null, birthday: bdayIn(45), anniversary: "2024-05-30", source: "manual", last_sent_year: 2025, last_active: "2025-12-01" },
  { id: 5, name: "Shanice Reid", email: "shanice@example.com", phone: null, birthday: null, anniversary: null, source: "inkress", last_sent_year: null, last_active: "2026-05-25" },
];
let CID = 5;
let SETTINGS: any = { channels: ["email"], auto_send: true, accent: "#e0457b", code_prefix: "BDAY",
  subject: "Happy Birthday from {{shop}}! 🎂", body: "We're celebrating you, {{name}}! Pop in this week and enjoy a treat on the house. Use {{code}}.", days_before: 0,
  anniversary: { enabled: true, subject: "Happy anniversary, {{name}}!", body: "A year with {{shop}} — thank you!" },
  winback: { enabled: false, days_inactive: 120, subject: "We miss you at {{shop}}", body: "It's been a while, {{name}}." } };
const LOG: any[] = [{ id: 1, email: "kemar@example.com", code: "BDAY-A1B2", channel: "email", kind: "birthday", sent_by_name: "Front Desk", created_at: new Date(Date.now() - 9e7).toISOString() }];

function daysUntil(b: string | null) { if (!b) return 9999; const now = new Date(); const t = new Date(b); const next = new Date(now.getFullYear(), t.getMonth(), t.getDate()); if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next.setFullYear(now.getFullYear() + 1); return Math.round((+next - +new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000); }
const ser = (c: any) => ({ ...c, days_until: daysUntil(c.birthday), days_until_anniv: daysUntil(c.anniversary) });

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 80));
    const cm = u.pathname.match(/\/api\/contacts\/(\d+)(\/send)?$/);

    if (u.pathname === "/api/contacts" && method === "GET") {
      let rows = CONTACTS.map(ser).sort((a, b) => a.name.localeCompare(b.name));
      const all = rows.slice(); const q = (u.searchParams.get("q") || "").toLowerCase(); const fil = u.searchParams.get("filter");
      if (q) rows = rows.filter((c) => (c.name + (c.email || "")).toLowerCase().includes(q));
      if (fil === "upcoming") rows = rows.filter((c) => c.days_until <= 30); else if (fil === "no_email") rows = rows.filter((c) => !c.email); else if (fil === "no_birthday") rows = rows.filter((c) => !c.birthday);
      const up = all.filter((c) => c.birthday && c.days_until <= 30).sort((a, b) => a.days_until - b.days_until);
      return json({ contacts: rows, upcoming: up, ses_configured: true, sms_configured: true, connected: true, capture_url: location.origin + "/birthday/183", stats: { total: all.length, upcoming: up.length, with_email: all.filter((c) => c.email).length, no_birthday: all.filter((c) => !c.birthday).length } });
    }
    if (u.pathname === "/api/contacts" && method === "POST") { CONTACTS.push({ id: ++CID, name: body.name, email: body.email || null, phone: body.phone || null, birthday: body.birthday || null, anniversary: body.anniversary || null, source: "manual", last_sent_year: null, last_active: null }); return json({ ok: true }, 201); }
    if (u.pathname === "/api/contacts/import" && method === "POST") { return json({ imported: 12, with_birthday: 3, capture_url: location.origin + "/birthday/183" }); }
    if (u.pathname === "/api/contacts/csv" && method === "POST") { const n = String(body.csv || "").split(/\r?\n/).filter((l) => l.trim() && !/^name,/i.test(l)).length; return json({ imported: n }); }
    if (u.pathname === "/api/contacts.csv") return new Response("name,email,birthday,phone,anniversary,source\nMaria Brown,maria@example.com,1990-05-12,,,manual", { status: 200, headers: { "Content-Type": "text/csv" } });
    if (cm && cm[2] === "/send") { LOG.unshift({ id: LOG.length + 1, email: "x@example.com", code: SETTINGS.code_prefix + "-A1B2", channel: "email", kind: body.kind || "birthday", sent_by_name: "Front Desk", created_at: new Date().toISOString() }); return json({ ok: true, sent: 1 }); }
    if (cm && method === "PATCH") { const c = CONTACTS.find((x) => x.id === Number(cm[1])); Object.assign(c, body); return json({ ok: true }); }
    if (cm && method === "DELETE") { CONTACTS = CONTACTS.filter((c) => c.id !== Number(cm[1])); return json({ ok: true }); }
    if (u.pathname === "/api/settings" && method === "GET") return json({ settings: SETTINGS, ses_configured: true, sms_configured: true });
    if (u.pathname === "/api/settings" && method === "POST") { SETTINGS = { ...SETTINGS, ...body }; return json({ settings: SETTINGS }); }
    if (u.pathname === "/api/status") return json({ realtime: true, webhook_registered: true, can_register: true });
    if (u.pathname === "/api/log") return json({ log: LOG, roi: { codes_sent: 8, redeemed: 3, revenue: 21500 } });
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "JMD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["customers:read", "merchant_profile:read", "webhooks:manage", "offline_access"],
  };
}
