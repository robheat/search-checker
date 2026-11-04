'use strict';

// End-to-end: real Chromium -> app server -> mock Webshare proxy -> fake *.test sites.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockWebshare } = require('./mock-webshare');

let proxy;
let app;
let base;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-checker-test-'));

before(async () => {
  proxy = await startMockWebshare();
  const port = 4000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      WEBSHARE_USERNAME: 'testuser',
      WEBSHARE_PASSWORD: 'secret',
      WEBSHARE_PROXY_HOST: '127.0.0.1',
      WEBSHARE_PROXY_PORT: String(proxy.port),
      WEBSHARE_API_KEY: '',
      IP_LOOKUP_URLS: 'http://ip.test/json',
      NAV_TIMEOUT_MS: '15000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 20000);
    app.stdout.on('data', (d) => {
      if (String(d).includes('running')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
});

after(async () => {
  app.kill('SIGTERM');
  await proxy.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (p, body) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(base + p).then((r) => r.json());

async function waitFor(id, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const job = await get(`/api/jobs/${id}`);
    if (!['queued', 'running'].includes(job.status)) return job;
    if (Date.now() - t0 > ms) throw new Error(`job ${id} timed out in ${job.phase}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test('status reports configured credentials without leaking the password', async () => {
  const s = await get('/api/status');
  assert.equal(s.settings.configured, true);
  assert.equal(s.settings.hasPassword, true);
  assert.ok(!JSON.stringify(s).includes('secret'));
  assert.ok(s.countries.length > 20);
});

test('connection test returns the exit IP through the proxy', async () => {
  const r = await post('/api/settings/test', {});
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.match(r.body.ip.ip, /^203\.0\.113\./);
  assert.ok(proxy.usernames.includes('testuser-rotate'));
});

test('views a page in two countries with full capture', async () => {
  const r = await post('/api/views', { url: 'http://site.test/', countries: ['US', 'DE'], ipMode: 'rotate', device: 'desktop' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.jobs.length, 2);
  const [us, de] = await Promise.all(r.body.jobs.map((j) => waitFor(j.id)));
  for (const [job, cc] of [[us, 'US'], [de, 'DE']]) {
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.status, 200);
    assert.equal(job.result.title, 'Mock Site');
    assert.equal(job.result.exitIp.country, cc);
    assert.equal(job.result.description, 'A page served through the mock proxy');
    assert.ok(job.result.network.some((n) => n.url.endsWith('/pixel.png')));
    assert.ok(job.result.console.some((c) => c.text.includes('mock console error')));
    assert.ok(job.result.bytes > 0);
    assert.equal(job.result.blocked, null);
    const shot = await fetch(`${base}/api/jobs/${job.id}/screenshot.jpg`);
    assert.equal(shot.headers.get('content-type'), 'image/jpeg');
    assert.ok((await shot.arrayBuffer()).byteLength > 1000);
    const text = await fetch(`${base}/api/jobs/${job.id}/page.txt`).then((x) => x.text());
    assert.ok(text.includes(`Hello from the mock site (${cc})`));
    assert.ok(text.includes('JS ran'), 'JavaScript executed');
    const html = await fetch(`${base}/api/jobs/${job.id}/page.html`);
    assert.match(html.headers.get('content-type'), /text\/plain/);
    assert.match(html.headers.get('content-security-policy'), /sandbox/);
  }
  assert.ok(proxy.usernames.includes('testuser-US-rotate'));
  assert.ok(proxy.usernames.includes('testuser-DE-rotate'));
  assert.equal(us.result.locale, 'en-US');
  assert.equal(de.result.locale, 'de-DE');
});

test('sticky mode uses a session username and mobile emulation', async () => {
  const r = await post('/api/views', { url: 'http://site.test/', countries: ['GB'], ipMode: 'sticky', device: 'mobile' });
  const job = await waitFor(r.body.jobs[0].id);
  assert.equal(job.status, 'done', JSON.stringify(job.error));
  assert.ok(job.result.session);
  assert.ok(proxy.usernames.includes(`testuser-GB-${job.result.session}`));
  assert.ok(job.result.viewport.width < 500);
  assert.match(job.result.userAgent, /Android/);
});

test('follows redirects and records the chain', async () => {
  const r = await post('/api/views', { url: 'http://redirect.test/', countries: [''] });
  const job = await waitFor(r.body.jobs[0].id);
  assert.equal(job.status, 'done', JSON.stringify(job.error));
  assert.equal(job.result.finalUrl, 'http://site.test/landing');
  assert.equal(job.result.redirects[0].status, 302);
});

test('detects block pages and retries with fresh IPs', async () => {
  const r = await post('/api/views', { url: 'http://blocked.test/', retries: 1 });
  const job = await waitFor(r.body.jobs[0].id);
  assert.equal(job.status, 'done');
  assert.equal(job.result.attempts, 2);
  assert.match(job.result.blocked.reason, /Cloudflare/);
});

test('retries after a dropped proxy connection', async () => {
  const r = await post('/api/views', { url: 'http://flaky.test/', retries: 2 });
  const job = await waitFor(r.body.jobs[0].id);
  assert.equal(job.status, 'done', JSON.stringify(job.error));
  assert.ok(job.result.attempts >= 2);
  assert.equal(job.result.title, 'Mock Site');
});

test('bad proxy password gives a clear, non-retried error', async () => {
  await post('/api/settings', { password: 'wrong' });
  try {
    const t = await post('/api/settings/test', {});
    assert.equal(t.body.ok, false);
    const r = await post('/api/views', { url: 'http://site.test/', retries: 2 });
    const job = await waitFor(r.body.jobs[0].id);
    assert.equal(job.status, 'error');
    assert.equal(job.error.code, 'PROXY_AUTH', JSON.stringify(job.error));
    assert.equal(job.attempt, 1);
  } finally {
    await post('/api/settings', { password: 'secret' });
  }
});

test('rejects invalid input', async () => {
  assert.equal((await post('/api/views', { url: 'ftp://x.com' })).status, 400);
  assert.equal((await post('/api/views', { url: '' })).status, 400);
  assert.equal((await post('/api/settings', { rotateTemplate: 'no-user-here' })).status, 400);
});

test('history lists finished views and SSE replays events', async () => {
  const { jobs } = await get('/api/jobs');
  assert.ok(jobs.length >= 6);
  const res = await fetch(`${base}/api/jobs/${jobs[0].id}/events`);
  const body = await res.text();
  assert.match(body, /"type":"snapshot"/);
});
