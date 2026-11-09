'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { app: appConfig, getProxySettings, saveProxySettings, DEFAULT_PROXY } = require('./config');
const { buildProxy, hasCredentials, fetchProxyConfig, maskUser } = require('./webshare');
const { COUNTRIES } = require('./countries');
const { getBrowser, closeBrowser, classifyError, lookupExitIp } = require('./viewer');
const jobs = require('./jobs');

const server = express();
server.disable('x-powered-by');
server.use(express.json({ limit: '100kb' }));

// Optional password protection (recommended if you bind to 0.0.0.0).
if (appConfig.appPassword) {
  const expected = Buffer.from(appConfig.appPassword);
  server.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const pass = Buffer.from(Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':'));
      if (pass.length === expected.length && crypto.timingSafeEqual(pass, expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Search Checker"').status(401).send('Authentication required');
  });
}

server.use(
  express.static(path.join(__dirname, '..', 'public'), {
    extensions: ['html'],
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  })
);

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Status & settings
// ---------------------------------------------------------------------------
function publicSettings() {
  const s = getProxySettings();
  return {
    configured: hasCredentials(s),
    hasApiKey: Boolean(s.apiKey),
    username: s.username || '',
    usernameMasked: maskUser(s.username || ''),
    hasPassword: Boolean(s.password),
    host: s.host,
    port: s.port,
    rotateTemplate: s.rotateTemplate,
    stickyTemplate: s.stickyTemplate,
    defaults: DEFAULT_PROXY,
    planCountries: Array.isArray(s.planCountries) ? s.planCountries : [],
  };
}

server.get('/api/status', (req, res) => {
  res.json({
    settings: publicSettings(),
    countries: COUNTRIES.map(({ code, name, locale }) => ({ code, name, locale })),
    limits: { maxConcurrent: appConfig.maxConcurrent, navTimeoutMs: appConfig.navTimeoutMs },
  });
});

server.post(
  '/api/settings',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    const str = (v) => (typeof v === 'string' ? v.trim() : undefined);

    if (b.apiKey !== undefined) {
      const apiKey = str(b.apiKey);
      if (apiKey) {
        const cfg = await fetchProxyConfig(apiKey);
        patch.apiKey = apiKey;
        if (cfg.username) patch.username = cfg.username;
        if (cfg.password) patch.password = cfg.password;
        patch.planCountries = cfg.countries.length ? cfg.countries : null;
      } else {
        patch.apiKey = null;
        patch.planCountries = null;
      }
    }
    if (str(b.username)) patch.username = str(b.username);
    if (str(b.password)) patch.password = str(b.password); // blank = keep existing
    if (b.host !== undefined) patch.host = str(b.host) || null;
    if (b.port !== undefined) {
      const port = parseInt(b.port, 10);
      if (b.port !== '' && b.port !== null && !(port > 0 && port < 65536)) {
        return res.status(400).json({ error: 'Port must be a number between 1 and 65535.' });
      }
      patch.port = port || null;
    }
    for (const key of ['rotateTemplate', 'stickyTemplate']) {
      if (b[key] === undefined) continue;
      const t = str(b[key]);
      if (t && !t.includes('{user}')) return res.status(400).json({ error: 'Username templates must contain {user}.' });
      patch[key] = t || null;
    }
    if (b.clear === true) {
      Object.assign(patch, { apiKey: null, username: null, password: null, planCountries: null });
    }
    saveProxySettings(patch);
    res.json({ settings: publicSettings() });
  })
);

// Tests the current credentials by fetching the exit IP through the proxy.
server.post(
  '/api/settings/test',
  asyncRoute(async (req, res) => {
    const country = typeof req.body?.country === 'string' ? req.body.country : '';
    const t0 = Date.now();
    let context;
    try {
      const proxy = buildProxy({ country, mode: 'rotate' });
      delete proxy._session;
      const browser = await getBrowser();
      context = await browser.newContext({ proxy });
      const ip = await lookupExitIp(context);
      if (!ip) throw new Error('Connected, but no IP lookup service answered through the proxy (net::ERR_TUNNEL_CONNECTION_FAILED).');
      res.json({ ok: true, ip, ms: Date.now() - t0 });
    } catch (err) {
      const info = classifyError(err);
      res.json({ ok: false, error: info.message, hint: info.hint || '', raw: String(err.message || '').split('\n')[0].slice(0, 300) });
    } finally {
      if (context) await context.close().catch(() => {});
    }
  })
);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a URL to view.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http:// and https:// URLs are supported.');
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error("That doesn't look like a valid domain.");
  return u.toString();
}

const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
const clampInt = (v, min, max, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

server.post('/api/views', (req, res) => {
  if (!hasCredentials()) {
    return res.status(400).json({ error: 'Add your Webshare credentials in Settings first.', code: 'NOT_CONFIGURED' });
  }
  const b = req.body || {};
  let url;
  try {
    url = normalizeUrl(b.url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  let countries = Array.isArray(b.countries) ? b.countries : [b.country || ''];
  countries = [...new Set(countries.map((c) => String(c || '').toUpperCase()).filter((c) => c === '' || /^[A-Z]{2}$/.test(c)))];
  if (!countries.length) countries = [''];
  if (countries.length > 12) return res.status(400).json({ error: 'Pick at most 12 countries at once.' });

  const base = {
    url,
    device: pick(b.device, ['desktop', 'mobile', 'tablet'], 'desktop'),
    ipMode: pick(b.ipMode, ['rotate', 'sticky'], 'sticky'),
    waitUntil: pick(b.waitUntil, ['domcontentloaded', 'load', 'networkidle'], 'load'),
    extraWaitMs: clampInt(b.extraWaitMs, 0, 30000, 0),
    fullPage: b.fullPage !== false,
    bandwidth: pick(b.bandwidth, ['full', 'no-media', 'text-only'], 'no-media'),
    language: typeof b.language === 'string' && /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/.test(b.language) ? b.language : 'auto',
    retries: clampInt(b.retries, 0, 5, 2),
    retryOnBlock: b.retryOnBlock !== false,
    matchTimezone: b.matchTimezone !== false,
  };
  const created = countries.map((country) => jobs.createJob({ ...base, country }));
  res.status(201).json({ jobs: created.map((j) => j.summary()) });
});

server.get('/api/jobs', (req, res) => {
  res.json({ jobs: jobs.listJobs(clampInt(req.query.limit, 1, 500, 100)) });
});

server.delete('/api/jobs', (req, res) => {
  jobs.clearHistory();
  res.json({ ok: true });
});

function requireJob(req, res) {
  const job = jobs.getJob(req.params.id);
  if (!job) res.status(404).json({ error: 'Not found' });
  return job;
}

server.get('/api/jobs/:id', (req, res) => {
  const job = requireJob(req, res);
  if (job) res.json(job.toJSON());
});

server.delete('/api/jobs/:id', (req, res) => {
  res.json({ ok: jobs.deleteJob(req.params.id) });
});

server.post('/api/jobs/:id/cancel', (req, res) => {
  const job = requireJob(req, res);
  if (job) res.json({ ok: job.cancel() });
});

// Server-Sent Events: replays history, then streams live progress.
server.get('/api/jobs/:id/events', (req, res) => {
  const job = requireJob(req, res);
  if (!job) return;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const e of job.events) send(e);
  const done = () => job.status !== 'queued' && job.status !== 'running';
  if (done()) {
    send({ type: 'snapshot', job: job.summary() });
    return res.end();
  }
  const unsubscribe = job.subscribe((e) => {
    send(e);
    if (e.type === 'end') {
      send({ type: 'snapshot', job: job.summary() });
      cleanup();
      res.end();
    }
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const cleanup = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', cleanup);
});

// Result files
const FILES = {
  'screenshot.jpg': { file: 'screenshot.jpg', type: 'image/jpeg' },
  'preview.jpg': { file: 'preview.jpg', type: 'image/jpeg' },
  'page.html': { file: 'page.html', type: 'text/plain; charset=utf-8', ext: 'html' },
  'page.txt': { file: 'page.txt', type: 'text/plain; charset=utf-8', ext: 'txt' },
};

server.get('/api/jobs/:id/:file', (req, res) => {
  const spec = FILES[req.params.file];
  if (!spec) return res.status(404).json({ error: 'Not found' });
  const job = requireJob(req, res);
  if (!job) return;
  const attempt = /^\d+$/.test(String(req.query.a || '')) ? `a${req.query.a}` : job.result && job.result.attemptDir;
  const filePath = attempt ? path.join(job.dir, attempt, spec.file) : null;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not available yet' });
  // Captured HTML is served as inert text with a sandbox CSP — never rendered on our origin.
  res.set({
    'Content-Type': spec.type,
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': req.params.file === 'preview.jpg' ? 'no-cache' : 'private, max-age=86400',
  });
  if (req.query.download) {
    const host = (() => {
      try {
        return new URL(job.options.url).hostname;
      } catch {
        return 'page';
      }
    })();
    const name = `${host}-${job.options.country || 'any'}-${job.id}.${spec.ext || 'jpg'}`;
    res.attachment(name);
  }
  fs.createReadStream(filePath).pipe(res);
});

// Errors -> JSON
// eslint-disable-next-line no-unused-vars
server.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? (err.status === 401 || err.status === 403 ? 400 : err.status) : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

const shownHost = ['0.0.0.0', '::'].includes(appConfig.host) ? 'localhost' : appConfig.host;
const appUrl = `http://${shownHost}:${appConfig.port}`;
const shouldOpen = process.argv.includes('--open') || process.env.OPEN_BROWSER === '1';

// Open the app in the default browser (used by start.bat). Never fatal.
function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', `start "" "${url}"`]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: true });
    child.on('error', () => console.log(`  Open ${url} in your browser.`));
    child.unref();
  } catch {
    console.log(`  Open ${url} in your browser.`);
  }
}

const httpServer = server.listen(appConfig.port, appConfig.host, (err) => {
  if (err) return; // Express 5 passes listen errors here too; handled below.
  console.log(`\n  Search Checker is running →  ${appUrl}\n`);
  if (!hasCredentials()) console.log('  No Webshare credentials yet — open the app and add them in Settings.\n');
  if (appConfig.host === '0.0.0.0' && !appConfig.appPassword) {
    console.warn('  Warning: listening on all interfaces without APP_PASSWORD set.\n');
  }
  if (shouldOpen) openBrowser(appUrl);
  // Warm up the browser so the first view is fast.
  getBrowser().catch((err) => console.error('  Could not start Chromium:', err.userMessage || err.message));
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${appConfig.port} is already in use — Search Checker (or another app) is probably already running.`);
    console.error(`  Opening ${appUrl}. To use another port, set PORT in .env (e.g. PORT=3001).\n`);
    if (shouldOpen) openBrowser(appUrl);
    process.exit(2);
  }
  throw err;
});

async function shutdown() {
  httpServer.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, normalizeUrl };
