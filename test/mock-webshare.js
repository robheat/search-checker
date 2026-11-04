'use strict';

/**
 * A tiny stand-in for Webshare's rotating endpoint, for local testing:
 *  - HTTP proxy with Basic proxy auth (password must match)
 *  - records every username it sees (so tests can check country/session targeting)
 *  - serves fake sites on *.test hosts:
 *      ip.test/json      -> ipinfo-style JSON; IP/country derived from the proxy username
 *      site.test/        -> a normal page with an image, script and a console error
 *      blocked.test/     -> Cloudflare-style challenge page
 *      flaky.test/       -> drops the first two connections, works afterwards
 *      redirect.test/    -> 302 to site.test/landing
 */
const http = require('http');
const net = require('net');

function startMockWebshare({ password = 'secret' } = {}) {
  const usernames = [];
  let flakyHits = 0;
  let ipCounter = 10;

  const PAGE = `<!doctype html><html lang="en"><head><title>Mock Site</title>
<meta name="description" content="A page served through the mock proxy">
<link rel="canonical" href="http://site.test/"></head>
<body><h1>Hello from the mock site</h1><p>Price: $19.99</p>
<img src="/pixel.png" width="10" height="10"><a href="/a">A</a><a href="/b">B</a>
<script>console.error('mock console error'); document.body.insertAdjacentHTML('beforeend','<p id="js">JS ran</p>');</script>
</body></html>`;
  const PIXEL = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');

  function site(host, url, username, res) {
    const country = (username.match(/-([A-Z]{2})(?:-|$)/) || [])[1] || 'NL';
    if (host === 'ip.test') {
      ipCounter++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ip: `203.0.113.${ipCounter}`, city: 'Testville', region: 'Test', country, org: 'AS64500 Mock Residential ISP', timezone: 'UTC' }));
    }
    if (host === 'blocked.test') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      return res.end('<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing blocked.test</body></html>');
    }
    if (host === 'redirect.test') {
      res.writeHead(302, { Location: 'http://site.test/landing' });
      return res.end();
    }
    if (url.startsWith('/pixel.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PIXEL);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Mock-Country': country });
    res.end(PAGE.replace('Hello from the mock site', `Hello from the mock site (${country})`));
  }

  // Internal "internet": serves the fake *.test sites. Usernames are passed via a side map
  // keyed by the client port of the tunnel connection.
  const tunnelUsers = new Map();
  const sites = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const user = tunnelUsers.get(req.socket.remotePort) || '';
    site(host === 'flaky.test' ? 'site.test' : host, req.url, user, res);
  });

  function checkAuth(header) {
    const [scheme, encoded] = (header || '').split(' ');
    const decoded = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString() : '';
    const i = decoded.indexOf(':');
    const user = i === -1 ? '' : decoded.slice(0, i);
    const pass = i === -1 ? '' : decoded.slice(i + 1);
    return user && pass === password ? user : null;
  }

  // Plain HTTP proxying (absolute-URI requests).
  const server = http.createServer((req, res) => {
    const user = checkAuth(req.headers['proxy-authorization']);
    if (!user) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="mock-webshare"' });
      return res.end('Proxy Authentication Required');
    }
    usernames.push(user);
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      return res.end('absolute URL required');
    }
    if (target.hostname === 'flaky.test' && flakyHits++ < 2) {
      req.socket.destroy();
      return;
    }
    if (target.hostname === 'flaky.test') target.hostname = 'site.test';
    if (!target.hostname.endsWith('.test')) {
      res.writeHead(502);
      return res.end('mock proxy only serves *.test');
    }
    site(target.hostname, target.pathname + target.search, user, res);
  });

  // CONNECT tunnels (used by Playwright's request API, and by browsers for HTTPS).
  server.on('connect', (req, socket) => {
    const user = checkAuth(req.headers['proxy-authorization']);
    if (!user) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="mock-webshare"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    usernames.push(user);
    const host = req.url.split(':')[0];
    if (!host.endsWith('.test')) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const upstream = net.connect(sites.address().port, '127.0.0.1', () => {
      tunnelUsers.set(upstream.localPort, user);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const done = () => {
      tunnelUsers.delete(upstream.localPort);
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', done);
    socket.on('error', done);
    socket.on('close', done);
  });

  return new Promise((resolve) => {
    sites.listen(0, '127.0.0.1', () => {
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: server.address().port,
          usernames,
          close: () => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => sites.close(r))]),
        });
      });
    });
  });
}

module.exports = { startMockWebshare };

if (require.main === module) {
  startMockWebshare().then(({ port }) => console.log(`Mock Webshare proxy on 127.0.0.1:${port} (password: secret)`));
}
