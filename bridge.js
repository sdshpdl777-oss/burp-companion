// Runs in the isolated content-script world, in every frame of the page.
// Receives captures from inject.js (page world) via postMessage, keeps only the
// replies that contain true/false (see bools.js), and forwards them to the
// service worker. Other replies are forwarded without a body, only to be counted.
(function () {
  const isTop = window === window.top;
  const BODY_MAX = 50_000;

  function normalize(p) {
    const bools = extractBools(p.bodyText, p.contentType);
    let endpoint = p.url, path = p.url;
    try { const u = new URL(p.url); endpoint = u.host + u.pathname; path = u.pathname + u.search; } catch (_) {}
    const item = { url: p.url, endpoint, path, method: p.method, status: p.status, bools, ts: p.ts };
    if (!bools.length) return item; // only counted

    let pretty = formatBoolJson(p.bodyText, p.contentType) || p.bodyText;
    if (pretty.length > BODY_MAX) pretty = pretty.slice(0, BODY_MAX) + "\n… (truncated)";
    return {
      ...item,
      contentType: "application/json",
      pretty,
      reqHeaders: p.reqHeaders || [],
      reqBody: p.reqBody || ""
    };
  }

  // After the extension is reloaded, this old copy of the script is orphaned
  // ("Extension context invalidated") — stop sending instead of throwing.
  function send(msg) {
    if (!chrome.runtime?.id) return;
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (_) {}
  }

  // A fresh top-level page starts a fresh list.
  if (isTop) send({ type: "page-start" });

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__burpCap !== true || !d.payload) return;
    send({ type: "api-capture", item: normalize(d.payload) });
  });
})();
