# Search Checker

See any URL the way people in another country see it. Every view goes through a fresh **Webshare.io rotating residential proxy** IP in a real (headless) Chromium. You get:

- **A full-page screenshot.** A preview shows up within a second or two, then the final capture replaces it.
- **The rendered HTML and visible text**, with find-in-page highlighting (handy for checking a ranking, price or brand mention).
- **Every network request**, its size, and an estimate of the **residential bandwidth used**.
- **The exit IP, city, country and ISP** for each view, plus a warning if the IP isn't in the country you asked for.
- **Detection of blocks and CAPTCHAs**: Google's "unusual traffic" page, Cloudflare, PerimeterX, DataDome, Akamai and Imperva. When one is detected, the view is retried automatically on a new IP.
- **Automatic retries** with a new IP when a residential connection drops, plus plain-English error messages.
- **Side-by-side comparison across up to 12 countries** at once, as desktop, mobile (Pixel 7) or tablet.
- **A browser that matches the location**: locale, `Accept-Language` and timezone are set to fit the country.
- **A search mode**: type a query and choose Google, Bing, DuckDuckGo or Yahoo.
- **Saved history** with screenshots, which survives restarts. You can download the screenshot, HTML and text.

## Quick start

Requires Node.js 18.17+.

```bash
npm install
npm run setup      # downloads Chromium for Playwright (one-time)
npm start          # → http://127.0.0.1:3000
```

Open the app. On first run it asks for your Webshare credentials. You can give either:

- an **API key** (dashboard → *API* → *Keys*), which the app uses to fetch your proxy username and password automatically, or
- your **proxy username and password** (dashboard → *Proxy* → *Residential*). Enter the base username, without `-rotate` or a country suffix.

Click **Save & test**. The app connects through Webshare and shows the exit IP it got. You can also set credentials in `.env` (see `.env.example`).

## How proxy usernames are built

Webshare chooses rotation, country and sticky sessions from the proxy username. The app builds that username from a template, which you can edit under **Settings → Advanced**:

| Mode | Default template | Example |
| --- | --- | --- |
| Rotating, any country | `{user}[-{country}]-rotate` | `abcd1234-rotate` |
| Rotating, Germany | same | `abcd1234-DE-rotate` |
| Sticky IP, Germany | `{user}[-{country}]-{session}` | `abcd1234-DE-48213` |

`[ … ]` is left out when its placeholder is empty. **If your Webshare dashboard shows a different format** for country targeting or sticky sessions, change the template to match it. The settings screen shows a live preview of the exact usernames that will be sent. The default endpoint is `p.webshare.io:80`.

**Rotating or sticky?**
- *Rotating* gets a new IP for each view. Requests within one page can leave through different IPs.
- *Sticky* keeps one IP for the whole page load. Choose it when a site ties a session to one IP.

## Bandwidth

Residential traffic is billed per GB, so by default **video and audio are skipped**. Under *Options → Bandwidth* you can choose:

- **Everything**
- **Skip video & audio** (default)
- **Data saver**, which skips images and fonts as well

Each result shows roughly how much proxy bandwidth it used.

## Running it for a team

The app listens on `127.0.0.1` by default. To share it on your network, set `HOST=0.0.0.0` **and** `APP_PASSWORD=…`, which turns on HTTP basic auth. `MAX_CONCURRENT` (default 3) sets how many browsers run in parallel. Extra views wait in a queue and show their place in it.

Credentials saved from the UI go to `data/settings.json` (file mode 600). The password and API key are never sent back to the browser.

## Development

```bash
npm test
```

The test suite runs real Chromium against a **mock Webshare proxy** (`test/mock-webshare.js`). The mock enforces proxy auth, records the usernames it receives, and serves fake sites: normal, redirecting, blocked and flaky. The suite covers:

- country and sticky username building
- exit-IP lookup
- block detection and retries on a new IP
- 407 handling
- result capture

You can also run the mock on its own (`node test/mock-webshare.js`) to try the UI without spending bandwidth.

Project layout:

```
src/server.js     Express API + SSE progress stream
src/viewer.js     Playwright: per-view proxied contexts, retries, block detection, capture
src/jobs.js       Queue, concurrency, history persistence
src/webshare.js   Username templates, Webshare API (proxy config)
src/config.js     .env + saved settings
public/           Front-end (vanilla JS, no build step)
```
