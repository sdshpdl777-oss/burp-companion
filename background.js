importScripts("bools.js");

// Burp Companion - service worker
// Handles: proxy on/off through Burp, request replay, and the per-tab list of
// API responses captured by the content scripts (shown in the popup).

const DEFAULTS = { enabled: false, host: "127.0.0.1", port: 8080, scheme: "http" };

// Headers the Fetch spec forbids scripts from setting. We drop these on replay.
const FORBIDDEN_HEADERS = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers",
  "access-control-request-method", "connection", "content-length", "cookie2",
  "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "te",
  "trailer", "transfer-encoding", "upgrade", "via"
]);

async function getConfig() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function setDirect() {
  await chrome.proxy.settings.set({ scope: "regular", value: { mode: "direct" } });
}

async function applyProxy(cfg) {
  if (cfg.enabled) {
    await chrome.proxy.settings.set({
      scope: "regular",
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: { scheme: cfg.scheme, host: cfg.host, port: Number(cfg.port) },
          bypassList: ["<-loopback>"]
        }
      }
    });
  } else {
    await setDirect();
  }
  chrome.action.setBadgeText({ text: cfg.enabled ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#e8613c" });
  chrome.action.setTitle({ title: cfg.enabled ? "Burp Companion — proxy ON" : "Burp Companion — proxy OFF" });
}

// Is Burp actually listening? Probe the proxy address directly (loopback bypasses
// the proxy, so this connects straight to the port). A refused connection / timeout
// means Burp isn't there — so we must NOT route traffic into a black hole.
// SOCKS listeners don't answer HTTP, so we skip the probe for them.
async function burpReachable(cfg) {
  if (cfg.scheme === "socks4" || cfg.scheme === "socks5") return true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(`http://${cfg.host}:${cfg.port}/`, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    return true; // Burp answered (even an opaque/error response means the port is open)
  } catch {
    return false; // connection refused, or timed out
  } finally {
    clearTimeout(timer);
  }
}

// On install/startup, don't blindly re-enable a saved proxy: if Burp is gone, that
// would take the whole browser offline. Probe first; fall back to direct otherwise.
async function initProxy() {
  const cfg = await getConfig();
  if (!cfg.enabled) { await applyProxy(cfg); return; }
  await setDirect(); // browse normally while we check
  if (await burpReachable(cfg)) {
    await applyProxy(cfg);
  } else {
    cfg.enabled = false;
    await chrome.storage.local.set(cfg);
    await applyProxy(cfg);
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e05c5c" });
    chrome.action.setTitle({ title: `Burp unreachable at ${cfg.host}:${cfg.port} — proxy auto-disabled` });
  }
}

chrome.runtime.onInstalled.addListener(initProxy);
chrome.runtime.onStartup.addListener(initProxy);

// ---- Captured API responses, per tab ----
// Kept in storage.session so they survive the service worker going to sleep.
const CAP_LIMIT = 150;
const caps = new Map(); // tabId -> { seen, items } — items: replies with true/false
let capQueue = Promise.resolve(); // serialise read-modify-write

const capKey = (tabId) => `caps_${tabId}`;

async function loadCaps(tabId) {
  if (!caps.has(tabId)) {
    const got = await chrome.storage.session.get(capKey(tabId));
    caps.set(tabId, { seen: 0, items: [], ...got[capKey(tabId)] });
  }
  return caps.get(tabId);
}

function saveCaps(tabId) {
  return chrome.storage.session.set({ [capKey(tabId)]: caps.get(tabId) }).catch(() => {});
}

function withCaps(tabId, fn) {
  capQueue = capQueue.then(async () => {
    const c = await loadCaps(tabId);
    const out = fn(c);
    await saveCaps(tabId);
    return out;
  }).catch(() => {});
  return capQueue;
}

function resetCaps(tabId) {
  return withCaps(tabId, (c) => { c.seen = 0; c.items = []; });
}

function addCapture(tabId, item) {
  return withCaps(tabId, (c) => {
    c.seen++;
    if (!item.bools || !item.bools.length) return; // no true/false: only counted
    // Avoid duplicate entries captured within 1.5s for the same URL and method
    const isDup = c.items.some(
      (existing) => existing.url === item.url && existing.method === item.method && Math.abs((existing.ts || 0) - (item.ts || 0)) < 1500
    );
    if (isDup) return;
    c.items.push(item);
    if (c.items.length > CAP_LIMIT) c.items.shift();
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  caps.delete(tabId);
  chrome.storage.session.remove(capKey(tabId)).catch(() => {});
});

// ---- True response interception (server → [PAUSED HERE] → page) ----
// Uses the CDP **Fetch** domain, not the Network domain. The Network domain only
// *reports* responses (Network.responseReceived) as they're already being handed
// to the renderer. The Fetch domain, enabled at the Response stage, *pauses* each
// response after the server sent it but BEFORE the page's JS can read it — exactly
// where Burp sits. We inspect the held bytes, then release them with
// Fetch.continueRequest. (Fetch.fulfillRequest could rewrite them instead — that's
// how you'd add response editing later.)
const attached = new Set(); // tabIds we currently hold a debugger session on

// Decode a getResponseBody result to a JS string, honouring UTF-8 for text bodies
// (plain atob() mangles multi-byte characters).
function decodeBody(resData) {
  const raw = resData?.body || "";
  if (!resData?.base64Encoded) return raw;
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (_) {
    return "";
  }
}

// Skip resource types that never carry an API true/false and would waste a
// getResponseBody round-trip (and can be large binaries).
const SKIP_TYPES = new Set(["Image", "Media", "Font", "Stylesheet", "Manifest"]);

async function attachDebugger(tabId) {
  if (!chrome.debugger || attached.has(tabId)) return;
  attached.add(tabId); // reserve before await so concurrent onUpdated events don't double-attach
  try {
    const target = { tabId };
    await chrome.debugger.attach(target, "1.3");
    // Pause every response just before it reaches the page. requestStage:"Response"
    // means the request already went out and the server's reply is in hand, held.
    await chrome.debugger.sendCommand(target, "Fetch.enable", {
      patterns: [{ requestStage: "Response" }]
    });
  } catch (_) {
    attached.delete(tabId); // attach failed (e.g. DevTools already attached) — allow a retry later
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab?.url && /^https?:\/\//i.test(tab.url)) {
    attachDebugger(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));
if (chrome.debugger) {
  // The user can detach us via the "cancel" banner; forget the tab so we can reattach.
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId != null) attached.delete(source.tabId);
  });
}

if (chrome.debugger) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== "Fetch.requestPaused" || source.tabId == null) return;
    handlePaused(source, params);
  });
}

// Read a paused response, capture any true/false, then ALWAYS release it. If we
// never continued the request the page would hang forever, so releasing is in a
// finally and its own failure is swallowed (the tab may already be gone).
async function handlePaused(source, params) {
  const { requestId, request = {}, responseStatusCode, responseErrorReason, resourceType } = params;
  const isResponseStage = responseStatusCode != null || responseErrorReason != null;

  try {
    // A network error (DNS, refused, aborted) has no body to read — just let it through.
    if (!isResponseStage || responseErrorReason) return;

    const url = request.url || "";
    if (!/^https?:\/\//i.test(url)) return;
    if (SKIP_TYPES.has(resourceType)) return;
    if (/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff2?|ttf|eot)(\?.*)?$/i.test(url)) return;

    let resData;
    try {
      resData = await chrome.debugger.sendCommand(source, "Fetch.getResponseBody", { requestId });
    } catch (_) {
      return; // body unavailable (204/redirect/evicted) — nothing to inspect, still release below
    }
    const body = decodeBody(resData);
    if (!body) return;

    // responseHeaders is an array of {name, value}; find content-type case-insensitively.
    let ct = "";
    for (const h of params.responseHeaders || []) {
      if (h && /^content-type$/i.test(h.name)) { ct = h.value || ""; break; }
    }

    const bools = extractBools(body, ct);
    if (!bools.length) return;

    let endpoint = url, path = url;
    try { const u = new URL(url); endpoint = u.host + u.pathname; path = u.pathname + u.search; } catch (_) {}

    // The paused event also carries the outgoing request, so replay works from
    // network-captured items too (page-world hooks aren't the only source now).
    const reqHeaders = Object.entries(request.headers || {}).map(([name, value]) => ({ name, value: String(value) }));

    const item = {
      url,
      endpoint,
      path,
      method: request.method || "GET",
      status: responseStatusCode,
      bools,
      pretty: formatBoolJson(body, ct) || body,
      contentType: "application/json",
      reqHeaders,
      reqBody: request.postData || "",
      ts: Date.now()
    };
    await addCapture(source.tabId, item);
  } catch (_) {
    // never let inspection failure block the response
  } finally {
    try { await chrome.debugger.sendCommand(source, "Fetch.continueRequest", { requestId }); } catch (_) {}
  }
}

// The shared fetch core: fires ONE request straight from the service worker
// (not the page), carrying the site's session cookies when credentials:"include".
// This is the real request to the server — the same engine Send Request and the
// batch Collector both ride on.
async function rawFetch(req) {
  const headers = {};
  for (const h of req.headers || []) {
    if (!h || !h.name) continue;
    if (FORBIDDEN_HEADERS.has(h.name.toLowerCase())) continue;
    headers[h.name] = h.value;
  }
  const method = (req.method || "GET").toUpperCase();
  const init = {
    method, headers, cache: "no-store",
    redirect: req.redirect || "manual",
    credentials: req.credentials || "include"
  };
  if (req.body != null && !["GET", "HEAD"].includes(method)) init.body = req.body;

  const started = performance.now();
  const res = await fetch(req.url, init);
  const elapsedMs = Math.round(performance.now() - started);
  const resHeaders = [];
  res.headers.forEach((value, name) => resHeaders.push({ name, value }));
  const body = await res.text();
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, statusText: res.statusText, headers: resHeaders, body, ct, elapsedMs, finalUrl: res.url };
}

async function replay(req, senderTabId) {
  const r = await rawFetch(req);
  const bools = extractBools(r.body, r.ct);
  if (bools.length) {
    let endpoint = req.url, path = req.url;
    try { const u = new URL(req.url); endpoint = u.host + u.pathname; path = u.pathname + u.search; } catch (_) {}
    const pretty = formatBoolJson(r.body, r.ct) || r.body;
    const item = {
      url: req.url,
      endpoint,
      path,
      method: (req.method || "GET").toUpperCase(),
      status: r.status,
      bools,
      pretty,
      contentType: "application/json",
      reqHeaders: req.headers || [],
      reqBody: req.body || "",
      ts: Date.now()
    };

    let targetTabId = senderTabId;
    if (!targetTabId) {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tabs[0]) targetTabId = tabs[0].id;
    }
    if (targetTabId) {
      await addCapture(targetTabId, item);
    }
  }

  return { ok: true, status: r.status, statusText: r.statusText, headers: r.headers, body: r.body, elapsedMs: r.elapsedMs, finalUrl: r.finalUrl };
}

// ---- Active Collector ----
// Fires a batch of endpoints DIRECTLY from the extension (whether or not the page
// ever called them), reads each full response, and merges every true/false into a
// single JSON object keyed by "METHOD /path". This is the "fetch it myself, don't
// wait for the browser" engine — Burp-Repeater-style, run over a list at once.
// Authorized use only: point it at servers you own or are permitted to test.
async function collect(payload) {
  const list = Array.isArray(payload?.endpoints) ? payload.endpoints : [];
  const credentials = payload?.credentials || "include";
  const CONCURRENCY = 5;          // be gentle; a few in flight at a time
  const MAX_ENDPOINTS = 300;      // safety cap so a huge list can't hammer a host

  // De-duplicate by METHOD + URL, normalise to request objects.
  const seen = new Set();
  const reqs = [];
  for (const ep of list) {
    const url = typeof ep === "string" ? ep : ep?.url;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const method = ((typeof ep === "object" && ep.method) || "GET").toUpperCase();
    const key = method + " " + url;
    if (seen.has(key)) continue;
    seen.add(key);
    reqs.push({
      url, method,
      headers: (typeof ep === "object" && ep.headers) || [],
      body: (typeof ep === "object" && ep.body) || null,
      credentials, redirect: "follow"
    });
    if (reqs.length >= MAX_ENDPOINTS) break;
  }

  const aggregate = {};   // "METHOD /path" -> pruned true/false JSON
  const results = [];     // per-endpoint outcome for the run log

  async function runOne(req) {
    let label = req.url;
    try { const u = new URL(req.url); label = u.pathname + u.search; } catch (_) {}
    const tag = req.method + " " + label;
    try {
      const r = await rawFetch(req);
      const bools = extractBools(r.body, r.ct);
      const pretty = formatBoolJson(r.body, r.ct);
      if (bools.length) {
        let value;
        if (pretty) { try { value = JSON.parse(pretty); } catch (_) { value = pretty; } }
        // Unwrap the common { "value": true } single-field case to a bare boolean.
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const ks = Object.keys(value);
          if (ks.length === 1 && ks[0] === "value") value = value.value;
        }
        aggregate[tag] = value;
      }
      results.push({ tag, url: req.url, method: req.method, status: r.status, ok: true, count: bools.length });
    } catch (e) {
      results.push({ tag, url: req.url, method: req.method, ok: false, error: String((e && e.message) || e) });
    }
  }

  // Simple bounded-concurrency worker pool.
  let i = 0;
  async function worker() { while (i < reqs.length) { await runOne(reqs[i++]); } }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, reqs.length) }, worker));

  return { ok: true, aggregate, results, total: reqs.length, withBools: Object.keys(aggregate).length };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "getState":
          sendResponse(await getConfig());
          break;
        case "setState": {
          const cfg = { ...(await getConfig()), ...msg.payload };
          // Honor the user's choice: turning the toggle ON keeps it ON. We still
          // probe Burp, but only to WARN — we no longer force the toggle back off.
          // (If Burp really is down, pages route into it and may not load; the
          // warning says so, and toggling off restores a direct connection.)
          let warning;
          if (cfg.enabled) {
            await setDirect(); // stay online while probing
            if (!(await burpReachable(cfg))) {
              warning = `Proxy is ON, but Burp didn't answer at ${cfg.host}:${cfg.port}. If pages stop loading, start Burp's Proxy listener — or toggle this off.`;
            }
          }
          await chrome.storage.local.set(cfg);
          await applyProxy(cfg);
          sendResponse(warning ? { ...cfg, error: warning } : cfg);
          break;
        }
        case "replay":
          sendResponse(await replay(msg.payload, _sender.tab?.id || msg.payload?.tabId));
          break;
        case "collect":
          sendResponse(await collect(msg.payload));
          break;
        // ---- from bridge.js (content script) ----
        case "page-start":
          if (_sender.tab && _sender.frameId === 0) await resetCaps(_sender.tab.id);
          sendResponse({ ok: true });
          break;
        case "api-capture":
          if (_sender.tab && msg.item) await addCapture(_sender.tab.id, msg.item);
          sendResponse({ ok: true });
          break;
        // ---- from the popup ----
        case "getCaptures":
          sendResponse(await withCaps(msg.payload.tabId, (c) => ({ seen: c.seen, items: c.items })));
          break;
        case "clearCaptures":
          await resetCaps(msg.payload.tabId);
          sendResponse({ ok: true });
          break;
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;
});
