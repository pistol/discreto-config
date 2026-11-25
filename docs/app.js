// Discreto web app.
// The enclave is verified with Tinfoil's SecureClient before the access token
// is ever sent. All API traffic then goes through client.fetch, which is bound
// to the attested enclave. Every string from the server is rendered with
// textContent, never as HTML, because card text comes from email.
import { SecureClient } from "./vendor/tinfoil-1.4.0.js?v=2"; // bundled tinfoil@1.4.0, see vendor/README
import { ENCLAVE_URL, CONFIG_REPO } from "./config.js?v=2";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "discreto_token";
let client = null;
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
}

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
  div.append(el("span", text));
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

async function loadApprovals() {
  const list = $("approvals");
  const rows = await api("/api/approvals");
  list.replaceChildren();
  const pending = rows.filter((r) => r.status === "pending");
  if (!pending.length) list.append(el("li", "No steps are waiting for you.", "meta"));
  for (const r of pending) {
    const li = el("li");
    li.append(el("strong", r.tool), el("div", r.reason));
    li.append(el("pre", typeof r.args === "string" ? r.args : JSON.stringify(r.args, null, 2)));
    li.append(el("div", when(r.created), "meta"));
    const actions = el("div", null, "actions");
    const decide = (approve) => async () => {
      await api(`/api/approvals/${r.id}`, { method: "POST", body: { approve } });
      loadApprovals();
    };
    actions.append(button("Approve", decide(true)), button("Deny", decide(false), "danger"));
    li.append(actions);
    list.append(li);
  }
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

async function loadLog() {
  const [entries, check] = await Promise.all([api("/api/log"), api("/api/log/verify")]);
  $("log-verify").textContent = check.ok
    ? `Run log intact: ${check.entries} entries, chain and signatures check out.`
    : `Run log check failed: ${check.error}`;
  const list = $("log");
  list.replaceChildren();
  for (const e of entries.slice(-200).reverse()) {
    const li = el("li");
    const { user, ...data } = e.data;
    li.append(el("strong", `${e.kind} · ${data.tool || ""}`), el("div", `${new Date(e.ts * 1000).toLocaleString()} · task ${e.task_id}`, "meta"));
    li.append(el("pre", JSON.stringify(data, null, 2)));
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
  if (!(await verify())) return;
  if (token) await start();
  else $("login").hidden = false;
})();
