// Discreto web app.
// The enclave is verified with Tinfoil's SecureClient before the access token
// is ever sent. All API traffic then goes through client.fetch, which is bound
// to the attested enclave. Every string from the server is rendered with
// textContent, never as HTML, because card text comes from email. Chat replies
// go through renderMarkdown, which builds DOM nodes the same way.
import { SecureClient } from "./vendor/tinfoil-1.4.0.js?v=3"; // bundled tinfoil@1.4.0, see vendor/README
import { ENCLAVE_URL, CONFIG_REPO, START_REPO, START_WORKFLOW } from "./config.js?v=4";
import { renderMarkdown } from "./markdown.js?v=3";
import { hasVault, createVault, openVault, forgetVault, passkeysAvailable } from "./passkey.js?v=2";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "discreto_token";
let client = null;
const STORAGE_KEY = "discreto.storageKey";
// Secrets opened with Touch ID stay in memory for this page only.
let storageKeyMem = null;
let githubMem = null;
let vaultUpdate = null;
const GITHUB_KEY = "discreto.githubToken";
let token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);

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

let verifyDoc = null, verifyError = "", runInfo = null;

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
    verifyDoc = doc;
    paintVerify("ok");
    return true;
  } catch (err) {
    let detail = String(err && err.message ? err.message : err);
    try {
      if (client) detail += "\n" + JSON.stringify(await client.getVerificationDocument(), null, 2);
    } catch {}
    badge.textContent = "Not verified";
    badge.className = "badge bad";
    try { verifyDoc = client ? await client.getVerificationDocument() : null; } catch { verifyDoc = null; }
    verifyError = String(err && err.message ? err.message : err);
    paintVerify("bad");
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
  $("topbar").hidden = false;
  $("idle-note").hidden = false;
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
  // In the app the shield and pause live in the rail, so the page starts at the top.
  $("topbar").hidden = true;
  $("idle-note").hidden = true;
  // Unlock first: until then the enclave answers from an empty in-memory
  // database, so a tab loaded earlier shows nothing.
  await checkStorage();
  showTab(tabFromHash());
  offerPasskey();
  loadHeader();
  loadModels();
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
  runInfo = {};
  try {
    const v = await api("/api/version");
    runInfo.version = v.version;
    runInfo.started = v.started;
    parts.push(`Discreto v${v.version}`, `running since ${since(v.started)}`);
  } catch {}
  try {
    const i = await api("/api/idle");
    if (i.enabled) { runInfo.idleMinutes = i.minutes; parts.push(`stops after ${i.minutes} minutes without use`); }
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
  setCount("count-chat", s.decisions || 0, `${s.decisions} decisions wait on you`);
  setCount("count-cards", s.cards, `${s.cards} open`);
  setCount("count-memory", s.last_fact > (was.memory || 0) ? 1 : 0, "Something new was saved");
  const fails = Math.max(0, s.failures - (was.failures || 0));
  const logBadge = $("count-log");
  logBadge.classList.toggle("info", !fails);
  setCount("count-log", fails || (s.last_log > (was.log || 0) ? "new" : 0), fails ? `${fails} failed since you last looked` : "New activity");
  const waiting = (s.approvals || 0) + (s.decisions || 0);
  document.title = waiting ? `(${waiting}) Discreto` : "Discreto";
}
async function refreshBadges() {
  try { lastSummary = await api("/api/summary"); } catch { return; }
  if (typeof lastSummary.paused === "boolean") paintPause(lastSummary.paused);
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
  $("gh-token").hidden = Boolean(localStorage.getItem(GITHUB_KEY)) || hasVault();
  $("stopped").hidden = false;
}

$("start-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("stopped-msg");
  const btn = $("start-btn");
  let gh = localStorage.getItem(GITHUB_KEY) || githubMem || $("gh-token").value.trim();
  if (!gh && hasVault()) {
    try {
      const v = await openVault();
      vaultUpdate = v.update;
      githubMem = gh = v.secrets.githubToken || "";
    } catch (err) { msg.textContent = `Touch ID didn't open the saved keys: ${err.message}`; return; }
    if (!gh) { $("gh-token").hidden = false; msg.textContent = "No GitHub token is saved with Touch ID yet. Enter one once."; return; }
  }
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
      githubMem = null;
      $("gh-token").hidden = false;
    }
    msg.textContent = res.status === 404
      ? `GitHub can't see ${START_REPO} with this token (404). ${START_REPO} is private, so the token's Repository access must include it, with Actions set to Read and write.`
      : res.status === 401
        ? "GitHub didn't accept this token (401). It may be mistyped, expired or revoked."
        : `GitHub didn't start it (${res.status}). Check that the token has Actions read and write on ${START_REPO}.`;
    btn.disabled = false;
    return;
  }
  if (hasVault()) {
    githubMem = gh;
    // A token typed before Touch ID opened the vault used to stay in memory only.
    // Open it now so the token is saved and the next Start needs no typing.
    msg.textContent = "Started. Touch ID saves the GitHub token on this device...";
    try {
      if (!vaultUpdate) vaultUpdate = (await openVault()).update;
      await vaultUpdate({ githubToken: gh });
    } catch (err) {
      showToast(`Started, but the GitHub token wasn't saved with Touch ID: ${err.message}`);
    }
  } else {
    localStorage.setItem(GITHUB_KEY, gh);
  }
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


let lastKeyChecked = true;
async function unlockStorage(key, initialize) {
  const msg = $("storage-msg");
  msg.textContent = initialize ? "Setting up storage..." : "Unlocking...";
  try {
    const res = await api("/api/storage/unlock", { method: "POST", body: { key, initialize } });
    $("storage").hidden = true;
    // Only a key the volume itself accepted gets saved as the working key.
    lastKeyChecked = !(res && res.verified === false);
    if (!lastKeyChecked) { showToast("Storage was already open, so this key wasn't checked or saved."); return true; }
    storageKeyMem = key;
    if (vaultUpdate) vaultUpdate({ storageKey: key }).catch(() => {});
    return true;
  } catch (err) {
    msg.textContent = `Couldn't unlock: ${err.message}`;
    return false;
  }
}

function reloadActive() {
  const active = document.querySelector("nav button.active");
  if (active) showTab(active.dataset.tab);
}

async function checkStorage() {
  let state;
  try { state = (await api("/api/storage")).state; } catch { return; }
  if (state !== "locked") { $("storage").hidden = true; return; }
  const saved = storageKeyMem || localStorage.getItem(STORAGE_KEY);
  if (saved) {
    if (await unlockStorage(saved, false)) return;
    storageKeyMem = null;
    $("storage-msg").textContent = "The saved storage key didn't unlock the volume. Enter the key once; it replaces the saved one.";
  }
  $("storage-passkey").hidden = !hasVault();
  $("storage-show").hidden = !hasVault() && !localStorage.getItem(STORAGE_KEY);
  $("storage").hidden = false;
}

$("storage-passkey").addEventListener("click", async () => {
  try {
    const v = await openVault();
    vaultUpdate = v.update;
    githubMem = githubMem || v.secrets.githubToken || null;
    if (!v.secrets.storageKey) { $("storage-msg").textContent = "No storage key is saved with Touch ID yet. Enter it once below."; return; }
    if (await unlockStorage(v.secrets.storageKey, false)) reloadActive();
  } catch (err) {
    $("storage-msg").textContent = `Touch ID didn't open the saved keys: ${err.message}`;
  }
});

// Show the storage key saved with Touch ID, so it can be checked or backed up.
let revealTimer = null;
function hideKey() {
  $("storage-shown").textContent = "";
  $("storage-shown-info").textContent = "";
  $("storage-reveal").hidden = true;
  clearTimeout(revealTimer);
}
$("storage-show").addEventListener("click", async () => {
  try {
    // A plain copy from "Remember on this device" (before Touch ID) counts too.
    let key = localStorage.getItem(STORAGE_KEY), where = "remembered on this device";
    if (hasVault()) {
      const v = await openVault();
      vaultUpdate = v.update;
      if (v.secrets.storageKey) { key = v.secrets.storageKey; where = "saved with Touch ID"; }
    }
    if (!key) { $("storage-msg").textContent = "No storage key is saved on this device."; return; }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
    const fp = Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
    let bytes = "not valid base64";
    try { bytes = `${atob(key).length} bytes`; } catch {}
    $("storage-shown").textContent = key;
    $("storage-shown-info").textContent = `Key ${where}: ${key.length} characters, ${bytes}, fingerprint ${fp}. Hidden again in 60 seconds.`;
    $("storage-reveal").hidden = false;
    clearTimeout(revealTimer);
    revealTimer = setTimeout(hideKey, 60000);
  } catch (err) {
    $("storage-msg").textContent = `Touch ID didn't open the saved keys: ${err.message}`;
  }
});
$("storage-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("storage-shown").textContent); showToast("Copied."); }
  catch { showToast("Couldn't copy; select the key and copy it by hand."); }
});
$("storage-hide").addEventListener("click", hideKey);

$("storage-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("storage-key").value.trim();
  if (!key) return;
  if (await unlockStorage(key, false)) {
    if (lastKeyChecked && $("storage-remember").checked && !hasVault()) localStorage.setItem(STORAGE_KEY, key);
    // With a Touch ID vault, a key that works replaces the saved one.
    if (lastKeyChecked && hasVault() && !vaultUpdate) {
      try { vaultUpdate = (await openVault()).update; await vaultUpdate({ storageKey: key }); }
      catch (err) { showToast(`Unlocked, but the key wasn't saved with Touch ID: ${err.message}`); }
    }
    $("storage-key").value = "";
    reloadActive();
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
    if (lastKeyChecked && $("storage-remember").checked && !hasVault()) localStorage.setItem(STORAGE_KEY, key);
    $("storage-newkey").textContent = "";
    $("storage-create").hidden = true;
    reloadActive();
  }
});

// Touch ID / Face ID sign-in

$("login-passkey").addEventListener("click", async () => {
  try {
    const v = await openVault();
    vaultUpdate = v.update;
    token = v.secrets.token;
    // Kept for this tab only, so a reload doesn't ask for Touch ID again.
    sessionStorage.setItem(TOKEN_KEY, token);
    storageKeyMem = v.secrets.storageKey || null;
    githubMem = v.secrets.githubToken || null;
  } catch (err) {
    alertLine(`Touch ID didn't open the saved keys: ${err.message}`);
    return;
  }
  await start();
});

$("login-forget").addEventListener("click", () => {
  forgetVault();
  $("login-passkey-box").hidden = true;
});

async function offerPasskey() {
  const box = $("passkey-offer");
  if (hasVault() || localStorage.getItem("discreto.passkeyDeclined") || !(await passkeysAvailable())) return;
  box.hidden = false;
}

$("passkey-save").addEventListener("click", async () => {
  const msg = $("passkey-msg");
  msg.textContent = "Follow the Touch ID prompt...";
  try {
    await createVault({
      token,
      storageKey: storageKeyMem || localStorage.getItem(STORAGE_KEY),
      githubToken: githubMem || localStorage.getItem(GITHUB_KEY),
    });
  } catch (err) {
    msg.textContent = `Not saved: ${err.message}`;
    return;
  }
  const v = await openVault().catch(() => null);
  if (v) vaultUpdate = v.update;
  // Plain copies go away; from now on the keys come out only with Touch ID.
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(GITHUB_KEY);
  sessionStorage.setItem(TOKEN_KEY, token);
  $("passkey-offer").hidden = true;
  showToast("Saved. Next time, sign in with Touch ID.");
});

$("passkey-later").addEventListener("click", () => {
  localStorage.setItem("discreto.passkeyDeclined", "1");
  $("passkey-offer").hidden = true;
});

function showToast(text) {
  const p = el("p", text, "meta toast");
  $("app").prepend(p);
  setTimeout(() => p.remove(), 6000);
}

function alertLine(text) {
  const p = el("p", text, "meta");
  $("login").prepend(p);
  setTimeout(() => p.remove(), 6000);
}

// Tabs

const loaders = { cards: loadCards, approvals: loadApprovals, memory: loadMemory, log: loadLog };

const TABS = ["chat", "cards", "approvals", "memory", "log"];
const tabFromHash = () => { const h = location.hash.slice(1); return TABS.includes(h) ? h : "chat"; };

// The open tab lives in the address (#approvals), so a reload or a shared link opens the same tab.
function showTab(name) {
  if (location.hash.slice(1) !== name) history.replaceState(null, "", name === "chat" ? location.pathname + location.search : `#${name}`);
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
window.addEventListener("hashchange", () => { if (!$("app").hidden) showTab(tabFromHash()); });

// Chat

// Conversations are saved by Discreto on its encrypted volume, never in this
// browser. The tab only remembers which one is open. A conversation opened from
// a decision carries that decision with it, so Discreto answers about it.
const CHAT_KEY = "discreto.chat";
let chatId = null;     // the open conversation, once its first message is sent
let chatAbout = null;  // a decision a new conversation will be about: { id, text }
let chatTitle = "";
let chatList = [];
try {
  const kept = JSON.parse(sessionStorage.getItem(CHAT_KEY)) || {};
  chatId = typeof kept.chatId === "string" ? kept.chatId : null;
} catch {}
const saveChat = () => {
  try { sessionStorage.setItem(CHAT_KEY, JSON.stringify({ chatId })); } catch {}
};
saveChat(); // drops the messages older versions kept here

const SUGGESTIONS = ["What's waiting for my approval?", "Summarize today's mail", "What needs me this week?",
  "Which subscriptions do I never open?"];

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
const ICON_SHUFFLE = ["M16 3h5v5", "M4 20L21 3", "M21 16v5h-5", "M15 15l6 6", "M4 4l5 5"];
const ICON_CHECK = ["M4 4h16v16H4z", "M8 12l3 3 5-6"];
const ICON_CHEV_DOWN = ["M6 9l6 6 6-6"];
const ICON_CHEV_RIGHT = ["M9 6l6 6-6 6"];

function greet() {
  const h = new Date().getHours();
  $("greeting").textContent = h < 5 ? "Good evening!" : h < 12 ? "Good morning!" : h < 18 ? "Good afternoon!" : "Good evening!";
}

// Model picker, after Tinfoil Chat's: Auto with an intelligence slider, the
// main models, an effort setting, and the rest under Other models. Context
// size and price come from Discreto's model list.
const MODEL_KEY = "discreto.model";
let offer = null;   // { default, auto_levels, models }
let pick = (() => { try { return JSON.parse(localStorage.getItem(MODEL_KEY)) || {}; } catch { return {}; } })();
let showOther = false;
let showEffort = false;

function fmtContext(n) { return n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1000)}K`; }
function fmtPrice(n) { return `$${n.toFixed(2)}`; }
function fmtCost(n) { return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; }
function fmtTokens(n) { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : `${n}`; }
const modelById = (id) => (offer?.models || []).find((m) => m.id === id);
const EFFORT_WORDS = { none: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

function currentPick() {
  if (!offer) return { model: null, effort: null };
  const ids = offer.models.map((m) => m.id);
  let model = pick.model === "auto" && offer.auto_levels.length ? "auto" : ids.includes(pick.model) ? pick.model : offer.default;
  let effort = pick.effort ?? null;
  if (model === "auto") {
    const lv = offer.auto_levels.map((l) => l.id);
    if (!lv.includes(effort)) effort = lv.includes("high") ? "high" : lv[0];
  } else if (!(modelById(model)?.effort || []).includes(effort)) effort = null;
  return { model, effort };
}

function setPick(next) {
  pick = { ...currentPick(), ...next };
  localStorage.setItem(MODEL_KEY, JSON.stringify(pick));
  renderTrigger();
  renderModelMenu();
}

function renderTrigger() {
  const { model, effort } = currentPick();
  let label = "Model";
  if (model === "auto") label = `Auto · ${offer.auto_levels.find((l) => l.id === effort)?.label || ""}`;
  else if (model) label = (modelById(model)?.label || model) + (effort ? ` · ${EFFORT_WORDS[effort] || effort}` : "");
  $("model-trigger-label").textContent = label;
}

function modelIcon(m) {
  const span = el("span", (m.label || m.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase(), "m-icon");
  span.dataset.hue = String([...m.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 6);
  return span;
}

function menuRow(content, { selected = false, onPick, cls = "" } = {}) {
  const b = el("button", null, `m-row${selected ? " selected" : ""}${cls ? " " + cls : ""}`);
  b.type = "button";
  b.setAttribute("role", "menuitemradio");
  b.setAttribute("aria-checked", String(selected));
  b.append(...content);
  if (selected) b.append(icon(ICON_CHECK));
  b.addEventListener("click", (e) => { e.stopPropagation(); onPick(); });
  return b;
}

function modelRow(m, selected) {
  const text = el("span", null, "m-text");
  text.append(el("span", m.label, "m-label"));
  if (selected && m.description) text.append(el("span", m.description, "m-desc"));
  text.append(el("span", `${fmtContext(m.context)} context · ${fmtPrice(m.price_in)} / ${fmtPrice(m.price_out)} per 1M tokens`, "m-meta"));
  if (m.experimental) text.append(el("span", "Experimental", "m-badge"));
  // Runs outside Tinfoil: say where, and what protects the mail.
  if (m.provider && m.provider !== "tinfoil") {
    text.append(el("span", `${m.provider === "venice" ? "Venice" : m.provider}${m.privacy ? ` · ${m.privacy}` : ""}`, "m-badge"));
  }
  if (m.caveat) text.append(el("span", m.caveat, "m-badge m-warn"));
  return menuRow([modelIcon(m), text], { selected, onPick: () => { setPick({ model: m.id, effort: null }); closeModelMenu(); } });
}

function renderModelMenu() {
  const menu = $("model-menu");
  if (!offer) { menu.replaceChildren(el("p", "Loading models...", "m-note")); return; }
  const { model, effort } = currentPick();
  const parts = [];
  if (offer.auto_levels.length) {
    const auto = el("span", null, "m-text");
    auto.append(el("span", "Auto", "m-label"));
    parts.push(menuRow([icon(ICON_SHUFFLE), auto], { selected: model === "auto", onPick: () => setPick({ model: "auto", effort: null }) }));
    if (model === "auto") {
      const lv = offer.auto_levels;
      const i = Math.max(0, lv.findIndex((l) => l.id === effort));
      const box = el("div", null, "m-intel");
      const head = el("div", null, "m-intel-head");
      head.append(el("span", "Intelligence"), el("span", lv[i].label, "m-muted"));
      const track = el("div", null, "stepper");
      track.setAttribute("role", "slider");
      track.setAttribute("aria-label", "Auto intelligence");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", String(lv.length - 1));
      track.setAttribute("aria-valuenow", String(i));
      track.setAttribute("aria-valuetext", lv[i].label);
      track.tabIndex = 0;
      track.style.setProperty("--fill", `${((i + 0.5) / lv.length) * 100}%`);
      lv.forEach((l, n) => {
        const stop = el("button", null, `stop${n === i ? " on" : ""}${n < i ? " under" : ""}`);
        stop.type = "button";
        stop.title = l.label;
        stop.addEventListener("click", (e) => { e.stopPropagation(); setPick({ model: "auto", effort: l.id }); });
        track.append(stop);
      });
      track.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const n = Math.min(lv.length - 1, Math.max(0, i + d));
        setPick({ model: "auto", effort: lv[n].id });
        $("model-menu").querySelector(".stepper")?.focus();
      });
      box.append(head, track, el("p", "Higher intelligence picks a more capable model and thinks longer. Tinfoil picks the model for each step, and the reply says which one ran.", "m-note"));
      parts.push(box);
    }
    parts.push(el("div", null, "m-div"));
  }
  const top = offer.models.filter((m) => !m.other || m.id === model);
  const other = offer.models.filter((m) => m.other && m.id !== model);
  for (const m of top) parts.push(modelRow(m, m.id === model));
  const cur = model !== "auto" ? modelById(model) : null;
  if (cur && cur.effort.length) {
    parts.push(el("div", null, "m-div"));
    const row = el("button", null, "m-row m-effort");
    row.type = "button";
    row.setAttribute("aria-expanded", String(showEffort));
    const side = el("span", null, "m-side");
    side.append(el("span", effort ? (EFFORT_WORDS[effort] || effort) : "Default", "m-muted"), icon(showEffort ? ICON_CHEV_DOWN : ICON_CHEV_RIGHT));
    row.append(el("span", "Thinking effort", "m-label grow"), side);
    row.addEventListener("click", (e) => { e.stopPropagation(); showEffort = !showEffort; renderModelMenu(); });
    parts.push(row);
    if (showEffort) {
      const list = el("div", null, "m-effort-list");
      list.append(menuRow([el("span", "Default", "m-label"), el("span", "the model's own", "m-muted")], { selected: !effort, onPick: () => setPick({ effort: null }) }));
      for (const e of cur.effort) list.append(menuRow([el("span", EFFORT_WORDS[e] || e, "m-label")], { selected: effort === e, onPick: () => setPick({ effort: e }) }));
      list.append(el("p", "Higher effort means more thorough answers, but takes longer and costs more.", "m-note"));
      parts.push(list);
    }
  }
  if (other.length) {
    parts.push(el("div", null, "m-div"));
    const row = el("button", null, "m-row");
    row.type = "button";
    row.setAttribute("aria-expanded", String(showOther));
    row.append(el("span", "Other models", "m-label grow"), icon(showOther ? ["M6 15l6-6 6 6"] : ICON_CHEV_DOWN));
    row.addEventListener("click", (e) => { e.stopPropagation(); showOther = !showOther; renderModelMenu(); });
    parts.push(row);
    if (showOther) for (const m of other) parts.push(modelRow(m, false));
  }
  menu.replaceChildren(...parts);
  placeModelMenu();
}

function openModelMenu() {
  renderModelMenu();
  const menu = $("model-menu");
  menu.hidden = false;
  $("model-trigger").setAttribute("aria-expanded", "true");
  placeModelMenu();
}
// Open toward whichever side of the trigger has more room, like Tinfoil Chat's menu.
function placeModelMenu() {
  const menu = $("model-menu");
  if (menu.hidden) return;
  const r = $("model-trigger").getBoundingClientRect();
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const above = r.top - 20, below = vh - r.bottom - 20;
  const up = below < Math.min(menu.scrollHeight, 480) && above > below;
  menu.classList.toggle("up", up);
  menu.style.maxHeight = `${Math.max(160, Math.min(up ? above : below, vh * 0.7))}px`;
}
window.addEventListener("resize", placeModelMenu);
function closeModelMenu() {
  $("model-menu").hidden = true;
  showEffort = false;
  $("model-trigger").setAttribute("aria-expanded", "false");
}
$("model-trigger").addEventListener("click", (e) => {
  e.stopPropagation();
  $("model-menu").hidden ? openModelMenu() : closeModelMenu();
});
$("model-menu").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => { if (!$("model-menu").hidden) closeModelMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("model-menu").hidden) closeModelMenu(); });

async function loadModels() {
  try {
    offer = await api("/api/models");
  } catch {
    offer = null;
    $("model-trigger-label").textContent = "Default model";
    return;
  }
  renderTrigger();
}

// What one reply used: the model or models that ran, tokens, list-price cost and time.
function usageLine(u) {
  if (!u) return "";
  const parts = [];
  if (u.models?.length) parts.push(u.models.join(", "));
  if (u.tokens_in != null) parts.push(`${fmtTokens(u.tokens_in)} in / ${fmtTokens(u.tokens_out || 0)} out`);
  if (u.cost != null) parts.push(fmtCost(u.cost));
  if (u.ms) parts.push(`${(u.ms / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

function addMessage(who, text, { ts = Date.now() / 1000, cls = "", approvals = 0, usage = null, thinking = "" } = {}) {
  const div = el("div", null, `msg ${who}${cls ? " " + cls : ""}`);
  if (who === "assistant" && thinking) {
    const d = el("details", null, "thought");
    d.append(el("summary", usage?.ms ? `Thought for ${Math.max(1, Math.round(usage.ms / 1000))}s` : "Thought process"), el("div", thinking, "thought-body"));
    div.append(d);
  }
  div.append(who === "assistant" ? renderMarkdown(text) : el("span", text, "bubble"));
  // A model with a caveat says so under every reply it wrote, not just in the menu.
  for (const c of usage?.caveats || []) div.append(el("div", c, "caveat"));
  if (approvals) div.append(button(`Open Approvals (${approvals} waiting)`, () => showTab("approvals"), "link"));
  const foot = el("div", null, "when");
  foot.append(el("span", since(ts)));
  const line = usageLine(usage);
  if (line) foot.append(el("span", ` · ${line}`, "usage"));
  div.append(foot);
  $("messages").append(div);
  div.scrollIntoView({ block: "end" });
  syncEmpty();
}

function syncEmpty() {
  const empty = !$("messages").children.length;
  $("tab-chat").classList.toggle("is-empty", empty);
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

function summarizeUsage(out) {
  const u = out.usage || {};
  const t = u.totals || {};
  const models = Object.keys(u.by_model || {}).map((id) => modelById(id)?.label || id);
  const caveats = [...new Set(Object.keys(u.by_model || {}).map((id) => modelById(id)?.caveat).filter(Boolean))];
  return { models, caveats, tokens_in: t.tokens_in ?? null, tokens_out: t.tokens_out ?? null, ms: t.ms || 0,
    cost: typeof out.cost_usd === "number" ? out.cost_usd : null };
}

async function sendChat(message) {
  addMessage("user", message);
  setThinking(true);
  const { model, effort } = currentPick();
  const gen = chatGen;
  try {
    const out = await api("/api/chat", { method: "POST",
      body: { message, chat_id: chatId, about: chatId ? null : chatAbout?.id || null, model, effort } });
    if (gen !== chatGen) return; // switched to another conversation while this one was answering
    chatId = out.chat_id;
    chatTitle = out.title || chatTitle;
    chatAbout = null;
    saveChat();
    showChatHead();
    const n = (out.pending_approvals || []).length;
    addMessage("assistant", out.reply || "(no reply)", { approvals: n, usage: summarizeUsage(out), thinking: out.thinking || "" });
    if (n) refreshBadges();
    loadDecisions();
  } catch (err) {
    if (gen === chatGen) addMessage("assistant", err.message, { cls: "error" });
  } finally {
    if (gen === chatGen) setThinking(false);
  }
}

// Saved conversations

function showChatHead() {
  const head = $("chat-head");
  head.replaceChildren();
  const about = chatAbout?.text || (chatId && chatTitle);
  head.hidden = !about;
  if (!about) return;
  head.append(el("span", chatAbout || currentAbout ? "About" : "Conversation", "chat-head-k"), el("span", about, "chat-head-t"));
}

let currentAbout = null; // the plan item id the open saved conversation is about
let chatGen = 0;         // bumps on every switch, so a late reply never lands in another conversation

function clearChat() {
  chatGen++;
  $("messages").replaceChildren();
  setThinking(false);
  syncEmpty();
}

function startChat(about = null) {
  chatId = null;
  chatAbout = about;
  currentAbout = about?.id || null;
  chatTitle = "";
  saveChat();
  clearChat();
  greet();
  showChatHead();
  $("chat-input").placeholder = about ? "Ask about this, or ask for a change" : "How can I help you today?";
  loadDecisions();
  closeChatsMenu();
  showTab("chat");
  $("chat-input").focus();
}

async function openChat(id) {
  closeChatsMenu();
  let chat;
  try { chat = await api(`/api/chats/${encodeURIComponent(id)}`); } catch (err) {
    // Gone for good: start fresh. Anything else (locked storage, a restart): try again on the next visit.
    if (id === chatId && /\(404\)/.test(err.message)) { chatId = null; saveChat(); }
    if (id === chatId) chatRestored = false;
    return loadDecisions();
  }
  chatId = chat.id;
  chatAbout = null;
  currentAbout = chat.about || null;
  chatTitle = chat.title;
  saveChat();
  clearChat();
  for (const m of chat.messages || []) {
    const usage = m.usage ? summarizeUsage({ usage: m.usage, cost_usd: m.cost_usd }) : null;
    addMessage(m.who, m.text, { ts: m.ts, cls: m.cls || "", approvals: 0, usage, thinking: m.thinking || "" });
  }
  $("chat-input").placeholder = currentAbout ? "Ask about this, or ask for a change" : "How can I help you today?";
  showChatHead();
  loadDecisions();
}

function closeChatsMenu() {
  $("chats-menu").hidden = true;
  $("chat-list").setAttribute("aria-expanded", "false");
}

async function openChatsMenu() {
  const menu = $("chats-menu");
  menu.hidden = false;
  $("chat-list").setAttribute("aria-expanded", "true");
  menu.replaceChildren(el("div", "Loading...", "m-head"));
  placeChatsMenu();
  try { chatList = await api("/api/chats"); } catch (err) {
    menu.replaceChildren(el("div", err.message, "m-head"));
    return;
  }
  renderChatsMenu();
}

function placeChatsMenu() {
  const menu = $("chats-menu");
  const r = $("chat-list").getBoundingClientRect();
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const above = r.top - 20, below = vh - r.bottom - 20;
  const up = above > below;
  menu.classList.toggle("up", up);
  menu.style.maxHeight = `${Math.max(160, Math.min(up ? above : below, vh * 0.7))}px`;
}

function renderChatsMenu() {
  const menu = $("chats-menu");
  menu.replaceChildren(el("div", "Your conversations", "m-head"));
  menu.append(menuRow([icon(["M12 5v14", "M5 12h14"]), el("span", "New chat", "m-text")], { onPick: () => startChat() }));
  if (!chatList.length) menu.append(el("div", "No saved conversations yet.", "m-empty"));
  for (const c of chatList) {
    const row = el("div", null, "c-row");
    const text = el("span", null, "m-text");
    text.append(el("span", c.title, "m-name"));
    text.append(el("span", `${c.about ? "About a decision · " : ""}${since(c.updated)}`, "m-meta"));
    const pick = menuRow([text], { selected: c.id === chatId, onPick: () => openChat(c.id) });
    const del = button("", (e) => { e.stopPropagation(); askDelete(c, del); }, "icon-btn c-del");
    del.title = "Delete this conversation";
    del.setAttribute("aria-label", `Delete ${c.title}`);
    del.append(icon(["M5 7h14", "M10 11v6", "M14 11v6", "M7 7l1 12h8l1-12", "M9 7V4h6v3"]));
    row.append(pick, del);
    menu.append(row);
  }
  placeChatsMenu();
}

// Two clicks to delete: the first turns the bin into a Delete button.
async function askDelete(c, del) {
  if (!del.classList.contains("armed")) {
    del.classList.add("armed");
    del.replaceChildren(el("span", "Delete"));
    setTimeout(() => { if (del.isConnected) renderChatsMenu(); }, 4000);
    return;
  }
  try { await api(`/api/chats/${encodeURIComponent(c.id)}`, { method: "DELETE" }); } catch { return; }
  chatList = chatList.filter((x) => x.id !== c.id);
  if (c.id === chatId) startChat();
  renderChatsMenu();
}

$("chat-list").addEventListener("click", (e) => {
  e.stopPropagation();
  $("chats-menu").hidden ? openChatsMenu() : closeChatsMenu();
});
$("chats-menu").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => { if (!$("chats-menu").hidden) closeChatsMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("chats-menu").hidden) closeChatsMenu(); });

// Decisions: what waits on you, asked in the chat with an option button each.
// Picking an option runs the steps Discreto froze for it, which is your
// approval, and sets the other options' steps aside.
async function loadDecisions() {
  let items = [];
  try { items = await api("/api/plan"); } catch { return; }
  let open = items.filter((i) => i.owner === "you" && i.status !== "done" && i.options?.length);
  const box = $("decisions");
  box.replaceChildren();
  // A conversation about one decision shows just that one, so its buttons sit next to the answer.
  if (currentAbout) {
    const it = items.find((i) => i.id === currentAbout);
    open = open.filter((i) => i.id === currentAbout);
    box.hidden = !open.length;
    if (!open.length) {
      if (it) { box.hidden = false; box.append(el("div", it.chosen ? `Decided: ${it.chosen.label}.` : "This decision is closed.", "dec-head")); }
      return;
    }
    box.append(el("div", "This conversation is about", "dec-head"));
    box.append(decisionCard(open[0], { asking: true }));
    return;
  }
  box.hidden = !open.length;
  if (!open.length) return;
  box.append(el("div", open.length === 1 ? "1 decision waits on you" : `${open.length} decisions wait on you`, "dec-head"));
  for (const it of open) box.append(decisionCard(it));
}

function decisionCard(it, { asking = false } = {}) {
  const card = el("div", null, "decision");
  const top = el("div", null, "dec-top");
  top.append(el("div", it.text, "dec-q"));
  if (!asking) {
    const ask = button("", () => startChat({ id: it.id, text: it.text }), "dec-ask");
    ask.append(icon(["M4 5h16v11H9l-5 4z"]), el("span", "Ask about this"));
    ask.title = "Ask Discreto about this decision, or ask for a change";
    top.append(ask);
  }
  card.append(top);
  if (it.note) card.append(el("div", it.note, "dec-note"));
  if (it.chosen?.note) card.append(el("div", `Last time: ${it.chosen.label}, ${it.chosen.note}.`, "dec-note bad"));
  const opts = el("div", null, "dec-opts");
  it.options.forEach((o, n) => {
    const row = el("div", null, "dec-opt");
    const b = button(o.label, () => choose(it, n, card), "dec-btn");
    if (o.unavailable) { b.disabled = true; b.title = "This option's steps are gone. Ask Discreto to propose it again."; }
    row.append(b);
    const what = el("div", null, "dec-what");
    if (o.detail) what.append(el("div", o.detail));
    for (const st of o.steps || []) {
      what.append(el("div", st.reason));
      if (st.gmail_search) what.append(gmailLink(st.gmail_search, it.gmail_account, "See this mail in Gmail"));
    }
    if (!o.steps?.length && !o.detail) what.append(el("div", o.done === false ? "Asks again later." : "Changes nothing in Gmail."));
    row.append(what);
    opts.append(row);
  });
  card.append(opts);
  return card;
}

async function choose(it, n, card) {
  card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const status = el("div", `Running: ${it.options[n].label}...`, "dec-status");
  card.append(status);
  try {
    const out = await api(`/api/plan/${encodeURIComponent(it.id)}/choose`, { method: "POST", body: { option: n } });
    const words = (out.results || []).map((r) => r.result?.error ? `Failed: ${r.result.error}` : resultWords(r.tool, r.result)).filter(Boolean);
    const msg = `You chose **${out.chosen}** for "${it.text}".${words.length ? " " + words.join(" ") : ""}${out.status === "failed" ? " A step failed, so the rest didn't run." : ""}`;
    addMessage("assistant", msg, { cls: out.status === "failed" ? "error" : "note" });
    if (chatId) api(`/api/chats/${encodeURIComponent(chatId)}/note`, { method: "POST", body: { text: msg } }).catch(() => {});
    refreshBadges();
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("bad");
    card.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    return;
  }
  loadDecisions();
}

function autoGrow() {
  const t = $("chat-input");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 240)}px`;
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message || $("chat-send").disabled) return;
  input.value = "";
  autoGrow();
  sendChat(message);
});

$("chat-new").addEventListener("click", () => startChat());

for (const q of SUGGESTIONS) $("suggestions").append(button(q, () => sendChat(q), "chip-btn"));
greet();
syncEmpty();
let chatRestored = false;
loaders.chat = () => {
  // Reopen the conversation this tab had open, once Discreto is reachable.
  if (!chatRestored && chatId) { chatRestored = true; return openChat(chatId); }
  chatRestored = true;
  return loadDecisions();
};

$("chat-input").addEventListener("input", autoGrow);
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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
    // Older cards said "Draft reply", but Discreto never drafts mail: the reply is yours to write.
    if (c.action) top.append(chip(c.action === "Draft reply" ? "Reply" : c.action, "kind k-label"));
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
  "gmail.labels": { name: "Labels", cls: "k-label", group: "Tidy labels" },
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
    for (const [i, it] of items.slice(0, n).entries()) {
      const li = el("li");
      render(li, it, i);
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
    if (a.stale) {
      const d = a.stale_days || 365;
      const span = d % 365 === 0 ? (d === 365 ? "a year" : `${d / 365} years`) : `${d} days`;
      facts.push(chip(`No matching mail in ${span}`));
    }
    facts.push(chip("Mail stays where it is", "c-ok"));
    const searches = Array.isArray(a.searches) ? a.searches : [];
    // Stale filters match nothing recent, so each row opens everything that filter ever matched.
    if (summaries.length) body = itemList(summaries, "filter", (li, sum, i) => {
      renderFilter(li, sum);
      if (searches[i]) li.append(gmailLink(searches[i], r.gmail_account, "All its mail in Gmail"));
    });
  } else if (r.tool === "gmail.labels") {
    const create = Array.isArray(a.create) ? a.create : [];
    const rename = Array.isArray(a.rename) ? a.rename : [];
    const del = Array.isArray(a.delete) ? a.delete : [];
    const k = create.length + rename.length + del.length;
    title = `Tidy ${plural(k, "label")}`;
    if (create.length) facts.push(chip(`${plural(create.length, "parent label")} added`, "c-strong"));
    if (rename.length) facts.push(chip(`${plural(rename.length, "rename")}`));
    if (del.length) facts.push(chip(`${plural(del.length, "label")} deleted`, "c-bad"));
    facts.push(chip("No mail moves", "c-ok"));
    const rows = [
      ...create.map((x) => ({ text: `Add ${x}, so its labels nest under it` })),
      ...rename.map((x) => ({ text: `Rename ${x.from} to ${x.to}` })),
      ...del.map((x) => ({ text: `Delete ${x.name} (on ${Number(x.messages || 0).toLocaleString()} messages)`, name: x.name })),
    ];
    if (rows.length) body = itemList(rows, "label", (li, x) => {
      li.append(el("span", x.text));
      if (x.name) li.append(gmailLink(`label:${x.name.toLowerCase().replace(/[\s/]+/g, "-")}`, r.gmail_account, "Its mail in Gmail"));
    });
  }
  if (!body && senders.length) {
    body = itemList(senders, "sender", (li, s) => li.append(el("span", s, "sender")));
  }
  return { title, facts, body };
}

// The plan: what waits on you and what Discreto is working through. An item that
// carries steps shows them here to approve in place, and reads as done once every
// step is decided.
async function loadPlan(pendingById = new Map()) {
  const box = $("plan");
  let items = [];
  try { items = await api("/api/plan"); } catch { items = []; }
  box.replaceChildren();
  box.hidden = !items.length;
  const claimed = new Set();
  if (!items.length) return claimed;
  const sections = [["you", "Waiting on you", "ul"], ["discreto", "Discreto is working on", "ol"]];
  for (const [owner, heading, tag] of sections) {
    const mine = items.filter((i) => i.owner === owner);
    if (!mine.length) continue;
    const open = mine.filter((i) => i.status !== "done");
    const done = mine.filter((i) => i.status === "done");
    const sec = el("div", null, "plan-sec");
    sec.append(el("h3", `${heading} (${open.length})`));
    const list = el(tag, null, "plan-list");
    for (const it of open) {
      for (const a of it.steps?.waiting || []) if (pendingById.has(a)) claimed.add(a);
      list.append(planRow(it, pendingById));
    }
    if (!open.length) list.append(el("li", "Nothing open.", "meta"));
    sec.append(list);
    if (done.length) {
      const more = el("details", null, "plan-done");
      more.append(el("summary", `${done.length} done`));
      const dl = el("ul", null, "plan-list");
      for (const it of done) dl.append(planRow(it, pendingById));
      more.append(dl);
      sec.append(more);
    }
    box.append(sec);
  }
  return claimed;
}

function stepWords(st) {
  const bits = [];
  if (st.approved) bits.push(`${st.approved} approved`);
  if (st.denied) bits.push(`${st.denied} denied`);
  if (st.gone) bits.push(`${st.gone} set aside`);
  return bits.join(", ");
}

function planRow(it, pendingById) {
  const li = el("li", null, it.status === "done" ? "plan-item done" : "plan-item");
  const label = el("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = it.status === "done";
  if (it.auto_done) { box.disabled = true; box.title = "Done: every step was decided"; }
  box.addEventListener("change", async () => {
    box.disabled = true;
    try {
      await api(`/api/plan/${encodeURIComponent(it.id)}`, { method: "POST", body: { done: box.checked } });
      await loadApprovals();
    } catch { box.checked = !box.checked; box.disabled = false; }
  });
  label.append(box, el("span", it.text));
  li.append(label);
  if (it.note) li.append(el("div", it.note, "meta"));
  const st = it.steps;
  if (st) {
    const waiting = (st.waiting || []).map((a) => pendingById.get(a)).filter(Boolean);
    const past = stepWords(st);
    if (it.status !== "done" && waiting.length) {
      const more = el("details", null, "plan-steps");
      more.append(el("summary", `${plural(waiting.length, "step")} to review${past ? ` (${past})` : ""}`));
      const cards = waiting.map((r) => approvalCard(r));
      const ul = el("ul", null, "plan-cards");
      if (cards.length > 1) {
        const head = el("li", null, "group-head");
        head.append(el("span", "Each step shows exactly what it changes."), approveAllButton(cards, cards.length));
        ul.append(head);
      }
      ul.append(...cards);
      more.append(ul);
      li.append(more);
    } else if (past) {
      li.append(el("div", `${plural(st.total, "step")}: ${past}`, "meta"));
    }
  }
  if (it.options?.length && it.status !== "done") li.append(button("Decide in Chat", () => showTab("chat"), "link"));
  if (it.chosen) li.append(el("div", `You chose: ${it.chosen.label}${it.chosen.note ? ` (${it.chosen.note})` : ""}`, "meta"));
  return li;
}

async function loadApprovals() {
  const list = $("approvals");
  const rows = await api("/api/approvals");
  const all = rows.filter((r) => r.status === "pending");
  const claimed = await loadPlan(new Map(all.map((r) => [r.id, r])));
  list.replaceChildren();
  const pending = all.filter((r) => !claimed.has(r.id));
  if (!pending.length) {
    list.append(el("li", claimed.size ? "No other steps are waiting for you." : "No steps are waiting for you.", "meta"));
    return;
  }
  list.append(el("li", `${plural(pending.length, "step")} ${claimed.size ? "outside the plan " : ""}wait for you. Nothing changes until you approve each one.`, "meta summary"));
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

// Opens Gmail's own search for the mail a step would touch, in the account Discreto works on.
function gmailLink(search, account, label = "Open matching mail in Gmail") {
  // authuser picks the signed-in account by address; a /u/<address>/ path gives Gmail a 404.
  const who = account ? `?authuser=${encodeURIComponent(account)}` : "";
  const a = el("a", label, "gmail-link");
  a.href = `https://mail.google.com/mail/${who}#search/${encodeURIComponent(search)}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
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
  if (r.gmail_search) li.append(gmailLink(r.gmail_search, r.gmail_account));
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
      else status.textContent = `Done. ${resultWords(r.tool, res)}${out.undo ? " You can undo it from the Log tab." : ""}`;
    } catch (err) {
      ok = false;
      status.textContent = `Failed: ${err.message}`;
    }
    li.classList.remove("working");
    li.classList.add(ok ? "done" : "failed");
    status.classList.add(ok ? "ok" : "bad");
    if (!ok) { actions.hidden = false; approveBtn.textContent = "Try again"; }
    else { actions.remove(); delete li.approve; }
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
  if (res.filters_made) bits.push(`${n(res.filters_made)} filters recreated`);
  if (res.filters_deleted) bits.push(`${n(res.filters_deleted)} filters deleted`);
  if (res.labels_created) bits.push(`${n(res.labels_created)} labels added`);
  if (res.labels_renamed) bits.push(`${n(res.labels_renamed)} labels renamed`);
  if (res.labels_deleted) bits.push(`${n(res.labels_deleted)} labels deleted`);
  if (res.labels_changed) bits.push(`${n(res.labels_changed)} labels put back`);
  if (res.problems && res.problems.length) bits.push(`problems: ${res.problems.join("; ")}`);
  if (res.kept_replied) bits.push(`${n(res.kept_replied)} kept because you replied in their thread`);
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

// Import a saved database (one recovered from an old volume) into the unlocked storage.
$("import-file").addEventListener("change", (e) => { $("import-go").disabled = !e.target.files.length; });
$("import-go").addEventListener("click", async () => {
  const file = $("import-file").files[0];
  const msg = $("import-msg");
  if (!file) return;
  if (file.size > 64 * 1024 * 1024) { msg.textContent = "That file is larger than 64 MB."; return; }
  $("import-go").disabled = true;
  msg.textContent = `Importing ${file.name}...`;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const res = await api("/api/storage/import", { method: "POST", body: { data: btoa(bin), name: file.name } });
    const names = { facts: "memories", cards: "cards", approvals: "approvals", history: "history entries",
      episodes: "chat summaries", instances: "run records", kv: "settings" };
    const parts = Object.entries(res.tables).filter(([, c]) => c.added).map(([t, c]) => `${c.added} ${names[t] || t}`);
    msg.textContent = parts.length ? `Imported ${parts.join(", ")}.` : "Nothing new to import; it was all here already.";
    $("import-file").value = "";
    await loadMemory();
    refreshBadges();
  } catch (err) {
    msg.textContent = `Couldn't import: ${err.message}`;
    $("import-go").disabled = false;
  }
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
  "gmail.labels": "tidy labels", "approvals.list": "checked what waits for you", "memory.read": "looked up memory", "memory.write": "saved to memory",
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
    case "undo":
      return { text: `You undid: ${first(d.of || toolWords(d.tool))}. ${first(d.summary || "")}`, show: true };
    case "approval":
      return { text: `You ${d.approved ? "approved" : "denied"}: ${first(d.summary || toolWords(d.tool))}`, show: true };
    case "result": {
      const r = parsePreview(d.preview);
      const err = r && r.error;
      if (err) return { text: `Failed, ${toolWords(d.tool)}: ${first(String(err))}`, show: true, bad: true };
      if (d.tool === "undo") return { text: `Undo done. ${resultWords(d.tool, r)}`, show: true };
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

// Approved steps, newest first, each with an Undo that reverses exactly the messages it changed.
let historyAll = false;
async function loadHistory() {
  const box = $("log-history");
  let rows;
  try { rows = await api("/api/history"); } catch { return; }
  box.replaceChildren();
  if (!rows.length) return;
  box.append(el("strong", "Approved steps"));
  box.append(el("p", "Tap a row for details. Undo reverses exactly what a step changed.", "meta"));
  const list = el("ul", null, "history");
  const shown = historyAll ? rows : rows.slice(0, 10);
  for (const r of shown) list.append(historyRow(r));
  box.append(list);
  if (rows.length > shown.length) {
    box.append(button(`Show all ${rows.length}`, () => { historyAll = true; loadHistory(); }, "link"));
  }
}

// One compact row per decided step: kind, title, one line of what happened, and a small Undo.
// Tapping the row opens the exact wording and what undo would do.
function historyRow(r) {
  const kind = KINDS[r.tool] || { name: r.tool, cls: "" };
  const li = el("li", null, "h-row");
  let title;
  try { title = describeStep(r).title; } catch { title = first(r.reason, 120); }
  const verb = r.status === "approved" ? "" : "Denied · ";
  const res = r.status === "approved" && r.result ? ` · ${resultWords(r.tool, r.result).replace(/\.$/, "")}` : "";
  const main = el("div", null, "h-main");
  main.append(el("div", title, "h-title"), el("div", `${verb}${since(r.decided || r.created)}${res}`, "h-meta"));
  const side = el("div", null, "h-side");
  const detail = el("div", null, "h-detail");
  detail.hidden = true;
  if (r.can_undo && !r.undone) detail.append(el("div", `Undo would ${r.undo.charAt(0).toLowerCase()}${r.undo.slice(1)}`));
  else if (r.status === "approved" && r.why_not && !r.undone) detail.append(el("div", `No undo: ${r.why_not}.`, "meta"));
  detail.append(el("div", r.reason, "meta"));
  main.addEventListener("click", () => { detail.hidden = !detail.hidden; li.classList.toggle("open", !detail.hidden); });

  const note = (text, cls) => { side.replaceChildren(el("span", text, `h-note ${cls || ""}`)); };
  if (r.undone) {
    const ur = r.undo_result || {};
    note(ur.error ? "Undo failed" : `Undone ${since(r.undone)}`, ur.error ? "bad" : "ok");
    if (ur.error) detail.prepend(el("div", `Undo failed: ${ur.error}`, "bad"));
  } else if (r.can_undo) {
    let armed = false, timer = null;
    const b = button("Undo", async (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        b.textContent = "Confirm";
        detail.hidden = false;
        li.classList.add("open");
        timer = setTimeout(() => { armed = false; b.textContent = "Undo"; }, 5000);
        return;
      }
      clearTimeout(timer);
      side.replaceChildren(el("span", null, "spinner"));
      try {
        const out = await api(`/api/history/${r.id}/undo`, { method: "POST" });
        const ur = out.result || {};
        note(ur.error ? "Undo failed" : "Undone", ur.error ? "bad" : "ok");
        detail.prepend(el("div", ur.error ? `Undo failed: ${ur.error}` : `Undone. ${resultWords(r.tool, ur)}`, ur.error ? "bad" : "ok"));
      } catch (err) {
        note("Undo failed", "bad");
        detail.prepend(el("div", `Undo failed: ${err.message}`, "bad"));
      }
    }, "danger small");
    side.append(b);
  } else {
    note(r.status === "approved" ? "No undo" : "Denied");
  }
  li.append(chip(kind.name, `kind ${kind.cls}`), main, side, detail);
  return li;
}

async function loadLog() {
  const [entries, check] = await Promise.all([api("/api/log"), api("/api/log/verify")]);
  $("log-verify").textContent = check.ok
    ? `Run log intact: ${check.entries} entries since this run started, chain and signatures check out.`
    : `Run log check failed: ${check.error}`;
  loadRuns();
  loadHistory();
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
function paintPause(p) {
  paused = p;
  const b = $("pause");
  const label = paused ? "Agents are paused. Resume agents" : "Pause agents";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-pressed", String(paused));
  b.classList.toggle("on", paused);
}
$("pause").addEventListener("click", async () => {
  const b = $("pause");
  b.disabled = true;
  try {
    const out = await api("/api/pause", { method: "POST", body: { paused: !paused } });
    paintPause(out.paused);
  } catch (err) { alertLine(err.message); }
  b.disabled = false;
});

// Verification details: what the shield in the rail vouches for.

const STEP_WORDS = {
  fetchDigest: ["Found the published release", "The newest release of the config repo and its digest were fetched from GitHub."],
  verifyCode: ["The release is signed by its build", "Sigstore shows the release was built by GitHub Actions from the config repo, and gives the code's expected measurement."],
  verifyEnclave: ["The enclave is real confidential hardware", "The hardware's attestation report is signed by the chip maker's keys, so the machine is a genuine, isolated enclave."],
  compareMeasurements: ["The enclave runs exactly that release", "The measurement the hardware reports matches the one the signed release expects."],
  verifyCertificate: ["This connection ends inside the enclave", "The TLS and encryption keys you're talking to are the ones the attested enclave holds, so no one in between can read your traffic."],
};

function platformName(doc) {
  const t = (doc && doc.enclaveMeasurement && doc.enclaveMeasurement.measurement && doc.enclaveMeasurement.measurement.type) || "";
  if (t.includes("tdx") && t.includes("snp")) return "AMD SEV-SNP or Intel TDX";
  if (t.includes("tdx")) return "Intel TDX";
  if (t.includes("snp")) return "AMD SEV-SNP";
  return "";
}

function paintVerify(stateName) {
  const b = $("verify-btn");
  b.classList.remove("pending", "ok", "bad");
  b.classList.add(stateName);
  const label = stateName === "ok" ? "Enclave verified. Show what was checked"
    : stateName === "bad" ? "Enclave not verified. Show why" : "Checking the enclave";
  b.title = label;
  b.setAttribute("aria-label", label);
}

function short(x, n = 16) {
  x = String(x || "");
  return x.length > n * 2 ? `${x.slice(0, n)}...${x.slice(-8)}` : x;
}

function renderVerify() {
  const body = $("verify-body");
  const doc = verifyDoc || {};
  const ok = Boolean(doc.securityVerified);
  $("verify-title").textContent = ok ? "Enclave verified" : "Enclave not verified";
  body.replaceChildren();
  body.append(el("p", ok
    ? "Before sending anything, this page checked that Discreto runs the code published in your config repo, inside confidential hardware that no one else can read, not Tinfoil and not the cloud host."
    : `This page did not send anything to Discreto, because a check failed${verifyError ? `: ${verifyError}` : "."}`, "vd-lead"));
  const steps = doc.steps || {};
  const list = el("ul", null, "vd-steps");
  for (const [key, [title, more]] of Object.entries(STEP_WORDS)) {
    const st = (steps[key] && steps[key].status) || "pending";
    const li = el("li", null, `vd-step ${st}`);
    li.append(el("span", st === "success" ? "✓" : st === "failed" ? "✗" : "·", "vd-mark"));
    const text = el("div");
    text.append(el("div", title, "vd-title"), el("div", st === "failed" && steps[key].error ? steps[key].error : more, "meta"));
    li.append(text);
    list.append(li);
  }
  body.append(list);
  const facts = el("dl", null, "vd-facts");
  const add = (k, v, href) => {
    if (!v) return;
    facts.append(el("dt", k));
    const dd = el("dd");
    if (href) {
      const a = el("a", v);
      a.href = href; a.target = "_blank"; a.rel = "noopener";
      dd.append(a);
    } else dd.append(el("span", v));
    facts.append(dd);
  };
  const repo = doc.configRepo || CONFIG_REPO;
  add("Release", doc.releaseTag, doc.releaseTag ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(doc.releaseTag)}` : "");
  add("Config repo", repo, `https://github.com/${repo}`);
  add("Hardware", platformName(doc));
  add("Enclave", doc.enclaveHost);
  add("Code fingerprint", short(doc.codeFingerprint));
  add("Enclave fingerprint", short(doc.enclaveFingerprint));
  add("TLS key", short(doc.tlsPublicKey));
  add("Checked", doc.verifiedAt ? new Date(doc.verifiedAt).toLocaleString() : "");
  if (doc.verifier && doc.verifier.version) add("Checked by", `Tinfoil verifier ${doc.verifier.version}, running in this page`);
  if (runInfo && runInfo.version) add("Running", `Discreto v${runInfo.version}${runInfo.started ? `, since ${since(runInfo.started)}` : ""}`);
  if (runInfo && runInfo.idleMinutes) add("Idle stop", `after ${runInfo.idleMinutes} minutes without use`);
  body.append(facts);
  const raw = el("details", null, "vd-raw");
  raw.append(el("summary", "Full verification record"));
  const pre = el("pre", JSON.stringify(doc, null, 2));
  raw.append(pre, button("Copy", async (e) => {
    try { await navigator.clipboard.writeText(pre.textContent); e.target.textContent = "Copied"; } catch {}
  }));
  body.append(raw);
}

$("verify-btn").addEventListener("click", () => { renderVerify(); $("verify-dialog").showModal(); });
$("verify-close").addEventListener("click", () => $("verify-dialog").close());
$("verify-dialog").addEventListener("click", (e) => { if (e.target === $("verify-dialog")) $("verify-dialog").close(); });

// Boot

(async () => {
  if (!(await isUp())) { showStopped(); return; }
  if (!(await verify())) return;
  if (token) await start();
  else {
    $("login-passkey-box").hidden = !hasVault();
    $("login").hidden = false;
  }
})();
