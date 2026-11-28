// Touch ID / Face ID vault for Discreto's secrets on this device.
//
// A passkey (in iCloud Keychain) with the WebAuthn PRF extension gives the page a
// secret that only comes out after Touch ID or Face ID. That secret, run through
// HKDF, is an AES-GCM key that encrypts the access token, the storage key and the
// GitHub token. The passkey syncs through iCloud Keychain, so every one of your
// devices gets the same secret from it. Only the ciphertext is kept: in this
// browser's localStorage and, saved there by the save-vault workflow, as
// discreto-vault.json in the public config repo, which is how a new device finds it. The passkey's secret never leaves
// the device it is used on, and Discreto itself never sees it.

const VAULT_KEY = "discreto.vault";
export const VAULT_FILE = "discreto-vault.json";
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function hasVault() {
  return Boolean(localStorage.getItem(VAULT_KEY));
}

export function forgetVault() {
  localStorage.removeItem(VAULT_KEY);
}

// Only the four fields the vault needs, each plain base64 of a sane size, so a file
// from the config repo can't put anything else into this page's storage.
function clean(v) {
  if (!v || v.v !== 1) return null;
  const out = { v: 1 };
  for (const k of ["cred", "salt", "iv", "ct"]) {
    if (typeof v[k] !== "string" || !v[k] || v[k].length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v[k])) return null;
    out[k] = v[k];
  }
  return out;
}

function localVault() {
  try { return clean(JSON.parse(localStorage.getItem(VAULT_KEY) || "null")); } catch { return null; }
}

// The encrypted vault as a file to add to the config repo, or null if there is none.
export function vaultFile() {
  const v = localVault();
  return v ? JSON.stringify(v, null, 2) + "\n" : null;
}

// The copy published in the config repo, or null when there is none or it can't be read.
export async function publishedVault(configRepo) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(configRepo || "")) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${configRepo}/main/${VAULT_FILE}`,
      { cache: "no-store", signal: ctl.signal });
    return res.ok ? clean(await res.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// On a device with nothing saved yet, keep the published copy, so Touch ID or Face ID
// with the synced passkey opens it. Returns true when it was adopted.
export function adoptVault(published) {
  const v = clean(published);
  if (!v || hasVault()) return false;
  localStorage.setItem(VAULT_KEY, JSON.stringify(v));
  return true;
}

// Whether the published copy is exactly the one saved in this browser.
export function publishedIsCurrent(published) {
  const a = localVault(), b = clean(published);
  return Boolean(a && b) && ["cred", "salt", "iv", "ct"].every((k) => a[k] === b[k]);
}

export async function passkeysAvailable() {
  try {
    return Boolean(window.PublicKeyCredential) &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function aesKey(prfOutput, salt) {
  const base = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("discreto vault v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function prfFrom(credId, salt) {
  const got = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: credId }],
      userVerification: "required",
      timeout: 60000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const out = got && got.getClientExtensionResults().prf;
  if (!out || !out.results || !out.results.first) {
    throw new Error("This browser or passkey can't do Touch ID unlock (no PRF support). Safari 18 or a recent Chrome with iCloud Keychain can.");
  }
  return out.results.first;
}

// Make a passkey and save secrets under it. Asks for Touch ID (twice if the browser
// can't return the PRF secret while creating the passkey).
export async function createVault(secrets) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const made = await navigator.credentials.create({
    publicKey: {
      rp: { name: "Discreto" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Discreto", displayName: "Discreto" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
      timeout: 60000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const ext = made.getClientExtensionResults().prf || {};
  if (ext.enabled === false) {
    throw new Error("This passkey can't do Touch ID unlock (no PRF support). Safari 18 or a recent Chrome with iCloud Keychain can.");
  }
  const credId = new Uint8Array(made.rawId);
  const prf = ext.results && ext.results.first ? ext.results.first : await prfFrom(credId, salt);
  await seal(credId, salt, prf, secrets);
}

async function seal(credId, salt, prf, secrets) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(prf, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(secrets)));
  localStorage.setItem(VAULT_KEY, JSON.stringify({ v: 1, cred: b64(credId), salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}

// Touch ID, then the saved secrets: { token, storageKey, githubToken }.
export async function openVault() {
  const v = localVault();
  if (!v) throw new Error("Nothing is saved with Touch ID on this device.");
  const salt = unb64(v.salt);
  const prf = await prfFrom(unb64(v.cred), salt);
  const key = await aesKey(prf, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(v.iv) }, key, unb64(v.ct));
  let secrets = JSON.parse(dec.decode(pt));
  // Each update builds on the last one, so saving the storage key later in the same
  // page can't drop a GitHub token saved a moment earlier.
  // Nothing is re-encrypted when nothing changed, so the copy in the config repo
  // stays current across ordinary sign-ins.
  const update = async (more) => {
    if (Object.keys(more).every((k) => secrets[k] === more[k])) return;
    secrets = { ...secrets, ...more };
    await seal(unb64(v.cred), salt, prf, secrets);
  };
  return { secrets, update };
}
