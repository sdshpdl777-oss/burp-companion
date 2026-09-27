# Burp Companion

A Manifest V3 Chrome extension for use alongside [Burp Suite](https://portswigger.net/burp)
during **your own authorized** web-security testing. Two tools in one:

1. **API Responses viewer** (toolbar popup) — passively watches the current page's
   `fetch` / XHR calls and shows the **JSON the server returned**, pretty-printed, in
   the popup. Meant for a non-technical viewer: just open the popup and read the output.
   No pausing, no controls, no "being debugged" banner.
2. **Proxy toggle** (toolbar popup) — one click to route Chrome traffic through Burp's
   proxy (default `127.0.0.1:8080`) and back to a direct connection.
3. **Request inspector** (DevTools → **Burp** panel) — logs the current tab's HTTP
   requests, lets you inspect them, edit method / URL / headers / body, and **resend**
   them, plus copy any request as **cURL** or **fetch**.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `burp-companion/` folder.
4. Pin the extension from the puzzle-piece menu for quick access.

## Using the proxy toggle

- Start Burp Suite; confirm its Proxy listener (Proxy → Options) is on `127.0.0.1:8080`.
- Click the toolbar icon, set host/port/scheme if needed, and flip **Proxy through Burp**.
- The badge shows **ON** while active. Loopback addresses stay direct so local tooling
  isn't proxied.
- To intercept HTTPS, install Burp's CA certificate in your OS/Chrome trust store
  (see PortSwigger's docs).

**Fail-safe:** the proxy will only turn on if Burp is actually reachable at the
host/port. If Burp isn't running you'll see a warning and the toggle stays off, so the
extension can't take your browser offline. At browser startup a saved "on" state is
re-checked the same way and auto-disabled (badge shows `!`) if Burp is gone.
(SOCKS listeners can't be probed over HTTP, so this check is skipped for SOCKS.)

## Using the API Responses viewer

This is the "just show me what the server sent back" feature — the one a non-technical
person can use. No banner, no buttons to understand.

1. Open the page/app you want to watch.
2. Click the toolbar icon. The **API Responses** section lists every JSON response the
   page's code received, newest at the top. The newest one is expanded automatically;
   click any row to expand/collapse its body.
3. Interact with the app (click around). New API responses appear live while the popup
   is open.
4. Use the filter box to narrow by endpoint (e.g. `users`), or **Clear** to reset.

**How it works & limits**
- It hooks the page's `fetch` and `XMLHttpRequest`, so it sees exactly the API data the
  app receives — nothing is paused or changed; the app behaves normally.
- Only JSON-looking responses are kept (by content-type, or a body starting with `{`/`[`).
  Images, HTML, and scripts are ignored, so the list stays clean.
- Captures are kept per tab by the service worker (also from iframes) and reset on a full page reload. If you just
  installed/reloaded the extension, **reload the page once** so the hooks are in place.
- Bodies are capped at ~500 KB for display. Up to 150 responses are kept per page.
- Requests made *before* the page finished loading the extension's hook (very early
  boot requests) may be missed; a page reload captures them.

## Sending a request directly to the server

The popup's **Send Request** card calls the server **directly from the extension**, not
from the page, and shows exactly what comes back: status, response headers and body
(JSON is pretty-printed).

1. Pick the method, type the full URL, and add headers (`Name: value`, one per line)
   and a body if needed. Or click **Send again** on any captured API response to load
   that request's method, URL, headers and body into the form.
2. Leave **Send my cookies** ticked to send as your logged-in session; untick it to send
   as an anonymous visitor.
3. Press **Send** (or Enter in the URL box). Use **Copy** to copy the response body.

Page CORS doesn't block these requests. Redirects are followed. Browser-controlled
headers (Host, Cookie, Origin, Referer, …) can't be set by hand. If the proxy toggle is
on, these requests go through Burp too and appear in its HTTP history.

## Using the request inspector

- Open DevTools (`⌥⌘I` / `F12`) on the target tab and pick the **Burp** panel.
- Requests appear as they happen. Click one to load it into the editor.
- Edit anything, then **Resend**. Replays go through the extension's service worker,
  so they aren't blocked by page CORS. A handful of
  [forbidden request headers](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name)
  (Host, Content-Length, Cookie, etc.) are dropped automatically by the browser.
- **Preserve on navigate** keeps history across page loads. **Clear** empties it.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: proxy control + request replay |
| `inject.js` | Runs in the page world; hooks `fetch`/XHR to observe API responses |
| `bridge.js` | Isolated content script (every frame); marks JSON / true-false replies and forwards them to the service worker |
| `popup.html/.css/.js` | Toolbar UI: API Responses viewer + proxy toggle |
| `devtools.js` / `devtools.html` | Registers the DevTools panel |
| `panel.html/.css/.js` | Request history, inspector, and replay UI |
| `icons/` | Toolbar/panel icons |

## Scope & notes

- Intended for testing/observing systems **you own or are authorized to test**.
- The API viewer reads response bodies in the browser; it does not send them anywhere.
- `chrome.proxy` sets Chrome's proxy for the whole profile while enabled; toggle it off
  (or disable the extension) when you're done.
- This is a companion to Burp, not a replacement — heavy interception, scanning, and
  match/replace still live in Burp itself.
