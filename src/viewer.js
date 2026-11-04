'use strict';

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { app } = require('./config');
const { buildProxy } = require('./webshare');
const { countryInfo } = require('./countries');

const IP_LOOKUP_URLS = (process.env.IP_LOOKUP_URLS || 'https://ipinfo.io/json,https://api.ipify.org?format=json')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_SCREENSHOT_HEIGHT = 16000;
const MAX_NETWORK_ENTRIES = 600;
const MAX_CONSOLE_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Browser lifecycle: one shared Chromium, a fresh isolated context per attempt.
// ---------------------------------------------------------------------------
let browserPromise = null;

function launchOptions() {
  const opts = {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
  };
  if (app.chromiumPath) opts.executablePath = app.chromiumPath;
  // Chromium on Windows needs a global proxy placeholder for per-context proxies.
  if (process.platform === 'win32') opts.proxy = { server: 'http://per-context' };
  return opts;
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch(launchOptions())
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        if (/Executable doesn't exist|browserType\.launch/i.test(err.message)) {
          err.userMessage = 'Chromium is not installed. Run "npm run setup" (or set CHROMIUM_PATH) and try again.';
        }
        throw err;
      });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {
    /* ignore */
  }
  browserPromise = null;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
function desktopUserAgent(browserVersion) {
  const major = String(browserVersion || '140').split('.')[0];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function deviceOptions(device, browserVersion) {
  if (device === 'mobile') {
    const d = devices['Pixel 7'];
    return { ...d, userAgent: d.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${String(browserVersion).split('.')[0]}.0.0.0`) };
  }
  if (device === 'tablet') {
    const d = devices['Galaxy Tab S4'];
    return { ...d, userAgent: d.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${String(browserVersion).split('.')[0]}.0.0.0`) };
  }
  return {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: desktopUserAgent(browserVersion),
  };
}

// ---------------------------------------------------------------------------
// Error classification -> friendly messages + retry decisions
// ---------------------------------------------------------------------------
function classifyError(err) {
  const m = String((err && err.message) || err);
  if (err && err.code === 'CANCELLED') return { code: 'CANCELLED', retry: false, message: 'Cancelled.' };
  if (err && err.code === 'NOT_CONFIGURED') {
    return { code: 'NOT_CONFIGURED', retry: false, message: 'Add your Webshare credentials in Settings first.' };
  }
  if (err && err.userMessage) return { code: 'BROWSER', retry: false, message: err.userMessage };
  if (/ERR_INVALID_AUTH_CREDENTIALS|ERR_PROXY_AUTH|\b407\b|Proxy Authentication Required/i.test(m)) {
    return {
      code: 'PROXY_AUTH',
      retry: false,
      message: 'Webshare rejected the proxy login.',
      hint: 'Check the username/password in Settings. If you picked a country, make sure your plan supports country targeting and the username template matches the format shown in your Webshare dashboard.',
    };
  }
  if (/ERR_NAME_NOT_RESOLVED/i.test(m)) {
    return { code: 'DNS', retry: false, message: "That domain couldn't be resolved. Check the spelling." };
  }
  if (/ERR_CERT_|ERR_SSL_PROTOCOL|SSL_ERROR/i.test(m)) {
    return { code: 'TLS', retry: true, message: 'The secure (HTTPS) connection failed through this IP.' };
  }
  if (/Timeout \d+ms exceeded|ERR_TIMED_OUT|timed out/i.test(m)) {
    return { code: 'TIMEOUT', retry: true, message: 'The page took too long to load through this IP.' };
  }
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_|ERR_EMPTY_RESPONSE|ERR_SOCKS|ERR_HTTP2|ERR_QUIC|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED/i.test(m)) {
    return {
      code: 'PROXY_NETWORK',
      retry: true,
      message: 'The connection through the residential IP failed.',
      hint: 'Residential IPs come and go — retrying with a fresh IP usually fixes this. If every attempt fails, check that the domain is correct and reachable.',
    };
  }
  if (/net::ERR_ABORTED/i.test(m)) {
    return { code: 'ABORTED', retry: false, message: 'The browser aborted the navigation (the URL may be a file download).' };
  }
  if (/Target page, context or browser has been closed|Browser has been closed/i.test(m)) {
    return { code: 'CLOSED', retry: true, message: 'The browser session closed unexpectedly.' };
  }
  return { code: 'UNKNOWN', retry: true, message: m.split('\n')[0].slice(0, 300) };
}

// ---------------------------------------------------------------------------
// Block / challenge detection
// ---------------------------------------------------------------------------
const BLOCK_PATTERNS = [
  [/google\.[a-z.]+\/sorry\//i, 'url', 'Google “unusual traffic” CAPTCHA'],
  [/our systems have detected unusual traffic/i, 'text', 'Google “unusual traffic” CAPTCHA'],
  [/^just a moment\.\.\.$/i, 'title', 'Cloudflare browser challenge'],
  [/attention required! \| cloudflare/i, 'title', 'Cloudflare block page'],
  [/checking your browser before accessing|verify you are human|cf-turnstile|challenges\.cloudflare\.com/i, 'html', 'Cloudflare challenge'],
  [/px-captcha|perimeterx|press & hold/i, 'html', 'PerimeterX / HUMAN bot challenge'],
  [/captcha-delivery\.com|datadome/i, 'html', 'DataDome bot challenge'],
  [/^access denied$/i, 'title', 'Access denied (likely Akamai/WAF)'],
  [/you don't have permission to access .* on this server/i, 'text', 'Access denied (likely Akamai/WAF)'],
  [/www\.google\.com\/recaptcha\/|hcaptcha\.com\/captcha/i, 'html', 'CAPTCHA on page'],
  [/request unsuccessful\. incapsula|_incapsula_resource/i, 'html', 'Imperva/Incapsula block'],
];

async function detectBlock(page, status) {
  const snapshot = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title || '',
      text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 4000),
      html: document.documentElement ? document.documentElement.outerHTML.slice(0, 60000) : '',
    }))
    .catch(() => null);
  if (!snapshot) return null;
  for (const [re, field, reason] of BLOCK_PATTERNS) {
    if (re.test(snapshot[field] || '')) {
      // Recaptcha embedded on a normal content page is common — only flag when the page is small.
      if (reason === 'CAPTCHA on page' && snapshot.text.length > 1500) continue;
      return { reason, status };
    }
  }
  if ((status === 403 || status === 429) && snapshot.text.length < 2000) {
    return { reason: status === 429 ? 'Rate limited (HTTP 429)' : 'Forbidden (HTTP 403)', status };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exit IP lookup (through the same proxied browser context)
// ---------------------------------------------------------------------------
async function lookupExitIp(context) {
  for (const url of IP_LOOKUP_URLS) {
    try {
      const res = await context.request.get(url, { timeout: 12000, failOnStatusCode: false });
      if (res.status() === 407) throw Object.assign(new Error('HTTP 407 Proxy Authentication Required'), { code: 'PROXY_AUTH' });
      if (!res.ok()) continue;
      const data = await res.json().catch(async () => ({ ip: (await res.text()).trim() }));
      if (!data || !data.ip) continue;
      return {
        ip: data.ip,
        city: data.city || '',
        region: data.region || '',
        country: data.country || data.country_code || '',
        org: data.org || data.isp || '',
        timezone: data.timezone || '',
        source: new URL(url).host,
      };
    } catch (err) {
      if (err.code === 'PROXY_AUTH') throw err;
      /* otherwise try the next lookup service */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One attempt = one fresh context = (normally) one fresh residential IP
// ---------------------------------------------------------------------------
const BANDWIDTH_BLOCKS = {
  full: new Set(),
  'no-media': new Set(['media']),
  'text-only': new Set(['media', 'image', 'font']),
};

async function runAttempt(job, attempt, dir) {
  const o = job.options;
  const emit = (type, data) => job.emit(type, data);
  const browser = await getBrowser();
  job.throwIfCancelled();

  const proxy = buildProxy({ country: o.country, mode: o.ipMode });
  const country = countryInfo(o.country);
  const locale = o.language && o.language !== 'auto' ? o.language : (country && country.locale) || 'en-US';
  const timezoneId = o.matchTimezone !== false && country && country.timezone ? country.timezone : undefined;

  const { _session, ...playwrightProxy } = proxy;
  emit('log', {
    message: `Attempt ${attempt}: connecting via ${proxy.server.replace(/^https?:\/\//, '')} as ${maskProxyUser(proxy.username)}`,
  });

  const context = await browser.newContext({
    ...deviceOptions(o.device, browser.version()),
    proxy: playwrightProxy,
    locale,
    timezoneId,
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'Accept-Language': acceptLanguage(locale) },
  });
  job.onCancel(() => context.close().catch(() => {}));

  const network = [];
  const consoleLog = [];
  const sizePromises = [];
  let bytes = 0;
  let requests = 0;
  let failedRequests = 0;

  try {
    const blocked = BANDWIDTH_BLOCKS[o.bandwidth] || BANDWIDTH_BLOCKS['no-media'];
    if (blocked.size) {
      await context.route('**/*', (route) => {
        if (blocked.has(route.request().resourceType())) return route.abort('blockedbyclient');
        return route.fallback();
      });
    }

    const page = await context.newPage();
    page.setDefaultTimeout(app.navTimeoutMs);

    page.on('console', (msg) => {
      if (consoleLog.length < MAX_CONSOLE_ENTRIES && ['error', 'warning'].includes(msg.type())) {
        consoleLog.push({ type: msg.type(), text: msg.text().slice(0, 500) });
      }
    });
    page.on('pageerror', (err) => {
      if (consoleLog.length < MAX_CONSOLE_ENTRIES) consoleLog.push({ type: 'error', text: String(err.message).slice(0, 500) });
    });
    page.on('request', () => {
      requests++;
    });
    page.on('requestfinished', (req) => {
      const entry = { url: req.url(), method: req.method(), type: req.resourceType(), status: null, size: 0 };
      if (network.length < MAX_NETWORK_ENTRIES) network.push(entry);
      sizePromises.push(
        Promise.all([req.sizes().catch(() => null), req.response().catch(() => null)]).then(([s, res]) => {
          if (s) {
            entry.size = s.responseBodySize + s.responseHeadersSize;
            bytes += entry.size + s.requestBodySize + s.requestHeadersSize;
          }
          if (res) entry.status = res.status();
        })
      );
    });
    page.on('requestfailed', (req) => {
      const failure = (req.failure() && req.failure().errorText) || 'failed';
      if (failure.includes('ERR_BLOCKED_BY_CLIENT')) return; // our own bandwidth saver
      failedRequests++;
      if (network.length < MAX_NETWORK_ENTRIES) {
        network.push({ url: req.url(), method: req.method(), type: req.resourceType(), status: null, size: 0, error: failure });
      }
    });

    // Exit IP lookup runs in parallel with the page load.
    const ipPromise = lookupExitIp(context)
      .then((ip) => {
        if (ip) emit('ip', ip);
        return ip;
      })
      .catch(() => null);

    emit('phase', { phase: 'navigating', message: 'Loading page through residential IP…' });
    const t0 = Date.now();
    const waitUntil = o.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load';
    const response = await page.goto(o.url, { waitUntil, timeout: app.navTimeoutMs });
    const navMs = Date.now() - t0;
    job.throwIfCancelled();

    const status = response ? response.status() : null;
    if (status === 407) throw Object.assign(new Error('HTTP 407 Proxy Authentication Required'), { code: 'PROXY_AUTH' });
    emit('log', { message: `Got HTTP ${status ?? '—'} in ${(navMs / 1000).toFixed(1)}s` });

    // Quick preview so the UI has something to show right away.
    await page
      .screenshot({ path: path.join(dir, 'preview.jpg'), type: 'jpeg', quality: 70 })
      .then(() => emit('preview', { url: `/api/jobs/${job.id}/preview.jpg?a=${attempt}` }))
      .catch(() => {});

    if (o.waitUntil === 'networkidle' || o.waitUntil === 'load') {
      emit('phase', { phase: 'settling', message: 'Waiting for the page to settle…' });
      const idleCap = o.waitUntil === 'networkidle' ? 20000 : 6000;
      await page.waitForLoadState('networkidle', { timeout: idleCap }).catch(() => {});
    }
    if (o.extraWaitMs > 0) {
      emit('log', { message: `Waiting an extra ${(o.extraWaitMs / 1000).toFixed(1)}s…` });
      await page.waitForTimeout(o.extraWaitMs);
    }
    job.throwIfCancelled();

    const block = await detectBlock(page, status);
    if (block) emit('log', { level: 'warn', message: `Looks blocked: ${block.reason}` });

    emit('phase', { phase: 'capturing', message: 'Capturing screenshot & page data…' });
    const meta = await page.evaluate(() => {
      const pick = (sel, attr = 'content') => {
        const el = document.querySelector(sel);
        return el ? el.getAttribute(attr) || '' : '';
      };
      return {
        title: document.title || '',
        description: pick('meta[name="description"]'),
        canonical: pick('link[rel="canonical"]', 'href'),
        robots: pick('meta[name="robots"]'),
        lang: document.documentElement.getAttribute('lang') || '',
        h1: Array.from(document.querySelectorAll('h1')).slice(0, 5).map((h) => h.innerText.trim()).filter(Boolean),
        links: document.querySelectorAll('a[href]').length,
        height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      };
    });

    const viewport = page.viewportSize() || { width: 1440, height: 900 };
    const fullPage = o.fullPage !== false;
    const truncated = fullPage && meta.height > MAX_SCREENSHOT_HEIGHT;
    const shotOpts = { path: path.join(dir, 'screenshot.jpg'), type: 'jpeg', quality: 82, timeout: 30000, animations: 'disabled' };
    if (fullPage) {
      shotOpts.fullPage = true;
      if (truncated) shotOpts.clip = { x: 0, y: 0, width: viewport.width, height: MAX_SCREENSHOT_HEIGHT };
    }
    await page.screenshot(shotOpts).catch(async () => {
      // Very tall/complex pages can fail full-page capture; fall back to the viewport.
      await page.screenshot({ path: path.join(dir, 'screenshot.jpg'), type: 'jpeg', quality: 82 });
    });

    const html = await page.content();
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    fs.writeFileSync(path.join(dir, 'page.html'), html);
    fs.writeFileSync(path.join(dir, 'page.txt'), text.slice(0, 2_000_000));

    // Redirect chain for the main document.
    const redirects = [];
    if (response) {
      let req = response.request().redirectedFrom();
      while (req) {
        const r = await req.response().catch(() => null);
        redirects.unshift({ url: req.url(), status: r ? r.status() : null });
        req = req.redirectedFrom();
      }
    }

    const exitIp = await Promise.race([ipPromise, new Promise((r) => setTimeout(() => r(null), 4000))]);
    await Promise.race([Promise.allSettled(sizePromises), new Promise((r) => setTimeout(r, 3000))]);

    return {
      requestedUrl: o.url,
      finalUrl: page.url(),
      status,
      statusText: response ? response.statusText() : '',
      headers: response ? await response.allHeaders().catch(() => ({})) : {},
      redirects,
      ...meta,
      locale,
      timezoneId: timezoneId || null,
      userAgent: await page.evaluate(() => navigator.userAgent).catch(() => ''),
      viewport,
      screenshot: { fullPage, truncated, pageHeight: meta.height },
      timings: { navigationMs: navMs, totalMs: Date.now() - t0 },
      bytes,
      requests,
      failedRequests,
      network,
      console: consoleLog,
      exitIp,
      session: _session || null,
      blocked: block,
      textLength: text.length,
      htmlLength: html.length,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function acceptLanguage(locale) {
  const base = locale.split('-')[0];
  if (base === 'en') return `${locale},en;q=0.9`;
  return `${locale},${base};q=0.9,en;q=0.8`;
}

function maskProxyUser(u) {
  // Show the targeting suffix (useful for debugging) but hide most of the account id.
  const i = u.indexOf('-');
  const head = i === -1 ? u : u.slice(0, i);
  const tail = i === -1 ? '' : u.slice(i);
  return `${head.slice(0, 3)}…${tail}`;
}

/**
 * Run a view job with automatic retries on fresh IPs.
 */
async function runView(job) {
  const o = job.options;
  const dir = job.dir;
  fs.mkdirSync(dir, { recursive: true });
  const maxAttempts = 1 + Math.max(0, Math.min(5, o.retries ?? 2));
  let lastError = null;
  let lastBlockedResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    job.throwIfCancelled();
    job.emit('attempt', { attempt, maxAttempts });
    job.emit('phase', {
      phase: 'connecting',
      message: attempt === 1 ? 'Getting a residential IP…' : `Retrying with a fresh IP (attempt ${attempt} of ${maxAttempts})…`,
    });
    try {
      const attemptDir = path.join(dir, `a${attempt}`);
      fs.mkdirSync(attemptDir, { recursive: true });
      const result = await runAttempt(job, attempt, attemptDir);
      result.attempts = attempt;
      if (result.blocked && o.retryOnBlock !== false && attempt < maxAttempts) {
        lastBlockedResult = result;
        job.emit('log', { level: 'warn', message: 'Blocked page detected — trying another IP.' });
        continue;
      }
      return result;
    } catch (err) {
      const info = classifyError(err);
      if (info.code === 'CANCELLED' || job.cancelled) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED', info });
      lastError = { ...info, raw: String(err.message || err).split('\n')[0].slice(0, 400) };
      job.emit('log', { level: 'error', message: `${info.message}${info.retry && attempt < maxAttempts ? ' Retrying…' : ''}` });
      if (!info.retry) break;
    }
  }
  if (lastBlockedResult) return lastBlockedResult; // every IP was blocked: still show what we saw
  const err = new Error(lastError ? lastError.message : 'Failed to load the page.');
  err.info = lastError;
  throw err;
}

module.exports = { runView, getBrowser, closeBrowser, classifyError, lookupExitIp, deviceOptions };
