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

// ---- Network-level Response Interception via Chrome Debugger ----
async function attachDebugger(tabId) {
  if (!chrome.debugger) return;
  try {
    const target = { tabId };
    await chrome.debugger.attach(target, "1.3");
    await chrome.debugger.sendCommand(target, "Network.enable");
  } catch (_) {}
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab?.url && /^https?:\/\//i.test(tab.url)) {
    attachDebugger(tabId);
  }
});

if (chrome.debugger) {
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    if (method === "Network.responseReceived" && source.tabId) {
      const { requestId, response } = params;
      if (!response || !response.url || !/^https?:\/\//i.test(response.url)) return;

      if (/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff2?|ttf|eot)(\?.*)?$/i.test(response.url)) return;

      try {
        const resData = await chrome.debugger.sendCommand(source, "Network.getResponseBody", { requestId });
        let body = resData.body || "";
        if (resData.base64Encoded) {
          try { body = atob(body); } catch (_) {}
        }

        const ct = response.headers ? (response.headers["content-type"] || response.headers["Content-Type"] || "") : "";
        const bools = extractBools(body, ct);
        if (bools.length) {
          let endpoint = response.url, path = response.url;
          try { const u = new URL(response.url); endpoint = u.host + u.pathname; path = u.pathname + u.search; } catch (_) {}
          const pretty = formatBoolJson(body, ct) || body;
          const item = {
            url: response.url,
            endpoint,
            path,
            method: response.method || "GET",
            status: response.status,
            bools,
            pretty,
            contentType: "application/json",
            reqHeaders: [],
            reqBody: "",
            ts: Date.now()
          };
          await addCapture(source.tabId, item);
        }
      } catch (_) {}
    }
  });
}

async function replay(req, senderTabId) {
  const headers = {};
  for (const h of req.headers || []) {
    if (!h || !h.name) continue;
    if (FORBIDDEN_HEADERS.has(h.name.toLowerCase())) continue;
    headers[h.name] = h.value;
  }
  const init = {
    method: req.method || "GET", headers, cache: "no-store",
    redirect: req.redirect || "manual",
    credentials: req.credentials || "include"
  };
  if (req.body != null && !["GET", "HEAD"].includes(init.method.toUpperCase())) init.body = req.body;

  const started = performance.now();
  const res = await fetch(req.url, init);
  const elapsedMs = Math.round(performance.now() - started);
  const resHeaders = [];
  res.headers.forEach((value, name) => resHeaders.push({ name, value }));
  const body = await res.text();

  const ct = res.headers.get("content-type") || "";
  const bools = extractBools(body, ct);
  if (bools.length) {
    let endpoint = req.url, path = req.url;
    try { const u = new URL(req.url); endpoint = u.host + u.pathname; path = u.pathname + u.search; } catch (_) {}
    const pretty = formatBoolJson(body, ct) || body;
    const item = {
      url: req.url,
      endpoint,
      path,
      method: (req.method || "GET").toUpperCase(),
      status: res.status,
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

  return { ok: true, status: res.status, statusText: res.statusText, headers: resHeaders, body, elapsedMs, finalUrl: res.url };
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
          if (cfg.enabled) {
            await setDirect(); // stay online while probing
            if (!(await burpReachable(cfg))) {
              cfg.enabled = false;
              await chrome.storage.local.set(cfg);
              await applyProxy(cfg);
              sendResponse({
                ...cfg,
                error: `Can't reach Burp at ${cfg.host}:${cfg.port}. Start Burp and its Proxy listener, then try again.`
              });
              break;
            }
          }
          await chrome.storage.local.set(cfg);
          await applyProxy(cfg);
          sendResponse(cfg);
          break;
        }
        case "replay":
          sendResponse(await replay(msg.payload, _sender.tab?.id || msg.payload?.tabId));
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
