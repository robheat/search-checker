'use strict';

const crypto = require('crypto');
const { getProxySettings } = require('./config');

const API_BASE = (process.env.WEBSHARE_API_BASE || 'https://proxy.webshare.io/api/v2').replace(/\/+$/, '');

/**
 * Render a username template.
 *   {user}, {country}, {session}  -> substituted
 *   [ ... ]                        -> optional group, removed if any placeholder inside is empty
 */
function renderTemplate(template, vars) {
  const sub = (s) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
  return template
    .replace(/\[([^\]]*)\]/g, (_, group) => {
      const keys = [...group.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      return keys.every((k) => vars[k]) ? sub(group) : '';
    })
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

function newSessionId() {
  // Short, numeric-ish id: works with plans that expect "-1", "-2", ... as well as free-form ids.
  return String(crypto.randomInt(1, 1_000_000));
}

function hasCredentials(settings = getProxySettings()) {
  return Boolean(settings.username && settings.password && settings.host && settings.port);
}

/**
 * Playwright proxy config for a single view.
 * @param {{country?: string, mode?: 'rotate'|'sticky', session?: string}} opts
 */
function buildProxy({ country = '', mode = 'rotate', session } = {}, settings = getProxySettings()) {
  if (!hasCredentials(settings)) {
    const err = new Error('Webshare credentials are not configured.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const vars = {
    user: settings.username,
    country: (country || '').toUpperCase(),
    session: mode === 'sticky' ? session || newSessionId() : '',
  };
  const template = mode === 'sticky' ? settings.stickyTemplate : settings.rotateTemplate;
  const username = renderTemplate(template, vars);
  return {
    server: `http://${settings.host}:${settings.port}`,
    username,
    password: settings.password,
    // Never route our own localhost traffic through the proxy.
    bypass: 'localhost,127.0.0.1',
    _session: vars.session,
  };
}

async function apiGet(apiKey, pathname) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { detail: text.slice(0, 300) };
  }
  if (!res.ok) {
    const err = new Error(
      res.status === 401 || res.status === 403
        ? 'Webshare rejected the API key. Copy it again from dashboard → API → Keys.'
        : `Webshare API error ${res.status}: ${body.detail || 'unknown error'}`
    );
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * Fetch proxy username/password (and available countries, if the plan reports them)
 * using a Webshare API key.
 */
async function fetchProxyConfig(apiKey) {
  const cfg = await apiGet(apiKey, '/proxy/config/');
  const countries = [];
  if (cfg && cfg.countries && typeof cfg.countries === 'object' && !Array.isArray(cfg.countries)) {
    for (const [code, count] of Object.entries(cfg.countries)) {
      if (/^[A-Za-z]{2}$/.test(code)) countries.push({ code: code.toUpperCase(), count: Number(count) || 0 });
    }
  }
  return {
    username: cfg.username || cfg.proxy_username || '',
    password: cfg.password || cfg.proxy_password || '',
    countries: countries.sort((a, b) => b.count - a.count),
  };
}

function maskUser(u = '') {
  if (u.length <= 4) return u ? `${u[0]}***` : '';
  return `${u.slice(0, 3)}…${u.slice(-2)}`;
}

module.exports = { renderTemplate, buildProxy, hasCredentials, fetchProxyConfig, newSessionId, maskUser, API_BASE };
