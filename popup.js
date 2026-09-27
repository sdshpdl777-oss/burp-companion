const $ = (id) => document.getElementById(id);
const send = (type, payload) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve));

// ====================== API RESPONSES ======================
const apiList = $("apiList"), apiCount = $("apiCount"), apiStatus = $("apiStatus");
const apiFilter = $("apiFilter"), apiClear = $("apiClear"), apiTpl = $("apiTpl");

let activeTabId = null;
let items = []; // replies containing true/false, newest first

function statusClass(s) {
  if (s >= 500) return "s-5xx"; if (s >= 400) return "s-4xx";
  if (s >= 300) return "s-3xx"; if (s >= 200) return "s-2xx"; return "";
}

// Readable title from the endpoint: /api/v1/check-code/123 -> "Check Code".
function apiTitle(it) {
  let segs = [];
  try { segs = new URL(it.url).pathname.split("/").filter(Boolean); } catch (_) {}
  const skip = /^(api|v\d+|\d+|[0-9a-f-]{16,}|index(\.\w+)?)$/i;
  const seg = segs.reverse().find((x) => !skip.test(x)) || (() => { try { return new URL(it.url).host; } catch (_) { return it.url; } })();
  return decodeURIComponent(seg).replace(/\.\w+$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "Response";
}

// Put text in the element with every true/false word coloured.
function colorBools(el, text) {
  el.textContent = "";
  text.split(/\b(true|false)\b/).forEach((part, i) => {
    if (i % 2 === 0) { if (part) el.append(part); return; }
    const w = document.createElement("span");
    w.className = part === "true" ? "jt" : "jf";
    w.textContent = part;
    el.append(w);
  });
}

function renderApi() {
  const q = apiFilter.value.trim().toLowerCase();
  const match = (it) => !q || it.endpoint.toLowerCase().includes(q) || it.url.toLowerCase().includes(q);
  const visible = items.filter(match);
  apiCount.textContent = String(items.length);

  apiList.textContent = "";
  if (!visible.length) return; // status line already explains the empty state

  visible.forEach((it) => {
    const node = apiTpl.content.firstElementChild.cloneNode(true);

    if (it.method === "WS") node.querySelector(".resend").hidden = true;
    node.querySelector(".method").textContent = it.method;
    const st = node.querySelector(".astatus");
    st.textContent = it.status || "—";
    const sc = statusClass(it.status);
    if (sc) st.classList.add(sc); // classList.add("") throws (WebSocket 101, status 0)
    node.querySelector(".title").textContent = apiTitle(it);
    const ep = node.querySelector(".endpoint");
    ep.textContent = it.path || it.endpoint;
    ep.title = it.url;

    node.querySelector(".resend").addEventListener("click", (e) => {
      e.stopPropagation(); // don't toggle the row
      loadIntoSender(it);
    });

    const body = node.querySelector(".api-body");
    colorBools(body, it.pretty || "(empty)");

    const head = node.querySelector(".api-head");
    const chev = node.querySelector(".chev");
    const expanded = true; // every reply open, formatted
    body.hidden = !expanded;
    chev.textContent = expanded ? "▾" : "▸";
    head.addEventListener("click", () => {
      body.hidden = !body.hidden;
      chev.textContent = body.hidden ? "▸" : "▾";
    });

    apiList.appendChild(node);
  });
}

function setStatus(text) { apiStatus.textContent = text; }

let seen = 0; // every network call the page made, JSON or not

function updateStatus() {
  const hidden = Math.max(0, seen - items.length);
  if (items.length) setStatus(`${items.length} API(s) replied true/false. Hid ${hidden} other call(s).`);
  else if (seen) setStatus(`Checked ${seen} call(s) on this page — none replied true/false yet.`);
  else setStatus("No network calls seen yet. Use the site — or, if you just installed/reloaded the extension, reload this page once.");
}

async function loadCaptures() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) { setStatus("No active tab."); return; }
  activeTabId = tab.id;
  const res = await send("getCaptures", { tabId: tab.id });
  seen = (res && res.seen) || 0;
  items = ((res && res.items) || []).slice().reverse(); // newest first
  updateStatus();
  renderApi();
}

apiFilter.addEventListener("input", renderApi);
apiClear.addEventListener("click", () => {
  if (activeTabId != null) send("clearCaptures", { tabId: activeTabId });
  items = []; seen = 0;
  setStatus("Cleared. Waiting for new API calls…");
  renderApi();
});

// Live updates from the page while the popup is open.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab || sender.tab.id !== activeTabId) return;
  if (msg?.type === "page-start" && sender.frameId === 0) {
    items = []; seen = 0;
  } else if (msg?.type === "api-capture" && msg.item) {
    seen++;
    if (msg.item.bools && msg.item.bools.length) {
      items.unshift(msg.item);
      if (items.length > 150) items.pop();
    }
  } else return;
  updateStatus();
  renderApi();
});

// ======================= SEND REQUEST =======================
// Calls the server directly from the extension's service worker (not from the
// page), so page CORS doesn't apply and you see exactly what the server returns.
const reqMethod = $("reqMethod"), reqUrl = $("reqUrl"), reqHeaders = $("reqHeaders");
const reqBody = $("reqBody"), reqCookies = $("reqCookies"), reqSend = $("reqSend");
const resBox = $("resBox"), resStatus = $("resStatus"), resInfo = $("resInfo");
const resHeaders = $("resHeaders"), resBody = $("resBody"), resCopy = $("resCopy");

function parseHeaders(text) {
  return text.split("\n").map((line) => {
    const i = line.indexOf(":");
    if (i <= 0) return null;
    return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
  }).filter((h) => h && h.name);
}

function loadIntoSender(it) {
  reqMethod.value = [...reqMethod.options].some((o) => o.value === it.method) ? it.method : "GET";
  reqUrl.value = it.url;
  reqHeaders.value = (it.reqHeaders || []).map((h) => `${h.name}: ${h.value}`).join("\n");
  reqBody.value = it.reqBody || "";
  $("sendCard").scrollIntoView({ behavior: "smooth" });
  reqUrl.focus();
}

async function sendRequest() {
  const url = reqUrl.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    resBox.hidden = false;
    resStatus.textContent = ""; resHeaders.textContent = ""; resBody.textContent = "";
    resInfo.textContent = "⚠ Enter a full URL starting with http:// or https://";
    return;
  }
  reqSend.disabled = true; reqSend.textContent = "Sending…";
  const res = await send("replay", {
    method: reqMethod.value,
    url,
    headers: parseHeaders(reqHeaders.value),
    body: reqBody.value || null,
    credentials: reqCookies.checked ? "include" : "omit",
    redirect: "follow"
  });
  reqSend.disabled = false; reqSend.textContent = "Send";
  resBox.hidden = false;

  if (!res || res.ok === false) {
    resStatus.textContent = "ERR"; resStatus.className = "astatus s-5xx";
    resInfo.textContent = (res && res.error) || "No response";
    resHeaders.textContent = ""; resBody.textContent = "";
    return;
  }
  resStatus.textContent = res.status; resStatus.className = "astatus " + statusClass(res.status);
  resInfo.textContent = `${res.statusText || ""} · ${res.elapsedMs} ms · ${res.body.length} chars`;
  resInfo.title = res.finalUrl || url;
  resHeaders.textContent = res.headers.map((h) => `${h.name}: ${h.value}`).join("\n");
  let pretty = res.body;
  try { pretty = prettyJson(JSON.parse(res.body)); } catch (_) {}
  resBody.textContent = pretty || "(empty)";

  // A reply containing true/false also goes into the captured list above.
  const ct = (res.headers.find((h) => h.name.toLowerCase() === "content-type") || {}).value || "";
  const bools = extractBools(res.body, ct);
  if (bools.length) {
    const formattedBool = formatBoolJson(res.body, ct);
    if (formattedBool) {
      resBody.textContent = formattedBool;
    }
    await loadCaptures();
  }
}

reqSend.addEventListener("click", sendRequest);
reqUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") sendRequest(); });
resCopy.addEventListener("click", () => navigator.clipboard.writeText(resBody.textContent));

// ============================ PROXY ============================
const toggle = $("toggle"), host = $("host"), port = $("port"), scheme = $("scheme");
const statusEl = $("status"), dot = $("dot");

function renderProxy(cfg) {
  toggle.checked = !!cfg.enabled;
  host.value = cfg.host; port.value = cfg.port; scheme.value = cfg.scheme;
  dot.classList.toggle("on", cfg.enabled);
  statusEl.classList.toggle("on", cfg.enabled);
  statusEl.classList.toggle("warn", !!cfg.error);
  if (cfg.error) statusEl.textContent = "⚠ " + cfg.error;
  else statusEl.textContent = cfg.enabled
    ? `Proxying via ${cfg.scheme}://${cfg.host}:${cfg.port}`
    : "Direct connection.";
}

async function commitProxy() {
  if (toggle.checked) {
    statusEl.classList.remove("on", "warn");
    statusEl.textContent = "Checking Burp is running…";
  }
  renderProxy(await send("setState", {
    enabled: toggle.checked,
    host: host.value.trim() || "127.0.0.1",
    port: Number(port.value) || 8080,
    scheme: scheme.value
  }));
}

toggle.addEventListener("change", commitProxy);
scheme.addEventListener("change", commitProxy);
for (const el of [host, port]) {
  el.addEventListener("change", commitProxy);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") commitProxy(); });
}

// ---------- init ----------
send("getState").then(renderProxy);
loadCaptures();
