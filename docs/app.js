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

const RESTARTING = "Discreto is restarting. Try again in a minute; this page reconnects by itself.";

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await client.fetch(`${ENCLAVE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    watchRestart();
    throw new Error(RESTARTING);
  }
  if (res.status === 401) {
    signOut();
    throw new Error("Your token was not accepted.");
  }
  if ([502, 503, 504].includes(res.status)) {
    watchRestart();
    throw new Error(RESTARTING);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail ? `${detail} (${res.status})` : `Request failed (${res.status})`);
  }
  return res.json();
}

// While Discreto restarts (an update, or a crash), show one banner and reconnect when it's back.
let restartWatch = null;
function watchRestart() {
  if (restartWatch) return;
  $("restart-banner").hidden = false;
  restartWatch = setInterval(async () => {
    if (!(await isUp())) return;
    clearInterval(restartWatch);
    restartWatch = null;
    $("restart-banner").hidden = true;
    loadHeader();
    checkStorage();
    const active = document.querySelector("nav button.active");
    if (active) showTab(active.dataset.tab);
  }, 5000);
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
  loadHeader();
  setInterval(() => { if (document.visibilityState === "visible") refreshBadges(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshBadges(); });
}

function since(ts) {
  const d = new Date(ts * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function duration(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
}

async function loadHeader() {
  const parts = [];
  try {
    const v = await api("/api/version");
    parts.push(`Discreto v${v.version}`, `running since ${since(v.started)}`);
  } catch {}
  try {
    const i = await api("/api/idle");
    if (i.enabled) parts.push(`stops after ${i.minutes} minutes without use`);
  } catch {}
  $("idle-note").textContent = parts.join(" · ");
  refreshBadges();
}

// Tab badges: how many approvals and cards wait, and whether Memory or Log has
// something new since you last opened it. /api/summary doesn't count as use,
// so an open tab never keeps Discreto running.
const SEEN = "discreto.seen";
let lastSummary = null;
function seen() { try { return JSON.parse(localStorage.getItem(SEEN)) || {}; } catch { return {}; } }
function markSeen(tab) {
  if (!lastSummary) return;
  const s = seen();
  if (tab === "memory") s.memory = lastSummary.last_fact;
  if (tab === "log") { s.log = lastSummary.last_log; s.failures = lastSummary.failures; }
  localStorage.setItem(SEEN, JSON.stringify(s));
  paintBadges();
}
function setCount(id, n, title) {
  const b = $(id);
  b.hidden = !n;
  if (b.classList.contains("dot")) b.textContent = "";
  else b.textContent = n > 99 ? "99+" : String(n || "");
  b.title = title || "";
}
function paintBadges() {
  const s = lastSummary;
  if (!s) return;
  const was = seen();
  setCount("count-approvals", s.approvals, `${s.approvals} waiting for you`);
  setCount("count-cards", s.cards, `${s.cards} open`);
  setCount("count-memory", s.last_fact > (was.memory || 0) ? 1 : 0, "Something new was saved");
  const fails = Math.max(0, s.failures - (was.failures || 0));
  const logBadge = $("count-log");
  logBadge.classList.toggle("info", !fails);
  setCount("count-log", fails || (s.last_log > (was.log || 0) ? "new" : 0), fails ? `${fails} failed since you last looked` : "New activity");
  document.title = s.approvals ? `(${s.approvals}) Discreto` : "Discreto";
}
async function refreshBadges() {
  try { lastSummary = await api("/api/summary"); } catch { return; }
  const active = document.querySelector("nav button.active");
  if (active && (active.dataset.tab === "memory" || active.dataset.tab === "log")) markSeen(active.dataset.tab);
  else paintBadges();
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
  clearError(name);
  if (loaders[name]) loaders[name]().then(() => markSeen(name)).catch((err) => showError(name, err));
}

function clearError(name) {
  const old = $(`tab-${name}`).querySelector(":scope > .tab-error");
  if (old) old.remove();
}

function showError(name, err) {
  clearError(name);
  $(`tab-${name}`).prepend(el("p", err.message, "tab-error"));
}

document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// Chat

// The conversation stays in this browser tab (sessionStorage) until New chat.
const CHAT_KEY = "discreto.chat";
let chatLog = [];
try { ({ taskId = null, chatLog = [] } = JSON.parse(sessionStorage.getItem(CHAT_KEY)) || {}); } catch {}
const saveChat = () => sessionStorage.setItem(CHAT_KEY, JSON.stringify({ taskId, chatLog: chatLog.slice(-100) }));

const SUGGESTIONS = ["What's waiting for my approval?", "Summarize today's mail", "What needs me this week?",
  "Which subscriptions do I never open?", "What did Discreto change in my Gmail today?"];

function addMessage(who, text, { save = true, ts = Date.now() / 1000, cls = "", approvals = 0 } = {}) {
  const div = el("div", null, `msg ${who}${cls ? " " + cls : ""}`);
  div.append(who === "assistant" ? renderMarkdown(text) : el("span", text));
  if (approvals) {
    div.append(button(`Open Approvals (${approvals} waiting)`, () => showTab("approvals"), "link"));
  }
  div.append(el("div", since(ts), "when"));
  $("messages").append(div);
  div.scrollIntoView({ block: "end" });
  if (save) { chatLog.push({ who, text, ts, cls, approvals }); saveChat(); }
}

function setThinking(on) {
  $("thinking").hidden = !on;
  $("chat-send").disabled = on;
  if (!on) return;
  const t0 = Date.now();
  const tick = () => {
    if ($("thinking").hidden) return;
    const s = Math.round((Date.now() - t0) / 1000);
    $("thinking-text").textContent = s < 4 ? "Thinking..." : `Working on it, ${s}s (reading mail can take a while)`;
    setTimeout(tick, 1000);
  };
  tick();
}

async function sendChat(message) {
  addMessage("user", message);
  setThinking(true);
  try {
    const out = await api("/api/chat", { method: "POST", body: { message, task_id: taskId } });
    taskId = out.task_id;
    const n = (out.pending_approvals || []).length;
    addMessage("assistant", out.reply || "(no reply)", { approvals: n });
    if (n) refreshBadges();
  } catch (err) {
    addMessage("assistant", err.message, { cls: "error" });
  } finally {
    setThinking(false);
    saveChat();
  }
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message || $("chat-send").disabled) return;
  input.value = "";
  sendChat(message);
});

$("chat-new").addEventListener("click", () => {
  taskId = null;
  chatLog = [];
  saveChat();
  $("messages").replaceChildren();
  $("chat-input").focus();
});

for (const q of SUGGESTIONS) $("suggestions").append(button(q, () => sendChat(q)));
for (const m of chatLog) addMessage(m.who, m.text, { save: false, ts: m.ts, cls: m.cls, approvals: m.approvals });

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
    const li = el("li", null, "card");
    const top = el("div", null, "card-top");
    if (c.action) top.append(chip(c.action, "kind k-label"));
    top.append(el("strong", c.title, "card-title"));
    li.append(top, el("div", c.body), el("div", `From new mail · ${since(c.created)}`, "meta"));
    const actions = el("div", null, "actions");
    const set = (status, label) => async (ev) => {
      for (const b of actions.querySelectorAll("button")) b.disabled = true;
      ev.target.textContent = label;
      try { await api(`/api/cards/${c.id}`, { method: "POST", body: { status } }); } catch (err) { showError("cards", err); }
      loadCards();
      refreshBadges();
    };
    const handled = button("Handled", set("done", "Marked handled"), "primary");
    handled.title = "You've dealt with it. The card goes away.";
    const hide = button("Hide", set("dismissed", "Hidden"));
    hide.title = "Clear it without doing anything.";
    const nope = button("Not useful", set("not_useful", "Noted"));
    nope.title = "Discreto remembers this and learns to skip mail like it.";
    actions.append(handled, hide, nope);
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
    showError("cards", err);
    b.textContent = "Check mail now";
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
    facts.push(chip("Label: Discreto", "c-strong"));
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
    const head = el("li", null, "group-head");
    head.append(el("span", `${g} (${items.length})`));
    const cards = items.map((r) => approvalCard(r));
    if (items.length > 1) head.append(approveAllButton(cards, items.length));
    list.append(head, ...cards);
  }
}

// One tap arms it, a second tap within five seconds runs each step in turn.
function approveAllButton(cards, n) {
  let armed = false;
  let timer = null;
  const b = button(`Approve all ${n}`, async () => {
    if (!armed) {
      armed = true;
      b.textContent = `Tap again to approve all ${n}`;
      timer = setTimeout(() => { armed = false; b.textContent = `Approve all ${n}`; }, 5000);
      return;
    }
    clearTimeout(timer);
    b.disabled = true;
    const todo = cards.filter((c) => c.approve);
    for (let i = 0; i < todo.length; i++) {
      b.textContent = `Approving ${i + 1} of ${todo.length}...`;
      const ok = await todo[i].approve();
      if (!ok) { b.textContent = `Stopped at ${i + 1} of ${todo.length}: it failed`; return; }
    }
    b.textContent = `All ${todo.length} approved`;
    setTimeout(loadApprovals, 3000);
  }, "primary");
  return b;
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
  const status = el("div", null, "step-status");
  status.hidden = true;
  const approveBtn = button("Approve", () => decide(true), "primary");
  const denyBtn = button("Deny", () => decide(false), "danger");
  actions.append(approveBtn, denyBtn);
  // Returns true when the step ran (or was denied) without an error.
  const decide = async (approve) => {
    actions.hidden = true;
    li.classList.add("working");
    status.hidden = false;
    status.className = "step-status";
    status.replaceChildren(el("span", null, "spinner"),
      el("span", approve ? " Approved. Making the change in Gmail, big steps can take a minute..." : " Denying..."));
    let ok = true;
    try {
      const out = await api(`/api/approvals/${r.id}`, { method: "POST", body: { approve } });
      const res = out && out.result;
      if (!approve) status.textContent = "Denied. Nothing changed.";
      else if (res && res.error) { ok = false; status.textContent = `Failed: ${res.error}`; }
      else status.textContent = `Done. ${resultWords(r.tool, res)}`;
    } catch (err) {
      ok = false;
      status.textContent = `Failed: ${err.message}`;
    }
    li.classList.remove("working");
    li.classList.add(ok ? "done" : "failed");
    status.classList.add(ok ? "ok" : "bad");
    if (!ok) { actions.hidden = false; approveBtn.textContent = "Try again"; }
    else delete li.approve;
    refreshBadges();
    return ok;
  };
  li.approve = () => decide(true);
  li.append(status, actions);
  return li;
}

function resultWords(tool, res) {
  if (!res || typeof res !== "object") return "";
  const n = (x) => Number(x).toLocaleString();
  const bits = [];
  if (typeof res.changed === "number") bits.push(`${n(res.changed)} messages changed`);
  if (res.left_inbox) bits.push(`${n(res.left_inbox)} left the inbox`);
  if (res.unstarred) bits.push(`${n(res.unstarred)} unstarred`);
  if (typeof res.deleted === "number") bits.push(`${n(res.deleted)} filters deleted`);
  if (res.filter_id && tool === "gmail.filter") bits.push("filter created");
  if (res.more_left) bits.push("more matched than one step covers, so another step is needed");
  return bits.length ? bits.join(", ") + "." : "";
}

// Memory

async function loadMemory() {
  const q = $("memory-q").value.trim();
  const list = $("memory");
  const facts = await api(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  list.replaceChildren();
  if (!facts.length) list.append(el("li", q ? "Nothing matches." : "Nothing saved yet. Tell Discreto a preference in Chat, or add one above.", "meta"));
  const from = { you: "Added by you", card: "From card feedback", agent: "Learned in chat" };
  for (const f of facts) {
    const li = el("li");
    li.append(el("div", f.statement), el("div", `${from[f.source] || f.source || "Learned in chat"} · ${since(f.created)}`, "meta"));
    const actions = el("div", null, "actions");
    actions.append(button("Forget", async () => { await api(`/api/memory/${f.id}`, { method: "DELETE" }); loadMemory(); }, "danger"));
    li.append(actions);
    list.append(li);
  }
}

$("memory-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statement = $("memory-new").value.trim();
  if (!statement) return;
  try {
    await api("/api/memory", { method: "POST", body: { subject: "note", statement } });
    $("memory-new").value = "";
    await loadMemory();
    refreshBadges();
  } catch (err) { showError("memory", err); }
});

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

const TOOL_WORDS = {
  "mail.search": "read recent mail", "mail.read": "read a message", "mail.stats": "measured the mailbox",
  "mail.scan": "scanned the mailbox", "gmail.count": "counted matching mail", "gmail.filters": "listed Gmail filters",
  "gmail.archive": "archive", "gmail.label": "label mail", "gmail.filter": "new filter", "gmail.trash": "move to Trash",
  "gmail.filter_delete": "delete filters", "gmail.apply_filter": "apply a filter to past mail",
  "approvals.list": "checked what waits for you", "memory.read": "looked up memory", "memory.write": "saved to memory",
  "cards.create": "made a card", "calendar.list": "read the calendar",
};
const toolWords = (t) => TOOL_WORDS[t] || t || "";
const first = (text, n = 220) => (text && text.length > n ? text.slice(0, n - 1) + "..." : text || "");
function parsePreview(p) { try { return JSON.parse(p); } catch { return null; } }

// One plain sentence per entry; the raw entry stays one tap away.
function logLine(e) {
  const d = e.data || {};
  switch (e.kind) {
    case "proposal":
      if (d.verdict === "ask") return { text: `Proposed for your approval: ${first(d.summary || toolWords(d.tool))}`, show: true };
      if (d.verdict === "deny") return { text: `Blocked by policy: ${toolWords(d.tool)} (${d.reason})`, show: true, bad: true };
      return { text: `Agent ${toolWords(d.tool)}`, show: false };
    case "approval":
      return { text: `You ${d.approved ? "approved" : "denied"}: ${first(d.summary || toolWords(d.tool))}`, show: true };
    case "result": {
      const r = parsePreview(d.preview);
      const err = r && r.error;
      if (err) return { text: `Failed, ${toolWords(d.tool)}: ${first(String(err))}`, show: true, bad: true };
      if (String(d.tool || "").startsWith("gmail.") && !["gmail.count", "gmail.filters"].includes(d.tool)) {
        return { text: `Done, ${toolWords(d.tool)}. ${resultWords(d.tool, r)}`, show: true };
      }
      return { text: `Agent ${toolWords(d.tool)}`, show: false };
    }
    case "model-usage": {
      const t = d.totals || {};
      return { text: `${d.run === "/triage" ? "Inbox check" : "Chat"} via ${d.via || "?"}: ${num(t.calls)} model calls, ${((t.ms || 0) / 1000).toFixed(1)}s`, show: true, usage: true };
    }
    case "mail-scan": return { text: `Mailbox scan ${d.event}${d.error ? `: ${first(d.error)}` : ""}`, show: true, bad: !!d.error };
    case "storage": return { text: `Storage ${d.event}${d.error ? `: ${first(d.error)}` : ""}`, show: true, bad: !!d.error };
    case "idle": return { text: `Idle stop: ${d.event}${d.idle_minutes ? ` after ${d.idle_minutes} minutes` : ""}${d.error ? `: ${first(d.error)}` : ""}`, show: true, bad: !!d.error };
    case "pause": return { text: d.paused ? "Agents paused" : "Agents resumed", show: true };
    case "google": return { text: `Gmail: ${d.event}`, show: true, bad: /failed/.test(d.event || "") };
    case "gmail-log": return { text: `Couldn't write the Gmail log entry: ${first(d.error)}`, show: true, bad: true };
    case "mcp":
      if (d.event) return { text: `Claude connector: ${d.event}`, show: true };
      return { text: `Claude used ${d.tool}`, show: false };
    default: return { text: `${e.kind} ${d.tool || d.event || ""}`, show: false };
  }
}

async function loadRuns() {
  const box = $("log-runs");
  box.replaceChildren();
  let out;
  try { out = await api("/api/instances"); } catch { return; }
  const rows = out.instances || [];
  if (!rows.length) return;
  box.append(el("strong", "Discreto runs"));
  const table = el("table");
  const head = el("tr");
  for (const h of ["Version", "Started", "Ran for", "Ended"]) head.append(el("th", h));
  table.append(head);
  for (const r of rows.slice(0, 15)) {
    const tr = el("tr");
    const now = r.id === out.current;
    tr.append(el("td", `v${r.version}`), el("td", since(r.started)), el("td", duration(r.last_seen - r.started)),
      el("td", now ? "running now" : (r.ended || `last seen ${since(r.last_seen)}`), now ? "now" : ""));
    table.append(tr);
  }
  const wrap = el("div", null, "table-wrap");
  wrap.append(table);
  box.append(wrap);
  if (rows.some((r) => !r.ended && r.id !== out.current)) {
    box.append(el("div", "Runs with no end were stopped by an update or a restart; the time is up to their last check-in.", "meta"));
  }
}

async function loadLog() {
  const [entries, check] = await Promise.all([api("/api/log"), api("/api/log/verify")]);
  $("log-verify").textContent = check.ok
    ? `Run log intact: ${check.entries} entries since this run started, chain and signatures check out.`
    : `Run log check failed: ${check.error}`;
  loadRuns();
  const shown = entries.slice(-300);
  usageSummary(shown);
  const all = $("log-all").checked;
  const list = $("log");
  list.replaceChildren();
  let hidden = 0;
  for (const e of shown.reverse()) {
    const line = logLine(e);
    if (!line.show && !all) { hidden += 1; continue; }
    const li = el("li", null, line.bad ? "bad" : "");
    li.append(el("div", line.text, "line"), el("div", since(e.ts), "meta"));
    const { user, ...data } = e.data;
    const det = el("details");
    det.append(el("summary", "Details"));
    if (e.kind === "model-usage") {
      det.append(usageTable(usageRows(data.by_model)));
      det.append(usageTable((data.calls || []).map((c) => ({ ...c, calls: 1, role: c.role + (c.fallback_from ? ` (fallback from ${c.fallback_from})` : "") + (c.error ? " (failed)" : "") }))));
    } else {
      det.append(el("pre", JSON.stringify({ kind: e.kind, task: e.task_id, ...data }, null, 2)));
    }
    li.append(det);
    list.append(li);
  }
  if (hidden) list.append(el("li", `${hidden} routine agent steps hidden. Tick "Show every entry" to see them.`, "meta"));
}

$("log-all").addEventListener("change", () => loadLog().catch((err) => showError("log", err)));

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
