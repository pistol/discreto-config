// Discreto web app.
// The enclave is verified with Tinfoil's SecureClient before the access token
// is ever sent. All API traffic then goes through client.fetch, which is bound
// to the attested enclave. Every string from the server is rendered with
// textContent, never as HTML, because card text comes from email. Chat replies
// go through renderMarkdown, which builds DOM nodes the same way.
import { SecureClient } from "./vendor/tinfoil-1.4.0.js?v=3"; // bundled tinfoil@1.4.0, see vendor/README
import { ENCLAVE_URL, CONFIG_REPO, START_REPO, START_WORKFLOW } from "./config.js?v=4";
import { renderMarkdown } from "./markdown.js?v=3";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "discreto_token";
let client = null;
const STORAGE_KEY = "discreto.storageKey";
const GITHUB_KEY = "discreto.githubToken";
let token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
let taskId = null;

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (cls) node.className = cls;
  return node;
}

function button(label, onClick, cls) {
  const b = el("button", label, cls);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function when(ts) {
  return new Date(ts * 1000).toLocaleString();
}

async function api(path, { method = "GET", body } = {}) {
  const res = await client.fetch(`${ENCLAVE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    signOut();
    throw new Error("Your token was not accepted.");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json();
}

// Verification

async function verify() {
  const badge = $("verify");
  try {
    client = new SecureClient({ enclaveURL: ENCLAVE_URL, configRepo: CONFIG_REPO });
    await client.ready();
    const doc = await client.getVerificationDocument();
    if (!doc || !doc.securityVerified) throw new Error("securityVerified is false");
    badge.textContent = "Enclave verified";
    badge.className = "badge ok";
    badge.title = JSON.stringify(doc, null, 2);
    return true;
  } catch (err) {
    let detail = String(err && err.message ? err.message : err);
    try {
      if (client) detail += "\n" + JSON.stringify(await client.getVerificationDocument(), null, 2);
    } catch {}
    badge.textContent = "Not verified";
    badge.className = "badge bad";
    $("blocked-detail").textContent = detail;
    $("blocked").hidden = false;
    client = null;
    return false;
  }
}

// Session

function signOut() {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(GITHUB_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  $("app").hidden = true;
  $("pause").hidden = true;
  $("login").hidden = false;
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  (($("remember").checked) ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  $("token").value = "";
  await start();
});

async function start() {
  try {
    await api("/api/cards");
  } catch (err) {
    alertLine(err.message);
    return;
  }
  $("login").hidden = true;
  $("app").hidden = false;
  $("pause").hidden = false;
  showTab("chat");
  checkStorage();
  api("/api/idle").then((i) => {
    if (i.enabled) $("idle-note").textContent = `Discreto stops itself after ${i.minutes} minutes without use.`;
  }).catch(() => {});
}

// Start a stopped instance. Tinfoil has no wake-on-request, so the web app asks
// GitHub to run the deploy workflow, then waits for the enclave to answer.
// Only /healthz is called before verification, and it carries nothing.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp() {
  try {
    const r = await fetch(`${ENCLAVE_URL}/healthz`, { cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

function showStopped() {
  const badge = $("verify");
  badge.textContent = "Stopped";
  badge.className = "badge pending";
  $("gh-token").hidden = Boolean(localStorage.getItem(GITHUB_KEY));
  $("stopped").hidden = false;
}

$("start-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("stopped-msg");
  const btn = $("start-btn");
  const gh = localStorage.getItem(GITHUB_KEY) || $("gh-token").value.trim();
  if (!gh) { msg.textContent = "Enter a GitHub token first."; return; }
  btn.disabled = true;
  msg.textContent = "Asking GitHub to start Discreto...";
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${START_REPO}/actions/workflows/${START_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gh}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { action: "deploy" } }),
    });
  } catch (err) {
    msg.textContent = `Couldn't reach GitHub: ${err.message}`;
    btn.disabled = false;
    return;
  }
  if (!res.ok) {
    if ([401, 403, 404].includes(res.status)) {
      localStorage.removeItem(GITHUB_KEY);
      $("gh-token").hidden = false;
    }
    msg.textContent = `GitHub didn't start it (${res.status}). Check that the token has Actions access to ${START_REPO}.`;
    btn.disabled = false;
    return;
  }
  localStorage.setItem(GITHUB_KEY, gh);
  $("gh-token").value = "";
  $("gh-token").hidden = true;
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    await sleep(3000);
    msg.textContent = `Starting Discreto... ${Math.round((Date.now() - t0) / 1000)}s`;
    if (await isUp()) { location.reload(); return; }
  }
  msg.textContent = `Discreto isn't up after 4 minutes. Check the workflow runs in ${START_REPO} on GitHub.`;
  btn.disabled = false;
});

// Encrypted storage: the key stays with the user and goes only to the verified enclave.


async function unlockStorage(key, initialize) {
  const msg = $("storage-msg");
  msg.textContent = initialize ? "Setting up storage..." : "Unlocking...";
  try {
    await api("/api/storage/unlock", { method: "POST", body: { key, initialize } });
    $("storage").hidden = true;
    return true;
  } catch (err) {
    msg.textContent = `Couldn't unlock: ${err.message}`;
    return false;
  }
}

async function checkStorage() {
  let state;
  try { state = (await api("/api/storage")).state; } catch { return; }
  if (state !== "locked") { $("storage").hidden = true; return; }
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && await unlockStorage(saved, false)) return;
  $("storage").hidden = false;
}

$("storage-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("storage-key").value.trim();
  if (!key) return;
  if (await unlockStorage(key, false)) {
    if ($("storage-remember").checked) localStorage.setItem(STORAGE_KEY, key);
    $("storage-key").value = "";
  }
});

$("storage-new").addEventListener("click", () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  $("storage-newkey").textContent = btoa(String.fromCharCode(...raw));
  $("storage-create").hidden = false;
});

$("storage-saved").addEventListener("change", (e) => { $("storage-init").disabled = !e.target.checked; });

$("storage-init").addEventListener("click", async () => {
  const key = $("storage-newkey").textContent;
  if (await unlockStorage(key, true)) {
    if ($("storage-remember").checked) localStorage.setItem(STORAGE_KEY, key);
    $("storage-newkey").textContent = "";
    $("storage-create").hidden = true;
  }
});

function alertLine(text) {
  const p = el("p", text, "meta");
  $("login").prepend(p);
  setTimeout(() => p.remove(), 6000);
}

// Tabs

const loaders = { cards: loadCards, approvals: loadApprovals, memory: loadMemory, log: loadLog };

function showTab(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  if (loaders[name]) loaders[name]().catch((err) => showError(name, err));
}

function showError(name, err) {
  const tab = $(`tab-${name}`);
  tab.prepend(el("p", err.message, "meta"));
}

document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// Chat

function addMessage(who, text) {
  const div = el("div", null, `msg ${who}`);
  div.append(who === "assistant" ? renderMarkdown(text) : el("span", text));
  $("messages").append(div);
  div.scrollIntoView({ block: "end" });
}

$("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  addMessage("user", message);
  try {
    const out = await api("/api/chat", { method: "POST", body: { message, task_id: taskId } });
    taskId = out.task_id;
    if (out.reply) addMessage("assistant", out.reply);
    if (out.pending_approvals && out.pending_approvals.length) {
      addMessage("assistant", `${out.pending_approvals.length} step(s) wait for your approval in Approvals.`);
    }
  } catch (err) {
    addMessage("assistant", `Error: ${err.message}`);
  }
});

$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("chat-form").requestSubmit();
  }
});

// Cards

async function loadCards() {
  const list = $("cards");
  const cards = await api("/api/cards");
  list.replaceChildren();
  const open = cards.filter((c) => c.status === "open");
  if (!open.length) list.append(el("li", "Nothing needs you right now.", "meta"));
  for (const c of open) {
    const li = el("li");
    li.append(el("strong", c.title), el("div", c.body), el("div", `${c.action || c.category} · ${when(c.created)}`, "meta"));
    const actions = el("div", null, "actions");
    const set = (status) => async () => { await api(`/api/cards/${c.id}`, { method: "POST", body: { status } }); loadCards(); };
    actions.append(button("Done", set("done")), button("Dismiss", set("dismissed")), button("Not useful", set("not_useful")));
    li.append(actions);
    list.append(li);
  }
}

$("triage").addEventListener("click", async () => {
  const b = $("triage");
  b.disabled = true;
  b.textContent = "Checking...";
  try {
    const out = await api("/api/triage", { method: "POST" });
    b.textContent = `Checked ${out.scanned}, ${out.created} new`;
    await loadCards();
  } catch (err) {
    b.textContent = err.message;
  } finally {
    setTimeout(() => { b.disabled = false; b.textContent = "Check mail now"; }, 3000);
  }
});

// Approvals
//
// Each step is drawn as a card: a colored kind, a short title, a few facts as
// chips, and every sender or filter on its own line. The server's own sentence
// stays under "Exact wording", and the raw step under "Technical details".

const KINDS = {
  "gmail.label": { name: "Label", cls: "k-label", group: "Label past mail" },
  "gmail.filter": { name: "New filter", cls: "k-filter", group: "New filters for new mail" },
  "gmail.apply_filter": { name: "Apply filter", cls: "k-filter", group: "Apply filters to past mail" },
  "gmail.filter_delete": { name: "Delete filters", cls: "k-danger", group: "Delete old filters" },
  "gmail.trash": { name: "Trash", cls: "k-danger", group: "Move to Trash" },
  "gmail.archive": { name: "Archive", cls: "k-archive", group: "Archive" },
};

function countIn(reason) {
  const m = /([\d,]+) (?:inbox |existing )?messages/.exec(reason || "");
  return m ? m[1] : null;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function chip(text, cls) {
  return el("span", text, `chip${cls ? " " + cls : ""}`);
}

// A long list shown five at a time, with the rest one tap away.
function itemList(items, noun, render) {
  const box = el("div", null, "items");
  const head = el("div", plural(items.length, noun), "items-head");
  const ul = el("ul", null, "item-list");
  const show = (n) => {
    ul.replaceChildren();
    for (const it of items.slice(0, n)) {
      const li = el("li");
      render(li, it);
      ul.append(li);
    }
  };
  show(5);
  box.append(head, ul);
  if (items.length > 5) {
    let open = false;
    const more = button(`Show all ${items.length}`, () => {
      open = !open;
      show(open ? items.length : 5);
      more.textContent = open ? "Show fewer" : `Show all ${items.length}`;
    }, "link");
    box.append(more);
  }
  return box;
}

// "from x.com -> skip inbox, label Shopping" as a match line and action chips.
function renderFilter(li, summary) {
  const i = summary.indexOf(" -> ");
  const match = i >= 0 ? summary.slice(0, i) : summary;
  const acts = i >= 0 ? summary.slice(i + 4).split(", ") : [];
  li.append(el("div", match, "f-match"));
  if (acts.length) {
    const row = el("div", null, "chips");
    for (const a of acts) row.append(chip(a, /trash/.test(a) ? "c-bad" : ""));
    li.append(row);
  }
}

function senderOf(r) {
  const a = r.args || {};
  if (Array.isArray(a.senders)) return a.senders;
  if (a.sender) return [a.sender];
  return [];
}

function describeStep(r) {
  const a = (r.args && typeof r.args === "object") ? r.args : {};
  const n = countIn(r.reason);
  const senders = senderOf(r);
  const facts = [];
  let title = r.tool;
  let body = null;
  const who = a.category ? `Gmail's ${a.category} tab` : (senders.length ? plural(senders.length, "sender") : "every sender");
  const days = a.older_than_days ? `Older than ${a.older_than_days} days` : null;
  if (r.tool === "gmail.label") {
    title = `Label ${n || ""} messages from ${who}`.replace("  ", " ");
    if (a.label) facts.push(chip(`Label: ${a.label}`, "c-strong"));
    if (a.to_category) facts.push(chip(`Move to ${a.to_category}`));
    if (days) facts.push(chip(days));
    facts.push(chip("Nothing else changes", "c-ok"));
  } else if (r.tool === "gmail.filter") {
    title = `Filter new mail from ${who}`;
    if (a.label) facts.push(chip(`Label: ${a.label}`, "c-strong"));
    if (a.trash) facts.push(chip("Goes to Trash", "c-bad"));
    else if (a.skip_inbox === false || String(a.skip_inbox).toLowerCase() === "false") facts.push(chip("Stays in inbox", "c-ok"));
    else facts.push(chip("Skips the inbox"));
    if (a.to_category) facts.push(chip(`Move to ${a.to_category}`));
    if (a.replaces) facts.push(chip("Replaces an old filter"));
    facts.push(chip("Existing mail unchanged", "c-ok"));
  } else if (r.tool === "gmail.trash") {
    title = `Trash ${n || ""} messages from ${who}`.replace("  ", " ");
    if (days) facts.push(chip(days));
    facts.push(chip("Starred kept", "c-ok"), chip("Restorable for 30 days"));
  } else if (r.tool === "gmail.archive") {
    title = `Archive ${n || ""} inbox messages from ${who}`.replace("  ", " ");
    if (a.label) facts.push(chip(`Label: ${a.label}`, "c-strong"));
    if (days) facts.push(chip(days));
    facts.push(chip("Stays in All Mail", "c-ok"));
  } else if (r.tool === "gmail.apply_filter") {
    const sum = String(a.summary || "");
    const i = sum.indexOf(" -> ");
    const match = i >= 0 ? sum.slice(0, i) : sum;
    const acts = i >= 0 ? sum.slice(i + 4).split(", ") : [];
    const from = /^from (.*)$/.exec(match);
    const list = from ? from[1].split(" OR ") : [];
    title = `Apply a filter to ${n || "past"} messages${list.length > 1 ? ` from ${plural(list.length, "sender")}` : ""}`;
    for (const act of acts) if (act.startsWith("label ")) facts.push(chip(`Label: ${act.slice(6)}`, "c-strong"));
    for (const act of acts) {
      if (act === "skip inbox") {
        facts.push(chip("Leaves the inbox"));
        const st = a.starred && a.starred !== "0" ? a.starred : null;
        if (!a.include_starred) facts.push(chip("Starred stay in inbox", "c-ok"));
        else if (st && a.unstar) facts.push(chip(`Unstars ${st}, marked Discreto/Unstarred`, "c-warn"));
        else if (st) facts.push(chip(`${st} starred move too, keep star`));
      }
      else if (!act.startsWith("label ")) facts.push(chip(act));
    }
    facts.push(chip("Filter unchanged", "c-ok"));
    if (list.length > 1) body = itemList(list, "sender", (li, x) => li.append(el("span", x, "sender")));
    else if (match) { body = el("ul", null, "item-list"); const li = el("li"); renderFilter(li, sum); body.append(li); }
  } else if (r.tool === "gmail.filter_delete") {
    let summaries = Array.isArray(a.summaries) ? a.summaries : [];
    if (!summaries.length) {
      const m = /^Delete the Gmail filter: (.*)\. Mail it already/.exec(r.reason || "");
      if (m) summaries = [m[1]];
    }
    const k = summaries.length || (Array.isArray(a.filter_ids) ? a.filter_ids.length : 1);
    title = a.stale ? `Delete ${plural(k, "stale filter")}` : `Delete ${plural(k, "filter")}`;
    if (a.stale) facts.push(chip("No matching mail in a year"));
    facts.push(chip("Mail stays where it is", "c-ok"));
    if (summaries.length) body = itemList(summaries, "filter", renderFilter);
  }
  if (!body && senders.length) {
    body = itemList(senders, "sender", (li, s) => li.append(el("span", s, "sender")));
  }
  return { title, facts, body };
}

async function loadApprovals() {
  const list = $("approvals");
  const rows = await api("/api/approvals");
  list.replaceChildren();
  const pending = rows.filter((r) => r.status === "pending");
  if (!pending.length) { list.append(el("li", "No steps are waiting for you.", "meta")); return; }
  list.append(el("li", `${plural(pending.length, "step")} wait for you. Nothing changes until you approve each one.`, "meta summary"));
  const order = Object.keys(KINDS);
  const groups = new Map();
  for (const r of pending) {
    const key = KINDS[r.tool] ? r.tool : "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  const keys = [...groups.keys()].sort((x, y) => rank(x) - rank(y));
  for (const key of keys) {
    const items = groups.get(key);
    const g = KINDS[key] ? KINDS[key].group : "Other steps";
    list.append(el("li", `${g} (${items.length})`, "group-head"));
    for (const r of items) list.append(approvalCard(r));
  }
}

function approvalCard(r) {
  const kind = KINDS[r.tool] || { name: r.tool, cls: "" };
  const li = el("li", null, "card");
  const { title, facts, body } = describeStep(r);
  const top = el("div", null, "card-top");
  top.append(chip(kind.name, `kind ${kind.cls}`), el("strong", title, "card-title"));
  li.append(top);
  if (facts.length) {
    const row = el("div", null, "chips");
    row.append(...facts);
    li.append(row);
  }
  if (body) li.append(body);
  const exact = el("details");
  exact.append(el("summary", "Exact wording"), el("div", r.reason, "reason"));
  const tech = el("details");
  tech.append(el("summary", "Technical details"),
    el("pre", typeof r.args === "string" ? r.args : JSON.stringify(r.args, null, 2)));
  li.append(exact, tech, el("div", `Proposed ${when(r.created)}`, "meta"));
  const actions = el("div", null, "actions");
  const status = el("div", null, "meta");
  const decide = (approve) => async () => {
    for (const b of actions.querySelectorAll("button")) b.disabled = true;
    status.textContent = approve ? "Working on it..." : "Denying...";
    try {
      const out = await api(`/api/approvals/${r.id}`, { method: "POST", body: { approve } });
      const res = out && out.result;
      if (!approve) status.textContent = "Denied.";
      else if (res && res.error) status.textContent = `Failed: ${res.error}`;
      else if (res && typeof res.changed === "number") status.textContent = `Done. ${res.changed} messages changed.`;
      else status.textContent = "Done.";
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    }
    setTimeout(loadApprovals, 4000);
  };
  actions.append(button("Approve", decide(true), "primary"), button("Deny", decide(false), "danger"));
  li.append(status, actions);
  return li;
}

// Memory

async function loadMemory() {
  const q = $("memory-q").value.trim();
  const list = $("memory");
  const facts = await api(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  list.replaceChildren();
  if (!facts.length) list.append(el("li", "Nothing saved yet.", "meta"));
  for (const f of facts) {
    const li = el("li");
    li.append(el("strong", f.subject), el("div", f.statement), el("div", `${f.source || ""} · ${when(f.created)}`, "meta"));
    const actions = el("div", null, "actions");
    actions.append(button("Forget", async () => { await api(`/api/memory/${f.id}`, { method: "DELETE" }); loadMemory(); }, "danger"));
    li.append(actions);
    list.append(li);
  }
}

let memoryTimer = null;
$("memory-q").addEventListener("input", () => {
  clearTimeout(memoryTimer);
  memoryTimer = setTimeout(() => loadMemory().catch((err) => showError("memory", err)), 300);
});

// Log

const num = (n) => (n === null || n === undefined ? "?" : Number(n).toLocaleString());

function usageTable(rows) {
  const table = el("table", null, "usage");
  const head = el("tr");
  for (const h of ["Model", "Role", "Calls", "Tokens in", "Tokens out", "Time"]) head.append(el("th", h));
  table.append(head);
  for (const r of rows) {
    const tr = el("tr");
    tr.append(el("td", r.model), el("td", r.role), el("td", num(r.calls)), el("td", num(r.tokens_in)),
      el("td", num(r.tokens_out)), el("td", `${((r.ms || 0) / 1000).toFixed(1)}s`));
    table.append(tr);
  }
  const wrap = el("div", null, "table-wrap");
  wrap.append(table);
  return wrap;
}

function usageRows(byModel) {
  return Object.entries(byModel || {}).map(([model, m]) => ({ model, role: (m.roles || []).join(", "), ...m }));
}

function usageSummary(entries) {
  const byModel = {};
  let runs = 0;
  for (const e of entries) {
    if (e.kind !== "model-usage") continue;
    runs += 1;
    for (const [model, m] of Object.entries(e.data.by_model || {})) {
      const t = (byModel[model] ||= { calls: 0, tokens_in: 0, tokens_out: 0, ms: 0, roles: [] });
      t.calls += m.calls; t.tokens_in += m.tokens_in; t.tokens_out += m.tokens_out; t.ms += m.ms;
      for (const r of m.roles || []) if (!t.roles.includes(r)) t.roles.push(r);
    }
  }
  const box = $("log-usage");
  box.replaceChildren();
  if (!runs) return;
  box.append(el("strong", `Models used in the last ${runs} run${runs === 1 ? "" : "s"}`), usageTable(usageRows(byModel)));
}

async function loadLog() {
  const [entries, check] = await Promise.all([api("/api/log"), api("/api/log/verify")]);
  $("log-verify").textContent = check.ok
    ? `Run log intact: ${check.entries} entries, chain and signatures check out.`
    : `Run log check failed: ${check.error}`;
  const shown = entries.slice(-200);
  usageSummary(shown);
  const list = $("log");
  list.replaceChildren();
  for (const e of shown.reverse()) {
    const li = el("li");
    const { user, ...data } = e.data;
    const when = `${new Date(e.ts * 1000).toLocaleString()} · task ${e.task_id}`;
    if (e.kind === "model-usage") {
      const t = data.totals || {};
      li.append(el("strong", `model usage · ${data.run || ""} via ${data.via || ""}`), el("div", when, "meta"),
        el("div", `${num(t.calls)} calls · ${num(t.tokens_in)} tokens in · ${num(t.tokens_out)} tokens out · ${((t.ms || 0) / 1000).toFixed(1)}s`
          + (t.unmetered_calls ? ` · ${t.unmetered_calls} call(s) reported no token counts` : ""), "meta"),
        usageTable(usageRows(data.by_model)));
      const calls = el("details");
      calls.append(el("summary", "Each call"),
        usageTable((data.calls || []).map((c) => ({ ...c, calls: 1, role: c.role + (c.fallback_from ? ` (fallback from ${c.fallback_from})` : "") + (c.error ? " (failed)" : "") }))));
      li.append(calls);
    } else {
      li.append(el("strong", `${e.kind} · ${data.tool || ""}`), el("div", when, "meta"));
      li.append(el("pre", JSON.stringify(data, null, 2)));
    }
    list.append(li);
  }
}

// Pause

let paused = false;
$("pause").addEventListener("click", async () => {
  const out = await api("/api/pause", { method: "POST", body: { paused: !paused } });
  paused = out.paused;
  $("pause").textContent = paused ? "Resume agents" : "Pause agents";
});

// Boot

(async () => {
  if (!(await isUp())) { showStopped(); return; }
  if (!(await verify())) return;
  if (token) await start();
  else $("login").hidden = false;
})();
