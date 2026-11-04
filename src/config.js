'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (no dependency). Existing environment variables win.
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const app = {
  host: process.env.HOST || '127.0.0.1',
  port: int(process.env.PORT, 3000),
  appPassword: process.env.APP_PASSWORD || '',
  maxConcurrent: Math.max(1, int(process.env.MAX_CONCURRENT, 3)),
  maxHistory: Math.max(10, int(process.env.MAX_HISTORY, 200)),
  navTimeoutMs: int(process.env.NAV_TIMEOUT_MS, 45000),
  chromiumPath: process.env.CHROMIUM_PATH || '',
  dataDir: DATA_DIR,
};

// Defaults for Webshare's rotating endpoint. Every value can be overridden
// from the environment or the in-app settings screen, because username
// formats differ between plan types.
const DEFAULT_PROXY = {
  host: 'p.webshare.io',
  port: 80,
  // Templates: {user}, {country} (ISO code, upper-case) and {session}.
  // A [...] group is dropped when a placeholder inside it is empty,
  // e.g. "{user}[-{country}]-rotate" -> "abc-rotate" or "abc-US-rotate".
  rotateTemplate: '{user}[-{country}]-rotate',
  stickyTemplate: '{user}[-{country}]-{session}',
};

function envProxySettings() {
  const s = {};
  if (process.env.WEBSHARE_API_KEY) s.apiKey = process.env.WEBSHARE_API_KEY;
  if (process.env.WEBSHARE_USERNAME) s.username = process.env.WEBSHARE_USERNAME;
  if (process.env.WEBSHARE_PASSWORD) s.password = process.env.WEBSHARE_PASSWORD;
  if (process.env.WEBSHARE_PROXY_HOST) s.host = process.env.WEBSHARE_PROXY_HOST;
  if (process.env.WEBSHARE_PROXY_PORT) s.port = int(process.env.WEBSHARE_PROXY_PORT, DEFAULT_PROXY.port);
  if (process.env.WEBSHARE_ROTATE_TEMPLATE) s.rotateTemplate = process.env.WEBSHARE_ROTATE_TEMPLATE;
  if (process.env.WEBSHARE_STICKY_TEMPLATE) s.stickyTemplate = process.env.WEBSHARE_STICKY_TEMPLATE;
  return s;
}

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let saved = readSaved();

/** Effective proxy settings: defaults < env < saved (in-app) settings. */
function getProxySettings() {
  return { ...DEFAULT_PROXY, ...envProxySettings(), ...saved };
}

function saveProxySettings(patch) {
  const next = { ...saved };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v === '') delete next[k];
    else next[k] = v;
  }
  saved = next;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return getProxySettings();
}

module.exports = { app, DEFAULT_PROXY, getProxySettings, saveProxySettings };
