const $ = (id) => document.getElementById(id);

const rowsEl = $("rows");
const emptyEl = $("empty");
const countEl = $("count");
const filterEl = $("filter");
const preserveEl = $("preserve");
const detailEmpty = $("detailEmpty");
const editor = $("editor");
const methodEl = $("method");
const urlEl = $("url");
const headersEl = $("headers");
const bodyEl = $("body");
const respMeta = $("respMeta");
const respBody = $("respBody");
const sendBtn = $("send");


let entries = [];       // captured requests
let selectedId = null;
let nextId = 1;

// ---- Capture -------------------------------------------------------------
chrome.devtools.network.onRequestFinished.addListener((har) => {
  const req = har.request || {};
  const res = har.response || {};
  entries.push({
    id: nextId++,
    method: req.method || "GET",
    url: req.url || "",
    status: res.status || 0,
    headers: (req.headers || []).map((h) => ({ name: h.name, value: h.value })),
    body: req.postData ? (req.postData.text || "") : ""
  });
  renderList();
});

chrome.devtools.network.onNavigated.addListener(() => {
  if (!preserveEl.checked) {
    entries = [];
    selectEntry(null);
    renderList();
  }
});

// ---- History list --------------------------------------------------------
function statusClass(s) {
  if (s >= 500) return "s-5xx";
  if (s >= 400) return "s-4xx";
  if (s >= 300) return "s-3xx";
  if (s >= 200) return "s-2xx";
  return "";
}

function renderList() {
  const q = filterEl.value.trim().toLowerCase();
  const visible = entries.filter(
    (e) => !q || e.url.toLowerCase().includes(q) || e.method.toLowerCase().includes(q)
  );

  rowsEl.textContent = "";
  for (const e of visible) {
    const tr = document.createElement("tr");
    tr.dataset.id = e.id;
    if (e.id === selectedId) tr.classList.add("selected");

    const m = document.createElement("td");
    m.className = "c-method";
    m.innerHTML = `<span class="method-badge">${e.method}</span>`;

    const s = document.createElement("td");
    s.className = "c-status " + statusClass(e.status);
    s.textContent = e.status || "—";

    const u = document.createElement("td");
    u.className = "c-url";
    u.textContent = e.url;
    u.title = e.url;

    tr.append(m, s, u);
    tr.addEventListener("click", () => selectEntry(e.id));
    rowsEl.appendChild(tr);
  }

  countEl.textContent = String(visible.length);
  emptyEl.style.display = entries.length ? "none" : "block";
}

filterEl.addEventListener("input", renderList);

$("clear").addEventListener("click", () => {
  entries = [];
  selectEntry(null);
  renderList();
});

// ---- Detail / editor -----------------------------------------------------
function headersToText(headers) {
  return headers.map((h) => `${h.name}: ${h.value}`).join("\n");
}

function textToHeaders(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf(":");
    if (i === -1) continue;
    out.push({ name: trimmed.slice(0, i).trim(), value: trimmed.slice(i + 1).trim() });
  }
  return out;
}

function selectEntry(id) {
  selectedId = id;
  const e = entries.find((x) => x.id === id);

  if (!e) {
    editor.hidden = true;
    detailEmpty.hidden = false;
    renderList();
    return;
  }
  detailEmpty.hidden = true;
  editor.hidden = false;

  methodEl.value = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(e.method)
    ? e.method : "GET";
  urlEl.value = e.url;
  headersEl.value = headersToText(e.headers);
  bodyEl.value = e.body;
  respMeta.textContent = "No response yet.";
  respMeta.style.borderLeftColor = "var(--muted)";
  respBody.value = "";
  switchTab("reqHeaders");
  renderList();
}

// ---- Tabs ----------------------------------------------------------------
function switchTab(name) {
  for (const t of document.querySelectorAll(".tab")) {
    t.classList.toggle("active", t.dataset.tab === name);
  }
  for (const p of document.querySelectorAll(".pane")) {
    p.hidden = p.id !== name;
  }
}
for (const t of document.querySelectorAll(".tab")) {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
}

// ---- Build the current request from editor fields ------------------------
function currentRequest() {
  return {
    method: methodEl.value,
    url: urlEl.value.trim(),
    headers: textToHeaders(headersEl.value),
    body: bodyEl.value
  };
}

// ---- Replay --------------------------------------------------------------
sendBtn.addEventListener("click", () => {
  const req = currentRequest();
  if (!req.url) return;
  switchTab("response");
  respMeta.textContent = "Sending…";
  respMeta.style.borderLeftColor = "var(--amber)";
  respBody.value = "";
  sendBtn.disabled = true;

  chrome.runtime.sendMessage({ type: "replay", payload: req }, (res) => {
    sendBtn.disabled = false;
    if (!res || !res.ok) {
      respMeta.textContent = "Error: " + (res && res.error ? res.error : "no response");
      respMeta.style.borderLeftColor = "var(--red)";
      return;
    }
    const cls = statusClass(res.status);
    const color = cls === "s-2xx" ? "var(--green)"
      : cls === "s-3xx" ? "var(--amber)"
        : cls ? "var(--red)" : "var(--muted)";
    respMeta.style.borderLeftColor = color;
    respMeta.textContent = `${res.status} ${res.statusText}  ·  ${res.elapsedMs} ms  ·  ${res.body.length} bytes`;
    const hdrText = res.headers.map((h) => `${h.name}: ${h.value}`).join("\n");
    respBody.value = hdrText + "\n\n" + res.body;
  });
});

// ---- Copy helpers --------------------------------------------------------
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function toCurl(req) {
  const parts = ["curl", "-i", "-X", req.method, shellQuote(req.url)];
  for (const h of req.headers) parts.push("-H", shellQuote(`${h.name}: ${h.value}`));
  if (req.body && !["GET", "HEAD"].includes(req.method)) parts.push("--data-raw", shellQuote(req.body));
  return parts.join(" ");
}

function toFetch(req) {
  const headers = {};
  for (const h of req.headers) headers[h.name] = h.value;
  const init = { method: req.method, headers };
  if (req.body && !["GET", "HEAD"].includes(req.method)) init.body = req.body;
  return `fetch(${JSON.stringify(req.url)}, ${JSON.stringify(init, null, 2)});`;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    // Clipboard can be blocked in the devtools context; fall back to a textarea select.
    respBody.value = text;
  }
}

$("copyCurl").addEventListener("click", (e) => copy(toCurl(currentRequest()), e.target));
$("copyFetch").addEventListener("click", (e) => copy(toFetch(currentRequest()), e.target));

renderList();
