import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtDate, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Contact { id: number; name: string; email: string | null; phone: string | null; birthday: string | null; anniversary: string | null; source: string; last_sent_year: number | null; days_until: number; days_until_anniv: number; }
interface Tpl { enabled?: boolean; days_inactive?: number; subject: string; body: string; }
interface Settings { channels: string[]; auto_send: boolean; accent: string; code_prefix: string; subject: string; body: string; days_before: number; anniversary: Tpl; winback: Tpl; }
interface ContactsData { contacts: Contact[]; upcoming: Contact[]; ses_configured: boolean; sms_configured: boolean; connected: boolean; capture_url: string; stats: { total: number; upcoming: number; with_email: number; no_birthday: number }; }
interface LogRow { id: number; email: string; code: string; channel: string; kind: string; sent_by_name: string | null; created_at: string; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let sesOk = false, smsOk = false;
let captureUrl = "";
let shell: ReturnType<typeof mountShell>;
let cSearch = "", cFilter = "";

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";

  shell = mountShell({
    brandIcon: "cake", brandLogo: "/logo.svg", title: "Birthday Promotions",
    subtitle: `${merchantName} · celebrate customers, win loyalty`, poweredBy: "Marketplace",
    tabs: [
      { id: "birthdays", label: "Contacts", icon: "cake", render: renderBirthdays },
      { id: "message", label: "Messages", icon: "message", render: renderMessage },
      { id: "sent", label: "Activity", icon: "inbox", render: renderSent },
    ],
  });
  bvApi<{ realtime: boolean }>("/api/status").catch(() => {});
})();

const sidOf = () => sessionStorage.getItem("bv_app_session_id") || localStorage.getItem("bv_app_session_id") || "";

/* ---------------------------------------------------------------- Contacts */
async function renderBirthdays(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: ContactsData;
  const qs = `q=${encodeURIComponent(cSearch)}${cFilter ? `&filter=${cFilter}` : ""}`;
  try { data = await bvApi(`/api/contacts?${qs}`); sesOk = data.ses_configured; smsOk = data.sms_configured; captureUrl = data.capture_url; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  host.append(statRow([
    { k: "Contacts", v: String(data.stats.total), icon: "users" },
    { k: "Birthdays ≤ 30 days", v: String(data.stats.upcoming), tone: "accent", icon: "cake" },
    { k: "With email", v: String(data.stats.with_email), icon: "message" },
    { k: "Missing birthday", v: String(data.stats.no_birthday), tone: data.stats.no_birthday ? "bad" : undefined, icon: "alert" },
  ]));

  if (data.upcoming.length) host.append(card({ title: "Coming up", body: h("div", { class: "bp-up" },
    ...data.upcoming.slice(0, 10).map((c) => h("div", { class: "bp-up-card" },
      h("div", { class: "bp-up-when" }, c.days_until === 0 ? "Today!" : c.days_until === 1 ? "Tomorrow" : `in ${c.days_until}d`),
      h("strong", null, c.name),
      h("div", { class: "bv-muted" }, c.birthday ? fmtDate(c.birthday).replace(/,?\s*\d{4}$/, "") : ""),
      (c.email || c.phone) ? h("button", { class: "primary sm", disabled: !sesOk && !smsOk, onClick: () => send(c, "birthday") }, "Send") : h("span", { class: "bv-muted bp-noemail" }, "no contact")))) }));

  // toolbar
  const importBtn = h("button", { class: "ghost sm", disabled: !data.connected, title: data.connected ? "" : "Connecting…", onClick: () => doImport() }, iconEl("download", 13), "Import from Inkress");
  const captureBtn = h("button", { class: "ghost sm", onClick: () => { navigator.clipboard?.writeText(captureUrl); flash("Capture link copied — share it to collect birthdays", "success"); } }, iconEl("copy", 13), "Capture link");
  const csvBtn = h("button", { class: "ghost sm", onClick: () => openCsvImport() }, iconEl("plus", 13), "CSV");
  const exportBtn = h("a", { class: "ghost sm", href: "/api/contacts.csv", onClick: (e: any) => { e.preventDefault(); downloadCsv(); } }, iconEl("download", 13), "Export");
  const add = h("button", { class: "primary", onClick: () => openContact(null) }, iconEl("plus", 15), "Add contact");

  const search = h("input", { class: "bp-search", placeholder: "Search…", value: cSearch, onInput: (e: any) => { cSearch = e.target.value; renderList(); } }) as HTMLInputElement;
  const filt = h("select", { onChange: (e: any) => { cFilter = e.target.value; shell.select("birthdays"); } },
    h("option", { value: "", selected: !cFilter }, "All"), h("option", { value: "upcoming", selected: cFilter === "upcoming" }, "Upcoming ≤30d"),
    h("option", { value: "no_email", selected: cFilter === "no_email" }, "No email"), h("option", { value: "no_birthday", selected: cFilter === "no_birthday" }, "No birthday")) as HTMLSelectElement;

  const listWrap = h("div");
  host.append(card({ title: "All contacts", action: h("div", { class: "bp-toolbar" }, importBtn, captureBtn, csvBtn, exportBtn, add), body: h("div", null, h("div", { class: "bp-filterbar" }, search, filt), listWrap) }));
  renderList();
  function renderList() {
    listWrap.innerHTML = "";
    let rows = data.contacts.slice();
    const q = cSearch.trim().toLowerCase();
    if (q) rows = rows.filter((c) => (c.name + (c.email || "")).toLowerCase().includes(q));
    if (!rows.length) { listWrap.append(emptyState({ icon: "cake", title: "No contacts", text: "Add contacts, import from Inkress, or share your birthday-capture link." })); return; }
    listWrap.append(dataTable<Contact>({
      columns: [
        { head: "Name", cell: (c) => h("div", null, h("strong", null, c.name), c.source !== "manual" ? h("span", { class: "bp-src" }, c.source) : null) },
        { head: "Birthday", cell: (c) => c.birthday ? fmtDate(c.birthday).replace(/,?\s*\d{4}$/, "") : h("span", { class: "bv-muted" }, "—") },
        { head: "Contact", cell: (c) => h("span", { class: "bv-muted" }, c.email || c.phone || "—") },
        { head: "Next", cell: (c) => c.birthday ? pill(c.days_until === 0 ? "today" : `${c.days_until}d`, c.days_until <= 7 ? "accent" : undefined) : h("span", { class: "bv-muted" }, "—") },
      ],
      rows,
      rowActions: (c) => h("div", { class: "bp-row-actions" },
        (c.email || c.phone) ? h("button", { class: "ghost sm", disabled: !sesOk && !smsOk, onClick: () => send(c, "birthday") }, iconEl("send", 14)) : null,
        h("button", { class: "ghost sm", onClick: () => openContact(c) }, iconEl("edit", 14)),
        h("button", { class: "ghost sm", onClick: async () => { await bvApi(`/api/contacts/${c.id}`, { method: "DELETE" }); shell.select("birthdays"); } }, iconEl("trash", 14))),
    }));
  }

  if (!sesOk && !smsOk) host.append(h("div", { class: "bp-warn" }, iconEl("alert", 15), "No delivery channel configured yet (email/SMS) — you can collect contacts, but sends are disabled."));
}

async function send(c: Contact, kind: string) {
  try { const r = await bvApi<{ sent: number }>(`/api/contacts/${c.id}/send`, { method: "POST", body: JSON.stringify({ kind }) }); flash(`Sent to ${c.name} (${r.sent} channel${r.sent === 1 ? "" : "s"})`, "success"); shell.select("birthdays"); }
  catch (err: any) { toast(err?.message || "Couldn't send", "error"); }
}
async function doImport() {
  try { const r = await bvApi<{ imported: number; with_birthday: number }>("/api/contacts/import", { method: "POST" }); flash(`Imported ${r.imported} customers (${r.with_birthday} had a birthday on file — share your capture link for the rest)`, "success"); shell.select("birthdays"); }
  catch (err: any) { toast(err?.message || "Import failed", "error"); }
}
function openCsvImport() {
  const ta = h("textarea", { rows: "6", placeholder: "name,email,birthday,phone\nMaria Brown,maria@x.com,1990-05-12,8761234567" }) as HTMLTextAreaElement;
  openModal({ title: "Import contacts (CSV)", body: h("div", { class: "bp-form" }, h("p", { class: "bv-muted", style: { margin: "0" } }, "Paste rows: name, email, birthday (YYYY-MM-DD), phone."), ta), actions: [{ label: "Import", primary: true, onClick: () => { void (async () => { try { const r = await bvApi<{ imported: number }>("/api/contacts/csv", { method: "POST", body: JSON.stringify({ csv: ta.value }) }); flash(`Imported ${r.imported} rows`, "success"); shell.select("birthdays"); } catch (e: any) { toast(e?.message || "error", "error"); } })(); } }] });
}
function downloadCsv() { fetch("/api/contacts.csv", { headers: { "X-BV-Session": sidOf() } }).then((r) => r.blob()).then((b) => { const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "contacts.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); }).catch(() => toast("Couldn't export", "error")); }

function openContact(c: Contact | null) {
  const name = h("input", { value: c?.name || "", placeholder: "Customer name" }) as HTMLInputElement;
  const birthday = h("input", { type: "date", value: c?.birthday?.slice(0, 10) || "" }) as HTMLInputElement;
  const email = h("input", { type: "email", value: c?.email || "", placeholder: "Email" }) as HTMLInputElement;
  const phone = h("input", { value: c?.phone || "", placeholder: "Phone (for SMS)" }) as HTMLInputElement;
  const anniversary = h("input", { type: "date", value: c?.anniversary?.slice(0, 10) || "" }) as HTMLInputElement;
  const save = async () => {
    if (!name.value.trim()) { toast("Name required", "warning"); return; }
    const payload = { name: name.value, birthday: birthday.value || null, email: email.value || null, phone: phone.value || null, anniversary: anniversary.value || null };
    try {
      if (c) await bvApi(`/api/contacts/${c.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await bvApi("/api/contacts", { method: "POST", body: JSON.stringify(payload) });
      flash(c ? "Saved" : "Contact added", "success"); shell.select("birthdays");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: c ? `Edit ${c.name}` : "Add contact", body: h("div", { class: "bp-form" }, field("Name", name),
    h("div", { class: "bp-form-grid" }, field("Birthday", birthday), field("First-visit anniversary", anniversary)),
    field("Email", email), field("Phone (SMS)", phone)), actions: [{ label: c ? "Save" : "Add", primary: true, onClick: () => { void save(); } }] });
}

/* ------------------------------------------------------------------ Messages */
async function renderMessage(host: HTMLElement) {
  let s: Settings;
  try { const r = await bvApi<{ settings: Settings; ses_configured: boolean; sms_configured: boolean }>("/api/settings"); s = r.settings; sesOk = r.ses_configured; smsOk = r.sms_configured; }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }

  // delivery + automation
  const chEmail = h("input", { type: "checkbox", checked: s.channels.includes("email"), disabled: !sesOk }) as HTMLInputElement;
  const chSms = h("input", { type: "checkbox", checked: s.channels.includes("sms"), disabled: !smsOk }) as HTMLInputElement;
  const auto = h("input", { type: "checkbox", checked: s.auto_send }) as HTMLInputElement;
  const accent = h("input", { type: "color", value: s.accent || "#e0457b" }) as HTMLInputElement;
  const prefix = h("input", { value: s.code_prefix || "BDAY", style: { textTransform: "uppercase" } }) as HTMLInputElement;
  const daysBefore = h("input", { type: "number", min: "0", max: "30", value: String(s.days_before || 0) }) as HTMLInputElement;

  // birthday template
  const subject = h("input", { value: s.subject }) as HTMLInputElement;
  const body = h("textarea", { rows: "3" }, s.body) as HTMLTextAreaElement;

  const preview = h("div", { class: "bp-preview" });
  const renderPreview = () => {
    preview.innerHTML = ""; preview.style.setProperty("--ac", accent.value);
    preview.append(h("div", { class: "bp-mail" }, h("div", { class: "bp-cake" }, "🎂"), h("h3", null, "Happy Birthday, Maria!"),
      h("p", null, (body.value || "").replace(/\{\{shop\}\}/g, merchantName).replace(/\{\{name\}\}/g, "Maria").replace(/\{\{code\}\}/g, `${prefix.value}-A1B2`)),
      h("div", { class: "bp-code" }, h("span", null, "Your gift code"), h("b", null, `${(prefix.value || "BDAY").toUpperCase()}-A1B2`)),
      h("div", { class: "bp-mail-foot" }, `with love from ${merchantName}`)));
  };
  [subject, body, prefix].forEach((el) => el.addEventListener("input", renderPreview));
  accent.addEventListener("input", renderPreview);
  renderPreview();

  // anniversary + winback
  const annEnabled = h("input", { type: "checkbox", checked: s.anniversary.enabled }) as HTMLInputElement;
  const annSubject = h("input", { value: s.anniversary.subject }) as HTMLInputElement;
  const annBody = h("textarea", { rows: "2" }, s.anniversary.body) as HTMLTextAreaElement;
  const wbEnabled = h("input", { type: "checkbox", checked: s.winback.enabled }) as HTMLInputElement;
  const wbDays = h("input", { type: "number", min: "30", max: "365", value: String(s.winback.days_inactive || 120) }) as HTMLInputElement;
  const wbSubject = h("input", { value: s.winback.subject }) as HTMLInputElement;
  const wbBody = h("textarea", { rows: "2" }, s.winback.body) as HTMLTextAreaElement;

  const save = h("button", { class: "primary", onClick: async () => {
    const channels = [chEmail.checked ? "email" : "", chSms.checked ? "sms" : ""].filter(Boolean);
    try {
      await bvApi("/api/settings", { method: "POST", body: JSON.stringify({
        channels, auto_send: auto.checked, accent: accent.value, code_prefix: prefix.value, days_before: Number(daysBefore.value) || 0,
        subject: subject.value, body: body.value,
        anniversary: { enabled: annEnabled.checked, subject: annSubject.value, body: annBody.value },
        winback: { enabled: wbEnabled.checked, days_inactive: Number(wbDays.value) || 120, subject: wbSubject.value, body: wbBody.value } }) });
      flash("Saved", "success");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  } }, iconEl("check", 15), "Save all");

  const palette = h("div", { class: "bp-hint bv-muted" }, "Merge tags: ", h("code", null, "{{name}}"), " ", h("code", null, "{{shop}}"), " ", h("code", null, "{{code}}"));

  host.append(card({ title: "Delivery & automation", body: h("div", { class: "bp-form" },
    h("div", { class: "bp-channels" },
      h("label", { class: "bp-check" }, chEmail, " Email", !sesOk ? h("span", { class: "bv-muted" }, " (not configured)") : null),
      h("label", { class: "bp-check" }, chSms, " SMS", !smsOk ? h("span", { class: "bv-muted" }, " (not configured)") : null),
      h("span", { class: "bp-wa-soon bv-muted" }, "WhatsApp — coming via the central WhatsApp hub")),
    h("label", { class: "bp-check" }, auto, " Auto-send on the day (once per year, no manual work)"),
    h("div", { class: "bp-form-grid" }, field("Send N days before", daysBefore), fieldColor("Accent colour", accent), field("Gift-code prefix", prefix))) }));

  host.append(card({ title: "Birthday message", body: h("div", { class: "bp-msg" },
    h("div", null, field("Subject", subject), field("Body", body), palette, h("div", { style: { marginTop: "12px" } }, save)),
    h("div", null, h("div", { class: "bv-label" }, "Preview"), preview)) }));

  host.append(card({ title: "Other milestones", body: h("div", { class: "bp-form" },
    h("label", { class: "bp-check" }, annEnabled, " First-visit anniversary"),
    field("Anniversary subject", annSubject), field("Anniversary body", annBody),
    h("div", { class: "bp-divider" }),
    h("label", { class: "bp-check" }, wbEnabled, " “We miss you” win-back for lapsed customers"),
    h("div", { class: "bp-form-grid" }, field("Inactive for (days)", wbDays), field("", h("span"))),
    field("Win-back subject", wbSubject), field("Win-back body", wbBody)) }));
}

/* ---------------------------------------------------------------------- Activity */
async function renderSent(host: HTMLElement) {
  let data: { log: LogRow[]; roi: { codes_sent: number; redeemed: number; revenue: number } };
  try { data = await bvApi("/api/log"); }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.append(statRow([
    { k: "Codes sent", v: String(data.roi.codes_sent), icon: "tag" },
    { k: "Redeemed", v: String(data.roi.redeemed), tone: "accent", icon: "check" },
    { k: "Birthday revenue", v: data.roi.revenue ? `$${data.roi.revenue.toLocaleString()}` : "$0", tone: "ok", icon: "coins" },
  ]));
  host.append(card({ title: "Send activity", body: data.log.length ? dataTable<LogRow>({
    columns: [
      { head: "When", cell: (r) => h("span", { class: "bv-muted" }, relTime(r.created_at)) },
      { head: "To", cell: (r) => r.email },
      { head: "Type", cell: (r) => pill(r.kind, r.kind === "birthday" ? "accent" : undefined) },
      { head: "Channel", cell: (r) => h("span", { class: "bv-muted" }, r.channel) },
      { head: "Code", cell: (r) => r.code ? pill(r.code, "primary") : "—" },
    ], rows: data.log,
  }) : emptyState({ icon: "inbox", title: "Nothing sent yet", text: "Send a message from the Contacts tab, or turn on auto-send." }) }));
}

function field(label: string, el: HTMLElement) { return h("label", { class: "bp-field" }, label ? h("span", { class: "bv-label" }, label) : null, el); }
function fieldColor(label: string, el: HTMLElement) { return h("label", { class: "bp-field bp-field-color" }, h("span", { class: "bv-label" }, label), el); }
function fatal(msg?: string) { return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Birthday Promotions couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard.")); }
